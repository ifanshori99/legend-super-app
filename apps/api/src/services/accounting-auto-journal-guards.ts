// Auto-journal guards (legend-9pz9, design docs/design/auto-journals.md
// section 10). Two families, both pure reads:
//
// 1. Backing state: is the journal a fact depends on (intent receipt, fund
//    receipt, sale) posted, still able to post, or never going to post.
// 2. Time-bound amount checks: a payout, a forfeit and a sale each see only
//    the historical facts that were final at their own moment, so the verdict
//    is the same whichever order the events are delivered in.
//
// Time bounds: refund bound B = (payment_refunds.completed_at, refundId), sale
// bound S = (pos_orders.completed_at, orderId), forfeit bound =
// reservations.closed_at. On equal time the sale counts as earlier than a
// refund or a forfeit, the forfeit as earlier than a refund. Only rows final at
// that moment are read (completed refunds, completed orders, closed
// reservations); nothing here reads a "current" status without a time bound.

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { AccountingError } from "@starter/shared/accounting";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  autoJournalParked,
  domainEventOutbox,
  journalEntries,
  journalLines,
  orders,
  paymentIntents,
  paymentRefunds,
  posOrders,
  posOrderTenders,
  reservationDepositAllocations,
  reservations,
} from "../db/schema/index.ts";
import {
  AutoJournalPayloadInvalid,
  boundedKey,
  receiptKeyOf,
} from "./accounting-auto-journal-amounts.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

/** DP intents that took money: their receipts decide where the DP sits. */
export const DP_INTENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const;

// ---------------------------------------------------------------------------
// Backing state (A1)
// ---------------------------------------------------------------------------

/** The journal a fact stands on. */
export type Backing =
  | { kind: "intent"; intentId: string }
  | { kind: "fund"; fundId: string; intentId: string }
  | { kind: "sale"; orderId: string };

export type BackingState = "posted" | "pending" | "none";

/** Idempotency key of the journal behind `backing`. */
export function backingKeyOf(backing: Backing): string {
  switch (backing.kind) {
    case "intent":
      return receiptKeyOf(backing.intentId);
    case "fund":
      return boundedKey(`aj:receipt-fund:${backing.fundId}`);
    case "sale":
      return boundedKey(`aj:sale:${backing.orderId}`);
  }
}

const fundPayloadId = sql<string>`${domainEventOutbox.event}->'payload'->>'unallocatedFundId'`;
const salePayloadId = sql<string>`${domainEventOutbox.event}->'payload'->>'orderId'`;

/**
 * State of every backing journal (cutover/ordering guard), keyed by
 * `backingKeyOf`:
 * - "posted": the journal exists;
 * - "pending": its event (payment.paid, payment.funds_unallocated, order.paid)
 *   is still in the outbox (pending, retrying, dead letter) or the journal is
 *   parked retryable: it can still post;
 * - "none": it will never post by itself (event consumed before the consumer
 *   went live or with accounting off, never emitted, or parked non-retryable).
 * Read order outbox, parked, journals: each later source is written by the
 * same transaction that clears the earlier one (consumption marks the outbox
 * row delivered with the journal or its parked row; the sweep inserts the
 * journal and deletes the parked row), so under read committed a journal that
 * commits between two reads is seen as pending or posted, never as none.
 */
