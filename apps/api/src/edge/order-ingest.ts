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
//  R3 No outbox, deduction, receipt number or `pos_receipts` row. Money side
//     effects are written here, directly, in the ingest savepoint (legend-uctlr,
//     same as a cloud sale): the PBJT `tax_snapshots` rows copied from the
//     payload `taxes` (absent or inconsistent rows never refuse the sale), the
//     sale journal and its void reversal (`deliverAutoJournalEvent`, keyed
//     `aj:sale:` / `aj:sale-void:` so a replay posts once) and the loyalty
//     earn / reversal (`deliverLoyaltyEarnEvent`, unique per order). The edge
//     event itself is the replay key; no offline point redemption exists.
//  R4 One lock key for order paid, void and cost recompute (`lockOrderSource`).
import { and, eq, sql } from "drizzle-orm";
import { hasParkedEdgeRefund } from "../services/payment-refund-edge-history.ts";
import {
  createUlid,
  idr,
  toIsoDateTime,
  ulidToUuid,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PAYMENT_GATEWAY_PROVIDERS,
  type PaymentGatewayProvider,
} from "@starter/shared/platform";
import {
  orderPaidPayloadSchema,
  orderVoidedPayloadSchema,
  type OrderPaidPayload,
  type OrderVoidedPayload,
} from "@starter/shared/pos";
import { customerProfiles } from "../db/schema/crm-member.ts";
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
import { orderIssues } from "../db/schema/kds-issues.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { logger } from "../lib/logger.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { recordAudit } from "../services/core-audit.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";
import { liveRouteManualRefundWhere } from "../services/order-issue-route-refund.ts";
import { ord09RefundExistsOf } from "../services/order-refund-lane.ts";
import { settleOrderVouchersForVoid } from "../services/order-voucher-void.ts";
import { lockLoyaltyJournalEntity } from "../services/accounting-auto-journal-amounts.ts";
import { deliverLoyaltyEarnEvent } from "../services/loyalty-earn-consumer.ts";
import { recordTaxSnapshotsFromPayload } from "../services/tax.service.ts";
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

/** True when the aggregate and the payload name the same order and outlet. */
function aggregateMatches(
  event: EventEnvelope,
  payload: { orderId: string; outletId: string },
  outletId: string,
): boolean {
  return (
    sameOrder(event.aggregateId, payload.orderId) &&
    payload.outletId.toLowerCase() === outletId.toLowerCase()
  );
}

/**
 * Takes the order lock inside the caller's savepoint. A failure (lock timeout,
 * deadlock, ...) is a `lock_failed` refusal, never a throw out of the ingest.
 */
async function lockOrThrow(
  tx: EdgeTx,
  tenantId: TenantId,
  orderId: string,
): Promise<void> {
  try {
    await lockOrderSource(tx, tenantId, sourceIdToDb(orderId));
  } catch {
    throw new IngestRefusal("lock_failed");
  }
}

/**
 * Refusal reasons that a later delivery of the same event may retry (legend-132mw):
 * only lock trouble (`lock_failed`) and the SQLSTATEs deadlock_detected 40P01,
 * lock_not_available 55P03 and serialization_failure 40001. Any other
 * `db_error:*` (23505 unique clash, ...) is final: a retry would fail the same way.
 */
export const TRANSIENT_REFUSAL_REASONS: readonly string[] = [
  "lock_failed",
  "db_error:40P01",
  "db_error:55P03",
  "db_error:40001",
];

export function isTransientReason(reason: string | null): boolean {
  return reason !== null && TRANSIENT_REFUSAL_REASONS.includes(reason);
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
  // A mismatching aggregate names no trustworthy order id: nothing is locked
  // or written to the ledger, the parked event is the only record.
  if (!aggregateMatches(event, payload, outletId)) {
    logger.warn(
      { eventId: event.id, reason: "aggregate_mismatch" },
      "Edge order.paid refused",
    );
    return;
  }
  try {
    await tx.transaction((sp) =>
      applyPaid(sp, tenantId, outletId, event, payload, meta),
    );
  } catch (error) {
    const reason = reasonOf(error);
    logger.warn({ eventId: event.id, reason }, "Edge order.paid refused");
    await bestEffort(tx, event.id, reason, async (sp) => {
      const recorded = await insertLedger(sp, {
        tenantId,
        orderId: payload.orderId,
        outletId,
        paidEventId: event.id,
        state: "refused",
        reason,
      });
      // A failed retry rolled back with its savepoint, so the old refused row
      // is still there: note the new reason on it (legend-132mw), only for
      // this very event.
      if (!recorded)
        await sp
          .update(edgeOrderIngests)
          .set({ reason, updatedAt: new Date() })
          .where(
            and(
              eq(edgeOrderIngests.tenantId, tenantId),
              eq(edgeOrderIngests.orderId, payload.orderId),
              eq(edgeOrderIngests.state, "refused"),
              eq(edgeOrderIngests.paidEventId, event.id),
            ),
          );
    });
  }
}

