-- Custom SQL migration file, put your code below! ---
-- legend-uloj6: a purchase return books the difference between the order-price
-- stock value and the moving-average cost to the new inventory_price_variance
-- role (account 5106 "Selisih Harga Persediaan"), so the GL inventory stays
-- equal to the stock ledger (INV-01). New entities get 5106 and that mapping
-- from the standard chart (packages/shared coa.ts). An entity provisioned
-- earlier lacks them, so backfill 5106 and the mapping for every already
-- provisioned (tenant_id, legal_entity_id) pair, meaning one that has at least
-- one account_mappings row. Unprovisioned entities get nothing: the
-- provisioning service seeds them.
--
-- Backfill rules, idempotent (a re-run changes nothing), never update or
-- delete, as in 0147 and 0205:
--   * 5106 is inserted only when the entity has no account with that code (a
--     custom 5106 is kept as is);
--   * the parent is the entity's 5100 only when it exists and has the same
--     type (0027 assert_account_parent requires an equal-type parent),
--     otherwise NULL;
--   * the role is mapped only when it has no mapping yet AND the entity's
--     5106 account is an active expense account with no child account (a
--     header account is not postable, ACCOUNT_NOT_POSTABLE).
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116, 0147 and 0205.
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '5106', 'Selisih Harga Persediaan', 'expense', 'cogs', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '5100'
  AND parent.type = 'expense'
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '5106'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'inventory_price_variance', a.id
FROM public.chart_of_accounts a
WHERE a.code = '5106'
  AND a.type = 'expense'
  AND a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id AND x.role = 'inventory_price_variance'
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
