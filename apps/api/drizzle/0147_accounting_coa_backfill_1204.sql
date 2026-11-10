-- Custom SQL migration file, put your code below! ---
-- legend-s8a3: the balanced payroll journal (payroll.locked) posts employee
-- receivables (loan, PPh 21 receivable) to the employee_receivable role,
-- employee reimbursements to the new reimbursement_expense role and
-- employer-borne PPh 21 to the new pph21_borne_expense role. New entities get
-- account 1204 "Piutang Karyawan", 6110 "Beban Reimbursement Karyawan" and
-- 6111 "Beban PPh 21 Ditanggung Perusahaan" with those mappings from the
-- standard chart (packages/shared coa.ts). An entity provisioned earlier lacks
-- 6110 and 6111 (and possibly 1204 or its mapping), so
-- the payroll journal could not resolve the role. Backfill them for every
-- already provisioned (tenant_id, legal_entity_id) pair, meaning one that has
-- at least one account_mappings row. Unprovisioned entities get nothing: the
-- provisioning service seeds them.
--
-- Rules, all idempotent (a re-run changes nothing), never update or delete:
--   * an account is inserted only when the entity has no account with that
--     code (a custom 1204, 6110 or 6111 is kept as is);
--   * the parent is the entity's 1200 / 6100 only when it exists and has the
--     same type (0027 assert_account_parent requires an equal-type parent),
--     otherwise NULL;
--   * a role is mapped only when it has no mapping yet AND the entity's 1204 /
--     6110 account has the right type (asset / expense), is active and has no
--     child account (a header account is not postable, ACCOUNT_NOT_POSTABLE).
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116.
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '1204', 'Piutang Karyawan', 'asset', 'current_asset', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '1200'
  AND parent.type = 'asset'
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '1204'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '6110', 'Beban Reimbursement Karyawan', 'expense', 'operating_expense', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '6100'
  AND parent.type = 'expense'
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '6110'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '6111', 'Beban PPh 21 Ditanggung Perusahaan', 'expense', 'operating_expense', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '6100'
  AND parent.type = 'expense'
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '6111'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, m.role, a.id
FROM public.chart_of_accounts a
JOIN (VALUES
  ('employee_receivable', '1204', 'asset'),
  ('reimbursement_expense', '6110', 'expense'),
  ('pph21_borne_expense', '6111', 'expense')
) AS m(role, code, type) ON m.code = a.code AND m.type = a.type
WHERE a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id AND x.role = m.role
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts c
    WHERE c.tenant_id = a.tenant_id AND c.legal_entity_id = a.legal_entity_id AND c.parent_id = a.id
  )
ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY;
