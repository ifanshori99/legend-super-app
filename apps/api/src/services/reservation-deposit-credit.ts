// legend-e7zj: one rule for what a reservation DP still credits on a seated
// table session, shared by the bill lookup (RSV-02) and the WS-05 refund cap.
//
// - Credit of one allocation = min(allocated amount, what its DP intent still
//   holds). "Holds" is the reservation module's rule (loadHeldDeposit): zero
//   unless the intent is paid / partially_refunded, else min(deposit, intent
//   amount) minus every non-failed refund reserved against the intent
//   (unallocated-fund payouts aside). A refund filed after seating therefore
//   lowers the credit at once, while it is still pending.
// - DP in use of an intent = what the DP paid on its sessions (the larger of
//   the DP non-voided orders applied and the live bill not covered by link
//   payments, for open-bill tables settled from the credit),
//   attributed to this intent after the session's other (net) credits, capped
//   at this allocation's gross amount; refunds of the intent plus that amount
//   never exceed what the intent received (refundableBalance). A refund locks
//   every DP of the sessions involved, since refunding one DP of a table moves
//   the share of the others.
//
// Race (refund vs DP use): the bill reads the credit before it takes the
// session deposit lock (`lockSessionDeposit`, a leaf lock taken after the promo
// locks, legend-94qt), so that lock cannot order a refund against a sale. A
// second advisory lock per DP intent does: the credit lookup takes it SHARED
// (held to commit) before it reads refunds, the refund cap takes it EXCLUSIVE
// under the intent row lock before it reads what orders applied. Either the
// sale reads the committed refund, or the refund sees the committed sale. The
// shared lock is taken by every reader of the credit, before or after the
// promo locks; no refund path takes a promo or session lock, and no credit
// reader locks a DP intent row, so the two cannot wait on each other in a cycle.
import type { TenantId } from "@starter/shared/core";
import { sql } from "drizzle-orm";
import type { Tx } from "./permission-resolver.ts";

/** Advisory key of one DP intent's refund-vs-credit lock. */
function depositIntentLockKey(tenantId: TenantId, intentId: string): string {
  return `deposit-intent:${tenantId}:${intentId.toLowerCase()}`;
}

type AllocationCredit = {
  tableSessionId: string;
  paymentIntentId: string;
  /** min(allocated, what the intent still holds): the bill's credit. */
  creditIdr: bigint;
  /** min(allocated, what the intent took in), refunds not subtracted. */
  grossIdr: bigint;
};

/** Credits of every allocation on the given sessions (see header). */
async function allocationCredits(
  tx: Tx,
  tenantId: TenantId,
  where: { tableSessionId: string } | { paymentIntentId: string },
): Promise<AllocationCredit[]> {
  const filter =
    "tableSessionId" in where
      ? sql`a.table_session_id = ${where.tableSessionId}::uuid`
      : sql`a.table_session_id IN (
          SELECT table_session_id FROM reservation_deposit_allocations
           WHERE tenant_id = ${tenantId} AND payment_intent_id = ${where.paymentIntentId}::uuid)`;
  const result = await tx.execute(sql`
    SELECT a.table_session_id::text AS session_id,
           a.payment_intent_id::text AS intent_id,
           a.amount_idr::text AS allocated,
           CASE WHEN i.status IN ('paid', 'partially_refunded', 'refunded')
                THEN least(r.deposit_idr, i.amount_idr)
                ELSE 0 END::text AS gross,
           CASE WHEN i.status IN ('paid', 'partially_refunded')
                THEN least(r.deposit_idr, i.amount_idr) - coalesce((
                  SELECT sum(f.amount_idr) FROM payment_refunds f
                   WHERE f.tenant_id = a.tenant_id
                     AND f.payment_intent_id = a.payment_intent_id
                     AND f.status <> 'failed'
                     AND f.unallocated_fund_id IS NULL), 0)
                ELSE 0 END::text AS held
      FROM reservation_deposit_allocations a
      JOIN reservations r ON r.tenant_id = a.tenant_id AND r.id = a.reservation_id
      LEFT JOIN payment_intents i
        ON i.tenant_id = a.tenant_id AND i.id = a.payment_intent_id
     WHERE a.tenant_id = ${tenantId} AND ${filter}
     ORDER BY a.payment_intent_id
  `);
  return result.rows.map((row) => {
    const allocated = BigInt(String(row.allocated));
    const held = BigInt(String(row.held ?? "0"));
    const gross = BigInt(String(row.gross ?? "0"));
    const credit = held < allocated ? held : allocated;
    const grossCredit = gross < allocated ? gross : allocated;
    return {
      tableSessionId: String(row.session_id),
      paymentIntentId: String(row.intent_id),
      creditIdr: credit > 0n ? credit : 0n,
      grossIdr: grossCredit > 0n ? grossCredit : 0n,
    };
  });
}