async function applyPaid(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: NonNullable<EventEnvelope["outletId"]>,
  event: EventEnvelope,
  payload: OrderPaidPayload,
  meta: EdgeApplyMeta,
): Promise<void> {
  // 1. R4: one lock for paid, void and cost recompute of this order. Inside
  //    the savepoint so a failure is a recorded `lock_failed` refusal.
  await lockOrThrow(tx, tenantId, payload.orderId);

  // 2. Replay guard: a ledger row means this order was handled. A row of
  //    another event is final; a row of this very event is final too, except a
  //    refusal with a transient reason, which is cleared and retried.
  const [prior] = await tx
    .select({
      paidEventId: edgeOrderIngests.paidEventId,
      state: edgeOrderIngests.state,
      reason: edgeOrderIngests.reason,
    })
    .from(edgeOrderIngests)
    .where(
      and(
        eq(edgeOrderIngests.tenantId, tenantId),
        eq(edgeOrderIngests.orderId, payload.orderId),
      ),
    );
  if (prior) {
    const retry =
      prior.state === "refused" &&
      prior.paidEventId.toLowerCase() === event.id.toLowerCase() &&
      isTransientReason(prior.reason);
    if (!retry) return;
    await tx
      .delete(edgeOrderIngests)
      .where(
        and(
          eq(edgeOrderIngests.tenantId, tenantId),
          eq(edgeOrderIngests.orderId, payload.orderId),
          eq(edgeOrderIngests.state, "refused"),
        ),
      );
  }
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
  // Tax rows (legend-uctlr) never refuse a sale: money already changed hands.
  // Missing or inconsistent rows are not snapshotted; the journal then books
  // all tax to PBJT (`saleTaxSplitOf` fallback). Log event id and code only.
  const taxesUsable =
    payload.taxes !== undefined &&
    payload.taxes.reduce((sum, row) => sum + Number(row.taxIdr), 0) ===
      Number(payload.pbjtIdr);
  if (!taxesUsable) {
    const code =
      payload.taxes === undefined
        ? Number(payload.pbjtIdr) > 0
          ? "tax_missing"
          : null
        : "tax_mismatch";
    if (code !== null) {
      logger.warn({ eventId: event.id, code }, "Edge order tax rows skipped");
      await tx
        .update(edgeOrderIngests)
        .set({ taxFlag: code })
        .where(
          and(
            eq(edgeOrderIngests.tenantId, tenantId),
            eq(edgeOrderIngests.orderId, payload.orderId),
          ),
        );
    }
  }
  for (const tender of payload.tenders) {
    if (providerOf(tender.method, tender.provider) === null)
      throw new IngestRefusal("tender_unsupported");
    if (tender.method === "points" && tender.pointsUsed === undefined)
      throw new IngestRefusal("tender_invalid");
    if (
      tender.method === "cash" &&
      tender.receivedIdr !== undefined &&
      Number(tender.receivedIdr) < Number(tender.amountIdr)
    )
      throw new IngestRefusal("tender_invalid");
  }

  // A sale is never lost over a points link: a customer unknown to this
  // tenant is stored as no customer (no points), not refused by the FK.
  let customerProfileId = payload.customerProfileId ?? null;
  if (customerProfileId !== null) {
    const [profile] = await tx
      .select({ id: customerProfiles.id })
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, customerProfileId),
        ),
      );
    if (!profile) {
      logger.warn(
        { eventId: event.id },
        "Edge order.paid customer unknown, ingested without customer",
      );
      customerProfileId = null;
    }
  }
  // legend-cqehx: who attached the customer, three cases. A user id: a staff
  // user attached the member. null: nobody did (the member attached
  // themselves). Missing key: an older producer, the attacher is unknown; it is
  // stored as null like "nobody", so only the cashier check of the earn guard
  // (LOY-02) applies. The id is stored verbatim, never turned into null, and
  // only with the customer it belongs to.
  const customerAttachedBy =
    customerProfileId !== null && payload.customerAttachedBy !== undefined
      ? payload.customerAttachedBy
      : null;

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
    customerProfileId,
    customerAttachedBy,
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
      // Non-null: unmappable methods were refused above.
      provider: providerOf(tender.method, tender.provider) as
        "edc" | "manual" | PaymentGatewayProvider,
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

  // 5. Sale side effects, same as a cloud sale (legend-uctlr). Order matters:
  //    the PBJT snapshots first (the journal's tax split reads them), then the
  //    journal, then the points earn (reads `orders.customer_profile_id`).
  if (taxesUsable && payload.taxes !== undefined)
    await recordTaxSnapshotsFromPayload(tx, meta.context, {
      sourceType: "order",
      sourceId: ulidToUuid(payload.orderId),
      outletId,
      businessDate: payload.businessDate,
      taxes: payload.taxes,
    });
  await deliverSaleEffects(tx, meta, event);
}

