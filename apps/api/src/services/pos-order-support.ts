// Shared plumbing of the POS order service (bead legend-kk7): row loading and
// locking, optimistic concurrency, the request-bound idempotency ledger, the
// §6 order_events log, the transactional outbox (POS contract events only),
// audit, approval verification, repricing and the contract DTOs.
//
// Lock order (every POS mutation, same as the promo engine, docs/backend.md
// "Promo engine lock order"): idempotency advisory lock -> table live-state
// lock (orders on a table session) -> `orders` row FOR UPDATE -> `pos_orders`
// row FOR UPDATE -> child rows. Two cashiers on one order therefore serialize
// on the order row; the loser re-reads the committed state and fails the
// stale-screen guard (expectedStatus) or the version guard (If-Match) with
// PRECONDITION_FAILED (legend-63l6).

import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import { formatPickupCode } from "@starter/shared/kitchen";
import {
  assertOutletInScope,
  businessDateOf,
  CoreError,
  createUlid,
  idr,
  toIsoDateTime,
  ulidSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { EdcError } from "@starter/shared/edc";
import {
  canSettlePosOrder,
  PosError,
  posEvents,
  posOrderDetailSchema,
  posOrderSummarySchema,
  posTenderVoidReasonSchema,
  voidReasonSchema,
  type PosEventName,
  type PosOrderDetail,
  type PosOrderStatus,
  type PosOrderSummary,
  type PosTender,
  type PosTenderVoidReason,
} from "@starter/shared/pos";
import {
  approvalRequests,
  domainEventOutbox,
  floorZones,
  menuItems,
  outlets,
  pickupCalls,
  posOverrides,
  tableSessions,
  tables,
} from "../db/schema/index.ts";
import {
  orderEvents,
  posOrderApprovalUses,
  posOrderDiscounts,
  posOrderIdempotency,
  posOrderItems,
  posOrders,
  posOrderTenders,
} from "../db/schema/pos-order.ts";
import { edcTransactions } from "../db/schema/edc.ts"; // legend-ig2sl
import { orderIssues } from "../db/schema/kds-issues.ts"; // legend-kxoyf
import { paymentVaReleases } from "../db/schema/payment-va-release.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import { posOverrideUsableFromDevice } from "./device-pin-support.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { Tx } from "./menu-internals.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  computePosBill,
  lineSubtotalIdr,
  loadPosTaxConfig,
  posPriceChannel,
  type PosBillLine,
} from "./pos-order-pricing.ts";
import { posReceiptPort } from "./pos-order-ports.ts";
import { depositCreditFor, lockSessionDeposit } from "./qr-order-ports.ts";

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type PosRow = typeof posOrders.$inferSelect;
export type PosItemRow = typeof posOrderItems.$inferSelect;
export type TenderRow = typeof posOrderTenders.$inferSelect;
export type DiscountRow = typeof posOrderDiscounts.$inferSelect;
export type OutletRow = typeof outlets.$inferSelect;
export type ZoneRow = typeof floorZones.$inferSelect;
export type Locked = { order: OrderRow; pos: PosRow };

/** Who is acting: the verified session user and (once WS-02 lands) device. */
export type PosCaller = {
  readonly userId: UserId;
  readonly deviceId: string | null;
  /** Order version the client expects (legend-63l6): body `expectedVersion`
   * or `If-Match`; null when the client sent neither. */
  readonly expectedVersion: number | null;
};

const EVENT_DESTINATION = "cloud-sync";
const AUDIT_SAFE_FIELDS = [
  "id",
  "number",
  "status",
  "channel",
  "serviceType",
  "totalIdr",
  "amountIdr",
  "itemCount",
  "itemIds",
  "course",
  "method",
  "source",
  "kind",
  "percentBp",
  "reason",
  "approvedBy",
  "approvalRequestId",
  "overrideId",
  "receiptNumber",
  "version",
  // Refund of returned items (legend-q1e0, legend-wkl3): no PII.
  "requestedAmountIdr",
  "items",
  "itemId",
  "quantity",
  "goodsReturnOnly",
  "goodsReturnNote",
  // legend-s7rx: what a deposit (DP) still owes after a promo refund; a number,
  // a running balance (read the latest audit row, never sum them).
  "depositOwedIdr",
  "orderId",
  "shiftId",
  "cashIdr",
] as const;

export function notFound(message = "Pesanan tidak ditemukan."): CoreError {
  return new CoreError("NOT_FOUND", message);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---- Outlet, session, business date ---------------------------------------

export async function loadOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<OutletRow> {
  assertOutletInScope(context.outletScope, outletId);
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!row) throw notFound("Outlet tidak ditemukan.");
  return row;
}

export function businessDateFor(outlet: OutletRow, now: Date): string {
  return businessDateOf(now, outletBusinessDayClock(outlet));
}

