// Cloud ingest of an edge-paid POS order and its void (bead legend-771dl,
// design docs/design/edge-order-ingest.md v2). `order.paid` / `order.voided`
// are parked by edge/deferred-event-applier.ts; the parked hooks in
// edge/order-edge-applier.ts call this module so a sale paid on an offline
// edge becomes a cloud `orders` row (sales metrics, receipt-run merge).
//
// Hard rules (architect review):
//  R1 Parking is never undone: after parking, ingest NEVER throws. All writes
//     run in their own savepoint; every error (refusal, CoreError, SQL 23xxx)
//     is caught and recorded in `edge_order_ingests` as `refused` + a reason
//     code, with a warning log (event id only, no payload).
//  R2 Every amount comes from the payload: nothing is computed, rounded or
//     priced here.
//  R3 No side effects of a cloud sale: no outbox, deduction, journal, loyalty,
//     receipt number or `pos_receipts` row.
//  R4 One lock key for order paid, void and cost recompute (`lockOrderSource`).
import { and, eq, sql } from "drizzle-orm";
import { createUlid, idr, type TenantId } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  orderPaidPayloadSchema,
  orderVoidedPayloadSchema,
  type OrderPaidPayload,
  type OrderVoidedPayload,
} from "@starter/shared/pos";
import {
  edgeOrderIngests,
  type EdgeOrderIngestState,
} from "../db/schema/edge-order-ingest.ts";
import {
  posOrderItems,
  posOrderRefunds,
  posOrderTenders,
  posOrderVoids,
  posOrders,
} from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { logger } from "../lib/logger.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Source type of the order advisory lock (shared with the cost recompute). */
const ORDER_SOURCE_TYPE = "order";

/** Channels both `orders` and `pos_orders` accept (qr / facility are not POS). */
const INGEST_CHANNELS: ReadonlySet<string> = new Set([
  "pos",
  "captain",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
  "kiosk",
]);

/**
 * R4: the one advisory lock of an order, the same key the stock row insert
 * (inventory.service.ts lockStockSource) takes. `orderDbId` is the id after
 * `sourceIdToDb`.
 */
