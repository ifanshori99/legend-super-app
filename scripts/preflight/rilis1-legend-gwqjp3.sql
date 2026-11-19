-- gate: legend-gwqjp3
-- before: none
-- requires: public.journal_entries, public.journal_lines, public.account_mappings
-- mode: block
-- resolve: Tahan rilis. Finance memeriksa tiap entri yang mendebit dan mengkredit satu akun kas sekaligus dan memutuskan koreksinya; jurnal terposting tidak dibalik otomatis, lalu jalankan ulang gerbang.
-- Gerbang legend-gwqjp (legend 1118), statement 3 dari 4; padanan statement 3 di scripts/preflight/1118-shared-cash-mapping.sql, yang tetap ada untuk psql manual.
-- an entry without a snapshot uses the entity's mapping of those roles today.
-- Any row blocks the release.
SELECT
  je.tenant_id,
  je.legal_entity_id,
  je.id AS entry_id,
  je.idempotency_key,
  je.source_type,
  l.account_id,
  SUM(l.debit_idr) AS debit_idr,
  SUM(l.credit_idr) AS credit_idr
FROM journal_entries je
JOIN journal_lines l
  ON l.tenant_id = je.tenant_id
 AND l.entry_id = je.id
WHERE je.reversal_of IS NULL
  AND l.account_id::text IN (
    SELECT CASE
             WHEN je.posting_account_snapshot IS NULL
               OR je.posting_account_snapshot = '{}'::jsonb
             THEN cm.account_id::text
             ELSE je.posting_account_snapshot->>r.role
           END
    FROM (VALUES ('petty_cash'), ('cash_on_hand'), ('bank')) AS r(role)
    LEFT JOIN account_mappings cm
      ON cm.tenant_id = je.tenant_id
     AND cm.legal_entity_id = je.legal_entity_id
     AND cm.role = r.role
  )
GROUP BY je.tenant_id, je.legal_entity_id, je.id, je.idempotency_key, je.source_type, l.account_id
HAVING bool_or(l.debit_idr > 0)
   AND bool_or(l.credit_idr > 0)
ORDER BY je.tenant_id, je.legal_entity_id, je.id, l.account_id;