/** The zone of a dine-in order's table session, for its service charge. */
export async function zoneOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  tableSessionId: string,
): Promise<ZoneRow | null> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({ zone: floorZones })
    .from(tableSessions)
    .innerJoin(
      tables,
      and(
        eq(tables.tenantId, tableSessions.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .innerJoin(
      floorZones,
      and(
        eq(floorZones.tenantId, tables.tenantId),
        eq(floorZones.id, tables.zoneId),
      ),
    )
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.id, tableSessionId),
      ),
    );
  return row?.zone ?? null;
}

// ---- Loading and locking ----------------------------------------------------

/**
 * The order and its POS row, locked FOR UPDATE in the lock order above. An
 * order of another outlet, another tenant (RLS) or another channel's API (no
 * pos_orders row, e.g. a QR order) is 404, so the route is no oracle.
 */
export async function lockPosOrder(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<Locked> {
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        eq(orders.outletId, outletId),
      ),
    )
    .for("update");
  if (!order) throw notFound();
  const [pos] = await tx
    .select()
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, orderId)),
    )
    .for("update");
  if (!pos) throw notFound();
  return { order, pos };
}

export async function readPosOrder(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<Locked> {
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({ order: orders, pos: posOrders })
    .from(orders)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        eq(orders.outletId, outletId),
      ),
    );
  if (!row) throw notFound();
  return row;
}

export async function itemsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<Array<{ item: OrderItemRow; pos: PosItemRow | null }>> {
  const rows = await tx
    .select({ item: orderItems, pos: posOrderItems })
    .from(orderItems)
    .leftJoin(
      posOrderItems,
      and(
        eq(posOrderItems.tenantId, orderItems.tenantId),
        eq(posOrderItems.itemId, orderItems.id),
      ),
    )
    .where(
      and(
        eq(orderItems.tenantId, context.tenant.tenantId),
        eq(orderItems.orderId, orderId),
      ),
    )
    .orderBy(asc(orderItems.id));
  return rows;
}

export async function tendersOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<TenderRow[]> {
  return tx
    .select()
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, context.tenant.tenantId),
        eq(posOrderTenders.orderId, orderId),
      ),
    )
    .orderBy(asc(posOrderTenders.requestedAt), asc(posOrderTenders.id));
}

export async function liveDiscountsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<DiscountRow[]> {
  return tx
    .select()
    .from(posOrderDiscounts)
    .where(
      and(
        eq(posOrderDiscounts.tenantId, context.tenant.tenantId),
        eq(posOrderDiscounts.orderId, orderId),
        isNull(posOrderDiscounts.removedAt),
      ),
    )
    .orderBy(asc(posOrderDiscounts.createdAt), asc(posOrderDiscounts.id));
}

export function capturedIdr(tenders: readonly TenderRow[]): number {
  return tenders
    .filter((tender) => tender.status === "captured")
    .reduce((sum, tender) => sum + tender.amountIdr, 0);
}

/** What is still due: total − reservation deposit − captured tenders. */
export function remainingIdr(
  order: OrderRow,
  tenders: readonly TenderRow[],
): number {
  return Math.max(
    0,
    order.totalIdr - order.depositAppliedIdr - capturedIdr(tenders),
  );
}

// ---- Guards -----------------------------------------------------------------

/**
 * A QRIS tender still waiting for its verified payment was billed for the
 * remaining balance at that time. Changing the order total (discount, line
 * void) while it is pending would let the guest pay a stale amount that
 * `handlePosPaymentPaid` can no longer capture: fail closed instead.
 */
export function assertNoPendingGatewayTender(
  tenders: readonly TenderRow[],
): void {
  if (
    tenders.some(
      (tender) =>
        tender.status === "authorized" && tender.paymentLinkId !== null,
    )
  )
    throw new CoreError(
      "CONFLICT",
      "Masih ada QRIS yang menunggu pembayaran; total pesanan tidak dapat diubah.",
    );
}

/**
 * EDC-01 (legend-ig2sl): while an ECR sale for this bill is still open, the
 * terminal was asked to charge the amount at that time. Any total-changing
 * action (and any other tender) fails closed (409) until the request is final
 * or the bill is settled. Open means: `pending`/`unknown`; a late approval
 * kept as declined/cancelled/failed (`needs_reconciliation`); or `approved`
 * without a live tender yet (money taken, not booked). An approved sale that
 * already is a live tender does not lock. Call it after the order row is
 * locked, inside the mutating transaction: it takes the same advisory lock as
 * the edge write-ahead (tenant, outlet:reference), so the two never interleave.
 */
export async function assertNoOpenEdcRequest(
  tx: Tx,
  context: ScopedTenantContext,
  order: Pick<OrderRow, "outletId" | "number">,
): Promise<void> {
  if (await hasOpenEdcRequest(tx, context, order))
    throw new PosError("EDC_REQUEST_OPEN");
}

/**
 * The check behind `assertNoOpenEdcRequest`, for callers that must decide
 * instead of throw (the QRIS payment webhook voids and refunds, it never
 * throws). Same advisory lock and query; true when a request is open.
 */
