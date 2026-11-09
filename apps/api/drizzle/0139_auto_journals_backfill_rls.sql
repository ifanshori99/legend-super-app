-- Auto-journals F19 (design docs/design/auto-journals.md sections 6 and 7).
-- Companion of 0113_auto_journals (generated DDL: auto_journal_parked with its
-- tenant and (tenant_id, outlet_id) foreign keys, journal_entries.
-- late_adjustment_from, source type customer_deposit).
--
-- 1. RLS for auto_journal_parked: tenant-owned AND outlet-owned (outlet_id NOT
--    NULL), so the RESTRICTIVE tenant policy and, right after it, the outlet
--    policy (TEN-03, guard test src/db/outlet-rls.test.ts), as in 0087.
-- 2. Per-legal-entity backfill of the two new posting roles. The migrator may
--    be a plain table owner (no SUPERUSER, no BYPASSRLS; legend-wg5t, see 0070
--    and src/test/edge-received-events-migration.test.ts): FORCE ROW LEVEL
--    SECURITY would apply the tenant policies to it and, with no app.tenant_id
--    set, raise 42501 on the inserts and on the foreign key checks. Lift FORCE
--    on legal_entities, chart_of_accounts and account_mappings for this
--    transaction only and restore it at the end (drizzle applies pending
--    migrations in one transaction, so no other session ever sees the lifted
--    state). Without FORCE the owner skips RLS, so the backfill still spans
--    every tenant.
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
-- 2107 Uang Muka Pelanggan under the entity's own header 2100. Only when 2100
-- is a liability header that already has at least one child account (so it is
-- a real group, as in the template) and no account mapping points at 2100
-- itself (a header used as a posting account must not gain children). The other
-- entities get nothing and park ACCOUNT_MAPPING_MISSING until finance maps the
-- role. A tenant's own, different 2107 stays untouched (ON CONFLICT DO NOTHING).
INSERT INTO public.chart_of_accounts
  (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT h.tenant_id, h.legal_entity_id, '2107', 'Uang Muka Pelanggan',
       'liability', 'current_liability', h.id
  FROM public.chart_of_accounts h
  WHERE h.code = '2100' AND h.type = 'liability'
    AND EXISTS (
      SELECT 1 FROM public.chart_of_accounts c
        WHERE c.tenant_id = h.tenant_id
          AND c.legal_entity_id = h.legal_entity_id
          AND c.parent_id = h.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.account_mappings m
        WHERE m.tenant_id = h.tenant_id
          AND m.legal_entity_id = h.legal_entity_id
          AND m.account_id = h.id)
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
-- 7103 Pendapatan Uang Muka Hangus (other income) under the entity's 7100,
-- with the same two guards as 2107.
INSERT INTO public.chart_of_accounts
  (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT h.tenant_id, h.legal_entity_id, '7103', 'Pendapatan Uang Muka Hangus',
       'revenue', 'other_income', h.id
  FROM public.chart_of_accounts h
  WHERE h.code = '7100' AND h.type = 'revenue'
    AND EXISTS (
      SELECT 1 FROM public.chart_of_accounts c
        WHERE c.tenant_id = h.tenant_id
          AND c.legal_entity_id = h.legal_entity_id
          AND c.parent_id = h.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.account_mappings m
        WHERE m.tenant_id = h.tenant_id
          AND m.legal_entity_id = h.legal_entity_id
          AND m.account_id = h.id)
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
