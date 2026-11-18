-- gate: legend-0go0p
-- before: 0381_payout_pending_settle_return_claims
-- requires: public.payroll_disbursement_items
-- mode: block
-- resolve: For each listed item id, give the return a proof of its own that no other batch or payment confirmation uses, then run the gate again.
WITH pending AS (
  SELECT tenant_id, id, batch_id, return_evidence_key
  FROM payroll_disbursement_items
  WHERE returned_by IS NOT NULL
    AND returned_by_2 IS NULL
    AND return_evidence_key IS NOT NULL
),
findings AS (
  SELECT p.tenant_id, p.id, 'return_proof_in_other_batch' AS reason
  FROM pending p
  WHERE EXISTS (
    SELECT 1
    FROM payroll_disbursement_items o
    WHERE o.tenant_id = p.tenant_id
      AND o.return_evidence_key = p.return_evidence_key
      AND o.batch_id <> p.batch_id
  )
  UNION ALL
  SELECT p.tenant_id, p.id, 'return_proof_is_payment_proof' AS reason
  FROM pending p
  WHERE EXISTS (
    SELECT 1
    FROM payroll_disbursement_items o
    WHERE o.tenant_id = p.tenant_id
      AND (o.confirmation_evidence_key = p.return_evidence_key
        OR o.resolution_evidence_key = p.return_evidence_key)
  )
)
SELECT
  tenant_id,
  reason,
  count(*) AS row_count,
  array_agg(id ORDER BY id) AS ids
FROM findings
GROUP BY tenant_id, reason
ORDER BY tenant_id, reason;