export async function hasOpenEdcRequest(
  tx: Tx,
  context: ScopedTenantContext,
  order: Pick<OrderRow, "outletId" | "number">,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${order.outletId}:${order.number}`}))`,
  );
  const [open] = await tx
    .select({ id: edcTransactions.id })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.outletId, order.outletId),
        eq(edcTransactions.type, "sale"),
        eq(edcTransactions.reference, order.number),
        or(
          inArray(edcTransactions.status, ["pending", "unknown"]),
          eq(edcTransactions.needsReconciliation, true),
          and(
            eq(edcTransactions.status, "approved"),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(posOrderTenders)
                .where(
                  and(
                    eq(posOrderTenders.tenantId, tenantId),
                    eq(posOrderTenders.edcTransactionId, edcTransactions.id),
                    notInArray(posOrderTenders.status, ["voided", "failed"]),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return open !== undefined;
}

/**
 * An EDC sale may only ask the terminal for what the bill can book as a card
 * tender right now (legend-xcbs7). The bill is the POS order whose number is
 * the request reference. Refused with ORDER_NOT_PAYABLE when it is missing, not
 * a POS order, not open for payment, or still carries a legacy order-level
 * payment link (the card tender path refuses those, so the money could never
 * be booked); with EDC_AMOUNT_MISMATCH when `amountIdr` is not exactly the
 * remaining balance. The caller holds the (tenant, outlet:reference) advisory
 * lock; the order row is not locked here (lock order).
 */
export async function assertEdcSaleBillPayable(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    readonly outletId: OutletId;
    readonly reference: string;
    readonly amountIdr: number;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [found] = await tx
    .select({ order: orders, posOrderId: posOrders.orderId })
    .from(orders)
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, input.outletId),
        eq(orders.number, input.reference),
      ),
    )
    .limit(1);
  if (
    !found ||
    found.posOrderId === null ||
    !canSettlePosOrder(found.order.status) ||
    found.order.paymentLinkId !== null
  )
    throw new PosError("ORDER_NOT_PAYABLE");
  if (
    input.amountIdr !==
    remainingIdr(found.order, await tendersOf(tx, context, found.order.id))
  )
    throw new EdcError("EDC_AMOUNT_MISMATCH");
}

/**
 * legend-yhia9 / legend-w0ows: a card sale may not START while the bill has a
 * QR that can still be paid (the terminal would take money the tender step
 * refuses to book while the hold is active). Only for the write-ahead of a new
 * sale: booking or reconciling a sale that already ran must never call this
 * (the card wins, founder Q7). The caller holds the (tenant, outlet:reference)
 * advisory lock, the lock `addPosTender` takes before it issues a QR, so a QR
 * and a new sale never both pass; the order row is not locked here (lock
 * order), the hold rows are only read.
 */
export async function assertNoActiveQrisHoldForEdcSale(
  tx: Tx,
  context: ScopedTenantContext,
  input: { readonly outletId: OutletId; readonly reference: string },
): Promise<void> {
  const [active] = await tx
    .select({ id: posQrisHolds.id })
    .from(posQrisHolds)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posQrisHolds.tenantId),
        eq(orders.id, posQrisHolds.orderId),
      ),
    )
    .where(
      and(
        eq(posQrisHolds.tenantId, context.tenant.tenantId),
        eq(orders.outletId, input.outletId),
        eq(orders.number, input.reference),
        inArray(posQrisHolds.state, ["open", "cancelling"]),
      ),
    )
    .limit(1);
  if (active) throw new PosError("QRIS_HOLD_ACTIVE");
}

/** Stale-screen guard (contract `expectedStatus`): 412 when it moved on. */
export function assertExpectedStatus(
  order: OrderRow,
  expected: PosOrderStatus,
): void {
  if (order.status !== expected)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Pesanan sudah diubah di perangkat lain; muat ulang pesanan.",
    );
}

/** Optimistic concurrency on the order version (legend-63l6). */
export function assertExpectedVersion(
  pos: PosRow,
  expected: number | null,
): void {
  if (expected !== null && pos.version !== expected)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Pesanan sudah diubah di perangkat lain; muat ulang pesanan.",
    );
}

/** POS-04 service guard; the DB trigger is the backstop. */
export function assertMutable(order: OrderRow): void {
  if (order.status === "completed" || order.status === "voided")
    throw new PosError("ORDER_FINAL_IMMUTABLE");
}

/** Bumps the version under the row lock (compare-and-set as a backstop). */
export async function bumpPos(
  tx: Tx,
  context: ScopedTenantContext,
  pos: PosRow,
  now: Date,
  patch: Partial<
    Pick<
      PosRow,
      | "shiftId"
      | "deviceId"
      | "cashierId"
      | "submittedAt"
      | "completedAt"
      | "voidReasonNote"
      | "voidApprovedBy"
      | "voidApprovalRequestId"
      | "voidOverrideId"
    >
  > = {},
): Promise<PosRow> {
  const [row] = await tx
    .update(posOrders)
    .set({ ...patch, version: pos.version + 1, updatedAt: now })
    .where(
      and(
        eq(posOrders.tenantId, context.tenant.tenantId),
        eq(posOrders.orderId, pos.orderId),
        eq(posOrders.version, pos.version),
      ),
    )
    .returning();
  if (!row)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Pesanan sudah diubah di perangkat lain; muat ulang pesanan.",
    );
  return row;
}

