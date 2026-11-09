-- Auto-journals F19 (design docs/design/auto-journals.md sections 6 and 7).
-- Companion of 0113_auto_journals (generated DDL: auto_journal_parked,
-- journal_entries.late_adjustment_from, source type customer_deposit).
--
-- 1. RLS for auto_journal_parked: tenant-owned AND outlet-owned (outlet_id NOT
--    NULL), so the RESTRICTIVE tenant policy and, right after it, the outlet
--    policy (TEN-03, guard test src/db/outlet-rls.test.ts), as in 0087. The
--    only foreign key is to tenants, so no FORCE lift is needed for the table.
-- 2. Per-legal-entity backfill of the two new posting roles. The migrator may
--    be a plain table owner (no SUPERUSER, no BYPASSRLS): FORCE ROW LEVEL
--    SECURITY would apply the tenant policies to it, and with no app.tenant_id
--    set they raise 42501 on the inserts and on the foreign keys checked
--    against legal_entities and chart_of_accounts. Lift FORCE for these three
--    tables inside this transaction only and restore it before commit (same
--    pattern as 0065, 0074, 0075; drizzle applies pending migrations in one
--    transaction, so no other session ever sees the lifted state).
SELECT app.enforce_tenant_rls('public.auto_journal_parked'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.auto_journal_parked'::regclass);
--> statement-breakpoint
ALTER TABLE public.legal_entities NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 2107 Uang Muka Pelanggan under the entity's own header 2100. Only entities
-- that already have a liability 2100; the others get nothing and park
-- ACCOUNT_MAPPING_MISSING until finance maps the role. A tenant's own,
-- different 2107 stays untouched (ON CONFLICT DO NOTHING).
INSERT INTO public.chart_of_accounts
  (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT h.tenant_id, h.legal_entity_id, '2107', 'Uang Muka Pelanggan',
       'liability', 'current_liability', h.id
  FROM public.chart_of_accounts h
  WHERE h.code = '2100' AND h.type = 'liability'
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
-- Map the role only to the account this migration (or the template) created:
-- same code, name and type. Never map a tenant's own different 2107.
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'customer_deposit', a.id
  FROM public.chart_of_accounts a
  WHERE a.code = '2107' AND a.name = 'Uang Muka Pelanggan'
    AND a.type = 'liability' AND a.is_active
ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING;
--> statement-breakpoint
-- 7103 Pendapatan Uang Muka Hangus (other income) under the entity's 7100.
INSERT INTO public.chart_of_accounts
  (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT h.tenant_id, h.legal_entity_id, '7103', 'Pendapatan Uang Muka Hangus',
       'revenue', 'other_income', h.id
  FROM public.chart_of_accounts h
  WHERE h.code = '7100' AND h.type = 'revenue'
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'deposit_forfeit_income', a.id
  FROM public.chart_of_accounts a
  WHERE a.code = '7103' AND a.name = 'Pendapatan Uang Muka Hangus'
    AND a.type = 'revenue' AND a.is_active
ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;
