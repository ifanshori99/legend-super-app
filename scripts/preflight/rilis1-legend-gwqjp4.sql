-- gate: legend-gwqjp4
-- before: none
-- requires: public.account_mappings, public.journal_entries, public.journal_lines, public.chart_of_accounts, public.audit_logs
-- mode: block
-- resolve: Tahan rilis. Finance memeriksa tiap mapping role kas yang akunnya sudah berjurnal dengan makna lain; memindahkan role kas ke akun berjurnal (termasuk kembali ke akun semula) harus lewat akun baru, jangan mengubah account_mappings langsung di DB.
-- Gerbang legend-gwqjp (legend 1118), statement 4 dari 4; padanan statement 4 di scripts/preflight/1118-shared-cash-mapping.sql, yang tetap ada untuk psql manual.
-- Fourth statement (legend 1147, decision 3): a current cash-role mapping
-- (cash_on_hand, petty_cash, bank) whose account already had journal lines
-- BEFORE the mapping pointed at it. account_mappings has no timestamp, so there
-- are two kinds of evidence, one SELECT each, joined by UNION (a journal that
-- both kinds catch is listed once). One row per (mapping, journal).
-- (a) Snapshot: the journal has a line on the mapped account X, and its
-- posting_account_snapshot (the full effective role map of that journal, see
-- accounting-journal.service.ts) says that role was NOT X then (another account
-- or no entry for the role). Only journals WITH a snapshot are seen here: a NULL
-- or empty snapshot is normal for manual, recurring, cash-bank, fixed-asset,
-- waive and reversal journals (not only legacy ones), so reversals do NOT count
-- by snapshot.
-- (b) Mapping audit: the audit event accounting.account_mappings.replaced of
-- the legal entity (objectId) moved this role onto the code of X (listed in
-- maskedChanges.after.mappings, absent from maskedChanges.before.mappings), and X
-- has a line in a journal created before that audit row, snapshot or not. This
-- catches the NULL-snapshot journals, e.g. a bank account with opening balance
-- lines remapped to petty_cash. Limits: a mapping that no audit event ever
-- moved (original provisioning) is not flagged by (b), and a mapping changed
-- without that audit event (direct SQL, config import) is seen only by (a).
-- A malformed mappings array in an audit row raises an error, which blocks.
-- Such an account carries history of a different meaning, so a reversal of that
-- journal could raise the cash GL of X without real money. The mapping endpoint
-- and the config import refuse that change (CASH_MAPPING_ACCOUNT_HAS_HISTORY),
-- this gate finds the ones that already exist. Any row blocks the release and
-- must be zero or explained by finance.
SELECT
  m.tenant_id,
  m.legal_entity_id,
  m.role,
  m.account_id,
  je.id AS entry_id,
  je.idempotency_key,
  je.source_type,
  je.posting_account_snapshot->>m.role AS snapshot_account_id
FROM account_mappings m
JOIN journal_entries je
  ON je.tenant_id = m.tenant_id
 AND je.legal_entity_id = m.legal_entity_id
WHERE m.role IN ('cash_on_hand', 'petty_cash', 'bank')
  AND je.posting_account_snapshot IS NOT NULL
  AND je.posting_account_snapshot <> '{}'::jsonb
  AND je.posting_account_snapshot->>m.role IS DISTINCT FROM m.account_id::text
  AND EXISTS (
    SELECT 1
    FROM journal_lines l
    WHERE l.tenant_id = je.tenant_id
      AND l.entry_id = je.id
      AND l.account_id = m.account_id
  )
UNION
SELECT
  m.tenant_id,
  m.legal_entity_id,
  m.role,
  m.account_id,
  je.id,
  je.idempotency_key,
  je.source_type,
  je.posting_account_snapshot->>m.role
FROM account_mappings m
JOIN chart_of_accounts c
  ON c.tenant_id = m.tenant_id
 AND c.id = m.account_id
JOIN audit_logs a
  ON a.tenant_id = m.tenant_id
 AND a.event->>'action' = 'accounting.account_mappings.replaced'
 AND a.event->>'objectId' = m.legal_entity_id::text
JOIN journal_entries je
  ON je.tenant_id = m.tenant_id
 AND je.legal_entity_id = m.legal_entity_id
 AND je.created_at < a.created_at
WHERE m.role IN ('cash_on_hand', 'petty_cash', 'bank')
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(a.event->'maskedChanges'->'after'->'mappings') moved
    WHERE moved->>'role' = m.role
      AND moved->>'glCode' = c.code
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(a.event->'maskedChanges'->'before'->'mappings') was
    WHERE was->>'role' = m.role
      AND was->>'glCode' = c.code
  )
  AND EXISTS (
    SELECT 1
    FROM journal_lines l
    WHERE l.tenant_id = je.tenant_id
      AND l.entry_id = je.id
      AND l.account_id = m.account_id
  )
ORDER BY tenant_id, legal_entity_id, role, entry_id;
