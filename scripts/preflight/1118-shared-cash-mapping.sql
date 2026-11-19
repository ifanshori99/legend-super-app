-- Read-only release gate for legend 1118 (kasbon Dr1102/Cr1102), three statements.
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
