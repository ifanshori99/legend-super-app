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
// bound S = (saleAt, orderId), forfeit bound = reservations.closed_at. saleAt
// of an `orders` row: pos_orders.completed_at when a POS order exists, else
// orders.fired_at of a QR pay-first order (U3: fired in the same transaction
// as its order.paid), else none (not a sale, e.g. a QR open bill). On equal time the sale counts as earlier than a
// refund or a forfeit, the forfeit as earlier than a refund. Only rows final at
// that moment are read (completed refunds, completed orders, closed
// reservations); nothing here reads a "current" status without a time bound.

import {
  and,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { AccountingError } from "@starter/shared/accounting";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  autoJournalParked,
  domainEventOutbox,
  journalEntries,
  journalLines,
  orderIssueCharges,
  orders,
  paymentIntents,
  paymentRefunds,
  posOrderRefunds,
  posOrderTenders,
  posOrderVoids,
  reservationDepositAllocations,
  reservations,
} from "../db/schema/index.ts";
import {
  AutoJournalDepositCutoverMixed,
  AutoJournalPayloadInvalid,
  AutoJournalReceiptPending,
  boundedKey,
  receiptKeyOf,
} from "./accounting-auto-journal-amounts.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { posDepositRefunds } from "../db/schema/pos-deposit-refund.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";
import {
  netPosTendersOfIntentSql,
  posRefundsOfIntentSql,
} from "./pos-intent-attribution.ts";

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
  | { kind: "sale"; orderId: string }
  /** legend-hxpd5: the order.refunded journal of a POS refund (pos_order_refunds.id). */
  | { kind: "posRefund"; refundId: string }
  /**
   * legend-94q2l: the order.refunded journal of a QR refund opened from a failed
   * order item (ORD-09). refundId is the order_issues.id (the event's refundId).
   */
  | { kind: "qrRefund"; refundId: string }
  /** legend-x1i1h: the order.voided journal of a completed-sale void (orders ULID). */
  | { kind: "void"; orderId: string }
  /** legend-nsvu0: the order_issue.charge_paid journal of a swap-difference charge. */
  | { kind: "charge"; chargeId: string }
  /** legend-nsvu0: the order_issue.charge_refunded journal (refundId = payment_refunds.id). */
  | { kind: "chargeRefund"; refundId: string };

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
    case "posRefund":
    case "qrRefund":
      return boundedKey(`aj:order-refund:${backing.refundId}`);
    case "void":
      return boundedKey(`aj:sale-void:${backing.orderId}`);
    case "charge":
      return boundedKey(`aj:order-charge:${backing.chargeId}`);
    case "chargeRefund":
      return boundedKey(`aj:order-charge-refund:${backing.refundId}`);
  }
}

const fundPayloadId = sql<string>`${domainEventOutbox.event}->'payload'->>'unallocatedFundId'`;
const salePayloadId = sql<string>`${domainEventOutbox.event}->'payload'->>'orderId'`;
const posRefundPayloadId = sql<string>`${domainEventOutbox.event}->'payload'->>'refundId'`;

