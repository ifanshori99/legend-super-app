-- gate: legend-gwqjp1
-- before: none
-- requires: public.account_mappings
-- mode: block
-- resolve: Tahan rilis. Pemilik akuntansi tenant memetakan ulang role non-kas ke akun sendiri lewat pengaturan mapping (validasi CASH_ACCOUNT_SHARED menolak sisanya); jangan mengubah account_mappings langsung di DB, lalu jalankan ulang gerbang.
-- Gerbang legend-gwqjp (legend 1118), statement 1 dari 4; padanan statement 1 di scripts/preflight/1118-shared-cash-mapping.sql, yang tetap ada untuk psql manual.
-- First statement (shared accounts): zero rows means no legal entity maps one account to a cash role
-- (cash_on_hand, petty_cash, bank) and to any other role; any row blocks the
-- release. Same rule as accountMappingIssues (CASH_ACCOUNT_SHARED).
SELECT
  m.tenant_id,
  m.legal_entity_id,
  m.account_id,
  array_agg(m.role ORDER BY m.role) AS roles
FROM account_mappings m
GROUP BY m.tenant_id, m.legal_entity_id, m.account_id
HAVING count(*) > 1
   AND bool_or(m.role IN ('cash_on_hand', 'petty_cash', 'bank'))
ORDER BY m.tenant_id, m.legal_entity_id, m.account_id;