/** RSV-02 credit of a table session: the sum of its allocation credits. */
export async function sessionDepositCredit(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<number> {
  const intents = await tx.execute(sql`
    SELECT DISTINCT payment_intent_id::text AS intent_id
      FROM reservation_deposit_allocations
     WHERE tenant_id = ${tenantId} AND table_session_id = ${tableSessionId}::uuid
     ORDER BY 1
  `);
  if (intents.rows.length === 0) return 0;
  // Ascending intent id, so two readers never take them in opposite orders.
  for (const row of intents.rows)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${depositIntentLockKey(tenantId, String(row.intent_id))}, 0))`,
    );
  const credits = await allocationCredits(tx, tenantId, { tableSessionId });
  const total = credits.reduce((sum, row) => sum + row.creditIdr, 0n);
  return Number(total);
}

/**
 * DP of `intentId` that already paid its sessions' bills (header: applied or
 * uncovered open bill, after the session's other DPs, capped at this
 * allocation's gross amount); 0 when the intent backs no seated session. With
 * `lock` (writers, the caller holding the intent row lock) it first takes the
 * lock of every DP intent on those sessions exclusive, ascending; a read-only
 * listing passes false and gets an unlocked estimate.
 */
export async function depositInUseOfIntent(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  { lock = true }: { lock?: boolean } = {},
): Promise<bigint> {
  if (lock) {
    // Every DP of the sessions this intent backs, ascending: a refund of a
    // second DP on the same table moves this one's share (see below).
    const intents = await tx.execute(sql`
      SELECT DISTINCT payment_intent_id::text AS intent_id
        FROM reservation_deposit_allocations
       WHERE tenant_id = ${tenantId}
         AND table_session_id IN (
           SELECT table_session_id FROM reservation_deposit_allocations
            WHERE tenant_id = ${tenantId} AND payment_intent_id = ${intentId}::uuid)
    `);
    const ids = [
      ...new Set([
        intentId.toLowerCase(),
        ...intents.rows.map((row) => String(row.intent_id).toLowerCase()),
      ]),
    ].sort();
    for (const id of ids)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${depositIntentLockKey(tenantId, id)}, 0))`,
      );
  }
  const credits = await allocationCredits(tx, tenantId, {
    paymentIntentId: intentId,
  });
  if (credits.length === 0) return 0n;
  const sessionIds = [...new Set(credits.map((row) => row.tableSessionId))];
  // What the DP paid on each session: the larger of what orders applied
  // (pay-first QR, POS) and the bill not covered by verified link payments
  // or captured POS tenders.
  // Open-bill QR orders apply nothing themselves; the session credit settles
  // them (qr-order.service.ts settlementOf, close at outstanding 0), so their
  // bill counts too, the unpaid part of an open table included (earmarked).
  const used = await tx.execute(sql`
    SELECT o.table_session_id::text AS session_id,
           coalesce(sum(o.deposit_applied_idr), 0)::text AS applied,
           (coalesce(sum(o.total_idr), 0) - coalesce(sum(l.paid_idr), 0)
             - coalesce(sum(t.captured), 0))::text AS uncovered
      FROM orders o
      LEFT JOIN payment_links l
        ON l.tenant_id = o.tenant_id AND l.id = o.payment_link_id
      LEFT JOIN LATERAL (
        SELECT sum(pt.amount_idr) AS captured
          FROM pos_order_tenders pt
         WHERE pt.tenant_id = o.tenant_id AND pt.order_id = o.id
           AND pt.status = 'captured') t ON true
     WHERE o.tenant_id = ${tenantId}
       AND o.table_session_id IN (${sql.join(
         sessionIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND o.status <> 'voided'
     GROUP BY o.table_session_id
  `);
  const usedBy = new Map(
    used.rows.map((row) => {
      const applied = BigInt(String(row.applied));
      const uncovered = BigInt(String(row.uncovered));
      return [
        String(row.session_id),
        applied > uncovered ? applied : uncovered,
      ];
    }),
  );
  let inUse = 0n;
  for (const sessionId of sessionIds) {
    const inSession = credits.filter((row) => row.tableSessionId === sessionId);
    // Gross, not net of this intent's own refunds: the caller compares its
    // refunds (pending ones included) plus this in-use amount to what it
    // received, so subtracting them here would let an approval through.
    const own = inSession
      .filter((row) => row.paymentIntentId === intentId)
      .reduce((sum, row) => sum + row.grossIdr, 0n);
    const others = inSession
      .filter((row) => row.paymentIntentId !== intentId)
      .reduce((sum, row) => sum + row.creditIdr, 0n);
    // The session's other DPs are used first; what is left comes from this one.
    const fromThis = (usedBy.get(sessionId) ?? 0n) - others;
    inUse += fromThis <= 0n ? 0n : fromThis > own ? own : fromThis;
  }
  return inUse;
}
