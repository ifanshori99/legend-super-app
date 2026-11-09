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
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { domainEventOutbox, menuItems } from "../db/schema/index.ts";
import { deliveryChannelOrders } from "../db/schema/delivery.ts";
import { posOrderItems, posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  findByExternalId,
  type DeliveryChannelOrderRow,
} from "./delivery-store.ts";
import { reserveMenuItemDailyLimit } from "./menu-availability.ts";
import { uniqueViolationOf } from "./pos-shift-support.ts";
import type { Tx } from "./menu-internals.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
  businessDateFor,
  loadOutlet,
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
  /** Every line must be matched, price_mismatch or sold_out (injectable). */
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
  orderId: string;
  pickupNumber: string;
  /** The stored row, as inserted. */
  row: DeliveryChannelOrderRow;
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
export function withSeenHash(
  seen: readonly string[],
  hash: string,
): string[] {
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
  await tx.insert(orderItems).values(
    itemRows.map(({ id, line, menu: item }) => ({
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

  // TODO(legend-5bn3, wire after milestone/m1 is merged into this branch): fire
  // the lines to the KDS exactly like POS/QR fire, in this same transaction.
  // Signature on milestone/m1 (apps/api/src/services/kds.service.ts):
  //
  //   import { routeFiredItemsToKitchen } from "./kds.service.ts";
  //   await routeFiredItemsToKitchen(tx, context, {
  //     outletId,
  //     orderId,
  //     itemIds: itemRows.map(({ id }) => id),
  //     actor: input.actorUserId
  //       ? { userId: input.actorUserId, deviceId: null }
  //       : null,
  //     now,
  //     // A platform order is already paid: never fail it on a missing station.
  //     onUnresolved: "skip",
  //   });
  //
  // Until then the order exists in `orders`/`order_items` (status sent, lines
  // fired) but has no kitchen ticket. The KDS test "ticket exists after
  // injection" goes with this call.
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
  // POS contract event for downstream consumers (cloud-sync, reports). It is
  // NOT what builds KDS tickets: the KDS routes fired lines synchronously
  // (kds.service `routeFiredItemsToKitchen`, called from POS/QR fire in the
  // same transaction), and that module is not in this branch yet. See the
  // report of legend-5bn3 D3: the call belongs right here once KDS merges.
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

  return { deliveryOrderId: row.id, orderId, pickupNumber, row };
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
 */
async function linkManualTwin(
  tx: Tx,
  context: ScopedTenantContext,
  input: InjectDeliveryOrderInput,
  orderId: string,
): Promise<InjectDeliveryOrderResult> {
  const tenantId = context.tenant.tenantId;
  const { now, outletId, platform } = input;
  const [order] = await tx
    .select({ number: orders.number })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  if (!order) throw new DeliveryError("DELIVERY_ORDER_DUPLICATE");
  const pickupNumber = order.number;
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
    acceptedAt: input.initialStatus === "accepted" ? now : null,
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
  return { deliveryOrderId: row.id, orderId, pickupNumber, row };
}