export async function backingStatesOf(
  tx: Tx,
  tenantId: TenantId,
  backings: readonly Backing[],
): Promise<Map<string, BackingState>> {
  const states = new Map<string, BackingState>(
    backings.map((backing) => [backingKeyOf(backing), "none"]),
  );
  if (states.size === 0) return states;
  const intentIds = new Set<string>();
  const fundIds = new Set<string>();
  const orderIds = new Set<string>();
  for (const backing of backings) {
    if (backing.kind === "intent") intentIds.add(backing.intentId);
    else if (backing.kind === "fund") fundIds.add(backing.fundId);
    else orderIds.add(backing.orderId);
  }
  const undelivered = and(
    eq(domainEventOutbox.tenantId, tenantId),
    eq(domainEventOutbox.destination, EVENT_DESTINATION),
    ne(domainEventOutbox.status, "delivered"),
  );
  // 1. Outbox first (see the ordering note above).
  if (intentIds.size > 0) {
    const rows = await tx
      .select({ intentId: domainEventOutbox.aggregateId })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          eq(domainEventOutbox.aggregateType, "payment"),
          inArray(domainEventOutbox.aggregateId, [...intentIds]),
          sql`${domainEventOutbox.event}->>'name' = 'payment.paid'`,
        ),
      );
    for (const row of rows) states.set(receiptKeyOf(row.intentId), "pending");
  }
  if (fundIds.size > 0) {
    const rows = await tx
      .select({ fundId: fundPayloadId })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          eq(domainEventOutbox.aggregateType, "payment"),
          sql`${domainEventOutbox.event}->>'name' = 'payment.funds_unallocated'`,
          inArray(fundPayloadId, [...fundIds]),
        ),
      );
    for (const row of rows)
      states.set(
        backingKeyOf({ kind: "fund", fundId: row.fundId, intentId: "" }),
        "pending",
      );
  }
  if (orderIds.size > 0) {
    const rows = await tx
      .select({ orderId: salePayloadId })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          eq(domainEventOutbox.aggregateType, "order"),
          sql`${domainEventOutbox.event}->>'name' = 'order.paid'`,
          inArray(salePayloadId, [...orderIds]),
        ),
      );
    for (const row of rows)
      states.set(
        backingKeyOf({ kind: "sale", orderId: row.orderId }),
        "pending",
      );
  }
  const keys = [...states.keys()];
  // 2. Then the parked journals: only a retryable one can still post.
  const parked = await tx
    .select({
      key: autoJournalParked.idempotencyKey,
      retryable: autoJournalParked.retryable,
    })
    .from(autoJournalParked)
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        inArray(autoJournalParked.idempotencyKey, keys),
      ),
    );
  for (const row of parked) if (row.retryable) states.set(row.key, "pending");
  // 3. Last the journals themselves (they win over pending).
  const posted = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(journalEntries.idempotencyKey, keys),
      ),
    );
  for (const row of posted) states.set(row.key, "posted");
  return states;
}

export async function backingStateOf(
  tx: Tx,
  tenantId: TenantId,
  backing: Backing,
): Promise<BackingState> {
  const states = await backingStatesOf(tx, tenantId, [backing]);
  return states.get(backingKeyOf(backing)) ?? "none";
}

/** Id of the journal entry posted under `idempotencyKey`, or null. */
export async function postedEntryIdOf(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<string | null> {
  const [entry] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return entry?.id ?? null;
}

/**
 * Credit total of the journal posted under `idempotencyKey` (0 when none, or
 * when finance reversed it: ACC-01 reverses an entry whole, so a reversed
 * receipt backs nothing).
 */
async function postedCreditOf(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<bigint> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${journalLines.creditIdr}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, idempotencyKey),
        sql`NOT EXISTS (SELECT 1 FROM journal_entries r
          WHERE r.tenant_id = ${tenantId}::uuid AND r.reversal_of = ${journalEntries.id})`,
      ),
    );
  return BigInt(row?.total ?? "0");
}

/**
 * Whether the fund has its own receipt event (payment.funds_unallocated), in
 * any outbox status. A fund the intent's payment.paid already counts
 * (payment.service.ts) has none: its money sits in the intent receipt.
 */
