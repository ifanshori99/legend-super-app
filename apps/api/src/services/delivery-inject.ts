// Delivery order injection (bead legend-5bn3 D3; PRD v1.7 §3.23 "Injeksi
// Pesanan", Alur G). One transaction-scoped function shared by the platform
// webhook (delivery-ingest.service.ts) and the manual POS mode
// (delivery-orders.service.ts): it records the `delivery_channel_orders` row,
// creates the `orders` + `pos_orders` rows tagged with the platform channel and
// `external_ref`, fires every line to the kitchen, allocates the pickup number
// and appends audit + outbox events.
//
// Money is the platform's: lines are priced as reported (gross), the order has
// no tax or service charge of ours, and nothing is captured through our gateway
// (platform-paid, PRD §3.23). The caller owns the transaction, the idempotency
// decision (webhook replay vs. payload change, handled before this runs) and
// any adapter call (accept_order is pushed after this commits).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  assertDeliveryOrderInjectable,
  assertDeliveryOrderTransition,
  deliveryEvents,
  DeliveryError,
  type DeliveryEventName,
  type DeliveryOrderLine,
  type DeliveryPlatform,
} from "@starter/shared/delivery";
import { FacilityError } from "@starter/shared/facility";
import {
  domainEventOutbox,
  kitchenTicketItems,
  kitchenTickets,
  menuItems,
} from "../db/schema/index.ts";
import { deliveryChannelOrders } from "../db/schema/delivery.ts";
import { posOrderItems, posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { logger } from "../lib/logger.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  findByExternalId,
  type DeliveryChannelOrderRow,
} from "./delivery-store.ts";
import { closedShowerMenuItemIds } from "./facility-shower-gate.ts";
import {
  cancelKitchenItemsForVoidedLines,
  routeFiredItemsToKitchen,
} from "./kds.service.ts";
import {
  releaseMenuItemDailyLimit,
  reserveMenuItemDailyLimit,
} from "./menu-availability.ts";
import { computeLineCostSnapshots } from "./order-cost-snapshot.service.ts";
import { uniqueViolationOf } from "./pos-shift-support.ts";
import type { Tx } from "./menu-internals.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
  businessDateFor,
  capturedIdr,
  loadOutlet,
  tendersOf,
  type OrderRow,
} from "./pos-order-support.ts";

const EVENT_DESTINATION = "cloud-sync";

/** Prefix of the pickup number and the order number, per platform. */
const PLATFORM_PREFIX: Record<DeliveryPlatform, string> = {
  gofood: "GF",
  grabfood: "GR",
  shopeefood: "SF",
};

export type InjectDeliveryOrderInput = {
  outletId: OutletId;
  platform: DeliveryPlatform;
  /** Unique per platform (PRD §6.G); the caller already ruled out a replay. */
  externalOrderId: string;
  source: "platform" | "manual_pos";
  /** As reported by the platform (manual: resolved by the server). */
  grossIdr: number;
  commissionIdr: number;
  /** SHA-256 hex of the raw payload (manual: of the typed input). */
  payloadHash: string;
  /** The webhook signature's instant (platform); null or absent for manual. */
  signedAt?: Date | null;
  customerNote: string | null;
  /** Every line must be matched or price_mismatch (injectable); sold_out is not. */
  lines: readonly DeliveryOrderLine[];
  /**
   * `accepted` records the order as already accepted (manual mode: the cashier
   * has the order in hand; a platform order stays `received` until the
   * adapter's accept_order succeeds). Goes through the delivery machine.
   */
  initialStatus: "received" | "accepted";
  /**
   * A delivery row already stored without an injection (needs_review) that the
   * platform has since corrected: the row is updated in place instead of
   * inserted, and `delivery_order.received` is not emitted a second time.
   */
  existing?: DeliveryChannelOrderRow;
  /** The cashier for manual orders; null for the webhook (system). */
  actorUserId: UserId | null;
  now: Date;
};

