-- Read-only release gate for legend 1118 (kasbon Dr1102/Cr1102), four statements.
-- Run with a maintenance/migrator login that sees every tenant despite RLS.
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

-- Second statement (legend 1118, D3): what the release will newly HOLD in the
-- petty cash reserve. Delivered cash kasbon (employee_loan.disbursed, not
-- bank) and non-payroll reimbursement.paid events whose journal exists but
-- whose net credit (credit - debit) on the cash accounts of that journal is
-- below the principal, e.g. the old Dr 1102 / Cr 1102. The net also counts the
-- lines of reversal journals of the original (journal_entries.reversal_of): a
-- reversal debits the cash account back without money returning to the till.
-- Cash accounts measured:
-- petty_cash / cash_on_hand / bank of the journal's posting_account_snapshot;
-- without a snapshot, the entity's current petty_cash mapping. Same rule as
-- heldDeliveredCashCreditsIdr. A delivered event WITHOUT a journal is not
-- listed (it releases). The legal entity is the one of the journal found by its
-- idempotency key, never the employee's current entity (an employee may have
-- moved). A delivered event whose amount (principalIdr / amountIdr) is NULL,
-- missing, not a JSON number (a JSON string such as "100000" is unreadable, as
-- in the helper) or not above zero is a blocking row too (its
-- principal_idr shows NULL), evaluated before the net filter, which is UNKNOWN
-- on NULL. Every row must be zero or explained by finance.
WITH delivered AS (
  SELECT
    o.tenant_id,
    o.event->>'name' AS event_name,
    o.event->'payload' AS payload
  FROM domain_event_outbox o
  WHERE o.destination = 'cloud-sync'
    AND o.status = 'delivered'
    AND o.aggregate_type IN ('employee_loan', 'reimbursement')
    AND o.event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
),
cash_events AS (
  SELECT
    d.tenant_id,
    d.event_name,
    (d.payload->>'legalEntityId') AS legal_entity_id,
    (d.payload->>'employeeLoanId') AS source_id,
    'payroll-gl:loan:' || (d.payload->>'employeeLoanId') AS journal_key,
    CASE WHEN jsonb_typeof(d.payload->'principalIdr') = 'number'
         THEN (d.payload->>'principalIdr')::numeric END AS principal_idr
  FROM delivered d
  WHERE d.event_name = 'employee_loan.disbursed'
    AND d.payload->>'disbursedVia' IS DISTINCT FROM 'bank'
  UNION ALL
  SELECT
    d.tenant_id,
    d.event_name,
    NULL::text,
    (d.payload->>'reimbursementId'),
    'payroll-gl:reimbursement:' || (d.payload->>'reimbursementId'),
    CASE WHEN jsonb_typeof(d.payload->'amountIdr') = 'number'
         THEN (d.payload->>'amountIdr')::numeric END
  FROM delivered d
  WHERE d.event_name = 'reimbursement.paid'
    AND d.payload->>'payout' IS DISTINCT FROM 'payroll'
)
SELECT
  c.tenant_id,
  je.legal_entity_id,
  c.event_name,
  c.source_id,
  c.principal_idr,
  net.net_credit_idr
FROM cash_events c
JOIN journal_entries je
  ON je.tenant_id = c.tenant_id
 AND je.idempotency_key = c.journal_key
 AND (c.legal_entity_id IS NULL OR je.legal_entity_id::text = c.legal_entity_id)
LEFT JOIN account_mappings pm
  ON pm.tenant_id = je.tenant_id
 AND pm.legal_entity_id = je.legal_entity_id
 AND pm.role = 'petty_cash'
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(l.credit_idr) - SUM(l.debit_idr), 0) AS net_credit_idr
  FROM journal_lines l
  WHERE l.tenant_id = je.tenant_id
    AND (
      l.entry_id = je.id
      OR l.entry_id IN (
        SELECT rev.id
        FROM journal_entries rev
        WHERE rev.tenant_id = je.tenant_id
          AND rev.reversal_of = je.id
      )
    )
    AND l.account_id::text IN (
      COALESCE(je.posting_account_snapshot->>'petty_cash', pm.account_id::text),
      je.posting_account_snapshot->>'cash_on_hand',
      je.posting_account_snapshot->>'bank'
    )
) net
WHERE (c.principal_idr > 0) IS NOT TRUE
   OR net.net_credit_idr < c.principal_idr
ORDER BY c.tenant_id, je.legal_entity_id, c.event_name, c.source_id;

-- Third statement (legend 1118, architect P2-1): journals that debit AND credit
-- one cash account inside the same entry, whatever the rule (cash payroll with
-- salaries_payable on 1102, petty cash journal, petty cash return to bank,
-- kasbon, reimbursement). Non-reversal entries only. Cash accounts measured:
-- petty_cash / cash_on_hand / bank of the journal's posting_account_snapshot;
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
