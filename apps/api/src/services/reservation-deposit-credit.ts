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
// - Credit moved to another session (reservation_customer_credit_uses) is
//   capped by the source intent's net (legend-svwdz, see transferredCreditPools).
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
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "./permission-resolver.ts";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";

/** Advisory key of one DP intent's refund-vs-credit lock. */
function depositIntentLockKey(tenantId: TenantId, intentId: string): string {
  return `deposit-intent:${tenantId}:${intentId.toLowerCase()}`;
}

/**
 * Principal no longer usable on a bill: every non-failed WS-05 reservation,
 * plus each permanent POS DP return not covered by its exact WS-05 request.
 * Aggregate MAX is unsafe when an earlier manual refund and a failed POS
 * request are different liabilities. Only the original mirror key, refund id
 * and intent prove that the same principal has already been counted.
 * Arguments are SQL identifiers supplied by our callers, never user text.
 */
export function depositPrincipalReservedSql(tenant: SQL, intent: SQL): SQL {
  return sql`(
    coalesce((SELECT sum(dp_refund.amount_idr) FROM payment_refunds dp_refund
      WHERE dp_refund.tenant_id=${tenant} AND dp_refund.payment_intent_id=${intent}
        AND dp_refund.status<>'failed' AND dp_refund.unallocated_fund_id IS NULL),0)
    + coalesce((SELECT sum(greatest(dp_return.amount_idr-coalesce((
      SELECT least(dp_return.amount_idr,dp_mirror.amount_idr)
      FROM payment_admin_idempotency dp_key JOIN payment_refunds dp_mirror
        ON dp_mirror.tenant_id=dp_key.tenant_id
        AND dp_mirror.id::text=dp_key.response->>'refundId'
      WHERE dp_key.tenant_id=dp_return.tenant_id
        AND dp_key.key='pos-refund-gateway:'||dp_return.pos_refund_id::text||':'||dp_return.payment_intent_id::text
        AND dp_mirror.payment_intent_id=dp_return.payment_intent_id
        AND dp_mirror.status<>'failed' AND dp_mirror.unallocated_fund_id IS NULL
      LIMIT 1),0),0)) FROM pos_deposit_refunds dp_return
      WHERE dp_return.tenant_id=${tenant} AND dp_return.payment_intent_id=${intent}),0)
  )`;
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
           -- legend-30hfs: money the provider refunded outside our own refunds
           -- is not credit; a flagged refund-after-paid intent credits 0.
           CASE WHEN i.status IN ('paid', 'partially_refunded')
                  AND i.provider_refunded_after_paid_at IS NULL
                THEN greatest(least(r.deposit_idr, i.amount_idr)
                  - ${depositPrincipalReservedSql(sql`a.tenant_id`, sql`a.payment_intent_id`)}
                  - ${providerRefundedForeignIdrSql(sql`a.tenant_id`, sql`a.payment_intent_id`)} - coalesce((
                  SELECT sum(c.amount_idr) FROM reservation_deposit_remainders c
                   WHERE c.tenant_id = a.tenant_id
                     AND c.payment_intent_id = a.payment_intent_id
                     AND c.table_session_id = a.table_session_id
                     AND c.kind = 'customer_credit'), 0), 0)
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

/**
 * legend-svwdz (1020): what the credit moved to other sessions
 * (reservation_customer_credit_uses) may still be worth. The source intent
 * holds, for the transferred credit, the sum of its customer_credit
 * remainders (what the first sessions left over) minus the provider refunds
 * made AFTER those remainders: a remainder is already net of what the provider
 * had refunded when its session closed (`provider_refunded_snapshot_idr`), so
 * only the growth since then comes off again, measured from the smallest
 * snapshot (restrictive; created_at is not used, the refund recorder does not
 * hold the deposit-intent lock). With `liveOnly`, an intent that is not paid /
 * partially refunded, or is flagged refunded after paid, holds nothing; the
 * refund guard passes false and keeps its stricter gross view. Floor 0.
 */
async function transferredCreditPools(
  tx: Tx,
  tenantId: TenantId,
  intentIds: string[],
  liveOnly: boolean,
): Promise<Map<string, bigint>> {
  const pools = new Map<string, bigint>();
  if (intentIds.length === 0) return pools;
  const result = await tx.execute(sql`
    SELECT i.id::text AS intent_id,
           (i.status IN ('paid', 'partially_refunded')
             AND i.provider_refunded_after_paid_at IS NULL) AS live,
           coalesce((SELECT sum(x.amount_idr) FROM reservation_deposit_remainders x
             WHERE x.tenant_id = i.tenant_id AND x.payment_intent_id = i.id
               AND x.kind = 'customer_credit'), 0)::text AS credit,
           coalesce((SELECT min(x.provider_refunded_snapshot_idr) FROM reservation_deposit_remainders x
             WHERE x.tenant_id = i.tenant_id AND x.payment_intent_id = i.id
               AND x.kind = 'customer_credit'), 0)::text AS snapshot,
           ${providerRefundedForeignIdrSql(sql`i.tenant_id`, sql`i.id`)}::text AS provider
      FROM payment_intents i
     WHERE i.tenant_id = ${tenantId}
       AND i.id IN (${sql.join(
         intentIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
  `);
  for (const row of result.rows) {
    const refundedSince =
      BigInt(String(row.provider)) - BigInt(String(row.snapshot));
    const net =
      BigInt(String(row.credit)) - (refundedSince > 0n ? refundedSince : 0n);
    const pool = liveOnly && row.live !== true ? 0n : net > 0n ? net : 0n;
    pools.set(String(row.intent_id), pool);
  }
  return pools;
}

/**
 * Recon flags of every credit use of one source intent (any session, closed
 * ones included), judged against the intent's current pool in the same
 * (created_at, id) order as effectiveCreditUseIdr. A use the pool no longer
 * covers gets a flag; an existing flag whose values changed is updated, so a
 * later provider refund is not frozen out. The used value is never cut; finance
 * looks at the row (legend-svwdz, 1020). Called where a provider refund is
 * recorded (same transaction) and when a session's credit is read.
 */
export async function flagCreditReconForIntent(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
): Promise<void> {
  const pool = (
    await transferredCreditPools(tx, tenantId, [intentId], true)
  ).get(intentId.toLowerCase());
  if (pool === undefined) return;
  const uses = await tx.execute(sql`
    SELECT u.id::text AS use_id, u.table_session_id::text AS session_id,
           (u.amount_idr - u.returned_idr)::text AS amount
      FROM reservation_customer_credit_uses u
      JOIN reservation_deposit_remainders x
        ON x.tenant_id = u.tenant_id AND x.id = u.remainder_id
     WHERE u.tenant_id = ${tenantId} AND x.payment_intent_id = ${intentId}::uuid
     ORDER BY u.created_at, u.id`);
  let left = pool;
  for (const row of uses.rows) {
    const used = BigInt(String(row.amount));
    if (used <= 0n) continue;
    const effective = used < left ? used : left;
    left -= effective;
    if (effective >= used) continue;
    await tx.execute(sql`
      INSERT INTO reservation_credit_recon_flags
        (tenant_id, credit_use_id, payment_intent_id, table_session_id,
         used_idr, effective_idr)
      VALUES (${tenantId}, ${String(row.use_id)}::uuid, ${intentId}::uuid,
              ${String(row.session_id)}::uuid, ${used.toString()}::bigint,
              ${effective.toString()}::bigint)
      ON CONFLICT (tenant_id, credit_use_id) DO UPDATE
        SET used_idr = excluded.used_idr, effective_idr = excluded.effective_idr
        WHERE reservation_credit_recon_flags.used_idr <> excluded.used_idr
           OR reservation_credit_recon_flags.effective_idr <> excluded.effective_idr`);
  }
}

/**
 * What the credit uses of one session are worth after the source intent's
 * pool (see transferredCreditPools): every use of the intent's remainders, in
 * every session, takes from the pool in (created_at, id) order with a running
 * cap, so the same net value is never counted for two sessions. A use the pool
 * no longer covers is reduced, never negative; the difference is only flagged
 * for reconciliation (log), nothing is deducted from what was already spent.
 */
async function effectiveCreditUseIdr(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<bigint> {
  const own = await tx.execute(sql`
    SELECT DISTINCT x.payment_intent_id::text AS intent_id
      FROM reservation_customer_credit_uses u
      JOIN reservation_deposit_remainders x
        ON x.tenant_id = u.tenant_id AND x.id = u.remainder_id
     WHERE u.tenant_id = ${tenantId} AND u.table_session_id = ${tableSessionId}::uuid
     ORDER BY 1`);
  const intentIds = own.rows.map((row) => String(row.intent_id));
  if (intentIds.length === 0) return 0n;
  const pools = await transferredCreditPools(tx, tenantId, intentIds, true);
  const uses = await tx.execute(sql`
    SELECT u.id::text AS use_id, u.table_session_id::text AS session_id,
           x.payment_intent_id::text AS intent_id,
           (u.amount_idr - u.returned_idr)::text AS amount
      FROM reservation_customer_credit_uses u
      JOIN reservation_deposit_remainders x
        ON x.tenant_id = u.tenant_id AND x.id = u.remainder_id
     WHERE u.tenant_id = ${tenantId}
       AND x.payment_intent_id IN (${sql.join(
         intentIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY u.created_at, u.id`);
  let total = 0n;
  for (const row of uses.rows) {
    const intentId = String(row.intent_id);
    const used = BigInt(String(row.amount));
    if (used <= 0n) continue;
    const left = pools.get(intentId) ?? 0n;
    const effective = used < left ? used : left;
    pools.set(intentId, left - effective);
    if (String(row.session_id) === tableSessionId) total += effective;
  }
  // Uses of other sessions of the same intents are re-judged too: a closed
  // session is never read again, so its flag would otherwise stay frozen.
  for (const intentId of intentIds)
    await flagCreditReconForIntent(tx, tenantId, intentId);
  return total;
}

/** RSV-02 credit of a table session: the sum of its allocation credits. */
export async function sessionDepositCredit(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<number> {
  const sources = await listSessionDepositSources(tx, tenantId, tableSessionId);
  const intents = {
    rows: sources.map((source) => ({ intent_id: source.paymentIntentId })),
  };
  if (intents.rows.length === 0) return 0;
  // Ascending intent id, so two readers never take them in opposite orders.
  for (const row of intents.rows)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${depositIntentLockKey(tenantId, String(row.intent_id))}, 0))`,
    );
  const credits = await allocationCredits(tx, tenantId, { tableSessionId });
  // legend-svwdz: transferred credit is capped by the source intent's net.
  const usedCredit = await effectiveCreditUseIdr(tx, tenantId, tableSessionId);
  const releases =
    await tx.execute(sql`SELECT coalesce(sum(p.amount_idr),0)::text AS amount
    FROM pos_deposit_refunds p JOIN orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id
    WHERE p.tenant_id=${tenantId} AND o.table_session_id=${tableSessionId}::uuid`);
  const total =
    credits.reduce((sum, row) => sum + row.creditIdr, 0n) + usedCredit;
  const released = BigInt(String(releases.rows[0]?.amount ?? "0"));
  // Native held already subtracts nonfailed WS05 refunds; a release must not
  // reopen credit when its provider request later fails. Keep the stricter cap.
  const gross =
    credits.reduce((sum, row) => sum + row.grossIdr, 0n) + usedCredit;
  const releasedCap = gross > released ? gross - released : 0n;
  return Number(total < releasedCap ? total : releasedCap);
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
  const creditHeld =
    await tx.execute(sql`SELECT greatest(coalesce(sum(r.amount_idr),0)-coalesce((
      SELECT sum(p.amount_idr) FROM pos_deposit_refunds p JOIN orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id
      WHERE p.tenant_id=${tenantId} AND p.payment_intent_id=${intentId}::uuid AND EXISTS (
        SELECT 1 FROM reservation_customer_credit_uses u JOIN reservation_deposit_remainders x
          ON x.tenant_id=u.tenant_id AND x.id=u.remainder_id
        WHERE u.tenant_id=p.tenant_id AND u.table_session_id=o.table_session_id
          AND x.payment_intent_id=p.payment_intent_id)),0),0)::text AS amount
    FROM reservation_deposit_remainders r WHERE r.tenant_id=${tenantId}
      AND r.payment_intent_id=${intentId}::uuid AND r.kind='customer_credit'`);
  // Gross view, not capped by the pool: the caller's refund check already
  // subtracts the provider's refunds from what was paid, so capping here would
  // count them twice and raise the refund limit (legend-svwdz, 1020).
  const heldCredit = BigInt(String(creditHeld.rows[0]?.amount ?? "0"));
  if (credits.length === 0) return heldCredit;
  const sessionIds = [...new Set(credits.map((row) => row.tableSessionId))];
  // What the DP paid on each session: the larger of what orders applied
  // (pay-first QR, POS) and the bill not covered by verified link payments
  // or captured POS tenders.
  // Open-bill QR orders apply nothing themselves; the session credit settles
  // them (qr-order.service.ts settlementOf, close at outstanding 0), so their
  // bill counts too, the unpaid part of an open table included (earmarked).
  const used = await tx.execute(sql`
    SELECT o.table_session_id::text AS session_id,
           greatest(coalesce(sum(o.deposit_applied_idr), 0)-coalesce((
             SELECT sum(p.amount_idr) FROM pos_deposit_refunds p JOIN orders po ON po.tenant_id=p.tenant_id AND po.id=p.order_id
             WHERE p.tenant_id=${tenantId} AND po.table_session_id=o.table_session_id),0),0)::text AS applied,
           (coalesce(sum(o.total_idr), 0) - coalesce(sum(l.paid_idr), 0)
             - coalesce(sum(t.captured), 0) - coalesce((
             SELECT sum(p.amount_idr) FROM pos_deposit_refunds p JOIN orders po ON po.tenant_id=p.tenant_id AND po.id=p.order_id
             WHERE p.tenant_id=${tenantId} AND po.table_session_id=o.table_session_id),0))::text AS uncovered
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
  return inUse + heldCredit;
}

/** Immutable native allocations plus explicitly assigned customer credit. */
export async function listSessionDepositSources(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<{ paymentIntentId: string; amountIdr: number }[]> {
  const result =
    await tx.execute(sql`SELECT payment_intent_id::text,sum(amount)::text AS amount FROM (
    SELECT payment_intent_id,amount_idr AS amount FROM reservation_deposit_allocations
      WHERE tenant_id=${tenantId} AND table_session_id=${tableSessionId}::uuid
    UNION ALL SELECT r.payment_intent_id,u.amount_idr-u.returned_idr FROM reservation_customer_credit_uses u
      JOIN reservation_deposit_remainders r ON r.tenant_id=u.tenant_id AND r.id=u.remainder_id
      WHERE u.tenant_id=${tenantId} AND u.table_session_id=${tableSessionId}::uuid
    ) sources GROUP BY payment_intent_id ORDER BY payment_intent_id`);
  return result.rows.map((r) => ({
    paymentIntentId: String(r.payment_intent_id),
    amountIdr: Number(r.amount),
  }));
}