export async function lockOrderSource(
  tx: EdgeTx,
  tenantId: TenantId,
  orderDbId: string,
): Promise<void> {
  const lockKey =
    `stock-source:${tenantId}:${ORDER_SOURCE_TYPE}:${orderDbId}`.toLowerCase();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

/** A refusal decided by this module; carries the recorded reason code. */
class IngestRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** SQLSTATE of a driver error (direct or wrapped as `cause`), else null. */
function sqlStateOf(error: unknown): string | null {
  const err = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof err?.code === "string" ? err.code : err?.cause?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function reasonOf(error: unknown): string {
  if (error instanceof IngestRefusal) return error.code;
  const state = sqlStateOf(error);
  return state ? `db_error:${state}` : "error";
}

function sameOrder(a: string, b: string): boolean {
  return sourceIdToDb(a).toLowerCase() === sourceIdToDb(b).toLowerCase();
}

/** Inserts the ledger row; false when a row for the order already exists. */
async function insertLedger(
  tx: EdgeTx,
  row: {
    tenantId: TenantId;
    orderId: string;
    outletId: NonNullable<EventEnvelope["outletId"]>;
    paidEventId: string;
    state: EdgeOrderIngestState;
    reason?: string | null;
    voidEventId?: string | null;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(edgeOrderIngests)
    .values({
      tenantId: row.tenantId,
      orderId: row.orderId,
      outletId: row.outletId,
      paidEventId: row.paidEventId,
      state: row.state,
      reason: row.reason ?? null,
      voidEventId: row.voidEventId ?? null,
    })
    .onConflictDoNothing({
      target: [edgeOrderIngests.tenantId, edgeOrderIngests.orderId],
    })
    .returning({ orderId: edgeOrderIngests.orderId });
  return inserted.length > 0;
}

/** Runs `work` in its own savepoint and swallows (but logs) any failure. */
async function bestEffort(
  tx: EdgeTx,
  eventId: string,
  reason: string,
  work: (sp: EdgeTx) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction((sp) => work(sp));
  } catch {
    // The refusal itself could not be recorded; the parked row is the
    // durable evidence. Event id and reason code only (ports.ts rule).
    logger.warn(
      { eventId, reason },
      "Edge order ingest refusal could not be recorded",
    );
  }
}

// ---- order.paid -----------------------------------------------------------

/**
 * Ingests a parked `order.paid` into the cloud order tables. Never throws
 * after the caller parked the event (R1). The caller must be inside the edge
 * link's receive transaction.
 */
export async function ingestEdgeOrderPaid(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = event.outletId;
  const parsed = orderPaidPayloadSchema.safeParse(event.payload);
  if (!outletId || !parsed.success) {
    logger.warn({ eventId: event.id }, "Edge order.paid not ingestable");
    return;
  }
  const payload = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  // R4: one lock for paid, void and cost recompute of this order.
  await lockOrderSource(tx, tenantId, sourceIdToDb(payload.orderId));
  try {
    await tx.transaction((sp) =>
      applyPaid(sp, tenantId, outletId, event, payload),
    );
  } catch (error) {
    const reason = reasonOf(error);
    logger.warn({ eventId: event.id, reason }, "Edge order.paid refused");
    await bestEffort(tx, event.id, reason, (sp) =>
      insertLedger(sp, {
        tenantId,
        orderId: payload.orderId,
        outletId,
        paidEventId: event.id,
        state: "refused",
        reason,
      }),
    );
  }
}

async function applyPaid(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: NonNullable<EventEnvelope["outletId"]>,
  event: EventEnvelope,
  payload: OrderPaidPayload,
): Promise<void> {
  // 1. The aggregate and the payload must name the same order and outlet.
  if (
    !sameOrder(event.aggregateId, payload.orderId) ||
    payload.outletId.toLowerCase() !== outletId.toLowerCase()
  )
    throw new IngestRefusal("aggregate_mismatch");

  // 2. Replay guard: a ledger row (any state) means this order was handled.
  const claimed = await insertLedger(tx, {
    tenantId,
    orderId: payload.orderId,
    outletId,
    paidEventId: event.id,
    state: "ingested",
  });
  if (!claimed) return;

  // 3. Refusals (the savepoint rolls the claim back; the caller records it).
  const { lines, subtotalIdr, orderNumber, paymentMode, pricesIncludeTax } =
    payload;
  if (
    lines === undefined ||
    subtotalIdr === undefined ||
    orderNumber === undefined ||
    paymentMode === undefined ||
    pricesIncludeTax === undefined
  )
    throw new IngestRefusal("legacy_payload");
  if (!INGEST_CHANNELS.has(payload.channel))
    throw new IngestRefusal("channel_unsupported");
  const [existing] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, payload.orderId)));
  if (existing) throw new IngestRefusal("order_exists");
  // The cloud checks, never computes: lines must be internally consistent
  // and sum to the payload subtotal (void lines excluded).
  let linesTotal = 0;
  for (const line of lines) {
    if (
      Number(line.lineTotalIdr) !==
      (Number(line.unitPriceIdr) + Number(line.modifiersTotalIdr)) *
        line.quantity
    )
      throw new IngestRefusal("lines_mismatch");
    if (line.status !== "voided") linesTotal += Number(line.lineTotalIdr);
  }
  if (linesTotal !== Number(subtotalIdr))
    throw new IngestRefusal("lines_mismatch");
  // 5. Money invariant: tenders plus the deposit settle the total exactly.
  const tendered = payload.tenders.reduce(
    (sum, tender) => sum + Number(tender.amountIdr),
    0,
  );
  if (tendered + Number(payload.paidDepositIdr) !== Number(payload.totalIdr))
    throw new IngestRefusal("money_mismatch");
  for (const tender of payload.tenders) {
    if (tender.method === "points" && tender.pointsUsed === undefined)
      throw new IngestRefusal("tender_invalid");
    if (
      tender.method === "cash" &&
      tender.receivedIdr !== undefined &&
      Number(tender.receivedIdr) < Number(tender.amountIdr)
    )
      throw new IngestRefusal("tender_invalid");
  }

  // 4. Writes.
  const paidAt = new Date(payload.paidAt);
  await tx.insert(orders).values({
    id: payload.orderId,
    tenantId,
    outletId,
    number: orderNumber,
    channel: payload.channel,
    serviceType: payload.serviceType,
    paymentMode,
    subtotalIdr,
    discountIdr: payload.discountIdr,
    serviceChargeIdr: payload.serviceChargeIdr,
    taxIdr: payload.pbjtIdr,
    roundingIdr: payload.roundingIdr,
    totalIdr: payload.totalIdr,
    pricesIncludeTax,
    depositAppliedIdr: payload.paidDepositIdr,
    status: "completed",
    businessDate: payload.businessDate,
    placedAt: paidAt,
  });
  await tx.insert(posOrders).values({
    orderId: payload.orderId,
    tenantId,
    outletId,
    channel: payload.channel,
    // Plain value: no FK, so an edge shift unknown to the cloud is fine.
    shiftId: payload.shiftId,
    deviceId: payload.deviceId,
    cashierId: payload.cashierId,
    isTraining: payload.isTraining ?? false,
    completedAt: paidAt,
  });
  const itemBase = paidAt.getTime();
  for (const [index, line] of lines.entries()) {
    const itemId = createUlid(itemBase + index);
    await tx.insert(orderItems).values({
      id: itemId,
      tenantId,
      outletId,
      orderId: payload.orderId,
      menuItemId: line.menuItemId,
      name: line.name,
      quantity: line.quantity,
      unitPriceIdr: line.unitPriceIdr,
      modifiersTotalIdr: line.modifiersTotalIdr,
      lineTotalIdr: line.lineTotalIdr,
      fireStatus: line.fireStatus,
      status: line.status,
      reservedBusinessDate: line.reservedBusinessDate,
    });
    await tx.insert(posOrderItems).values({
      itemId,
      tenantId,
      outletId,
      orderId: payload.orderId,
      heldByCashier: line.fireStatus === "held",
    });
  }
  for (const tender of payload.tenders) {
    const cash = tender.method === "cash";
    const received = cash
      ? Number(tender.receivedIdr ?? tender.amountIdr)
      : null;
    await tx.insert(posOrderTenders).values({
      tenantId,
      outletId,
      orderId: payload.orderId,
      method: tender.method,
      provider: providerOf(tender.method),
      amountIdr: tender.amountIdr,
      receivedIdr: received === null ? null : idr(received),
      changeIdr:
        received === null ? null : idr(received - Number(tender.amountIdr)),
      pointsUsed: tender.method === "points" ? tender.pointsUsed : null,
      status: "captured",
      requestedAt: paidAt,
      resolvedAt: paidAt,
      // Always NULL: FK `pos_order_tenders_shift_fk`, and edge cash must not
      // enter a cloud drawer.
      shiftId: null,
    });
  }
}

