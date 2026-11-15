// SO-885 (legend-05pjx): when does a FAILED refund still count as an open case?
//
// A failed refund pays nothing (`failed` is a definitive decline), but on an
// awaiting_payment guest QR order it keeps holding the order (the sweep never
// voids a bill with an unsettled refund) and staff must see it. Once a later
// COMPLETED refund replaced it, the old failed row is history:
// - a refund of a fund (`unallocated_fund_id`) is superseded by a completed
//   refund of the same fund;
// - any other refund is superseded when the intent's completed refunds cover
//   everything that came in for it (something was received; an intent with no
//   evidence is unknown money, so nothing supersedes there).
// Any doubt keeps the row open. Fragments take the SQL of the outer refund's
// columns so raw SQL (alias `r`) and Drizzle selects share one definition.
import { sql, type SQL } from "drizzle-orm";

export type RefundColumnsSql = {
  readonly tenantId: SQL;
  readonly paymentIntentId: SQL;
  readonly unallocatedFundId: SQL;
};

/** The refund aliased `alias` in raw SQL. */
export function refundColumnsOf(alias: string): RefundColumnsSql {
  return {
    tenantId: sql.raw(`${alias}.tenant_id`),
    paymentIntentId: sql.raw(`${alias}.payment_intent_id`),
    unallocatedFundId: sql.raw(`${alias}.unallocated_fund_id`),
  };
}

/** A FAILED refund `r` was replaced by a completed one (see the header). */
export function failedRefundSupersededSql(r: RefundColumnsSql): SQL {
  return sql`(
    CASE WHEN ${r.unallocatedFundId} IS NOT NULL THEN EXISTS (
      SELECT 1 FROM payment_refunds sc
       WHERE sc.tenant_id = ${r.tenantId}
         AND sc.unallocated_fund_id = ${r.unallocatedFundId}
         AND sc.status = 'completed')
    ELSE
      coalesce((SELECT sum(se.amount_idr) FROM payment_evidence se
                 WHERE se.tenant_id = ${r.tenantId}
                   AND se.payment_intent_id = ${r.paymentIntentId}), 0) > 0
      AND coalesce((SELECT sum(sc.amount_idr) FROM payment_refunds sc
                     WHERE sc.tenant_id = ${r.tenantId}
                       AND sc.payment_intent_id = ${r.paymentIntentId}
                       AND sc.status = 'completed'), 0)
          >= coalesce((SELECT sum(se.amount_idr) FROM payment_evidence se
                        WHERE se.tenant_id = ${r.tenantId}
                          AND se.payment_intent_id = ${r.paymentIntentId}), 0)
    END)`;
}

/** The refund `r` is a failed one that is not superseded. */
export function failedRefundOpenSql(
  r: RefundColumnsSql & { status: SQL },
): SQL {
  return sql`(${r.status} = 'failed' AND NOT ${failedRefundSupersededSql(r)})`;
}

/**
 * The failed, unsuperseded refund `r` belongs to an intent of the payment link
 * of an awaiting_payment guest QR order: it holds that order.
 */
export function failedRefundHoldsOrderSql(
  r: RefundColumnsSql & { status: SQL },
): SQL {
  return sql`(${failedRefundOpenSql(r)} AND EXISTS (
    SELECT 1 FROM payment_intents hi
      JOIN orders ho ON ho.tenant_id = hi.tenant_id
                    AND ho.payment_link_id = hi.payment_link_id
     WHERE hi.tenant_id = ${r.tenantId}
       AND hi.id = ${r.paymentIntentId}
       AND ho.channel = 'qr'
       AND ho.status = 'awaiting_payment'))`;
}