// ---- Idempotency --------------------------------------------------------------

/**
 * Runs `run` once per (outlet, key). The key is bound to the fingerprint of
 * actor, operation, target and request: the same request replays the stored
 * answer, any other request under the key is IDEMPOTENCY_KEY_REUSED. Requests
 * with one key serialize on an advisory lock first. A failed `run` rolls the
 * transaction back and stores nothing, so a retry recomputes.
 */
export async function posIdempotent<T>(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    actorId: string;
    key: string;
    operation: string;
    target: string;
    request: unknown;
  },
  run: () => Promise<T>,
): Promise<T> {
  const tenantId = context.tenant.tenantId;
  const fingerprint = sha256(
    JSON.stringify({
      actor: input.actorId.toLowerCase(),
      operation: input.operation,
      target: input.target,
      request: input.request,
    }),
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-order-idem:${tenantId}:${input.outletId}:${input.key}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(posOrderIdempotency)
    .where(
      and(
        eq(posOrderIdempotency.tenantId, tenantId),
        eq(posOrderIdempotency.outletId, input.outletId),
        eq(posOrderIdempotency.key, input.key),
      ),
    );
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempoten ini sudah dipakai untuk permintaan lain.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(posOrderIdempotency).values({
    tenantId,
    outletId: input.outletId as OutletId,
    key: input.key,
    operation: input.operation,
    fingerprint,
    response,
  });
  return response;
}

// ---- order_events, outbox, audit -------------------------------------------

/**
 * §6 order_events: one append per state change. The order row is locked by
 * the caller, so max(sequence) + 1 is gapless and race-free per order.
 */
export async function appendOrderEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: Pick<OrderRow, "id" | "outletId">;
    type: string;
    payload: Record<string, unknown>;
    caller: Pick<PosCaller, "userId" | "deviceId"> | null;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({ last: sql<number>`coalesce(max(${orderEvents.sequence}), 0)` })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.tenantId, tenantId),
        eq(orderEvents.orderId, input.order.id),
      ),
    );
  await tx.insert(orderEvents).values({
    id: createUlid(input.now.getTime()),
    tenantId,
    outletId: input.order.outletId,
    orderId: input.order.id,
    sequence: Number(row?.last ?? 0) + 1,
    type: input.type,
    payload: input.payload,
    actorId: input.caller?.userId ?? null,
    deviceId: input.caller?.deviceId ?? null,
    occurredAt: input.now,
  });
}

/**
 * One POS contract event (pos/events.ts) on the transactional outbox, in the
 * caller's transaction. The definition validates name, version and payload.
 */
export async function appendPosEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: PosEventName,
  input: {
    order: Pick<OrderRow, "id" | "outletId">;
    payload: Record<string, unknown>;
    caller: Pick<PosCaller, "userId" | "deviceId"> | null;
    now: Date;
  },
): Promise<void> {
  const definition = posEvents[name];
  const aggregateType = definition.entry.aggregateType;
  const aggregateUuid = ulidToUuid(input.order.id);
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
        eq(domainEventOutbox.aggregateId, aggregateUuid),
      ),
    );
  const sequence = Number(row?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.order.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType,
    aggregateId: input.order.id,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor:
      input.caller === null
        ? { type: "system" }
        : { type: "user", id: input.caller.userId },
    deviceId: input.caller?.deviceId ?? null,
    idempotencyKey: `${definition.name}:${input.order.id}:${sequence}`.slice(
      0,
      100,
    ),
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

export async function auditPos(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    order: Pick<OrderRow, "id" | "outletId">;
    caller: Pick<PosCaller, "userId" | "deviceId"> | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
    objectType?: string;
    objectId?: string;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.order.outletId,
      actorType: input.caller === null ? "system" : "user",
      actorId: input.caller?.userId ?? null,
      deviceId: input.caller?.deviceId ?? null,
      action: input.action,
      objectType: input.objectType ?? "order",
      objectId: input.objectId ?? input.order.id,
      reason: input.reason ?? null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, AUDIT_SAFE_FIELDS),
        after:
          input.after === null
            ? null
            : maskAuditChanges(input.after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Approvals (POS-02, AUTH-06) ------------------------------------------------

export type ApprovalPurpose =
  | "order_void"
  | "item_void"
  | "discount"
  | "correction_void"
  | "refund"
  | "edc_standalone"
  | "qris_release";

const APPROVAL_ERROR = {
  void: "VOID_APPROVAL_REQUIRED",
  discount: "DISCOUNT_APPROVAL_REQUIRED",
  refund: "REFUND_APPROVAL_REQUIRED",
  edc_standalone: "EDC_STANDALONE_APPROVAL_REQUIRED",
} as const;

/**
 * Verifies the supervisor approval a void / discount / refund names and
 * consumes it (one approval, one action). `overrideId` is the `pos_overrides`
 * row (ULID) the supervisor approved, by PIN or by phone (legend-0gy1: the
 * client names the exact row; there is no "newest unused override" guess). The
 * override must be approved, on this outlet, for this action and object,
 * requested by the caller, approved by `approvedBy` (never the requester,
 * AUTH-06), fresh (approved within PIN_APPROVAL_WINDOW_MS of `now`, for both
 * methods; a phone approval counts from its last chain level's `decidedAt`) and worth at least the value acted on. Anything else is the
 * contract's *_APPROVAL_REQUIRED (fail closed). Returns the override row:
 * callers store `override.id` and `override.approvalRequestId` (the WS-01 chain
 * id, null for a PIN) on rows, events and audit, never client input.
 */
export async function consumeApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: ApprovalCheckInput & { purpose: ApprovalPurpose },
): Promise<typeof posOverrides.$inferSelect> {
  const override = await verifyApproval(tx, context, input);
  const consumed = await tx
    .insert(posOrderApprovalUses)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: input.outletId as OutletId,
      overrideId: override.id,
      orderId: input.orderId,
      purpose: input.purpose,
    })
    .onConflictDoNothing()
    .returning({ id: posOrderApprovalUses.id });
  if (consumed.length === 0) throw new PosError(APPROVAL_ERROR[input.action]);
  return override;
}