async function fundReceiptEventExists(
  tx: Tx,
  tenantId: TenantId,
  fundId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: domainEventOutbox.id })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "payment"),
        sql`${domainEventOutbox.event}->>'name' = 'payment.funds_unallocated'`,
        eq(fundPayloadId, fundId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Receipt a payment.refunded payout is paid out of (A2). */
export async function payoutBackingOf(
  tx: Tx,
  tenantId: TenantId,
  refund: { intentId: string; unallocatedFundId: string | null },
): Promise<Backing> {
  if (
    refund.unallocatedFundId !== null &&
    (await fundReceiptEventExists(tx, tenantId, refund.unallocatedFundId))
  )
    return {
      kind: "fund",
      fundId: refund.unallocatedFundId,
      intentId: refund.intentId,
    };
  return { kind: "intent", intentId: refund.intentId };
}

// ---------------------------------------------------------------------------
// Time bounds
// ---------------------------------------------------------------------------

/**
 * The moment a fact is judged at: a payout (refund bound) or a sale. The time
 * is read in SQL from the fact's own row (payment_refunds.completed_at,
 * pos_orders.completed_at), never round-tripped through a JS Date: a Date
 * keeps milliseconds while timestamptz keeps microseconds, so a bound taken
 * from a Date could leave the fact's own row on the wrong side of it.
 */
export type Bound =
  | { kind: "refund"; tenantId: TenantId; refundId: string }
  | { kind: "sale"; tenantId: TenantId; orderId: string };

function timeOf(bound: Bound) {
  return bound.kind === "refund"
    ? sql`(SELECT b.completed_at FROM payment_refunds b
          WHERE b.tenant_id = ${bound.tenantId}::uuid AND b.id = ${bound.refundId}::uuid)`
    : sql`(SELECT b.completed_at FROM pos_orders b
          WHERE b.tenant_id = ${bound.tenantId}::uuid
            AND b.order_id = ${ulidToUuid(bound.orderId)}::uuid)`;
}

/** Completed refunds that count at `bound` (refund bound: up to itself). */
function refundsAt(bound: Bound) {
  const done = and(
    eq(paymentRefunds.status, "completed"),
    isNotNull(paymentRefunds.completedAt),
  );
  return bound.kind === "refund"
    ? and(
        done,
        sql`(${paymentRefunds.completedAt}, ${paymentRefunds.id}) <= (${timeOf(bound)}, ${bound.refundId}::uuid)`,
      )
    : and(done, sql`${paymentRefunds.completedAt} < ${timeOf(bound)}`);
}

/** Closed reservations that count at `bound` (forfeit earlier than a refund). */
function forfeitsAt(bound: Bound) {
  const closed = isNotNull(reservations.closedAt);
  return bound.kind === "refund"
    ? and(closed, sql`${reservations.closedAt} <= ${timeOf(bound)}`)
    : and(closed, sql`${reservations.closedAt} < ${timeOf(bound)}`);
}

/** Completed sales that count at `bound` (sale earlier than a refund). */
function salesAt(bound: Bound) {
  const done = isNotNull(posOrders.completedAt);
  return bound.kind === "refund"
    ? and(done, sql`${posOrders.completedAt} <= ${timeOf(bound)}`)
    : and(
        done,
        sql`(${posOrders.completedAt}, ${posOrders.orderId}) <= (${timeOf(bound)}, ${ulidToUuid(bound.orderId)}::uuid)`,
      );
}

const mismatch = (message: string) =>
  new AccountingError("POSTING_AMOUNTS_MISMATCH", message);

// ---------------------------------------------------------------------------
// DP of one table session at a bound (A3 session check, A4)
// ---------------------------------------------------------------------------

/**
 * DP of one table session as it stood at `bound`: its allocation intents, what
 * they still held and the DP its sales had applied.
 * - applied: orders completed by the bound (salesAt);
 * - held: every intent that took money (paid / partially_refunded / refunded,
 *   a status that never reverts) minus the completed non-fund refunds and the
 *   forfeits of the reservation that took it by the bound.
 */
export async function sessionDepositAt(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
  bound: Bound,
): Promise<{ intentIds: string[]; heldIdr: bigint; appliedIdr: bigint }> {
  const allocations = await tx
    .select({ paymentIntentId: reservationDepositAllocations.paymentIntentId })
    .from(reservationDepositAllocations)
    .where(
      and(
        eq(reservationDepositAllocations.tenantId, tenantId),
        eq(reservationDepositAllocations.tableSessionId, tableSessionId),
      ),
    );
  const intentIds = [...new Set(allocations.map((row) => row.paymentIntentId))];
  if (intentIds.length === 0) return { intentIds, heldIdr: 0n, appliedIdr: 0n };
  const intents = await tx
    .select({ id: paymentIntents.id, amountIdr: paymentIntents.amountIdr })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, intentIds),
        inArray(paymentIntents.status, [...DP_INTENT_STATUSES]),
      ),
    );
  const refunds = await tx
    .select({
      intentId: paymentRefunds.paymentIntentId,
      total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        inArray(paymentRefunds.paymentIntentId, intentIds),
        sql`${paymentRefunds.unallocatedFundId} IS NULL`,
        refundsAt(bound),
      ),
    )
    .groupBy(paymentRefunds.paymentIntentId);
  const forfeits = await tx
    .select({
      intentId: reservations.depositPaymentId,
      total: sql<string>`coalesce(sum(${reservations.depositForfeitedIdr}), 0)::text`,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, tenantId),
        inArray(reservations.depositPaymentId, intentIds),
        forfeitsAt(bound),
      ),
    )
    .groupBy(reservations.depositPaymentId);
  const refundedBy = new Map(
    refunds.map((row) => [row.intentId, BigInt(row.total)]),
  );
  const forfeitedBy = new Map(
    forfeits.map((row) => [row.intentId, BigInt(row.total)]),
  );
  let heldIdr = 0n;
  for (const intent of intents) {
    const held =
      BigInt(intent.amountIdr) -
      (refundedBy.get(intent.id) ?? 0n) -
      (forfeitedBy.get(intent.id) ?? 0n);
    if (held > 0n) heldIdr += held;
  }
  const [applied] = await tx
    .select({
      total: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
    })
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
        eq(orders.tableSessionId, tableSessionId),
        salesAt(bound),
      ),
    );
  return { intentIds, heldIdr, appliedIdr: BigInt(applied?.total ?? "0") };
}

