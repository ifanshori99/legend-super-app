-- gate: legend-7hg1q
-- before: 0463_payout_990_return_bank_ref
-- requires: public.payroll_payout_return_claims
-- mode: block
-- resolve: Finish the second step of each listed return through the old path so its claim becomes consumed, or ask ops or the CTO to decide that claim, then run the gate again.
SELECT
  tenant_id,
  'open_claim_without_bank_ref' AS reason,
  count(*) AS row_count,
  array_agg(id ORDER BY id) AS ids
FROM payroll_payout_return_claims
WHERE status = 'open'
  AND bank_ref IS NULL
GROUP BY tenant_id
ORDER BY tenant_id;
