-- gate: legend-gwqjp2
-- before: none
-- requires: public.domain_event_outbox, public.journal_entries, public.journal_lines, public.account_mappings
-- mode: block
-- resolve: Tahan rilis. Finance memeriksa tiap baris dan memutuskan koreksi jurnalnya; jurnal terposting tidak dibalik otomatis, dan baris yang dibiarkan menahan kas kecil sebesar pokoknya. Baris yang sudah dijelaskan finance dicatat sebagai keputusan CTO sebelum rilis.
-- Gerbang legend-gwqjp (legend 1118), statement 2 dari 4; padanan statement 2 di scripts/preflight/1118-shared-cash-mapping.sql, yang tetap ada untuk psql manual.
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