/**
 * The sale an order.paid event journals: it must be a completed POS order with
 * a completion time (the bound S), else AutoJournalPayloadInvalid.
 */
export async function saleBoundOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<Bound> {
  const [sale] = await tx
    .select({ completedAt: posOrders.completedAt })
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, orderId)),
    );
  if (!sale || sale.completedAt === null)
    throw new AutoJournalPayloadInvalid("Sale order is not completed");
  return { kind: "sale", tenantId, orderId };
}

// ---------------------------------------------------------------------------
// Payout amount check (A3)
// ---------------------------------------------------------------------------

async function sumOf(rows: PromiseLike<{ total: string }[]>): Promise<bigint> {
  const [row] = await rows;
  return BigInt(row?.total ?? "0");
}

/**
 * A completed payout may not take more out of customer_deposit than its
 * backing receipt put in, judged at its own bound B:
 * - fund backing: the completed payouts of the fund up to B <= the fund receipt;
 * - intent backing: the receipt >= POS tenders of that intent captured by
 *   sales completed by B (tie: sale earlier) + forfeits of reservations whose
 *   DP it is closed by B + every completed payout of the intent up to B that
 *   its receipt backs (this one included; a fund payout with its own fund
 *   receipt is not one);
 * - a non-fund payout of a DP intent also keeps the session DP check: the DP
 *   its sales applied by B may not exceed what the session intents still held.
 */
