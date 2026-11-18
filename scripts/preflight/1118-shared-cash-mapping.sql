-- Read-only release gate for legend 1118 (kasbon Dr1102/Cr1102), two statements.
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
-- below the principal, e.g. the old Dr 1102 / Cr 1102. Cash accounts measured:
-- petty_cash / cash_on_hand / bank of the journal's posting_account_snapshot;
-- without a snapshot, the entity's current petty_cash mapping. Same rule as
-- heldDeliveredCashCreditsIdr. A delivered event WITHOUT a journal is not
-- listed (it releases). Every row must be zero or explained by finance.
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
    (d.payload->>'principalIdr')::numeric AS principal_idr
  FROM delivered d
  WHERE d.event_name = 'employee_loan.disbursed'
    AND d.payload->>'disbursedVia' IS DISTINCT FROM 'bank'
  UNION ALL
  SELECT
    d.tenant_id,
    d.event_name,
    e.legal_entity_id::text,
    (d.payload->>'reimbursementId'),
    'payroll-gl:reimbursement:' || (d.payload->>'reimbursementId'),
    (d.payload->>'amountIdr')::numeric
  FROM delivered d
  JOIN employees e
    ON e.tenant_id = d.tenant_id
   AND e.id::text = d.payload->>'employeeId'
  WHERE d.event_name = 'reimbursement.paid'
    AND d.payload->>'payout' IS DISTINCT FROM 'payroll'
)
SELECT
  c.tenant_id,
  c.legal_entity_id,
  c.event_name,
  c.source_id,
  c.principal_idr,
  net.net_credit_idr
FROM cash_events c
JOIN journal_entries je
  ON je.tenant_id = c.tenant_id
 AND je.legal_entity_id::text = c.legal_entity_id
 AND je.idempotency_key = c.journal_key
LEFT JOIN account_mappings pm
  ON pm.tenant_id = c.tenant_id
 AND pm.legal_entity_id::text = c.legal_entity_id
 AND pm.role = 'petty_cash'
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(l.credit_idr) - SUM(l.debit_idr), 0) AS net_credit_idr
  FROM journal_lines l
  WHERE l.tenant_id = je.tenant_id
    AND l.entry_id = je.id
    AND l.account_id::text IN (
      COALESCE(je.posting_account_snapshot->>'petty_cash', pm.account_id::text),
      je.posting_account_snapshot->>'cash_on_hand',
      je.posting_account_snapshot->>'bank'
    )
) net
WHERE net.net_credit_idr < c.principal_idr
ORDER BY c.tenant_id, c.legal_entity_id, c.event_name, c.source_id;