/**
 * State of every backing journal (cutover/ordering guard), keyed by
 * `backingKeyOf`:
 * - "posted": the journal exists (a sale or POS refund journal: and finance
 *   has not reversed it; a void journal is itself a reversal, which ACC-01
 *   never reverses);
 * - "pending": its event (payment.paid, payment.funds_unallocated, order.paid,
 *   order.refunded, order.voided) is still in the outbox (pending, retrying, dead letter) or the journal is
 *   parked retryable: it can still post;
 * - "none": it will never post by itself (event consumed before the consumer
 *   went live or with accounting off, never emitted, or parked non-retryable;
 *   except a POS refund or void parked AUTO_JOURNAL_SALE_MISSING whose sale
 *   journal finance has not reversed, which is pending).
 * legend-j0ag5: a sale or POS refund journal that finance reversed (ACC-01,
 * journal_entries.reversal_of) is "none": it books nothing, so a check never
 * counts on it (fail closed). The rule also covers void keys, a no-op there. A receipt keeps "posted": its credit
 * is read net of a reversal (postedCreditOf).
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
  const posRefundIds = new Set<string>();
  const voidOrderIds = new Set<string>();
  const chargeIds = new Set<string>();
  const chargeRefundIds = new Set<string>();
  // legend-j0ag5: keys whose journal no longer counts once finance reversed it.
  const reversibleKeys = new Set<string>();
  for (const backing of backings) {
    if (backing.kind === "intent") intentIds.add(backing.intentId);
    else if (backing.kind === "fund") fundIds.add(backing.fundId);
    else {
      reversibleKeys.add(backingKeyOf(backing));
      if (backing.kind === "sale") orderIds.add(backing.orderId);
      else if (backing.kind === "posRefund" || backing.kind === "qrRefund")
        posRefundIds.add(backing.refundId);
      else if (backing.kind === "charge") chargeIds.add(backing.chargeId);
      else if (backing.kind === "chargeRefund")
        chargeRefundIds.add(backing.refundId);
      else voidOrderIds.add(backing.orderId);
    }
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
  if (posRefundIds.size > 0) {
    const rows = await tx
      .select({ refundId: posRefundPayloadId })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          eq(domainEventOutbox.aggregateType, "order"),
          sql`${domainEventOutbox.event}->>'name' = 'order.refunded'`,
          inArray(posRefundPayloadId, [...posRefundIds]),
        ),
      );
    for (const row of rows)
      states.set(
        backingKeyOf({ kind: "posRefund", refundId: row.refundId }),
        "pending",
      );
  }
  if (voidOrderIds.size > 0) {
    const rows = await tx
      .select({ orderId: salePayloadId })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          eq(domainEventOutbox.aggregateType, "order"),
          sql`${domainEventOutbox.event}->>'name' = 'order.voided'`,
          inArray(salePayloadId, [...voidOrderIds]),
        ),
      );
    for (const row of rows)
      states.set(
        backingKeyOf({ kind: "void", orderId: row.orderId }),
        "pending",
      );
  }
  // legend-nsvu0: the charge journal and the charge refund journal wait in the
  // outbox as order_issue.charge_paid / order_issue.charge_refunded.
  const chargeEvents: readonly {
    eventName: string;
    field: string;
    ids: Set<string>;
    backingOf: (id: string) => Backing;
  }[] = [
    {
      eventName: "order_issue.charge_paid",
      field: "chargeId",
      ids: chargeIds,
      backingOf: (chargeId) => ({ kind: "charge", chargeId }),
    },
    {
      eventName: "order_issue.charge_refunded",
      field: "refundId",
      ids: chargeRefundIds,
      backingOf: (refundId) => ({ kind: "chargeRefund", refundId }),
    },
  ];
  for (const { eventName, field, ids, backingOf } of chargeEvents) {
    if (ids.size === 0) continue;
    const idOf = sql<string>`${domainEventOutbox.event}->'payload'->>${field}`;
    const rows = await tx
      .select({ id: idOf })
      .from(domainEventOutbox)
      .where(
        and(
          undelivered,
          sql`${domainEventOutbox.event}->>'name' = ${eventName}`,
          inArray(idOf, [...ids]),
        ),
      );
    for (const row of rows)
      states.set(backingKeyOf(backingOf(row.id)), "pending");
  }
  const keys = [...states.keys()];
  // 2. Then the parked journals: only a retryable one can still post. A POS
  // refund (order.refunded) or a void (order.voided, legend-x1i1h) parked
  // non-retryable AUTO_JOURNAL_SALE_MISSING can too: once its sale posts, the
  // consumer requeues it (legend-3bsyh, requeueSaleDependents). Read as
  // "none", a payout or sale waiting on it would park POSTING_AMOUNTS_MISMATCH
  // non-retryable and stay parked after it posts; as "pending" it parks
  // retryable and the sweep ends it. legend-j0ag5: not when finance reversed
  // that sale journal: it never posts again, so neither does the dependent.
  const saleDependentKeys = new Set([
    ...[...posRefundIds].map((refundId) =>
      backingKeyOf({ kind: "posRefund", refundId }),
    ),
    ...[...voidOrderIds].map((orderId) =>
      backingKeyOf({ kind: "void", orderId }),
    ),
  ]);
  const parked = await tx
    .select({
      key: autoJournalParked.idempotencyKey,
      retryable: autoJournalParked.retryable,
      errorCode: autoJournalParked.errorCode,
      orderId: sql<string | null>`${autoJournalParked.payload}->>'orderId'`,
    })
    .from(autoJournalParked)
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        inArray(autoJournalParked.idempotencyKey, keys),
      ),
    );
  const saleMissing = parked.filter(
    (row) =>
      !row.retryable &&
      saleDependentKeys.has(row.key) &&
      row.errorCode === "AUTO_JOURNAL_SALE_MISSING" &&
      row.orderId !== null,
  );
  const reversedSales = await reversedKeysOf(
    tx,
    tenantId,
    saleMissing.map((row) =>
      backingKeyOf({ kind: "sale", orderId: row.orderId! }),
    ),
  );
  for (const row of parked) if (row.retryable) states.set(row.key, "pending");
  for (const row of saleMissing)
    if (
      !reversedSales.has(backingKeyOf({ kind: "sale", orderId: row.orderId! }))
    )
      states.set(row.key, "pending");
  // 3. Last the journals themselves (they win over pending); a sale, POS
  // refund or void journal finance reversed is "none" (legend-j0ag5).
  const posted = await tx
    .select({ key: journalEntries.idempotencyKey, reversed: reversedSql })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(journalEntries.idempotencyKey, keys),
      ),
    );
  for (const row of posted)
    states.set(
      row.key,
      row.reversed && reversibleKeys.has(row.key) ? "none" : "posted",
    );
  return states;
}

/**
 * Whether a reversal (ACC-01) of the selected journal_entries row exists. The
 * outer columns are spelled out: drizzle renders a column of a single-table
 * select list unqualified, which the subquery would read as its own.
 */
const reversedSql = sql<boolean>`EXISTS (SELECT 1 FROM journal_entries r
  WHERE r.tenant_id = journal_entries.tenant_id AND r.reversal_of = journal_entries.id)`;

