-- Custom SQL migration file, put your code below! ---
-- O2 (legend-wasr7.6, CTO 27 Nov): an offline tablet sale ingested after its
-- shift closed posts Dr offline_cash_clearing (order.paid#offline_unmatched),
-- because the close already booked its cash as the drawer's overage. New
-- entities get account 1205 "Kas Offline Belum Dicocokkan" (role
-- offline_cash_clearing) from the standard chart (packages/shared coa.ts). An
-- entity provisioned earlier lacks it, so such a sale parks
-- ACCOUNT_MAPPING_MISSING. Backfill the account and its mapping for every
-- already provisioned (tenant_id, legal_entity_id) pair, meaning one that has
-- at least one account_mappings row. Unprovisioned entities get nothing: the
-- provisioning service seeds them. Parked events are then posted by the
-- existing retry sweep.
--
-- Backfill rules, idempotent (a re-run changes nothing), never update or
-- delete, as in 0147 and 0360:
--   * 1205 is inserted only when the entity has no account with that code (a
--     custom account on the code is kept as is);
--   * the parent is the entity's 1200 (asset) only when it exists, has the
--     same type (0027 assert_account_parent requires an equal-type parent) AND
--     is not used by any posting mapping of the entity. Giving a mapped leaf a
--     child would turn it into a header, and the next journal on it would fail
--     ACCOUNT_NOT_POSTABLE. Otherwise the parent is NULL (the account is still
--     created and mapped);
--   * the role is mapped only when it has no mapping yet AND the entity's
--     account on 1205 is active, an asset, has no child account, carries
--     exactly the seeded name AND is not mapped to any role yet. A tenant's own
--     account on the code is never taken over (money, restrictive on purpose);
--     otherwise the mapping is skipped and the sale keeps parking
--     ACCOUNT_MAPPING_MISSING, which is safe.
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): lift FORCE ROW
-- LEVEL SECURITY for this transaction only and restore it before commit, as in
-- 0116, 0147, 0205, 0335 and 0360.
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '1205', 'Kas Offline Belum Dicocokkan', 'asset', 'current_asset', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '1200'
  AND parent.type = 'asset'
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings pm
    WHERE pm.tenant_id = parent.tenant_id
      AND pm.legal_entity_id = parent.legal_entity_id
      AND pm.account_id = parent.id
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '1205'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'offline_cash_clearing', a.id
FROM public.chart_of_accounts a
WHERE a.code = '1205'
  AND a.type = 'asset'
  AND a.name = 'Kas Offline Belum Dicocokkan'
  AND a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id
      AND x.role = 'offline_cash_clearing'
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