/** `pos_order_tenders.provider` of a payload tender method. */
function providerOf(method: string): "doit" | "edc" | "manual" {
  if (method === "cash" || method === "points") return "manual";
  if (method === "edc_card" || method === "edc_qris") return "edc";
  return "doit";
}

// ---- order.voided ---------------------------------------------------------

/**
 * Ingests a parked `order.voided`. Never throws after the caller parked the
 * event (R1). A non-final void records `cancelled` and creates nothing; a
 * final-sale void inserts exactly one `pos_order_voids` row.
 */
export async function ingestEdgeOrderVoided(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = event.outletId;
  const parsed = orderVoidedPayloadSchema.safeParse(event.payload);
  if (!outletId || !parsed.success) {
    logger.warn({ eventId: event.id }, "Edge order.voided not ingestable");
    return;
  }
  const payload = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  await lockOrderSource(tx, tenantId, sourceIdToDb(payload.orderId));
  try {
    await tx.transaction((sp) =>
      applyVoided(sp, tenantId, outletId, event, payload),
    );
  } catch (error) {
    const reason = reasonOf(error);
    logger.warn({ eventId: event.id, reason }, "Edge order.voided refused");
    // The ledger row of the paid order stays as it is (state untouched); the
    // refusal is noted on it. A void with no ledger row has nowhere to be
    // recorded (paid_event_id is NOT NULL): the warning above is the record.
    await bestEffort(tx, event.id, reason, async (sp) => {
      await sp
        .update(edgeOrderIngests)
        .set({ reason: `void_refused:${reason}`, updatedAt: new Date() })
        .where(
          and(
            eq(edgeOrderIngests.tenantId, tenantId),
            eq(edgeOrderIngests.orderId, payload.orderId),
            sql`${edgeOrderIngests.state} IN ('ingested', 'voided')`,
          ),
        );
    });
  }
}