export type ApprovalCheckInput = {
  action: "void" | "discount" | "refund" | "edc_standalone";
  outletId: OutletId;
  orderId: string;
  objectType: "order" | "order_item" | "pos_order";
  objectId: string;
  requesterId: string;
  approvedBy: string;
  overrideId: string;
  minValueIdr: number;
  /** The verified device the caller acts from (null: no device). */
  deviceId: string | null;
  now: Date;
};

/**
 * Every check of `consumeApproval` without spending the approval: the caller
 * must record the single use itself (legend-5wn1e: a guest order has no
 * `pos_orders` row for `pos_order_approval_uses`). Locks the override row.
 */
export async function verifyApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: ApprovalCheckInput,
): Promise<typeof posOverrides.$inferSelect> {
  const refuse = () => new PosError(APPROVAL_ERROR[input.action]);
  const overrideId = ulidSchema.safeParse(input.overrideId);
  if (!overrideId.success) throw refuse();
  if (input.approvedBy.toLowerCase() === input.requesterId.toLowerCase())
    throw refuse();
  const tenantId = context.tenant.tenantId;
  // FOR UPDATE: two concurrent uses of one override queue here, so the second
  // sees the first one's `pos_order_approval_uses` row.
  const [override] = await tx
    .select()
    .from(posOverrides)
    .where(
      and(
        eq(posOverrides.tenantId, tenantId),
        eq(posOverrides.outletId, input.outletId),
        eq(posOverrides.id, overrideId.data),
      ),
    )
    .for("update");
  if (
    !override ||
    override.status !== "approved" ||
    override.action !== input.action ||
    override.approvedBy === null ||
    override.approvedBy.toLowerCase() !== input.approvedBy.toLowerCase() ||
    override.requestedBy.toLowerCase() !== input.requesterId.toLowerCase() ||
    override.approvedBy.toLowerCase() === override.requestedBy.toLowerCase() ||
    override.objectType !== input.objectType ||
    override.objectId.toLowerCase() !== input.objectId.toLowerCase() ||
    override.valueIdr < input.minValueIdr
  )
    throw refuse();
  // A PIN approval typed on a verified device is bound to it (legend-fjwxo).
  // Refusal leaves it unspent.
  if (!posOverrideUsableFromDevice(override, input.deviceId)) throw refuse();
  // Freshness is measured from the approval, against the caller's injected
  // clock, never Date.now(). A PIN override is approved when it is created, so
  // `resolvedAt` (the row has no `approvedAt`; `createdAt` if missing) is the
  // approval. A phone approval is NOT: its `resolvedAt` is when the consumer
  // or poll processed it, which can be long after the supervisor decided
  // (legend-0gy1 round 2). It is as old as the last level of its WS-01
  // `approval_requests` chain was decided; no decided chain = fail closed.
  let approvedAt: Date;
  if (override.method === "supervisor_phone") {
    if (override.approvalRequestId === null) throw refuse();
    const [last] = await tx
      .select({ decidedAt: approvalRequests.decidedAt })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.chainId, override.approvalRequestId),
        ),
      )
      .orderBy(desc(approvalRequests.level))
      .limit(1);
    if (!last?.decidedAt) throw refuse();
    approvedAt = last.decidedAt;
  } else approvedAt = override.resolvedAt ?? override.createdAt;
  if (input.now.getTime() - approvedAt.getTime() > PIN_APPROVAL_WINDOW_MS)
    throw refuse();
  // One approval, one action (legend-5wn1e): an override already spent on a
  // POS action (`pos_order_approval_uses`) or on a VA release
  // (`payment_va_releases.override_id`) is refused. The override row is locked
  // above, so these reads cannot race a concurrent use.
  const [spent] = await tx
    .select({ id: posOrderApprovalUses.id })
    .from(posOrderApprovalUses)
    .where(
      and(
        eq(posOrderApprovalUses.tenantId, tenantId),
        eq(posOrderApprovalUses.overrideId, override.id),
      ),
    );
  if (spent) throw refuse();
  const [released] = await tx
    .select({ id: paymentVaReleases.id })
    .from(paymentVaReleases)
    .where(
      and(
        eq(paymentVaReleases.tenantId, tenantId),
        eq(paymentVaReleases.overrideId, override.id),
      ),
    );
  if (released) throw refuse();
  return override;
}

