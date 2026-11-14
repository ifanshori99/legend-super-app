-- Custom SQL migration file, put your code below! ---
-- legend-89pn: a POS cash_in / cash_out (cash_movement.recorded) posts
-- Dr cash_on_hand / Cr cash_in_clearing and Dr cash_out_expense / Cr cash_on_hand.
-- New entities get account 2108 "Kas Masuk Belum Diklasifikasi" (role
-- cash_in_clearing) and 6112 "Beban Kas Keluar Kasir" (role cash_out_expense)
-- from the standard chart (packages/shared coa.ts). An entity provisioned
-- earlier lacks them, so its cash movements park ACCOUNT_MAPPING_MISSING. Backfill
-- both accounts and both mappings for every already provisioned
-- (tenant_id, legal_entity_id) pair, meaning one that has at least one
-- account_mappings row. Unprovisioned entities get nothing: the provisioning
-- service seeds them. Parked events are then posted by the existing retry sweep.
--
-- Backfill rules, idempotent (a re-run changes nothing), never update or
-- delete, as in 0147, 0205 and 0335:
--   * 2108 / 6112 are inserted only when the entity has no account with that
--     code (a custom account on the code is kept as is);
--   * the parent is the entity's 2100 (liability) / 6100 (expense) only when it
--     exists, has the same type (0027 assert_account_parent requires an
--     equal-type parent) AND is not used by any posting mapping of the entity
--     (an account_mappings row with account_id = that account, e.g. 6100 as
--     salary_expense or 2100 as customer_deposit). Giving a mapped leaf a child
--     would turn it into a header, and the next journal on it would fail
--     ACCOUNT_NOT_POSTABLE. Otherwise the parent is NULL (the account is still
--     created and mapped);
--   * a role is mapped only when it has no mapping yet AND the entity's account
--     on that code is active, of the right type (liability for 2108, expense
--     for 6112), has no child account (a header account is not postable,
--     ACCOUNT_NOT_POSTABLE), carries exactly the seeded name AND is not mapped
--     to any role yet. A tenant's own account on the code (another name, or
--     already used by another role such as 'Titipan Khusus' or the
--     loyalty_liability account) is never taken over, so a cash in / out does
--     not land on an account used for something else (money, restrictive on
--     purpose). Otherwise the mapping is skipped and the event keeps parking
--     ACCOUNT_MAPPING_MISSING, which is safe.
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116, 0147, 0205 and 0335.
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, d.code, d.name, d.type, d.report_group, parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
CROSS JOIN (VALUES
  ('2108', 'Kas Masuk Belum Diklasifikasi', 'liability', 'current_liability', '2100'),
  ('6112', 'Beban Kas Keluar Kasir', 'expense', 'operating_expense', '6100')
) AS d (code, name, type, report_group, parent_code)
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = d.parent_code
  AND parent.type = d.type
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings pm
    WHERE pm.tenant_id = parent.tenant_id
      AND pm.legal_entity_id = parent.legal_entity_id
      AND pm.account_id = parent.id
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = d.code
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, d.role, a.id
FROM public.chart_of_accounts a
JOIN (VALUES
  ('2108', 'Kas Masuk Belum Diklasifikasi', 'liability', 'cash_in_clearing'),
  ('6112', 'Beban Kas Keluar Kasir', 'expense', 'cash_out_expense')
) AS d (code, name, type, role)
  ON d.code = a.code AND d.type = a.type AND d.name = a.name
WHERE a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id AND x.role = d.role
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings m
    WHERE m.tenant_id = a.tenant_id AND m.legal_entity_id = a.legal_entity_id AND m.account_id = a.id
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