/** legend-j0ag5: the keys among `keys` whose journal finance reversed. */
async function reversedKeysOf(
  tx: Tx,
  tenantId: TenantId,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(journalEntries.idempotencyKey, [...keys]),
        reversedSql,
      ),
    );
  return new Set(rows.map((row) => row.key));
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

/** Net booked credit of the original receipt; missing or reversed is zero. */
export async function postedIntentReceiptCreditOf(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
): Promise<bigint> {
  return postedCreditOf(tx, tenantId, receiptKeyOf(intentId));
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
 * Sale time of the `orders` row under SQL alias `o` (see the header): null
 * when the row is not a sale. Read in SQL only (see Bound on precision).
 */
function saleAtOf(o: string) {
  const pos = `FROM pos_orders sp WHERE sp.tenant_id = ${o}.tenant_id AND sp.order_id = ${o}.id`;
  return sql.raw(`(CASE WHEN EXISTS (SELECT 1 ${pos})
    THEN (SELECT sp.completed_at ${pos})
    WHEN ${o}.channel IN ('qr', 'facility') AND ${o}.payment_mode = 'pay_first' THEN ${o}.fired_at
    END)`);
}

/** saleAt of the `orders` table of the enclosing query. */
const saleAt = saleAtOf("orders");

/**
 * The moment a fact is judged at: a payout (refund bound) or a sale. The time
 * is read in SQL from the fact's own row (payment_refunds.completed_at,
 * saleAt of the order), never round-tripped through a JS Date: a Date
 * keeps milliseconds while timestamptz keeps microseconds, so a bound taken
 * from a Date could leave the fact's own row on the wrong side of it.
 */
export type Bound =
  | { kind: "refund"; tenantId: TenantId; refundId: string }
  | { kind: "sale"; tenantId: TenantId; orderId: string }
  /**
   * legend-i83ls: a paid swap-difference charge (order_issue_charges.paid_at).
   * Judged like a sale: refunds and forfeits count only when strictly before it.
   */
  | { kind: "charge"; tenantId: TenantId; chargeId: string };

function timeOf(bound: Bound) {
  switch (bound.kind) {
    case "refund":
      return sql`(SELECT b.completed_at FROM payment_refunds b
          WHERE b.tenant_id = ${bound.tenantId}::uuid AND b.id = ${bound.refundId}::uuid)`;
    case "charge":
      return sql`(SELECT b.paid_at FROM order_issue_charges b
          WHERE b.tenant_id = ${bound.tenantId}::uuid AND b.id = ${bound.chargeId}::uuid)`;
    case "sale":
      return sql`(SELECT ${saleAtOf("b")} FROM orders b
          WHERE b.tenant_id = ${bound.tenantId}::uuid
            AND b.id = ${ulidToUuid(bound.orderId)}::uuid)`;
  }
}

/**
 * Completed refunds that count at `bound` (refund bound: up to itself).
 * (completed_at, id) is a strict total order over completed refunds, and the
 * rows are read, never their journals (legend-41li5). On one intent
 * completed_at never ties and follows commit order: the completion takes the
 * intent lock and a time after its latest fact (lockIntentsForFact), so the
 * intent and fund checks depend on the stored rows only, not on delivery
 * order. Across intents (the DP session check) a completion locks only its
 * own intent: times may tie (the id breaks it) and a refund stamped earlier
 * may commit after a later one was judged, so that check can see fewer
 * refunds than the final rows. The request-time cap (depositInUseOfIntent,
 * locking every DP intent of the session) keeps that from paying out more
 * than the session held; legend-88pky tracks closing it here too.
 */
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

/**
 * POS refunds (pos_order_refunds) that count at `bound` (legend-hxpd5): a POS
 * refund earlier than or at a payout, strictly earlier than a sale.
 */
function posRefundsAt(bound: Bound) {
  return bound.kind === "refund"
    ? sql`${posOrderRefunds.refundedAt} <= ${timeOf(bound)}`
    : sql`${posOrderRefunds.refundedAt} < ${timeOf(bound)}`;
}

/**
 * Completed-sale voids (pos_order_voids) that count at `bound` (legend-x1i1h):
 * like a POS refund, earlier than or at a payout, strictly earlier than a sale.
 */
function voidsAt(bound: Bound) {
  return bound.kind === "refund"
    ? sql`${posOrderVoids.voidedAt} <= ${timeOf(bound)}`
    : sql`${posOrderVoids.voidedAt} < ${timeOf(bound)}`;
}

/** Closed reservations that count at `bound` (forfeit earlier than a refund). */
function forfeitsAt(bound: Bound) {
  const closed = isNotNull(reservations.closedAt);
  return bound.kind === "refund"
    ? and(closed, sql`${reservations.closedAt} <= ${timeOf(bound)}`)
    : and(closed, sql`${reservations.closedAt} < ${timeOf(bound)}`);
}

/**
 * Sales (`orders` rows with a saleAt) that count at `bound`: sale earlier than
 * a refund; between sales, tie-break on orders.id.
 */
function salesAt(bound: Bound) {
  const done = sql`${saleAt} IS NOT NULL`;
  // A sale is earlier than a refund or a charge made at the same instant.
  return bound.kind === "sale"
    ? and(
        done,
        sql`(${saleAt}, ${orders.id}) <= (${timeOf(bound)}, ${ulidToUuid(bound.orderId)}::uuid)`,
      )
    : and(done, sql`${saleAt} <= ${timeOf(bound)}`);
}

/**
 * Paid swap-difference charges (legend-i83ls) that count at `bound`: earlier
 * than or at a refund (the charge is earlier on a tie) and at itself, strictly
 * earlier than a sale (an order sale never uses a charge intent anyway).
 */
function chargesAt(bound: Bound) {
  // legend-v5z4h: a gateway charge refunded in full and then closed `voided`
  // with its order still counts as it did while `paid` (its refund releases
  // the amount again once journalled).
  const paid = and(
    inArray(orderIssueCharges.status, ["paid", "voided"]),
    isNotNull(orderIssueCharges.paidAt),
  );
  return bound.kind === "sale"
    ? and(paid, sql`${orderIssueCharges.paidAt} < ${timeOf(bound)}`)
    : and(paid, sql`${orderIssueCharges.paidAt} <= ${timeOf(bound)}`);
}

const mismatch = (message: string) =>
  new AccountingError("POSTING_AMOUNTS_MISMATCH", message);

// ---------------------------------------------------------------------------
// DP of one table session at a bound (A3 session check, A4)
// ---------------------------------------------------------------------------

/**
 * DP of one table session as it stood at `bound`: its allocation intents, what
 * they still held and the DP its sales had applied.
 * - applied: sales (POS or QR pay-first) made by the bound (salesAt), less DP
 *   returned by a POS refund whose restoring journal is posted;
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
  // Q82: spending a remainder moves the same receipt to another session. A
  // per-session check would count that receipt twice. Follow the bounded
  // session/intent component, then count each receipt and sale exactly once.
  // Keep historical credit-use edges even after an unused credit is returned;
  // returned_idr is mutable and cannot decide a past journal's capacity.
  const creditBefore =
    bound.kind === "refund"
      ? sql`u.created_at <= ${timeOf(bound)}`
      : sql`u.created_at < ${timeOf(bound)}`;
  const component = await tx.execute(sql`
    WITH RECURSIVE sources AS (
      SELECT a.table_session_id AS session_id, a.payment_intent_id AS intent_id
        FROM reservation_deposit_allocations a
       WHERE a.tenant_id = ${tenantId}::uuid
      UNION
      SELECT u.table_session_id, r.payment_intent_id
        FROM reservation_customer_credit_uses u
        JOIN reservation_deposit_remainders r
          ON r.tenant_id = u.tenant_id AND r.id = u.remainder_id
       WHERE u.tenant_id = ${tenantId}::uuid AND ${creditBefore}
    ), connected(node) AS (
      SELECT ${`s:${tableSessionId.toLowerCase()}`}::text
      UNION
      SELECT CASE WHEN c.node = 's:' || s.session_id::text
                  THEN 'i:' || s.intent_id::text
                  ELSE 's:' || s.session_id::text END
        FROM connected c
        JOIN sources s ON c.node = 's:' || s.session_id::text
                       OR c.node = 'i:' || s.intent_id::text
    )
    SELECT substring(c.node from 3) AS id, left(c.node, 1) AS kind,
           EXISTS (SELECT 1 FROM sources s
             WHERE s.session_id = ${tableSessionId}::uuid
               AND 'i:' || s.intent_id::text = c.node) AS direct
      FROM connected c ORDER BY c.node
  `);
  const intentIds = component.rows
    .filter((row) => row.kind === "i" && row.direct === true)
    .map((row) => String(row.id));
  if (intentIds.length === 0) return { intentIds, heldIdr: 0n, appliedIdr: 0n };
  const componentIntentIds = component.rows
    .filter((row) => row.kind === "i")
    .map((row) => String(row.id));
  const sessionIds = component.rows
    .filter((row) => row.kind === "s")
    .map((row) => String(row.id));
  // Serialize journal consumers of a shared receipt in deterministic order.
  // A sale's credit use committed before its sale fact; later uses and sales
  // are excluded by the bound, independently of journal delivery order.
  await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, componentIntentIds),
      ),
    )
    .orderBy(paymentIntents.id)
    .for("update");
  const intents = await tx
    .select({ id: paymentIntents.id, amountIdr: paymentIntents.amountIdr })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, componentIntentIds),
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
        inArray(paymentRefunds.paymentIntentId, componentIntentIds),
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
        inArray(reservations.depositPaymentId, componentIntentIds),
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
  const receiptStates = await backingStatesOf(
    tx,
    tenantId,
    intents.map(({ id }) => ({ kind: "intent", intentId: id })),
  );
  if (intents.length !== componentIntentIds.length)
    throw new AutoJournalPayloadInvalid(
      "Connected DP payment intent not found or never paid",
    );
  const componentReceiptStates = [...receiptStates.values()];
  if (componentReceiptStates.includes("pending"))
    throw new AutoJournalReceiptPending(
      "Connected DP receipt is not booked yet",
    );
  // A pre-cutover receipt still supports the legacy gateway-clearing path,
  // but cannot add capacity to another session's booked customer deposit.
  // The whole connected component must have the same receipt provenance.
  if (
    componentReceiptStates.includes("posted") &&
    componentReceiptStates.includes("none")
  )
    throw new AutoJournalDepositCutoverMixed(
      "Connected DP receipts are partly booked and partly before the cutover",
    );
  let heldIdr = 0n;
  for (const intent of intents) {
    // A posted receipt reversed by finance has no remaining credit. Its
    // payment intent remains paid, so the business amount alone is not
    // sufficient backing for another customer_deposit debit.
    let received = BigInt(intent.amountIdr);
    const receiptKey = receiptKeyOf(intent.id);
    if (receiptStates.get(receiptKey) === "posted") {
      const postedCredit = await postedCreditOf(tx, tenantId, receiptKey);
      if (postedCredit < received) received = postedCredit;
    }
    const held =
      received -
      (refundedBy.get(intent.id) ?? 0n) -
      (forfeitedBy.get(intent.id) ?? 0n);
    if (held > 0n) heldIdr += held;
  }
  const [applied] = await tx
    .select({
      total: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        inArray(orders.tableSessionId, sessionIds),
        salesAt(bound),
      ),
    );
  const releases = await tx
    .select({
      refundId: posDepositRefunds.posRefundId,
      total: sql<string>`sum(${posDepositRefunds.amountIdr})::text`,
    })
    .from(posDepositRefunds)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posDepositRefunds.tenantId),
        eq(orders.id, posDepositRefunds.orderId),
      ),
    )
    .where(
      and(
        eq(posDepositRefunds.tenantId, tenantId),
        inArray(posDepositRefunds.paymentIntentId, componentIntentIds),
        inArray(orders.tableSessionId, sessionIds),
        salesAt(bound),
        bound.kind === "refund"
          ? sql`${posDepositRefunds.releasedAt} <= ${timeOf(bound)}`
          : sql`${posDepositRefunds.releasedAt} < ${timeOf(bound)}`,
      ),
    )
    .groupBy(posDepositRefunds.posRefundId);
  // legend-ayz7q: finance locks the same source entry before reversing it.
  // Take every restoring entry in one stable order and hold it through the
  // payout posting. Read the reversal state in a separate statement after
  // the lock: a statement that waited can retain its old subquery snapshot.
  const releaseKeys = releases.map(({ refundId }) =>
    backingKeyOf({ kind: "posRefund", refundId }),
  );
  const lockedReleases =
    releaseKeys.length === 0
      ? []
      : await tx
          .select({ key: journalEntries.idempotencyKey })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.tenantId, tenantId),
              inArray(journalEntries.idempotencyKey, releaseKeys),
            ),
          )
          .orderBy(journalEntries.id)
          .for("update");
  const lockedReleaseKeys = new Set(lockedReleases.map(({ key }) => key));
  const states = await backingStatesOf(
    tx,
    tenantId,
    releases.map(({ refundId }) => ({ kind: "posRefund", refundId })),
  );
  let appliedIdr = BigInt(applied?.total ?? "0");
  let pendingReleaseIdr = 0n;
  for (const { refundId, total } of releases) {
    const key = backingKeyOf({ kind: "posRefund", refundId });
    const state = states.get(key);
    // A journal committed after the locking statement was absent from its
    // snapshot. It is visible now but unlocked: only a retry may use it.
    if (state === "posted" && !lockedReleaseKeys.has(key))
      throw new AutoJournalReceiptPending(
        "DP return journal appeared after the backing lock; retry to lock it",
      );
    if (state === "posted") appliedIdr -= BigInt(total);
    else if (state === "pending") pendingReleaseIdr += BigInt(total);
  }
  if (appliedIdr < 0n)
    throw mismatch("DP returns exceed what the component sales applied");
  if (appliedIdr > heldIdr && appliedIdr - pendingReleaseIdr <= heldIdr)
    throw new AutoJournalReceiptPending("DP return journal is not posted yet");
  return { intentIds, heldIdr, appliedIdr };
}

/**
 * The charge an order_issue.charge_paid event journals: it must be `paid`
 * (paid_at set), the bound of the charge, else AutoJournalPayloadInvalid.
 */
export async function chargeBoundOf(
  tx: Tx,
  tenantId: TenantId,
  chargeId: string,
): Promise<Bound> {
  const [charge] = await tx
    .select({ paidAt: orderIssueCharges.paidAt })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.id, chargeId),
        // legend-v5z4h: `voided` is a gateway charge refunded in full (or a
        // till charge returned) whose order was voided; it was paid.
        inArray(orderIssueCharges.status, ["paid", "voided"]),
      ),
    );
  if (!charge || charge.paidAt === null)
    throw new AutoJournalPayloadInvalid("Charge is not paid");
  return { kind: "charge", tenantId, chargeId };
}

