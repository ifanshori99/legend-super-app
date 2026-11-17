// legend-em6p (U4 of the fix142 review): one clock for the three money facts
// the auto-journal guards order by time (docs/design/auto-journals.md §10):
//
// - refund completion    payment_refunds.completed_at
// - POS sale completion  pos_orders.completed_at (DP or gateway tenders)
// - reservation close    reservations.closed_at (DP forfeit)
// - QR pay-first sale    orders.fired_at (legend-9vzvs; the paid consumer
//                        locks the payer intent and fires at this time)
//
// Each writer used to take its time before commit without a shared lock, so a
// sale stamped T1 could commit after a refund stamped T2 > T1 had already been
// journalled: the refund's guard never saw the sale, the sale's guard did not
// count the later refund, and customer_deposit was debited twice.
//
// Every writer of such a fact now locks the payment_intents rows the fact
// touches (`FOR UPDATE`, ascending id) and only then takes its time from
// `lockIntentsForFact`: the caller's `now`, moved to 1 ms after the latest
// fact already committed on those intents when that one is not earlier. Under
// the row lock every earlier fact on the intent has committed, so fact times
// on one intent follow commit order, whatever the API hosts' clocks say, and
// never tie (the design's tie rules only break ties between facts that
// committed in that order).
//
// Lock order: the intent rows are taken after the business row the writer
// already holds (orders -> pos_orders, or reservations), the order the POS
// late-payment refund already uses (pos-order-late-payment.ts). No path locks
// a payment_intents row and then an orders, pos_orders or reservations row,
// and refund paths take their bill authority group and linked POS row before
// the intent (lockRefundGraph), so they never acquire a POS row after an
// intent. The e7zj advisory lock (reservation-deposit-credit.ts)
// stays after the intent row, as before. Sale completion then voids pending
// QRIS tenders (voidPendingQrisTenders), locking their links after the DP and
// captured-tender intents, the reverse of the usual link -> intent order; no
// cycle, since a pending QRIS link never holds a DP or captured-tender intent.
// Reservation closers lock after reconcileDeposit, which may only then link a
// DP the gateway already settled.
import type { TenantId } from "@starter/shared/core";
import { sql } from "drizzle-orm";
import type { Tx } from "./permission-resolver.ts";

/** Lowercased, de-duplicated, ascending: one global order for every locker. */
function sortedIntentIds(intentIds: Iterable<string>): string[] {
  return [...new Set([...intentIds].map((id) => id.toLowerCase()))].sort();
}

/**
 * Locks `intentIds` (`FOR UPDATE`, ascending) and returns the time of the
 * fact about to be written: `now`, or 1 ms after the latest refund
 * completion, sale completion or reservation close already recorded on those
 * intents when that is not earlier than `now`. Returns `now` unchanged when
 * there is no intent to lock.
 *
 * A sale counts on an intent when its order's table session holds a DP
 * allocation or a customer-credit use of the intent, when it captured a
 * tender paid by the intent, or when it is a fired QR pay-first order pinned
 * to the intent. Credit assignment and permanent DP-return facts also order
 * later sales and payouts against the same original receipt.
 */
export async function lockIntentsForFact(
  tx: Tx,
  tenantId: TenantId,
  intentIds: Iterable<string>,
  now: Date,
): Promise<Date> {
  const ids = sortedIntentIds(intentIds);
  if (ids.length === 0) return now;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    SELECT id FROM payment_intents
     WHERE tenant_id = ${tenantId} AND id IN (${list})
     ORDER BY id
       FOR UPDATE
  `);
  const result = await tx.execute(sql`
    WITH deposit_sessions AS (
      SELECT a.table_session_id FROM reservation_deposit_allocations a
       WHERE a.tenant_id = ${tenantId} AND a.payment_intent_id IN (${list})
      UNION
      SELECT u.table_session_id FROM reservation_customer_credit_uses u
      JOIN reservation_deposit_remainders r
        ON r.tenant_id = u.tenant_id AND r.id = u.remainder_id
       WHERE u.tenant_id = ${tenantId} AND r.payment_intent_id IN (${list})
    )
    SELECT floor(extract(epoch FROM greatest(
      (SELECT max(f.completed_at) FROM payment_refunds f
        WHERE f.tenant_id = ${tenantId}
          AND f.payment_intent_id IN (${list})
          AND f.completed_at IS NOT NULL),
      (SELECT max(pr.created_at) FROM payment_provider_refunds pr
        WHERE pr.tenant_id = ${tenantId}
          AND pr.payment_intent_id IN (${list})),
      (SELECT max(r.closed_at) FROM reservations r
        WHERE r.tenant_id = ${tenantId}
          AND r.deposit_payment_id IN (${list})
          AND r.closed_at IS NOT NULL),
      (SELECT max(p.completed_at) FROM pos_orders p
         JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
        WHERE p.tenant_id = ${tenantId}
          AND p.completed_at IS NOT NULL
          AND o.table_session_id IN (
            SELECT table_session_id FROM deposit_sessions)),
      (SELECT max(q.fired_at) FROM orders q
        WHERE q.tenant_id = ${tenantId}
          AND q.table_session_id IN (SELECT table_session_id FROM deposit_sessions)
          AND q.deposit_applied_idr > 0
          AND q.channel IN ('qr', 'facility') AND q.payment_mode = 'pay_first'
          AND q.fired_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pos_orders sp
            WHERE sp.tenant_id = q.tenant_id AND sp.order_id = q.id)),
      (SELECT max(u.created_at) FROM reservation_customer_credit_uses u
        JOIN reservation_deposit_remainders r
          ON r.tenant_id = u.tenant_id AND r.id = u.remainder_id
       WHERE u.tenant_id = ${tenantId} AND r.payment_intent_id IN (${list})),
      (SELECT max(r.created_at) FROM reservation_deposit_remainders r
       WHERE r.tenant_id = ${tenantId} AND r.payment_intent_id IN (${list})),
      (SELECT max(r.released_at) FROM pos_deposit_refunds r
       WHERE r.tenant_id = ${tenantId} AND r.payment_intent_id IN (${list})),
      (SELECT max(q.fired_at) FROM orders q
        WHERE q.tenant_id = ${tenantId}
          AND q.payment_intent_id IN (${list})
          AND q.channel IN ('qr', 'facility') AND q.payment_mode = 'pay_first'
          AND q.fired_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pos_orders sp
            WHERE sp.tenant_id = q.tenant_id AND sp.order_id = q.id)),
      (SELECT max(p.completed_at) FROM pos_orders p
         JOIN pos_order_tenders t
           ON t.tenant_id = p.tenant_id AND t.order_id = p.order_id
        WHERE p.tenant_id = ${tenantId}
          AND p.completed_at IS NOT NULL
          AND t.status = 'captured'
          AND t.payment_intent_id IN (${list}))
    )) * 1000)::bigint::text AS latest_ms
  `);
  const latest = result.rows[0]?.latest_ms;
  if (latest === null || latest === undefined) return now;
  // PostgreSQL keeps microseconds, Date milliseconds: the latest fact's epoch
  // milliseconds, rounded down in SQL, plus 1 ms is strictly after it.
  const after = Number(String(latest)) + 1;
  return after > now.getTime() ? new Date(after) : now;
}