/**
 * Posts the sale journal (or its void reversal) and the loyalty earn (or
 * reversal) of an ingested edge event, in the ingest savepoint. The edge
 * event id is the replay key. The journal consumer parks instead of throwing
 * (as for a cloud sale): the ingest stays successful and the parked row is
 * the retry record; log the event id and code only, never the payload.
 */
async function deliverSaleEffects(
  tx: EdgeTx,
  meta: EdgeApplyMeta,
  event: EventEnvelope,
): Promise<void> {
  const journal = await deliverAutoJournalEvent(meta.context, event, tx);
  if (journal.status === "parked")
    logger.warn(
      { eventId: event.id, code: journal.code },
      "Edge order journal parked",
    );
  // The points ledger appends tenant-wide events, which need tenant scope; the
  // link's context is outlet-scoped. Same tenant, wider scope, as the cloud
  // outbox delivers loyalty events.
  // The consumer only try-locks the loyalty entity and throws a plain Error
  // when busy, which would record a final `error` and lose the sale. Take the
  // blocking lock first, bounded, so contention is a transient 55P03 refusal
  // that is re-driven. The lock is re-entrant for the consumer's own try-lock.
  await lockLoyaltyEntityBounded(tx, meta.context.tenant.tenantId);
  await deliverLoyaltyEarnEvent(
    establishScopedTenantContext(meta.context.tenant, { kind: "tenant" }),
    event,
    tx,
  );
}

/** Longest the ingest waits for the loyalty entity lock before a transient refusal. */
const LOYALTY_LOCK_TIMEOUT = "2s";

/**
 * Blocking loyalty entity lock under a bounded `lock_timeout`. The previous
 * timeout is restored afterwards (`SET LOCAL` outlives a released savepoint),
 * so later statements of the same transaction keep their own wait budget.
 */
