// SQL of the money the provider refunded on its own (bead legend-30hfs, 967).
// Its own file so the refund guard and `refundableBalance` can use it without
// importing the recorder (which imports `refundableBalance`).
import { sql, type SQL } from "drizzle-orm";

/**
 * SQL: money the provider refunded on its own for the intent (given as tenant
 * and intent id expressions), counted against what the intent may refund. Left
 * out: a refund of a parked fund's transaction (the fund itself is blocked, and
 * its money is not part of what the intent paid), and a refund whose provider
 * id is the provider reference of a refund of ours in the tenant that did not
 * fail (the echo of
 * our own payout that was recorded before we matched it: never counted twice).
 */
export function providerRefundedForeignIdrSql(
  tenantIdSql: SQL,
  intentIdSql: SQL,
): SQL {
  return sql`coalesce((SELECT sum(pr.amount_idr)
    FROM payment_provider_refunds pr
    WHERE pr.tenant_id = ${tenantIdSql}
      AND pr.payment_intent_id = ${intentIdSql}
      AND NOT EXISTS (SELECT 1 FROM payment_unallocated_funds uf
        WHERE uf.tenant_id = pr.tenant_id
          AND uf.evidence_id = pr.evidence_id)
      AND NOT EXISTS (SELECT 1 FROM payment_refunds own
        WHERE own.tenant_id = pr.tenant_id
          AND own.provider_ref = pr.provider_refund_id
          AND own.status <> 'failed')), 0)`;
}