/** PRD silent: an approved override (PIN or phone) is used within 15 minutes. */
const PIN_APPROVAL_WINDOW_MS = 15 * 60_000;

// ---- Repricing ------------------------------------------------------------------

async function categoriesOf(
  tx: Tx,
  context: ScopedTenantContext,
  menuItemIds: readonly string[],
): Promise<Map<string, string>> {
  if (menuItemIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: menuItems.id, categoryId: menuItems.categoryId })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        inArray(menuItems.id, [...new Set(menuItemIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.categoryId]));
}

/**
 * The reservation deposit (WS-08 `depositCreditForSession`, through the QR
 * port so one wiring serves both bills) this order may use: the session's
 * credit minus what its other payable orders already applied, never above
 * the order total (same rule as the QR checkout). Draft snapshots reserve none.
 */
async function depositFor(
  tx: Tx,
  context: ScopedTenantContext,
  order: Pick<OrderRow, "id" | "tableSessionId">,
  totalIdr: number,
): Promise<number> {
  if (order.tableSessionId === null || totalIdr <= 0) return 0;
  const tenantId = context.tenant.tenantId;
  const credit = await depositCreditFor(tx, tenantId, order.tableSessionId);
  if (credit <= 0) return 0;
  // legend-94qt: one lock per session shared with the QR checkout, held until
  // commit, so concurrent reprices never apply the same remaining credit twice.
  await lockSessionDeposit(tx, tenantId, order.tableSessionId);
  const [used] = await tx
    .select({
      used: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, order.tableSessionId),
        ne(orders.status, "draft"),
        ne(orders.status, "voided"),
        ne(orders.id, order.id),
      ),
    );
  return Math.min(Math.max(0, credit - Number(used?.used ?? 0)), totalIdr);
}

/**
 * Recomputes the order's money from its lines and live discount rows on the
 * server (percent discounts follow the new subtotal; promo/voucher amounts are
 * what the engine redeemed), then the deposit, and writes the order row. With
 * `allLines` the voided lines count too: the frozen history of a voided order
 * (contract posOrderDetailSchema).
 */
export async function repriceOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: OrderRow;
    outlet: OutletRow;
    now: Date;
    allLines?: boolean;
    releaseDeposit?: boolean;
  },
): Promise<OrderRow> {
  const { order } = input;
  // legend-yhia9: a bill with a collectible QRIS never reprices (lines,
  // discounts, DP). Defense in depth behind each mutator's own guard.
  const [frozen] = await tx
    .select({ id: posQrisHolds.id })
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, context.tenant.tenantId),
        eq(posQrisHolds.orderId, order.id),
        inArray(posQrisHolds.state, ["open", "cancelling"]),
      ),
    )
    .limit(1);
  if (frozen) throw new PosError("QRIS_HOLD_ACTIVE");
  const items = (await itemsOf(tx, context, order.id)).map((row) => row.item);
  const counted = input.allLines
    ? items
    : items.filter((item) => item.status !== "voided");
  const categories = await categoriesOf(
    tx,
    context,
    counted.map((item) => item.menuItemId),
  );
  const lines: PosBillLine[] = counted.map((item) => {
    const categoryId = categories.get(item.menuItemId);
    if (!categoryId) throw new Error("Order line without a menu category");
    return {
      lineId: item.id,
      menuItemId: item.menuItemId,
      categoryId,
      quantity: item.quantity,
      unitPriceIdr: item.unitPriceIdr,
      modifiersTotalIdr: item.modifiersTotalIdr,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + lineSubtotalIdr(line), 0);
  const discounts = await liveDiscountsOf(tx, context, order.id);
  let discountTotal = 0;
  for (const row of discounts) {
    let amount = row.amountIdr;
    if (row.kind === "percent" && row.percentBp !== null) {
      amount = idr(Math.floor((subtotal * row.percentBp) / 10_000));
      if (amount <= 0) throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
      if (amount !== row.amountIdr)
        await tx
          .update(posOrderDiscounts)
          .set({ amountIdr: idr(amount), updatedAt: input.now })
          .where(
            and(
              eq(posOrderDiscounts.tenantId, context.tenant.tenantId),
              eq(posOrderDiscounts.id, row.id),
            ),
          );
    }
    discountTotal += amount;
  }
  if (discountTotal > subtotal) throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
  const zone =
    order.tableSessionId !== null && order.serviceType === "dine_in"
      ? await zoneOfSession(tx, context, order.tableSessionId)
      : null;
  const bill = computePosBill({
    context,
    outletId: order.outletId as OutletId,
    businessDate: order.businessDate,
    channel: posPriceChannel(
      order.channel as Parameters<typeof posPriceChannel>[0],
      order.serviceType as Parameters<typeof posPriceChannel>[1],
    ),
    zone,
    lines,
    orderDiscountIdr: discountTotal,
    taxConfig: await loadPosTaxConfig(tx, context, order.outletId),
  });
  if (bill.discountIdr !== discountTotal)
    throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
  const deposit =
    input.releaseDeposit || order.status === "draft"
      ? 0
      : await depositFor(tx, context, order, bill.totalIdr);
  const [updated] = await tx
    .update(orders)
    .set({
      subtotalIdr: bill.subtotalIdr,
      discountIdr: bill.discountIdr,
      serviceChargeIdr: bill.serviceChargeIdr,
      taxIdr: bill.taxIdr,
      roundingIdr: bill.roundingIdr,
      totalIdr: bill.totalIdr,
      depositAppliedIdr: idr(deposit),
      taxResult: bill.tax,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.id, order.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("Order reprice returned no row");
  return updated;
}

export { depositFor as posDepositFor };

// ---- DTOs -----------------------------------------------------------------------

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function tenderDto(row: TenderRow): PosTender {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    method: row.method,
    provider: row.provider,
    paymentIntentId: row.paymentIntentId,
    amountIdr: row.amountIdr,
    receivedIdr: row.receivedIdr,
    changeIdr: row.changeIdr,
    reference: row.reference,
    edcTransactionId: row.edcTransactionId,
    pointsUsed: row.pointsUsed,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    capturedBy: row.capturedBy,
    approvedBy: row.approvedBy,
  } as PosTender;
}

/**
 * legend-kxoyf: the kitchen-swap links of an order (`order_issues`, tenant
 * scoped, only issues that got a replacement line). A swap leaves the order
 * money frozen, so the detail reports the replacement lines and the voided
 * swapped-out lines as recovery adjustments for the subtotal check.
 */
export async function swapLinksOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<{ replacementIds: Set<string>; replacedIds: Set<string> }> {
  const rows = await tx
    .select({
      orderItemId: orderIssues.orderItemId,
      replacementId: orderIssues.replacementOrderItemId,
    })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, context.tenant.tenantId),
        eq(orderIssues.orderId, orderId),
        isNotNull(orderIssues.replacementOrderItemId),
      ),
    );
  const replacementIds = new Set<string>();
  const replacedIds = new Set<string>();
  for (const row of rows) {
    if (row.replacementId !== null) replacementIds.add(row.replacementId);
    replacedIds.add(row.orderItemId);
  }
  return { replacementIds, replacedIds };
}

