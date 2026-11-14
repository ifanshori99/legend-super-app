// Delivery channel orders API (bead legend-5bn3, slice D4; PRD v1.7 §3.23
// "Integrasi Ojek Online", Alur G, D12; contract @starter/shared/delivery
// endpoints.ts). The ops screen lists the orders the webhook (D3) imported,
// records a manual order (D12 "Mode Manual") and moves an order along the
// fulfilment machine.
//
// - Every status step goes through `assertDeliveryOrderTransition` and
//   `deliveryActionForTransition` (contract machines.ts); the order row is
//   locked FOR UPDATE first, so two clicks or a click and a webhook replay
//   never interleave.
// - A platform order stores the mapped adapter action (`accept_order`,
//   `update_order`, `cancel_order`) as the `action` of its status event
//   (legend-bk99). The outbox consumer pushes it after the commit
//   (delivery-sync-consumer.ts); the adapter reference `<order id>:<status>`
//   makes a retry idempotent. A platform that is down no longer rolls the
//   step back: the consumer retries, and a clear refusal is recorded as a
//   `delivery_order.platform_desync` audit entry for reconciliation.
//   Manual orders live only in our POS: no adapter call.
// - A platform order the webhook kept for review (`order_id` null, never on
//   the KDS) can only be rejected or cancelled; it is never moved forward.
// - A cancel or reject before the kitchen cooks voids the queued KDS lines the
//   way a POS void does (line `voided`, daily limit released once, order
//   `voided` when no live line is left). Lines already cooking are left alone.
// - A manual order reuses D3's `injectDeliveryOrder`; prices come from the
//   platform price list, never from the client. It shares the unique
//   `pos_orders.external_ref` guard with the manual-ojol POS path
//   (pos-order.service.ts createPosOrder): either path refuses the other's
//   duplicate.
// - `Idempotency-Key` (optional header) is stored through `posIdempotent`
//   with the operation name and the order as target.
import { assertCatalogSalesAllowed } from "../edge/sales-gate.ts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
  toIsoDateTime,
  type UserId,
  z,
} from "@starter/shared/core";
import {
  assertDeliveryOrderInjectable,
  assertDeliveryOrderTransition,
  deliveryActionForTransition,
  deliveryEvents,
  DeliveryError,
  type CreateManualDeliveryOrderInput,
  type DeliveryAction,
  type DeliveryChannelOrder,
  type DeliveryOrderLine,
  type DeliveryOrderStatus,
  type ListDeliveryOrdersQuery,
  type UpdateDeliveryOrderStatusInput,
} from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import {
  deliveryChannelOrders,
  deliveryChannels,
} from "../db/schema/delivery.ts";
import { domainEventOutbox } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { injectDeliveryOrder, voidQueuedKdsLines } from "./delivery-inject.ts";
import {
  evaluatePacingIfStale,
  isLinePaused,
  readPausedMenuLines,
} from "./kds-pacing.service.ts";
import {
  lockDeliveryOrder,
  toDeliveryChannelOrder,
  type DeliveryChannelOrderRow,
} from "./delivery-store.ts";
import type { Tx } from "./menu-internals.ts";
import {
  businessDateFor,
  loadOutlet,
  posIdempotent,
  sha256,
} from "./pos-order-support.ts";
import { loadPosCatalogue, resolveLine } from "./pos-order-pricing.ts";

const EVENT_DESTINATION = "cloud-sync";

function orderNotFound(): DeliveryError {
  return new DeliveryError("DELIVERY_ORDER_NOT_FOUND");
}

/** Runs `run` once per Idempotency-Key (same key + same request = same response). */
async function maybeIdempotent<T>(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    actorId: string;
    key: string | null;
    operation: string;
    target: string;
    request: unknown;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (input.key === null) return run();
  return posIdempotent(tx, context, { ...input, key: input.key }, run);
}

// ---- Read ------------------------------------------------------------------------

const cursorKeySchema = z.tuple([z.iso.datetime(), z.uuid()]);

