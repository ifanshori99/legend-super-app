-- gate: legend-ofu02
-- before: none
-- requires: public.payment_reconciliation_cases
-- mode: info
-- resolve: Review the listed missing cases, then derive their source_transaction_id only where exactly one sale matches the case reference, so the one-case-per-sale key can cover them.
SELECT tenant_id,
       'missing_without_source'::text AS reason,
       count(*)::bigint AS row_count,
       array_agg(id ORDER BY id) AS ids
  FROM payment_reconciliation_cases
 WHERE settlement_line_id IS NULL
   AND source_transaction_id IS NULL
 GROUP BY tenant_id
 ORDER BY tenant_id;