/**
 * Why each voided QRIS tender of the order was voided: the `reason` of its
 * latest `order.tender_voided` event, kept only when it is one the cashier text
 * names (an unknown reason stays absent, so the POS shows the generic text).
 */
async function tenderVoidReasonsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  tenders: readonly TenderRow[],
): Promise<Map<string, PosTenderVoidReason>> {
  const reasons = new Map<string, PosTenderVoidReason>();
  if (!tenders.some((t) => t.status === "voided" && t.method === "qris"))
    return reasons;
  const events = await tx
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.tenantId, context.tenant.tenantId),
        eq(orderEvents.orderId, orderId),
        eq(orderEvents.type, "order.tender_voided"),
      ),
    )
    .orderBy(asc(orderEvents.sequence));
  for (const { payload } of events) {
    const { tenderId, reason } = (payload ?? {}) as {
      tenderId?: unknown;
      reason?: unknown;
    };
    if (typeof tenderId !== "string") continue;
    const parsed = posTenderVoidReasonSchema.safeParse(reason);
    // The latest event wins, so a later unnamed reason clears an earlier one.
    if (parsed.success) reasons.set(tenderId, parsed.data);
    else reasons.delete(tenderId);
  }
  return reasons;
}

/** The cashier screen's order: lines, tenders, live discounts and receipt. */
export async function orderDetail(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
): Promise<PosOrderDetail> {
  const { order, pos } = locked;
  const [items, tenders, discounts, receipt, swaps, calls] = await Promise.all([
    itemsOf(tx, context, order.id),
    tendersOf(tx, context, order.id),
    liveDiscountsOf(tx, context, order.id),
    posReceiptPort().findForOrder(tx, context, order.id),
    swapLinksOf(tx, context, order.id),
    tx
      .select({ number: pickupCalls.number })
      .from(pickupCalls)
      .where(
        and(
          eq(pickupCalls.tenantId, context.tenant.tenantId),
          eq(pickupCalls.outletId, order.outletId),
          eq(pickupCalls.orderId, order.id),
        ),
      ),
  ]);
  // A voided order's schema counts every line, so it carries no adjustment.
  const swapReplacementIdr =
    order.status === "voided"
      ? 0
      : items
          .filter(
            ({ item }) =>
              swaps.replacementIds.has(item.id) && item.status !== "voided",
          )
          .reduce((sum, { item }) => sum + item.lineTotalIdr, 0);
  const swapReplacedIdr =
    order.status === "voided"
      ? 0
      : items
          .filter(
            ({ item }) =>
              swaps.replacedIds.has(item.id) && item.status === "voided",
          )
          .reduce((sum, { item }) => sum + item.lineTotalIdr, 0);
  const voidReasons = await tenderVoidReasonsOf(tx, context, order.id, tenders);
  return posOrderDetailSchema.parse({
    id: order.id,
    tenantId: order.tenantId,
    outletId: order.outletId,
    number: order.number,
    callNumber: calls[0] ? formatPickupCode(calls[0].number) : null,
    channel: order.channel,
    serviceType: order.serviceType,
    tableSessionId: order.tableSessionId,
    customerProfileId: order.customerProfileId,
    externalRef: order.externalRef,
    shiftId: pos.shiftId,
    deviceId: pos.deviceId,
    cashierId: pos.cashierId,
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.discountIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    roundingIdr: order.roundingIdr,
    totalIdr: order.totalIdr,
    depositAppliedIdr: order.depositAppliedIdr,
    swapReplacementIdr,
    swapReplacedIdr,
    status: order.status,
    createdBy: order.createdBy,
    createdAt: order.createdAt.toISOString(),
    submittedAt: iso(pos.submittedAt),
    firedAt: iso(order.firedAt),
    completedAt: iso(pos.completedAt),
    voidedAt: iso(order.voidedAt),
    voidReason: order.status === "voided" ? order.voidReason : null,
    voidReasonNote: order.status === "voided" ? pos.voidReasonNote : null,
    voidApprovedBy: order.status === "voided" ? pos.voidApprovedBy : null,
    voidApprovalRequestId:
      order.status === "voided" ? pos.voidApprovalRequestId : null,
    voidOverrideId: order.status === "voided" ? pos.voidOverrideId : null,
    version: pos.version,
    items: items.map(({ item, pos: extra }) => {
      const voided = item.status === "voided";
      const swapRole = swaps.replacementIds.has(item.id)
        ? "replacement"
        : swaps.replacedIds.has(item.id)
          ? "replaced"
          : "none";
      // The swap consumer voids with its own reason ("item_failed_swap"), which
      // is not a cashier void reason: show it as "other" with the text as note.
      const knownReason = voidReasonSchema.safeParse(item.voidReason);
      return {
        id: item.id,
        tenantId: item.tenantId,
        orderId: item.orderId,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        name: item.name,
        quantity: item.quantity,
        unitPriceIdr: item.unitPriceIdr,
        modifiersTotalIdr: item.modifiersTotalIdr,
        lineTotalIdr: item.lineTotalIdr,
        modifiers: item.modifiers.map((modifier) => ({
          modifierId: modifier.modifierId,
          name: modifier.name,
          priceIdr: modifier.priceIdr,
        })),
        note: item.note,
        course: item.course,
        fireStatus: item.fireStatus,
        firedAt:
          item.fireStatus === "fired"
            ? (iso(extra?.firedAt ?? null) ?? item.updatedAt.toISOString())
            : null,
        status: item.status,
        swapRole,
        voidReason: voided
          ? knownReason.success
            ? knownReason.data
            : swapRole === "replaced"
              ? "other"
              : item.voidReason
          : null,
        voidReasonNote: voided
          ? (extra?.voidReasonNote ??
            (!knownReason.success && swapRole === "replaced"
              ? item.voidReason
              : null))
          : null,
        voidedBy: voided ? item.voidedBy : null,
        voidApprovedBy: voided ? item.voidApprovedBy : null,
        voidApprovalRequestId: voided
          ? (extra?.voidApprovalRequestId ?? null)
          : null,
        voidOverrideId: voided ? (extra?.voidOverrideId ?? null) : null,
        // HPP is finance data (inventory.cost.view); the POS DTO never carries it.
        costSnapshotIdr: null,
        createdAt: item.createdAt.toISOString(),
      };
    }),
    tenders: tenders.map((tender) => {
      const voidReason = voidReasons.get(tender.id);
      return voidReason
        ? { ...tenderDto(tender), voidReason }
        : tenderDto(tender);
    }),
    discounts: discounts.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      orderId: row.orderId,
      source: row.source,
      kind: row.kind,
      percentBp: row.percentBp,
      amountIdr: row.amountIdr,
      reason: row.reason,
      reasonNote: row.reasonNote,
      appliedBy: row.appliedBy,
      approvedBy: row.approvedBy,
      approvalRequestId: row.approvalRequestId,
      overrideId: row.overrideId,
      createdAt: row.createdAt.toISOString(),
    })),
    receipt,
  });
}

export function summaryDto(
  order: OrderRow,
  pos: PosRow,
  counts: { itemCount: number; heldItemCount: number },
): PosOrderSummary {
  return posOrderSummarySchema.parse({
    id: order.id,
    tenantId: order.tenantId,
    outletId: order.outletId,
    number: order.number,
    channel: order.channel,
    serviceType: order.serviceType,
    tableSessionId: order.tableSessionId,
    status: order.status,
    shiftId: pos.shiftId,
    totalIdr: order.totalIdr,
    itemCount: counts.itemCount,
    heldItemCount: counts.heldItemCount,
    createdAt: order.createdAt.toISOString(),
  });
}