async function lockLoyaltyEntityBounded(
  tx: EdgeTx,
  tenantId: TenantId,
): Promise<void> {
  const saved = await tx.execute(
    sql`SELECT current_setting('lock_timeout') AS value`,
  );
  const previous = String(saved.rows[0]?.value ?? "0");
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${LOYALTY_LOCK_TIMEOUT}, true)`,
  );
  await lockLoyaltyJournalEntity(tx, tenantId);
  await tx.execute(sql`SELECT set_config('lock_timeout', ${previous}, true)`);
}

/**
 * `pos_order_tenders.provider` of a payload tender, or null when it cannot be
 * mapped for certain. Cash, points and EDC methods map from the method; a
 * stated provider must agree with it. Gateway methods (card, va, ewallet,
 * qris) need the real gateway provider from the event (legend-yu8z0): without
 * one, or with a code that is not a gateway adapter, they stay unsupported.
 */
function providerOf(
  method: string,
  provider: string | undefined,
): "edc" | "manual" | PaymentGatewayProvider | null {
  let expected: "edc" | "manual" | null = null;
  if (method === "cash" || method === "points") expected = "manual";
  else if (method === "edc_card" || method === "edc_qris") expected = "edc";
  if (expected !== null)
    return provider === undefined || provider === expected ? expected : null;
  if (
    method === "card" ||
    method === "va" ||
    method === "ewallet" ||
    method === "qris"
  ) {
    const gateway = PAYMENT_GATEWAY_PROVIDERS.find((code) => code === provider);
    return gateway ?? null;
  }
  return null;
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
  if (!aggregateMatches(event, payload, outletId)) {
    logger.warn(
      { eventId: event.id, reason: "aggregate_mismatch" },
      "Edge order.voided refused",
    );
    return;
  }
  try {
    await tx.transaction((sp) =>
      applyVoided(sp, tenantId, outletId, event, payload, meta),
    );
  } catch (error) {
    const reason = reasonOf(error);
    logger.warn({ eventId: event.id, reason }, "Edge order.voided refused");
    // The ledger row of the paid order stays as it is (state untouched); the
    // refusal is noted on it. A void with no ledger row has nowhere to be
    // recorded (paid_event_id is NOT NULL): the warning above is the record.
    await bestEffort(tx, event.id, reason, async (sp) => {
      const noted = `void_refused:${reason}`;
      const where = and(
        eq(edgeOrderIngests.tenantId, tenantId),
        eq(edgeOrderIngests.orderId, payload.orderId),
        sql`${edgeOrderIngests.state} IN ('ingested', 'voided')`,
      );
      const [before] = await sp
        .select({ reason: edgeOrderIngests.reason })
        .from(edgeOrderIngests)
        .where(where)
        .for("update");
      // updatedAt always moves: the redrive picks the oldest rows first.
      await sp
        .update(edgeOrderIngests)
        .set({ reason: noted, updatedAt: new Date() })
        .where(where);
      // legend-3dsih (1095): a final refusal is also an audit row, so finance
      // sees why a void did not run. Once per reason change: a replay or a
      // redrive of the same refusal changes nothing and writes nothing; a
      // transient refusal (retried) is not audited. No money moves here.
      if (!before || before.reason === noted || isTransientReason(reason))
        return;
      await recordAudit(
        sp,
        meta.context,
        {
          id: createUlid(),
          tenantId,
          outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "order.void_refused",
          objectType: "order",
          objectId: payload.orderId,
          reason: noted,
          maskedChanges: {
            before: null,
            after: { orderId: payload.orderId, reason },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(new Date()),
        },
        ["orderId", "reason"],
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
  meta: EdgeApplyMeta,
): Promise<void> {
  await lockOrThrow(tx, tenantId, payload.orderId);

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
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, payload.orderId)))
    // legend-1042: the cloud refund/void and the manual refund serialise on this
    // row; the advisory lock above alone does not reach them.
    .for("update");
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
  // Brief 1244 r2: a legacy edge refund parked for this order already paid the
  // guest from the drawer and has no native row yet. A void row now would let a
  // full gateway refund pay the same money again; refuse, the event stays parked.
  if (await hasParkedEdgeRefund(tx, { tenantId, orderId: payload.orderId }))
    throw new IngestRefusal("refund_parked");
  // legend-1042: one order, one money-back lane. A live manual per-item refund
  // (approval route) already gave the guest money back; a void would pay twice.
  const [manualRefund] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        liveRouteManualRefundWhere(tenantId),
        eq(orderIssues.orderId, payload.orderId),
      ),
    )
    .limit(1);
  if (manualRefund) throw new IngestRefusal("manual_refund_exists");
  // legend-aja6g (1095): a live ORD-09 failed-item refund already pays the guest
  // back; read under the orders row lock above, same transaction.
  if (await ord09RefundExistsOf(tx, tenantId, payload.orderId))
    throw new IngestRefusal("ord09_refund_exists");
  // legend-3dsih (1095): a voucher given for this order is cancelled with the
  // void (same savepoint), or the void is refused when it was already used.
  const vouchersOfOrder = await settleOrderVouchersForVoid(tx, meta.context, {
    orderId: payload.orderId,
    actor: { userId: payload.approvedBy },
    now: new Date(),
  });
  if (vouchersOfOrder.kind === "used")
    throw new IngestRefusal("apology_voucher_exists");

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
  // legend-uctlr: reverse the sale journal exactly once (`aj:sale-void:`) and
  // take back the points through the existing loyalty reversal.
  await deliverSaleEffects(tx, meta, event);
}