/**
 * The sale an order.paid event journals: its order must have a saleAt (a
 * completed POS order, or a fired QR pay-first order), the bound S, else
 * AutoJournalPayloadInvalid.
 */
export async function saleBoundOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<Bound> {
  const [sale] = await tx
    .select({ isSale: sql<boolean>`${saleAt} IS NOT NULL` })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
  if (!sale || !sale.isSale)
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
 * What an intent's receipt backs at `bound`: POS tenders of the intent
 * captured by sales made by the bound and not voided by it (legend-x1i1h: a
 * void whose journal posted reversed the sale, crediting the intent's part
 * back to customer_deposit), less the part POS refunds by the bound
 * returned that is attributed to the intent (pos-intent-attribution.ts,
 * legend-hxpd5) + what QR pay-first sales took of it (total - DP when it paid
 * alone, else the part it put toward a bill split over several codes,
 * legend-05cm9) by the bound + forfeits of reservations whose DP it is
 * closed by the bound + completed payouts of the intent by the bound that its
 * receipt backs (a fund payout with its own fund receipt is not one). Tie
 * rules are those of salesAt, forfeitsAt and refundsAt.
 */
async function intentBackedAt(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  bound: Bound,
): Promise<{ backedIdr: bigint; backingPending: boolean }> {
  // legend-x1i1h: a sale of the intent voided by the bound no longer uses it
  // once the void journal posted (it reversed the sale, crediting the
  // intent's part back to customer_deposit). A void that can still post makes
  // the check wait (backingPending); one that never posts (parked
  // non-retryable, e.g. AUTO_JOURNAL_VOID_UNSUPPORTED) keeps the sale counted
  // (fail closed). A void journal is a reversal and is never reversed itself.
  // salesAt is and() of defined parts, never undefined at runtime.
  const madeSales = salesAt(bound)!;
  const voided = (
    await tx
      .selectDistinct({ orderId: posOrderVoids.orderId })
      .from(posOrderVoids)
      .where(
        and(
          eq(posOrderVoids.tenantId, tenantId),
          voidsAt(bound),
          sql`EXISTS (SELECT 1 FROM ${posOrderTenders}
            JOIN ${orders} ON ${orders.tenantId} = ${posOrderTenders.tenantId}
              AND ${orders.id} = ${posOrderTenders.orderId}
            WHERE ${posOrderTenders.tenantId} = ${tenantId}
              AND ${posOrderTenders.orderId} = ${posOrderVoids.orderId}
              AND ${posOrderTenders.status} = 'captured'
              AND ${posOrderTenders.paymentIntentId} = ${intentId}::uuid
              AND ${madeSales})`,
        ),
      )
  ).map((row) => row.orderId);
  const voidStates = await backingStatesOf(
    tx,
    tenantId,
    voided.map((orderId) => ({ kind: "void", orderId })),
  );
  const voidStateOf = (orderId: string) =>
    voidStates.get(backingKeyOf({ kind: "void", orderId })) ?? "none";
  const voidedPosted = voided.filter((id) => voidStateOf(id) === "posted");
  const voidPending = voided.some((id) => voidStateOf(id) === "pending");
  const sales =
    voidedPosted.length === 0
      ? madeSales
      : and(madeSales, notInArray(orders.id, voidedPosted))!;
  // legend-hxpd5: less the gateway part POS refunds of those sales gave back
  // (order.refunded credits it to customer_deposit), attributed to the intent.
  // Only a POS refund whose journal posted counts, like the receipt: one that
  // can still post makes the check wait (backingPending), one that never
  // posts (or finance reversed, legend-j0ag5) is not subtracted (fail closed).
  const filters = { sales, posRefunds: posRefundsAt(bound) };
  const candidates = (
    await tx.execute(posRefundsOfIntentSql(tenantId, intentId, filters))
  ).rows.map((row) => String(row.id));
  const states = await backingStatesOf(
    tx,
    tenantId,
    candidates.map((refundId) => ({ kind: "posRefund", refundId })),
  );
  const stateOf = (refundId: string) =>
    states.get(backingKeyOf({ kind: "posRefund", refundId })) ?? "none";
  const posted = candidates.filter((id) => stateOf(id) === "posted");
  const posRefundPending = candidates.some((id) => stateOf(id) === "pending");
  const tenders = BigInt(
    String(
      (
        await tx.execute(
          netPosTendersOfIntentSql(tenantId, intentId, {
            kind: "ledger",
            sales: filters.sales,
            posRefunds: and(
              filters.posRefunds,
              inArray(posOrderRefunds.id, posted),
            )!,
          }),
        )
      ).rows[0]?.amount ?? "0",
    ),
  );
  // QR pay-first sales carry no tenders: the money taken is total - DP. One
  // code paying alone is pinned (orders.payment_intent_id) and backs all of it.
  // legend-05cm9: a bill split over several codes of the order's payment link
  // pins only the code of the event that fired it; each code backs the part
  // it put toward the bill (its evidence less its unallocated funds, at most
  // total - DP), like
  // qrSaleInUseOfIntent (payment-admin.service.ts). The pinned payer of a split
  // bill backs its part too, not the whole bill its receipt never carried.
  const evidenceOf = (id: SQL) => sql`(
    SELECT coalesce(sum(e.amount_idr), 0) FROM payment_evidence e
      WHERE e.tenant_id = ${tenantId} AND e.payment_intent_id = ${id})
    - (SELECT coalesce(sum(f.amount_idr), 0) FROM payment_unallocated_funds f
      WHERE f.tenant_id = ${tenantId} AND f.payment_intent_id = ${id})`;
  const due = sql`(${orders.totalIdr} - ${orders.depositAppliedIdr})`;
  const qrSaleScope = and(
    eq(orders.tenantId, tenantId),
    sql`(${orders.paymentIntentId} = ${intentId}::uuid
      OR ${orders.paymentLinkId} = (SELECT pi.payment_link_id FROM payment_intents pi
        WHERE pi.tenant_id = ${tenantId} AND pi.id = ${intentId}::uuid))`,
    inArray(orders.channel, ["qr", "facility"]),
    eq(orders.paymentMode, "pay_first"),
    sql`NOT EXISTS (SELECT 1 FROM pos_orders sp
      WHERE sp.tenant_id = ${orders.tenantId} AND sp.order_id = ${orders.id})`,
    salesAt(bound),
  );
  // legend-94q2l: a refund opened from a failed order item (ORD-09) gave part of
  // a QR sale back (order.refunded credits it to customer_deposit). Like a POS
  // refund, it releases the sale only once the journal of its issue posted: one
  // that can still post makes the check wait (backingPending), one that never
  // posts (or finance reversed) releases nothing (fail closed). Per issue the
  // largest amount counts, whatever the refund status (as qrSaleInUseOfIntent).
  // Judged at the bound like a POS refund (posRefundsAt): an issue whose first
  // refund was opened after the bound releases nothing, and its journal
  // does not make the check wait.
  const issueOpenedAt = (issueId: SQL) => {
    const openedAt = sql`(SELECT min(ia.created_at) FROM payment_refunds ia
      WHERE ia.tenant_id = ${tenantId} AND ia.order_issue_id = ${issueId})`;
    return bound.kind === "refund"
      ? sql`${openedAt} <= ${timeOf(bound)}`
      : sql`${openedAt} < ${timeOf(bound)}`;
  };
  const issueCandidates = (
    await tx
      .selectDistinct({
        issueId: sql<string>`order_issues.id::text`,
      })
      .from(orders)
      .innerJoin(
        sql`order_issues`,
        sql`order_issues.tenant_id = ${orders.tenantId} AND order_issues.order_id = ${orders.id}`,
      )
      .where(
        and(
          qrSaleScope,
          sql`EXISTS (SELECT 1 FROM payment_refunds ir
            WHERE ir.tenant_id = ${tenantId} AND ir.order_issue_id = order_issues.id)`,
          issueOpenedAt(sql`order_issues.id`),
        ),
      )
  ).map((row) => row.issueId);
  const issueStates = await backingStatesOf(
    tx,
    tenantId,
    issueCandidates.map((refundId) => ({ kind: "qrRefund", refundId })),
  );
  const issueStateOf = (id: string) =>
    issueStates.get(backingKeyOf({ kind: "qrRefund", refundId: id })) ?? "none";
  const issuesPosted = issueCandidates.filter(
    (id) => issueStateOf(id) === "posted",
  );
  const qrRefundPending = issueCandidates.some(
    (id) => issueStateOf(id) === "pending",
  );
  // Like qrSaleInUseOfIntent, the release frees only the pinned code's part of
  // the sale (orders.payment_intent_id = intentId); other codes keep theirs whole.
  const releasedOf =
    issuesPosted.length === 0
      ? sql`0`
      : sql`(SELECT coalesce(sum(m.amount), 0) FROM (
          SELECT max(ir.amount_idr) AS amount FROM payment_refunds ir
            JOIN order_issues oi ON oi.tenant_id = ir.tenant_id AND oi.id = ir.order_issue_id
            WHERE ir.tenant_id = ${tenantId} AND oi.order_id = ${orders.id}
              AND ${issueOpenedAt(sql`oi.id`)}
              AND oi.id IN (${sql.join(
                issuesPosted.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})
            GROUP BY ir.order_issue_id) m)`;
  const qrSales = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(greatest(
          CASE WHEN ${orders.paymentIntentId} = ${intentId}::uuid
                AND NOT EXISTS (
                  SELECT 1 FROM payment_intents other
                  WHERE other.tenant_id = ${tenantId}
                    AND other.payment_link_id = ${orders.paymentLinkId}
                    AND other.id <> ${intentId}::uuid
                    AND other.status IN ('paid', 'partially_refunded', 'refunded')
                    AND ${evidenceOf(sql`other.id`)} > 0)
            THEN ${due}
            ELSE least(${due}, greatest(${evidenceOf(sql`${intentId}::uuid`)}, 0))
          END - CASE WHEN ${orders.paymentIntentId} = ${intentId}::uuid
            THEN ${releasedOf} ELSE 0 END, 0)), 0)::text`,
      })
      .from(orders)
      .where(qrSaleScope),
  );
  // legend-i83ls: the revenue of a swap-difference charge paid by this intent
  // took its amount out of customer_deposit (order_issue.charge_paid). The
  // charge has its own payment link, so qrSales never sees it.
  const charges = await sumOf(
    tx
      .select({
        total: sql<string>`coalesce(sum(${orderIssueCharges.amountIdr}), 0)::text`,
      })
      .from(orderIssueCharges)
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.paymentIntentId, intentId),
          chargesAt(bound),
        ),
      ),
  );
  // legend-nsvu0: a completed refund of such a charge whose reversal journal
  // posted (order_issue.charge_refunded credited customer_deposit) releases
  // its amount again: its payout is counted below instead. One whose journal
  // can still post makes the check wait; one that never posts (or finance
  // reversed) releases nothing (fail closed).
  const chargeRefundRows = await tx
    .select({ id: paymentRefunds.id, amountIdr: paymentRefunds.amountIdr })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.paymentIntentId, intentId),
        refundsAt(bound),
        // legend-9e21l: the name and refundId predicates below match the
        // partial expression index domain_event_outbox_charge_refunded_idx
        // (0565); keep their text identical.
        sql`EXISTS (SELECT 1 FROM ${domainEventOutbox}
          WHERE ${domainEventOutbox.tenantId} = ${tenantId}
            AND ${domainEventOutbox.destination} = ${EVENT_DESTINATION}
            AND ${domainEventOutbox.event}->>'name' = 'order_issue.charge_refunded'
            AND ${domainEventOutbox.event}->'payload'->>'refundId' = ${paymentRefunds.id}::text)`,
      ),
    );
  const chargeRefundStates = await backingStatesOf(
    tx,
    tenantId,
    chargeRefundRows.map((row) => ({
      kind: "chargeRefund" as const,
      refundId: row.id,
    })),
  );
  const chargeRefundStateOf = (refundId: string) =>
    chargeRefundStates.get(backingKeyOf({ kind: "chargeRefund", refundId })) ??
    "none";
  const chargeRefundReleased = chargeRefundRows
    .filter((row) => chargeRefundStateOf(row.id) === "posted")
    .reduce((sum, row) => sum + BigInt(row.amountIdr), 0n);
  const chargeRefundPending = chargeRefundRows.some(
    (row) => chargeRefundStateOf(row.id) === "pending",
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
  return {
    backedIdr:
      tenders +
      qrSales +
      (charges > chargeRefundReleased ? charges - chargeRefundReleased : 0n) +
      forfeits +
      payouts,
    backingPending:
      posRefundPending || voidPending || qrRefundPending || chargeRefundPending,
  };
}

/**
 * The intent backs more than its receipt at `bound`: a POS refund or void
 * journal that can still post may close the gap (AutoJournalReceiptPending,
 * retryable), else POSTING_AMOUNTS_MISMATCH.
 */
async function assertIntentWithinReceipt(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  bound: Bound,
  receiptCredit: bigint,
  message: string,
): Promise<void> {
  const { backedIdr, backingPending } = await intentBackedAt(
    tx,
    tenantId,
    intentId,
    bound,
  );
  if (backedIdr <= receiptCredit) return;
  if (backingPending)
    throw new AutoJournalReceiptPending(
      "POS refund or void journal of the intent's sale is not posted yet",
    );
  throw mismatch(message);
}

/**
 * A completed payout may not take more out of customer_deposit than its
 * backing receipt put in, judged at its own bound B:
 * - fund backing: the completed payouts of the fund up to B <= the fund receipt;
 * - intent backing: the receipt >= POS tenders of that intent captured by
 *   sales completed by B (tie: sale earlier), less what POS refunds by B
 *   returned of them (legend-hxpd5) + what QR pay-first sales took of it
 *   (total - DP, or its part of a split bill, legend-05cm9) by B + forfeits of reservations whose
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
  await assertIntentWithinReceipt(
    tx,
    tenantId,
    intentId,
    bound,
    receiptCredit,
    "Payout of an intent exceeds its receipt after sales, forfeits and earlier payouts",
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

/**
 * A QR pay-first sale taken out of a posted intent receipt may not take more
 * out of customer_deposit than that receipt put in, judged at its own bound S:
 * the receipt >= what the intent backs at S (this sale included; refunds and
 * forfeits only when strictly before S, since on a tie the sale counts as
 * earlier). Else a refund of the intent final before the sale already took
 * the money back.
 */
export async function assertSaleWithinReceipt(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  saleBound: Bound,
): Promise<void> {
  const receiptCredit = await postedCreditOf(
    tx,
    tenantId,
    backingKeyOf({ kind: "intent", intentId }),
  );
  await assertIntentWithinReceipt(
    tx,
    tenantId,
    intentId,
    saleBound,
    receiptCredit,
    "Sale of an intent exceeds its receipt after earlier sales, forfeits and payouts",
  );
}

/**
 * The revenue of a paid swap-difference charge (legend-i83ls) may not take more
 * out of customer_deposit than its intent receipt put in, judged at the charge
 * bound: the receipt >= what the intent backs there (this charge included;
 * payouts completed strictly before the charge count).
 */
export async function assertChargeWithinReceipt(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  chargeBound: Bound,
): Promise<void> {
  const receiptCredit = await postedCreditOf(
    tx,
    tenantId,
    backingKeyOf({ kind: "intent", intentId }),
  );
  await assertIntentWithinReceipt(
    tx,
    tenantId,
    intentId,
    chargeBound,
    receiptCredit,
    "Charge of an intent exceeds its receipt after earlier payouts",
  );
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
