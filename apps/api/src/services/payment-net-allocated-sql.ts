// SQL of what an intent put toward its bill (bead legend-m9pf6, 980). One place
// for the rule every "is this sale / part / bill paid" check reads, so none of
// them forgets the partial refunds the provider made on its own (967).
import { sql, type SQL } from "drizzle-orm";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";

/**
 * SQL: the bill part of what an intent brought in (`grossSql`: its evidence
 * less the funds parked). 1272 K1 and the fee second opinion (P2-1): the
 * guest fee is taken off ONCE, never capped away. An intent with a fee counts
 * `greatest(least(gross - fee, amount_idr), 0)`: a code paid late after the
 * bill was covered parked the bill (not the fee), so evidence - funds - fee is
 * 0 and the fee does not turn into refundable bill money. An intent without a
 * fee counts `grossSql` as it was.
 */
export function guestFeeBillSql(
  tenantIdSql: SQL,
  intentIdSql: SQL,
  grossSql: SQL,
): SQL {
  return sql`(SELECT CASE WHEN pi.guest_fee_idr > 0
                          THEN greatest(least((${grossSql}) - pi.guest_fee_idr, pi.amount_idr), 0)
                          ELSE (${grossSql}) END
               FROM payment_intents pi
              WHERE pi.tenant_id = ${tenantIdSql} AND pi.id = ${intentIdSql})`;
}

/**
 * SQL: the money the intent put toward its bill (tenant and intent id given as
 * expressions): the provider evidence it brought in, less the part booked as
 * unallocated funds, less what the provider refunded on its own
 * (`providerRefundedForeignIdrSql`; refunds that fit in the parked excess of
 * the same transaction are not taken off, legend-g6ept). Never below 0.
 * 1272 K1: an intent with a guest fee brought bill + fee, but the fee is not
 * parked and not bill money: `guestFeeBillSql` takes it off once before the
 * provider refunds are taken off, so a refund within the fee is not lost in it.
 * Restrictive on doubt: a partly refunded code never counts as paid in full.
 * `providerRefundsOnlyIf` (legend-tlm3h) limits the provider refunds taken off
 * to those a predicate over alias `pr` keeps (see
 * `providerRefundedForeignIdrSql`).
 */
export function netAllocatedIdrSql(
  tenantIdSql: SQL,
  intentIdSql: SQL,
  providerRefundsOnlyIf?: SQL,
): SQL {
  const gross = sql`coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
                 WHERE e.tenant_id = ${tenantIdSql}
                   AND e.payment_intent_id = ${intentIdSql}), 0)
      - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
                   WHERE f.tenant_id = ${tenantIdSql}
                     AND f.payment_intent_id = ${intentIdSql}), 0)`;
  return sql`greatest(
    ${guestFeeBillSql(tenantIdSql, intentIdSql, gross)}
    - ${providerRefundedForeignIdrSql(tenantIdSql, intentIdSql, providerRefundsOnlyIf)}, 0)`;
}
