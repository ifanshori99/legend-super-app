// SQL of the money the provider refunded on its own (bead legend-30hfs, 967).
// Its own file so the refund guard and `refundableBalance` can use it without
// importing the recorder (which imports `refundableBalance`).
import { sql, type SQL } from "drizzle-orm";

/**
 * SQL: money the provider refunded on its own for the intent (given as tenant
 * and intent id expressions), counted against what the intent may refund. Left
 * out: a refund of a transaction a parked fund holds WHOLE (the fund itself is
 * blocked, and that money is not part of what the intent paid; a split
 * transaction, part parked and part applied to the bill, stays counted unless
 * the refunds fit in the parked part, see legend-g6ept below; its fund stays
 * blocked either way: restrictive), and a refund whose provider
 * id is the provider reference of a refund of ours in the tenant that did not
 * fail (the echo of
 * our own payout that was recorded before we matched it: never counted twice).
 *
 * legend-g6ept (1016): a transaction that paid more than the bill and was
 * split (the bill took its part, the rest parked as a fund of the SAME
 * evidence) takes the provider's refunds of that transaction off the parked
 * excess (`fund.amount_idr`): while their sum stays within the excess, none of
 * it counts against the bill. Once the sum passes the excess the whole sum
 * counts again (the 1009 rule, restrictive: no partial credit for the
 * excess). Provable only by the fund's evidence binding: a refund with no
 * evidence, a fund with no evidence, or a fund an own refund of ours already
 * reserved (not failed: the excess may be returned twice) counts in full, the
 * restrictive side.
 *
 * `onlyIf` (legend-tlm3h, the auto journals) is a predicate over alias `pr`
 * that keeps only the refunds recorded by a moment, so a journal judged at its
 * own time is not changed by a refund that came after it.
 */
export function providerRefundedForeignIdrSql(
  tenantIdSql: SQL,
  intentIdSql: SQL,
  onlyIf?: SQL,
): SQL {
  return sql`coalesce((SELECT sum(g.counted) FROM (
    SELECT CASE WHEN sum(pr.amount_idr) <= coalesce((
        SELECT sum(uf.amount_idr)
          FROM payment_unallocated_funds uf
          JOIN payment_evidence pe
            ON pe.tenant_id = uf.tenant_id AND pe.id = uf.evidence_id
         WHERE uf.tenant_id = pr.tenant_id
           AND pr.evidence_id IS NOT NULL
           AND uf.evidence_id = pr.evidence_id
           AND uf.payment_intent_id = pr.payment_intent_id
           AND uf.amount_idr < pe.amount_idr
           AND uf.resolution IS NULL
           AND NOT EXISTS (SELECT 1 FROM payment_refunds fr
             WHERE fr.tenant_id = uf.tenant_id
               AND fr.unallocated_fund_id = uf.id
               AND fr.status <> 'failed')), 0)
      THEN 0 ELSE sum(pr.amount_idr) END AS counted
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
           -- Only a provider's own refund id can echo ours (1035).
           AND pr.refund_id_kind = 'provider'
           AND own.provider_ref = pr.provider_refund_id
           AND own.status <> 'failed')
     GROUP BY pr.tenant_id, pr.payment_intent_id, pr.evidence_id) g), 0)`;
}