export type InjectDeliveryOrderResult = {
  deliveryOrderId: string;
  /** Null only when `needsReview` (nothing was injected or linked). */
  orderId: string | null;
  pickupNumber: string | null;
  /** The stored row, as inserted. */
  row: DeliveryChannelOrderRow;
  /**
   * The platform order matches a POS order the cashier already voided: the
   * row is stored unlinked (needs_review) and must not be auto-accepted.
   */
  needsReview: boolean;
};

/** Modifier names then the customer's line note, for the kitchen ticket. */
function kitchenNote(line: DeliveryOrderLine): string | null {
  const parts = [
    ...line.modifiers.map((modifier) => `+ ${modifier.name}`),
    ...(line.note ? [line.note] : []),
  ];
  return parts.length === 0 ? null : parts.join("; ").slice(0, 200);
}

/** Payload hashes remembered per order (newest last) for replay detection. */
const SEEN_HASH_LIMIT = 32;

/** `seen` plus `hash` (moved to the end), keeping the newest SEEN_HASH_LIMIT. */
export function withSeenHash(seen: readonly string[], hash: string): string[] {
  return [...seen.filter((entry) => entry !== hash), hash].slice(
    -SEEN_HASH_LIMIT,
  );
}

/** The later of two signature instants; null only when both are. */
export function latestSignedAt(
  stored: Date | null,
  incoming: Date | null,
): Date | null {
  if (stored === null) return incoming;
  if (incoming === null) return stored;
  return incoming > stored ? incoming : stored;
}

/** Unique keys a racing writer of the same platform order can hit. */
const DUPLICATE_ORDER_KEYS = new Set([
  "pos_orders_external_ref_key",
  "delivery_channel_orders_external_key",
]);

/** Serialises writers of one key for the rest of the transaction. */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

