// SQL of what an intent put toward its bill (bead legend-m9pf6, 980). One place
// for the rule every "is this sale / part / bill paid" check reads, so none of
// them forgets the partial refunds the provider made on its own (967).
import { sql, type SQL } from "drizzle-orm";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";

/**
 * SQL: the money the intent put toward its bill (tenant and intent id given as
 * expressions): the provider evidence it brought in, less the part booked as
 * unallocated funds, less what the provider refunded on its own
 * (`providerRefundedForeignIdrSql`; refunds that fit in the parked excess of
 * the same transaction are not taken off, legend-g6ept). Never below 0.
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
  return sql`greatest(
    coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
               WHERE e.tenant_id = ${tenantIdSql}
                 AND e.payment_intent_id = ${intentIdSql}), 0)
    - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
                 WHERE f.tenant_id = ${tenantIdSql}
                   AND f.payment_intent_id = ${intentIdSql}), 0)
    - ${providerRefundedForeignIdrSql(tenantIdSql, intentIdSql, providerRefundsOnlyIf)}, 0)`;
}