/** GET .../delivery-orders: newest first, keyset paging on (received_at, id). */
export async function listDeliveryOrders(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: ListDeliveryOrdersQuery,
): Promise<CursorPage<DeliveryChannelOrder>> {
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const filters = [
      eq(deliveryChannelOrders.tenantId, tenantId),
      eq(deliveryChannelOrders.outletId, outletId),
    ];
    if (query.platform)
      filters.push(eq(deliveryChannelOrders.platform, query.platform));
    if (query.status)
      filters.push(eq(deliveryChannelOrders.status, query.status));
    // Match the staff action queue before LIMIT, so older held orders are
    // reachable without walking pages of orders that need no intervention.
    if (query.attention) {
      filters.push(sql`(
        ${deliveryChannelOrders.platformSyncState} = 'needs_action'
        OR (
          ${deliveryChannelOrders.status} = 'received'
          AND ${deliveryChannelOrders.orderId} IS NULL
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${deliveryChannelOrders.lines}) AS line(value)
            WHERE line.value->>'mapping' IN ('unmatched', 'sold_out')
          )
        )
      )`);
    }
    if (query.cursor) {
      let after: z.infer<typeof cursorKeySchema>;
      try {
        after = cursorKeySchema.parse(decodeCursor(query.cursor));
      } catch {
        throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
      }
      filters.push(
        sql`(${deliveryChannelOrders.receivedAt}, ${deliveryChannelOrders.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(deliveryChannelOrders)
      .where(and(...filters))
      .orderBy(
        desc(deliveryChannelOrders.receivedAt),
        desc(deliveryChannelOrders.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toDeliveryChannelOrder),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.receivedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET .../delivery-orders/:deliveryOrderId. */
export async function getDeliveryOrder(
  context: ScopedTenantContext,
  outletId: OutletId,
  deliveryOrderId: string,
): Promise<DeliveryChannelOrder> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(deliveryChannelOrders)
      .where(
        and(
          eq(deliveryChannelOrders.tenantId, context.tenant.tenantId),
          eq(deliveryChannelOrders.outletId, outletId),
          eq(deliveryChannelOrders.id, deliveryOrderId),
        ),
      )
      .limit(1);
    if (!row) throw orderNotFound();
    return toDeliveryChannelOrder(row);
  });
}

// ---- Manual order (D12) ------------------------------------------------------------

export type DeliveryOrderCaller = {
  readonly userId: UserId;
  /** Optional `Idempotency-Key` header, already validated. */
  readonly idempotencyKey: string | null;
};

/** The platform's commission on a gross amount, whole rupiah (half up). */
function commissionFor(grossIdr: number, rateBps: number): number {
  return Math.round((grossIdr * rateBps) / 10_000);
}

/**
 * POST .../delivery-orders/manual. The cashier records a platform order in the
 * POS: source `manual_pos`, recorded as already accepted, fired to the KDS by
 * D3's `injectDeliveryOrder`. The server prices every line from the platform's
 * channel price list and takes the commission rate from the outlet's channel
 * row (0 when the channel is not linked yet).
 */
export async function createManualDeliveryOrder(
  context: ScopedTenantContext,
  caller: DeliveryOrderCaller,
  outletId: OutletId,
  input: CreateManualDeliveryOrderInput,
  now = new Date(),
): Promise<DeliveryChannelOrder> {
  // legend-10nex: a manual order is a new sale priced from the synced catalogue.
  assertCatalogSalesAllowed();
  assertOutletInScope(context.outletScope, outletId);
  const request = input;
  // KDS-05: refresh the pause rows before the transaction, never inside it.
  await evaluatePacingIfStale(context, outletId, now);
  return withTenant(db, context, (tx) =>
    maybeIdempotent(
      tx,
      context,
      {
        outletId,
        actorId: caller.userId,
        key: caller.idempotencyKey,
        operation: "delivery_order.manual",
        target: outletId,
        request,
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        const outlet = await loadOutlet(tx, context, outletId);
        const businessDate = businessDateFor(outlet, now);
        const catalogue = await loadPosCatalogue(tx, context, {
          brandId: outlet.brandId,
          outletId,
          timeZone: outlet.timezone,
          businessDate,
          channel: input.platform,
          itemIds: input.lines.map((line) => line.menuItemId),
          now,
        });
        const paused = await readPausedMenuLines(
          tx,
          context,
          outletId,
          input.platform,
          now,
        );
        const lines: DeliveryOrderLine[] = input.lines.map((line, index) => {
          if (isLinePaused(paused, line.menuItemId, line.variantId ?? null))
            throw new CoreError(
              "CONFLICT",
              `KDS-05: menu baris ${index + 1} sedang dijeda untuk ${input.platform}`,
            );
          const item = catalogue.get(line.menuItemId);
          const resolution = resolveLine(item, {
            menuItemId: line.menuItemId,
            variantId: line.variantId ?? null,
            quantity: line.quantity,
            modifierIds: [],
          });
          if (!resolution.ok)
            throw resolution.reason === "sold_out"
              ? new CoreError(
                  "CONFLICT",
                  `Menu baris ${index + 1} sedang tidak dapat dijual di ${input.platform}.`,
                )
              : new CoreError("VALIDATION_ERROR", resolution.message);
          const unitPriceIdr = resolution.line.unitPriceIdr;
          return {
            lineNo: index + 1,
            externalItemId: null,
            externalItemName: resolution.line.name,
            menuItemId: line.menuItemId,
            variantId: line.variantId ?? null,
            quantity: line.quantity,
            unitPriceIdr,
            lineTotalIdr: idr(unitPriceIdr * line.quantity),
            modifiers: [],
            note: line.note ?? null,
            mapping: "matched",
            channelPriceIdr: unitPriceIdr,
          } satisfies DeliveryOrderLine;
        });
        const grossIdr = lines.reduce(
          (sum, line) => sum + line.lineTotalIdr,
          0,
        );
        const [channel] = await tx
          .select({ commissionRateBps: deliveryChannels.commissionRateBps })
          .from(deliveryChannels)
          .where(
            and(
              eq(deliveryChannels.tenantId, tenantId),
              eq(deliveryChannels.outletId, outletId),
              eq(deliveryChannels.platform, input.platform),
            ),
          )
          .limit(1);
        const injected = await injectDeliveryOrder(tx, context, {
          outletId,
          platform: input.platform,
          externalOrderId: input.externalOrderId,
          source: "manual_pos",
          grossIdr,
          commissionIdr: commissionFor(
            grossIdr,
            channel?.commissionRateBps ?? 0,
          ),
          payloadHash: sha256(JSON.stringify(request)),
          customerNote: input.customerNote ?? null,
          lines,
          initialStatus: "accepted",
          actorUserId: caller.userId,
          now,
        });
        return toDeliveryChannelOrder(injected.row);
      },
    ),
  );
}

// ---- Status step -------------------------------------------------------------------

async function appendStatusChangedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    row: DeliveryChannelOrderRow;
    from: DeliveryOrderStatus;
    to: DeliveryOrderStatus;
    action: DeliveryAction | null;
    actorUserId: UserId;
    now: Date;
  },
): Promise<void> {
  const definition = deliveryEvents["delivery_order.status_changed"];
  const aggregateType = definition.entry.aggregateType;
  const [last] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, input.row.id),
      ),
    );
  const sequence = Number(last?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.row.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType,
    aggregateId: input.row.id,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor: { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.row.id}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      deliveryChannelOrderId: input.row.id,
      platform: input.row.platform,
      externalOrderId: input.row.externalOrderId,
      orderId: input.row.orderId,
      from: input.from,
      to: input.to,
      action: input.action,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

function stepColumns(
  to: DeliveryOrderStatus,
  reason: string | undefined,
  now: Date,
): Partial<typeof deliveryChannelOrders.$inferInsert> {
  switch (to) {
    case "accepted":
      return { acceptedAt: now };
    case "ready":
      return { readyAt: now };
    case "picked_up":
      return { pickedUpAt: now };
    case "delivered":
      return { deliveredAt: now };
    case "cancelled":
    case "rejected":
      return { closedAt: now, closeReason: reason?.trim() ?? null };
    default:
      return {};
  }
}

/**
 * POST .../delivery-orders/:deliveryOrderId/status. Moves the order through
 * the contract machine, pushes the adapter action of a platform order and
 * voids the queued KDS lines of a cancel or reject.
 */
export async function updateDeliveryOrderStatus(
  context: ScopedTenantContext,
  caller: DeliveryOrderCaller,
  outletId: OutletId,
  deliveryOrderId: string,
  input: UpdateDeliveryOrderStatusInput,
  now = new Date(),
): Promise<DeliveryChannelOrder> {
  assertOutletInScope(context.outletScope, outletId);
  const request = input;
  return withTenant(db, context, (tx) =>
    maybeIdempotent(
      tx,
      context,
      {
        outletId,
        actorId: caller.userId,
        key: caller.idempotencyKey,
        operation: "delivery_order.status",
        target: deliveryOrderId,
        request,
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        const row = await lockDeliveryOrder(tx, tenantId, deliveryOrderId);
        if (!row || row.outletId !== outletId) throw orderNotFound();
        const from = row.status;
        const to = input.status;
        assertDeliveryOrderTransition(from, to);
        const action = deliveryActionForTransition(from, to);
        const platformOrder = row.source === "platform";

        // An order without a KDS order (kept `needs_review` by the webhook)
        // can only be turned down; moving it on would hide it from the kitchen.
        if (row.orderId === null && to !== "rejected" && to !== "cancelled") {
          assertDeliveryOrderInjectable(row);
          throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
        }

        // The store must be open on the platform to take an order in.
        if (to === "accepted" && platformOrder) {
          const [channel] = await tx
            .select({ isOpen: deliveryChannels.isOpen })
            .from(deliveryChannels)
            .where(
              and(
                eq(deliveryChannels.tenantId, tenantId),
                eq(deliveryChannels.outletId, outletId),
                eq(deliveryChannels.platform, row.platform),
              ),
            )
            .limit(1);
          if (!channel) throw new DeliveryError("DELIVERY_CHANNEL_UNKNOWN");
          if (!channel.isOpen)
            throw new DeliveryError("DELIVERY_CHANNEL_CLOSED");
        }

        const [updated] = await tx
          .update(deliveryChannelOrders)
          .set({
            status: to,
            ...stepColumns(to, input.reason, now),
            version: row.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(deliveryChannelOrders.tenantId, tenantId),
              eq(deliveryChannelOrders.id, row.id),
            ),
          )
          .returning();
        if (!updated) throw new Error("Delivery order update returned no row");

        // Before the kitchen cooks, a cancel or reject takes the order off the KDS.
        if (
          (to === "cancelled" || to === "rejected") &&
          (from === "received" || from === "accepted")
        )
          await voidQueuedKdsLines(tx, context, row, {
            reason: input.reason?.trim() ?? to,
            actorUserId: caller.userId,
            now,
          });

        await appendStatusChangedEvent(tx, context, {
          row: updated,
          from,
          to,
          action: platformOrder ? action : null,
          actorUserId: caller.userId,
          now,
        });
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId,
            actorType: "user",
            actorId: caller.userId,
            deviceId: null,
            action: "delivery_order.status_changed",
            objectType: "delivery_channel_order",
            objectId: row.id,
            reason: input.reason?.trim() ?? null,
            maskedChanges: {
              before: { platform: row.platform, status: from },
              after: { platform: row.platform, status: to },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: toIsoDateTime(now),
          },
          [],
        );

        // legend-bk99: the adapter action of a platform order is not called
        // here. The status event above carries it as a stored intent that
        // the outbox consumer pushes after this commit
        // (delivery-sync-consumer.ts), so the row lock never spans a
        // platform call and a replayed Idempotency-Key adds no second intent.
        return toDeliveryChannelOrder(updated);
      },
    ),
  );
}