export async function appendDeliveryEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: DeliveryEventName,
  input: {
    deliveryOrderId: string;
    outletId: string;
    payload: Record<string, unknown>;
    actorUserId: UserId | null;
    now: Date;
  },
): Promise<void> {
  const definition = deliveryEvents[name];
  const aggregateType = definition.entry.aggregateType;
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, input.deliveryOrderId),
      ),
    );
  const sequence = Number(row?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType,
    aggregateId: input.deliveryOrderId,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor:
      input.actorUserId === null
        ? { type: "system" }
        : { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey:
      `${definition.name}:${input.deliveryOrderId}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Injects one delivery order into the POS and the KDS inside the caller's
 * transaction. Throws DELIVERY_MAPPING_INCOMPLETE (an unmatched line cannot
 * reach the KDS, contract `assertDeliveryOrderInjectable`) and
 * DELIVERY_ORDER_DUPLICATE (same platform order id, a manual-mode entry of a
 * platform number already entered at the POS, or a racing writer hitting
 * pos_orders_external_ref_key; never a raw unique violation).
 *
 * A platform order the cashier already rang up at the POS (manual ojol mode,
 * `pos_orders.external_ref`) is not a second order: the delivery row is
 * stored linked to that POS order (no new order, no kitchen fire).
 */
export async function injectDeliveryOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: InjectDeliveryOrderInput,
): Promise<InjectDeliveryOrderResult> {
  try {
    return await injectOrLink(tx, context, input);
  } catch (error) {
    const constraint = uniqueViolationOf(error);
    if (constraint !== null && DUPLICATE_ORDER_KEYS.has(constraint))
      throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
    throw error;
  }
}

async function injectOrLink(
  tx: Tx,
  context: ScopedTenantContext,
  input: InjectDeliveryOrderInput,
): Promise<InjectDeliveryOrderResult> {
  assertDeliveryOrderInjectable({ lines: [...input.lines] });
  if (input.initialStatus === "accepted")
    assertDeliveryOrderTransition("received", "accepted");
  const tenantId = context.tenant.tenantId;
  const { now, outletId, platform } = input;

  // One platform order id at a time: the unique key would catch a race, this
  // lock turns it into the same clean DUPLICATE answer.
  await advisoryLock(
    tx,
    `delivery-order:${tenantId}:${platform}:${input.externalOrderId}`,
  );
  if (
    !input.existing &&
    (await findByExternalId(tx, tenantId, platform, input.externalOrderId))
  )
    throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
  if (input.existing && input.existing.orderId !== null)
    throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
  const [manualTwin] = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.tenantId, tenantId),
        eq(posOrders.outletId, outletId),
        eq(posOrders.channel, platform),
        eq(posOrders.externalRef, input.externalOrderId),
      ),
    )
    .limit(1);
  if (manualTwin) {
    // The cashier typing it twice is a duplicate; the platform's own webhook
    // for an order already rung up is linked to it.
    if (input.source !== "platform")
      throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
    return linkManualTwin(tx, context, input, manualTwin.orderId);
  }

  const outlet = await loadOutlet(tx, context, outletId);
  const businessDate = businessDateFor(outlet, now);

  // Lines carry the menu item (injectable); read name and course to print.
  const lines = input.lines.map((line) => {
    if (line.menuItemId === null)
      throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
    return { ...line, menuItemId: line.menuItemId };
  });
  const menu = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      course: menuItems.course,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        inArray(menuItems.id, [...new Set(lines.map((l) => l.menuItemId))]),
      ),
    );
  const menuById = new Map(menu.map((item) => [item.id, item]));
  if (lines.some((line) => !menuById.has(line.menuItemId)))
    throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
  // 1269 F0: last door for a line stored as matched before the shower closed.
  const closedShower = await closedShowerMenuItemIds(
    tx,
    tenantId,
    outletId,
    lines.map((line) => line.menuItemId),
  );
  if (closedShower.size > 0)
    throw new FacilityError("FACILITY_SHOWER_DISABLED");

  // The platform already took the customer's money, so a daily limit reached
  // here cannot refuse the order: the sale is counted (a denied reservation
  // writes nothing) and the sold-out sync stops the next one.
  for (const line of lines)
    await reserveMenuItemDailyLimit(tx, context, {
      outletId,
      menuItemId: line.menuItemId,
      businessDate,
      quantity: line.quantity,
      now,
    });

  // Pickup number: per outlet, platform and business date; a voided order
  // keeps its number, so it is never handed out twice.
  await advisoryLock(
    tx,
    `delivery-pickup:${tenantId}:${outletId}:${platform}:${businessDate}`,
  );
  const [issued] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        eq(orders.channel, platform),
        eq(orders.businessDate, businessDate),
      ),
    );
  const prefix = PLATFORM_PREFIX[platform];
  const pickupNumber = `${prefix}-${String(Number(issued?.count ?? 0) + 1).padStart(3, "0")}`;

  const orderId = createUlid(now.getTime());
  const modifiersTotal = (line: DeliveryOrderLine) =>
    line.modifiers.reduce((sum, modifier) => sum + modifier.priceIdr, 0);
  const itemRows = lines.map((line, index) => ({
    id: createUlid(now.getTime() + index + 1),
    line,
    menu: menuById.get(line.menuItemId)!,
  }));
  const subtotal = itemRows.reduce(
    (sum, { line }) =>
      sum + (line.unitPriceIdr + modifiersTotal(line)) * line.quantity,
    0,
  );
  const [order] = await tx
    .insert(orders)
    .values({
      id: orderId,
      tenantId,
      outletId,
      number: `${prefix}${businessDate.replaceAll("-", "").slice(2)}-${orderId.slice(-8)}`,
      channel: platform,
      serviceType: "delivery",
      tableSessionId: null,
      customerProfileId: null,
      externalRef: input.externalOrderId,
      // Platform-paid: nothing is captured here, the kitchen fires at once.
      paymentMode: "open_bill",
      subtotalIdr: idr(subtotal),
      discountIdr: idr(0),
      serviceChargeIdr: idr(0),
      taxIdr: idr(0),
      roundingIdr: idr(0),
      totalIdr: idr(subtotal),
      depositAppliedIdr: idr(0),
      status: "sent",
      businessDate,
      taxResult: null,
      note: input.customerNote?.slice(0, 200) ?? null,
      createdBy: input.actorUserId,
      placedAt: now,
      firedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!order) throw new Error("Delivery order insert returned no row");
  await tx.insert(posOrders).values({
    orderId,
    tenantId,
    outletId,
    channel: platform,
    externalRef: input.externalOrderId,
    deviceId: null,
    cashierId: input.actorUserId,
    holdItems: false,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  // HPP per line at sale time; null = unknown (never 0).
  const toNullableIdr = (value: number | null | undefined) =>
    value == null ? null : idr(value);
  const costSnapshots = await computeLineCostSnapshots(
    tx,
    context,
    outletId,
    itemRows.map(({ line }) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      // Platform modifiers carry no menu ids, so they add no recipe cost.
      modifierIds: [],
      quantity: line.quantity,
    })),
  );
  await tx.insert(orderItems).values(
    itemRows.map(({ id, line, menu: item }, index) => ({
      id,
      tenantId,
      outletId,
      orderId,
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      // Our menu name on the ticket; the platform's name stays on the delivery row.
      name: item.name,
      quantity: line.quantity,
      unitPriceIdr: idr(line.unitPriceIdr),
      modifiersTotalIdr: idr(modifiersTotal(line)),
      lineTotalIdr: idr(
        (line.unitPriceIdr + modifiersTotal(line)) * line.quantity,
      ),
      // Platform modifiers have no menu ids, so they are not stored as
      // snapshots; their names print on the ticket through the note and their
      // price is in modifiersTotalIdr (the delivery row keeps the full list).
      modifiers: [],
      costSnapshotIdr: toNullableIdr(costSnapshots[index]),
      note: kitchenNote(line),
      course: item.course,
      fireStatus: "fired" as const,
      status: "queued" as const,
      reservedBusinessDate: businessDate,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await tx.insert(posOrderItems).values(
    itemRows.map(({ id }) => ({
      itemId: id,
      tenantId,
      outletId,
      orderId,
      heldByCashier: false,
      firedAt: now,
      createdAt: now,
      updatedAt: now,
    })),
  );

  // Fire to the KDS exactly like POS/QR fire, in this same transaction. A
  // platform order is already paid: a line whose station cannot be resolved
  // never fails it; it is fired without a ticket and audited
  // (`kitchen_ticket.unrouted`).
  const routed = await routeFiredItemsToKitchen(tx, context, {
    outletId,
    orderId,
    itemIds: itemRows.map(({ id }) => id),
    actor: input.actorUserId
      ? { userId: input.actorUserId, deviceId: null }
      : null,
    now,
    onUnresolved: "skip",
  });
  if (routed.unroutedItemIds.length > 0)
    logger.warn(
      {
        orderId,
        outletId,
        platform,
        unroutedCount: routed.unroutedItemIds.length,
      },
      "Delivery injection: items have no KDS station and were fired without a ticket",
    );
  const acceptedAt = input.initialStatus === "accepted" ? now : null;
  const stored = {
    orderId,
    pickupNumber,
    status: input.initialStatus,
    source: input.source,
    grossIdr: idr(input.grossIdr),
    commissionIdr: idr(input.commissionIdr),
    payloadHash: input.payloadHash,
    ...seenFields(input),
    customerNote: input.customerNote,
    lines: [...input.lines],
    acceptedAt,
    updatedAt: now,
  };
  const [row] = input.existing
    ? await tx
        .update(deliveryChannelOrders)
        .set({ ...stored, version: sql`${deliveryChannelOrders.version} + 1` })
        .where(
          and(
            eq(deliveryChannelOrders.tenantId, tenantId),
            eq(deliveryChannelOrders.id, input.existing.id),
          ),
        )
        .returning()
    : await tx
        .insert(deliveryChannelOrders)
        .values({
          tenantId,
          outletId,
          platform,
          externalOrderId: input.externalOrderId,
          ...stored,
          receivedAt: now,
          createdAt: now,
        })
        .returning();
  if (!row) throw new Error("Delivery channel order insert returned no row");

  const caller = input.actorUserId
    ? { userId: input.actorUserId, deviceId: null }
    : null;
  await appendOrderEvent(tx, context, {
    order,
    type: "order.created",
    payload: {
      channel: platform,
      serviceType: "delivery",
      itemCount: itemRows.length,
      totalIdr: subtotal,
      externalRef: input.externalOrderId,
      holdItems: false,
    },
    caller,
    now,
  });
  await appendOrderEvent(tx, context, {
    order,
    type: "order.fired",
    payload: {
      itemIds: itemRows.map(({ id }) => id),
      course: null,
      status: "sent",
    },
    caller,
    now,
  });
  // POS contract event for downstream consumers (cloud-sync, reports), the
  // same one a POS submit emits (`order.placed` is the QR channel's event,
  // shared/qr-order/events.ts). It is NOT what builds KDS tickets: those were
  // routed synchronously above (`routeFiredItemsToKitchen`).
  await appendPosEvent(tx, context, "order.submitted", {
    order,
    payload: {
      orderId,
      outletId,
      businessDate,
      channel: platform,
      serviceType: "delivery",
      status: "awaiting_payment",
      itemCount: Math.max(1, Math.min(999, itemRows.length)),
      totalIdr: subtotal,
      shiftId: null,
      deviceId: null,
      submittedBy: input.actorUserId,
      submittedAt: now.toISOString(),
    },
    caller,
    now,
  });
  if (!input.existing)
    await appendDeliveryEvent(tx, context, "delivery_order.received", {
      deliveryOrderId: row.id,
      outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform,
        externalOrderId: input.externalOrderId,
        orderId,
        source: input.source,
        grossIdr: input.grossIdr,
        commissionIdr: input.commissionIdr,
        payloadHash: input.payloadHash,
      },
      actorUserId: input.actorUserId,
      now,
    });
  await auditPos(
    tx,
    context,
    {
      action: "delivery_order.injected",
      order: order as OrderRow,
      caller,
      before: null,
      after: {
        id: orderId,
        number: order.number,
        status: "sent",
        channel: platform,
        serviceType: "delivery",
        totalIdr: subtotal,
        itemCount: itemRows.length,
        source: input.source,
      },
    },
    now,
  );
  if (input.initialStatus === "accepted")
    await appendDeliveryEvent(tx, context, "delivery_order.status_changed", {
      deliveryOrderId: row.id,
      outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform,
        externalOrderId: input.externalOrderId,
        orderId,
        from: "received",
        to: "accepted",
        action: null,
      },
      actorUserId: input.actorUserId,
      now,
    });

  return {
    deliveryOrderId: row.id,
    orderId,
    pickupNumber,
    row,
    needsReview: false,
  };
}

/** Replay-detection columns of a write of `input` (see delivery-ingest). */
function seenFields(input: InjectDeliveryOrderInput) {
  return {
    seenPayloadHashes: withSeenHash(
      input.existing?.seenPayloadHashes ?? [],
      input.payloadHash,
    ),
    lastSignedAt: latestSignedAt(
      input.existing?.lastSignedAt ?? null,
      input.signedAt ?? null,
    ),
  };
}

/**
 * Stores the platform's delivery row for an order the cashier already rang up
 * at the POS with this platform number: linked to that order, which keeps its
 * own lines, number and kitchen state. Nothing is fired a second time.
 *
 * A twin the cashier already voided is not linked: the row is stored with
 * `order_id` null (needs_review, never auto-accepted) so staff decide whether
 * the platform order is cooked again or turned down.
 */
async function linkManualTwin(
  tx: Tx,
  context: ScopedTenantContext,
  input: InjectDeliveryOrderInput,
  twinOrderId: string,
): Promise<InjectDeliveryOrderResult> {
  const tenantId = context.tenant.tenantId;
  const { now, outletId, platform } = input;
  const [order] = await tx
    .select({ number: orders.number, status: orders.status })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, twinOrderId)))
    .limit(1);
  if (!order) throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
  const needsReview = order.status === "voided";
  const orderId = needsReview ? null : twinOrderId;
  const pickupNumber = needsReview ? null : order.number;
  const status = needsReview ? "received" : input.initialStatus;
  const stored = {
    orderId,
    pickupNumber,
    status,
    source: input.source,
    grossIdr: idr(input.grossIdr),
    commissionIdr: idr(input.commissionIdr),
    payloadHash: input.payloadHash,
    ...seenFields(input),
    customerNote: input.customerNote,
    lines: [...input.lines],
    acceptedAt: status === "accepted" ? now : null,
    updatedAt: now,
  };
  const [row] = input.existing
    ? await tx
        .update(deliveryChannelOrders)
        .set({ ...stored, version: sql`${deliveryChannelOrders.version} + 1` })
        .where(
          and(
            eq(deliveryChannelOrders.tenantId, tenantId),
            eq(deliveryChannelOrders.id, input.existing.id),
          ),
        )
        .returning()
    : await tx
        .insert(deliveryChannelOrders)
        .values({
          tenantId,
          outletId,
          platform,
          externalOrderId: input.externalOrderId,
          ...stored,
          receivedAt: now,
          createdAt: now,
        })
        .returning();
  if (!row) throw new Error("Delivery channel order link returned no row");
  if (!input.existing)
    await appendDeliveryEvent(tx, context, "delivery_order.received", {
      deliveryOrderId: row.id,
      outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform,
        externalOrderId: input.externalOrderId,
        orderId,
        source: input.source,
        grossIdr: input.grossIdr,
        commissionIdr: input.commissionIdr,
        payloadHash: input.payloadHash,
      },
      actorUserId: input.actorUserId,
      now,
    });
  if (status === "accepted")
    await appendDeliveryEvent(tx, context, "delivery_order.status_changed", {
      deliveryOrderId: row.id,
      outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform,
        externalOrderId: input.externalOrderId,
        orderId,
        from: "received",
        to: "accepted",
        action: null,
      },
      actorUserId: input.actorUserId,
      now,
    });
  return { deliveryOrderId: row.id, orderId, pickupNumber, row, needsReview };
}

/**
 * Voids the lines of a cancelled or rejected delivery order that the kitchen
 * has not started, once each, in the caller's transaction (D4 staff step and
 * the platform's own cancel): POS line `voided`, daily limit released, KDS
 * ticket line voided (ticket cancelled once empty). A line whose KDS ticket
 * line is already in progress, ready or served is left alone. The order is
 * `voided` only when no live line is left, with the same `order.voided`
 * order event and audit as a POS void. `actorUserId` null is the system
 * (platform cancel): `voided_by` stays null.
 *
 * Money already captured on the POS order (a manual POS twin the cashier took
 * payment for) is never voided here (same guard as `voidPosOrder`): nothing
 * changes, an audit entry is written and `needsReview` is returned so staff
 * settle it.
 */
export async function voidQueuedKdsLines(
  tx: Tx,
  context: ScopedTenantContext,
  row: Pick<DeliveryChannelOrderRow, "orderId">,
  input: { reason: string; actorUserId: UserId | null; now: Date },
): Promise<{ needsReview: boolean }> {
  if (row.orderId === null) return { needsReview: false };
  const tenantId = context.tenant.tenantId;
  const { now } = input;
  const caller =
    input.actorUserId === null
      ? null
      : { userId: input.actorUserId, deviceId: null };
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, row.orderId)))
    .limit(1)
    .for("update");
  if (!order || order.status === "voided" || order.status === "completed")
    return { needsReview: false };
  if (capturedIdr(await tendersOf(tx, context, order.id)) > 0) {
    await auditPos(
      tx,
      context,
      {
        action: "pos_order.delivery_cancel_needs_review",
        order,
        caller,
        before: { id: order.id, status: order.status },
        after: { id: order.id, status: order.status },
        reason: input.reason.slice(0, 500),
      },
      now,
    );
    return { needsReview: true };
  }
  // Order row first, then this order's kitchen tickets in id order: the KDS
  // void lock order (lockOrderOf, then the ticket). A start or bump holds the
  // ticket row, so no line can move to in_progress/ready between the check
  // below and the void.
  await tx
    .select({ id: kitchenTickets.id })
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, tenantId),
        eq(kitchenTickets.orderId, order.id),
      ),
    )
    .orderBy(asc(kitchenTickets.id))
    .for("update");
  // The UPDATE ... WHERE status = 'queued' RETURNING is the once-only key.
  const voided = await tx
    .update(orderItems)
    .set({
      status: "voided",
      voidReason: input.reason.slice(0, 100),
      voidedBy: input.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        eq(orderItems.status, "queued"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${kitchenTicketItems}
           WHERE ${kitchenTicketItems.tenantId} = ${orderItems.tenantId}
             AND ${kitchenTicketItems.orderItemId} = ${orderItems.id}
             AND ${kitchenTicketItems.status} IN ('in_progress', 'ready', 'served')
        )`,
      ),
    )
    .returning();
  for (const item of voided)
    await releaseMenuItemDailyLimit(tx, context, {
      outletId: order.outletId,
      menuItemId: item.menuItemId,
      businessDate: item.reservedBusinessDate,
      quantity: item.quantity,
      now,
    });
  if (voided.length > 0) {
    await tx
      .update(posOrderItems)
      .set({
        voidedAt: now,
        voidReasonNote: input.reason.slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(posOrderItems.tenantId, tenantId),
          inArray(
            posOrderItems.itemId,
            voided.map((item) => item.id),
          ),
        ),
      );
    await cancelKitchenItemsForVoidedLines(tx, context, {
      outletId: order.outletId,
      orderId: order.id,
      itemIds: voided.map((item) => item.id),
      reason: input.reason,
      actor: caller,
      now,
    });
  }
  const [live] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        sql`${orderItems.status} <> 'voided'`,
      ),
    );
  // Partial cancel (some lines already cooking): the POS order stays `sent`
  // with nothing closing it; staff review is bead legend-5d76.
  if (Number(live?.count ?? 0) > 0) return { needsReview: false };
  await tx
    .update(posOrders)
    .set({ voidReasonNote: input.reason.slice(0, 500), updatedAt: now })
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    );
  await tx
    .update(orders)
    .set({
      status: "voided",
      voidedAt: now,
      voidReason: input.reason.slice(0, 100),
      updatedAt: now,
    })
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
  // Same outbox event, order event and audit as voidPosOrder, so cloud sync
  // and reports drop the sale. A platform cancel has no approver
  // (`approvedBy` null is the contract's system void).
  const reasonNote = input.reason.trim().slice(0, 500);
  const payload = {
    orderId: order.id,
    outletId: order.outletId,
    businessDate: order.businessDate,
    amountIdr: order.totalIdr,
    reason: "customer_cancelled" as const,
    reasonNote: reasonNote.length >= 4 ? reasonNote : "Dibatalkan platform",
    approvedBy: input.actorUserId,
    approvalRequestId: null,
    overrideId: null,
    voidedFinalOrder: false,
    voidId: null,
    receiptNumber: null,
    voidedAt: now.toISOString(),
  };
  await appendPosEvent(tx, context, "order.voided", {
    order,
    payload,
    caller,
    now,
  });
  await appendOrderEvent(tx, context, {
    order,
    type: "order.voided",
    payload,
    caller,
    now,
  });
  await auditPos(
    tx,
    context,
    {
      action: "pos_order.voided",
      order,
      caller,
      before: { id: order.id, status: order.status, totalIdr: order.totalIdr },
      after: {
        id: order.id,
        status: "voided",
        itemCount: voided.length,
        reason: input.reason.slice(0, 100),
      },
      reason: input.reason.slice(0, 500),
    },
    now,
  );
  return { needsReview: false };
}