export async function assertPayoutWithinReceipt(
  tx: Tx,
  tenantId: TenantId,
  backing: Backing,
  refund: {
    refundId: string;
    completedAt: Date;
    intentId: string;
    unallocatedFundId: string | null;
  },
): Promise<void> {
  const bound: Bound = { kind: "refund", tenantId, refundId: refund.refundId };
  const receiptCredit = await postedCreditOf(
    tx,
    tenantId,
    backingKeyOf(backing),
  );
  if (backing.kind === "fund") {
    const paidOut = await sumOf(
      tx
        .select({
          total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
        })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            eq(paymentRefunds.unallocatedFundId, backing.fundId),
            refundsAt(bound),
          ),
        ),
    );
    if (paidOut > receiptCredit)
      throw mismatch("Payouts of an unallocated fund exceed its receipt");
    return;
  }
  if (backing.kind !== "intent") return;
  const intentId = backing.intentId;
  const tenders = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)::text`,
      })
      .from(posOrderTenders)
      .innerJoin(
        posOrders,
        and(
          eq(posOrders.tenantId, posOrderTenders.tenantId),
          eq(posOrders.orderId, posOrderTenders.orderId),
        ),
      )
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.paymentIntentId, intentId),
          eq(posOrderTenders.status, "captured"),
          salesAt(bound),
        ),
      ),
  );
  const forfeits = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(${reservations.depositForfeitedIdr}), 0)::text`,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.depositPaymentId, intentId),
          forfeitsAt(bound),
        ),
      ),
  );
  const payouts = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
      })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.paymentIntentId, intentId),
          // A fund with its own receipt event is paid out of that receipt.
          sql`(${paymentRefunds.unallocatedFundId} IS NULL OR NOT EXISTS (
            SELECT 1 FROM ${domainEventOutbox}
            WHERE ${domainEventOutbox.tenantId} = ${tenantId}
              AND ${domainEventOutbox.destination} = ${EVENT_DESTINATION}
              AND ${domainEventOutbox.aggregateType} = 'payment'
              AND ${domainEventOutbox.event}->>'name' = 'payment.funds_unallocated'
              AND ${fundPayloadId} = ${paymentRefunds.unallocatedFundId}::text))`,
          refundsAt(bound),
        ),
      ),
  );
  if (tenders + forfeits + payouts > receiptCredit)
    throw mismatch(
      "Payout of an intent exceeds its receipt after POS tenders, forfeits and earlier payouts",
    );
  if (refund.unallocatedFundId !== null) return;
  const sessions = await tx
    .selectDistinct({
      tableSessionId: reservationDepositAllocations.tableSessionId,
    })
    .from(reservationDepositAllocations)
    .where(
      and(
        eq(reservationDepositAllocations.tenantId, tenantId),
        eq(reservationDepositAllocations.paymentIntentId, intentId),
      ),
    );
  for (const { tableSessionId } of sessions) {
    const { heldIdr, appliedIdr } = await sessionDepositAt(
      tx,
      tenantId,
      tableSessionId,
      bound,
    );
    if (appliedIdr > heldIdr)
      throw mismatch("Refund of a DP that a completed sale already applied");
  }
}

// ---------------------------------------------------------------------------
// Forfeit amount check (A5)
// ---------------------------------------------------------------------------

/**
 * A forfeit plus the completed non-fund refunds of the same DP intent that
 * were final before the close (completed_at < closed_at; on a tie the forfeit
 * counts as earlier, so the refund is the one that parks) may not exceed what
 * the intent took.
 */
export async function assertForfeitWithinIntent(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  forfeitedIdr: number,
  reservationId: string,
): Promise<void> {
  const [intent] = await tx
    .select({ amountIdr: paymentIntents.amountIdr })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  if (!intent)
    throw new AutoJournalPayloadInvalid("DP payment intent not found");
  const refunded = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
      })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.paymentIntentId, intentId),
          sql`${paymentRefunds.unallocatedFundId} IS NULL`,
          eq(paymentRefunds.status, "completed"),
          isNotNull(paymentRefunds.completedAt),
          // The close time is read from the row (see Bound on precision).
          sql`${paymentRefunds.completedAt} < (SELECT r.closed_at FROM reservations r
            WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ${reservationId}::uuid)`,
        ),
      ),
  );
  if (BigInt(forfeitedIdr) + refunded > BigInt(intent.amountIdr))
    throw mismatch("DP forfeit and earlier refunds exceed the DP intent");
}