async function applyVoided(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: NonNullable<EventEnvelope["outletId"]>,
  event: EventEnvelope,
  payload: OrderVoidedPayload,
): Promise<void> {
  if (
    !sameOrder(event.aggregateId, payload.orderId) ||
    payload.outletId.toLowerCase() !== outletId.toLowerCase()
  )
    throw new IngestRefusal("aggregate_mismatch");

  const [ledger] = await tx
    .select({
      state: edgeOrderIngests.state,
      voidEventId: edgeOrderIngests.voidEventId,
    })
    .from(edgeOrderIngests)
    .where(
      and(
        eq(edgeOrderIngests.tenantId, tenantId),
        eq(edgeOrderIngests.orderId, payload.orderId),
      ),
    );

  if (!payload.voidedFinalOrder) {
    // The order was never paid: nothing to create. `paid_event_id` holds this
    // void event's id (there is no paid event); a cancelled order is never
    // paid later, so the replay guard cannot swallow a sale.
    if (ledger) return;
    await insertLedger(tx, {
      tenantId,
      orderId: payload.orderId,
      outletId,
      paidEventId: event.id,
      state: "cancelled",
      voidEventId: event.id,
    });
    return;
  }

  if (!ledger) throw new IngestRefusal("order_not_ingested");
  if (ledger.voidEventId === event.id) return; // replay
  if (ledger.state === "voided") throw new IngestRefusal("already_voided");
  if (ledger.state !== "ingested")
    throw new IngestRefusal("order_not_ingested");

  const [order] = await tx
    .select({ totalIdr: orders.totalIdr, status: orders.status })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, payload.orderId)));
  const [pos] = await tx
    .select({ cashierId: posOrders.cashierId })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.tenantId, tenantId),
        eq(posOrders.orderId, payload.orderId),
      ),
    );
  if (!order || !pos || order.status !== "completed")
    throw new IngestRefusal("order_not_ingested");
  const [voided] = await tx
    .select({ id: posOrderVoids.id })
    .from(posOrderVoids)
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.orderId, payload.orderId),
      ),
    );
  if (voided) throw new IngestRefusal("already_voided");
  const [refund] = await tx
    .select({ id: posOrderRefunds.id })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.orderId, payload.orderId),
      ),
    );
  if (refund) throw new IngestRefusal("refund_exists");

  const total = Number(order.totalIdr);
  if (total <= 0 || Number(payload.amountIdr) !== total)
    throw new IngestRefusal("void_amount_mismatch");

  // Older events carry no `requestedBy`: fall back to the order's cashier,
  // which must differ from the approver (table check).
  const requestedBy = payload.requestedBy ?? pos.cashierId;
  const approvedBy = payload.approvedBy;
  if (
    !requestedBy ||
    !approvedBy ||
    requestedBy.toLowerCase() === approvedBy.toLowerCase()
  )
    throw new IngestRefusal("void_actor_missing");
  if (
    payload.voidId === null ||
    payload.receiptNumber === null ||
    (payload.overrideId === null && payload.approvalRequestId === null)
  )
    throw new IngestRefusal("void_approval_missing");

  await tx.insert(posOrderVoids).values({
    id: payload.voidId,
    tenantId,
    outletId,
    orderId: payload.orderId,
    receiptNumber: payload.receiptNumber,
    amountIdr: payload.amountIdr,
    reason: payload.reason,
    reasonNote: payload.reasonNote,
    requestedBy,
    approvedBy,
    approvalRequestId: payload.approvalRequestId,
    overrideId: payload.overrideId,
    voidedAt: new Date(payload.voidedAt),
    // Edge cash never enters a cloud drawer.
    shiftId: null,
    needsApproval: false,
  });
  // `pos_orders.void_*` (trigger-blocked) and `orders.status` stay as they
  // are, like a cloud-native correction void.
  await tx
    .update(edgeOrderIngests)
    .set({ state: "voided", voidEventId: event.id, updatedAt: new Date() })
    .where(
      and(
        eq(edgeOrderIngests.tenantId, tenantId),
        eq(edgeOrderIngests.orderId, payload.orderId),
      ),
    );
}
