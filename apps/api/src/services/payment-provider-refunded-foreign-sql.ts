// SQL of the money the provider refunded on its own (bead legend-30hfs, 967).
// Its own file so the refund guard and `refundableBalance` can use it without
// importing the recorder (which imports `refundableBalance`).
import { sql, type SQL } from "drizzle-orm";

/**
 * SQL: money the provider refunded on its own for the intent (given as tenant
 * and intent id expressions), counted against what the intent may refund. Left
 * out: a refund of a transaction a parked fund holds WHOLE (the fund itself is
 * blocked, and that money is not part of what the intent paid; a split
 * transaction, part parked and part applied to the bill, stays counted and its
 * fund stays blocked: restrictive), and a refund whose provider
 * id is the provider reference of a refund of ours in the tenant that did not
 * fail (the echo of
 * our own payout that was recorded before we matched it: never counted twice).
 * `onlyIf` (legend-tlm3h, the auto journals) is a predicate over alias `pr`
 * that keeps only the refunds recorded by a moment, so a journal judged at its
 * own time is not changed by a refund that came after it.
 */
export function providerRefundedForeignIdrSql(
  tenantIdSql: SQL,
  intentIdSql: SQL,
  onlyIf?: SQL,
): SQL {
  return sql`coalesce((SELECT sum(pr.amount_idr)
    FROM payment_provider_refunds pr
    WHERE pr.tenant_id = ${tenantIdSql}
      AND pr.payment_intent_id = ${intentIdSql}
      AND ${onlyIf ?? sql`true`}
      AND NOT EXISTS (SELECT 1 FROM payment_unallocated_funds uf
        JOIN payment_evidence pe
          ON pe.tenant_id = uf.tenant_id AND pe.id = uf.evidence_id
        WHERE uf.tenant_id = pr.tenant_id
          AND uf.evidence_id = pr.evidence_id
          AND uf.amount_idr >= pe.amount_idr)
      AND NOT EXISTS (SELECT 1 FROM payment_refunds own
        WHERE own.tenant_id = pr.tenant_id
          AND own.provider_ref = pr.provider_refund_id
          AND own.status <> 'failed')), 0)`;
}
