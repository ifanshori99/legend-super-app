-- Custom SQL migration file, put your code below! ---
-- legend-1xbs / legend-v3lh: purchase return (purchase_return.recorded) and
-- simple petty-cash purchase (petty_purchase.recorded) post auto-journals.
--   * journal_entries.source_type accepts 'purchase_return' and
--     'petty_purchase' (drop and re-add the check, rows already satisfy it);
--   * the petty purchase debits the new petty_purchase_expense role. New
--     entities get account 5104 "Pembelian Langsung (Kas Kecil)" and that
--     mapping from the standard chart (packages/shared coa.ts). An entity
--     provisioned earlier lacks them, so backfill 5104 and the mapping for
--     every already provisioned (tenant_id, legal_entity_id) pair, meaning
--     one that has at least one account_mappings row. Unprovisioned entities
--     get nothing: the provisioning service seeds them.
--
-- Backfill rules, idempotent (a re-run changes nothing), never update or
-- delete, as in 0147:
--   * 5104 is inserted only when the entity has no account with that code (a
--     custom 5104 is kept as is);
--   * the parent is the entity's 5100 only when it exists and has the same
--     type (0027 assert_account_parent requires an equal-type parent),
--     otherwise NULL;
--   * the role is mapped only when it has no mapping yet AND the entity's
--     5104 account is an active expense account with no child account (a
--     header account is not postable, ACCOUNT_NOT_POSTABLE).
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116 and 0147.
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_check";
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_check" CHECK ("journal_entries"."source_type" IN ('sale', 'refund', 'gateway_settlement', 'edc_settlement', 'cogs', 'stock_adjustment', 'purchase', 'supplier_invoice', 'supplier_payment', 'production', 'payroll', 'loyalty', 'depreciation', 'asset_acquisition', 'asset_disposal', 'asset_revaluation', 'dividend', 'cash_deposit', 'cashier_shift', 'opening_balance', 'manual', 'recurring', 'reversal', 'customer_deposit', 'purchase_return', 'petty_purchase'));
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, '5104', 'Pembelian Langsung (Kas Kecil)', 'expense', 'cogs', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.code = '5100'
  AND parent.type = 'expense'
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = '5104'
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'petty_purchase_expense', a.id
FROM public.chart_of_accounts a
WHERE a.code = '5104'
  AND a.type = 'expense'
  AND a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id AND x.role = 'petty_purchase_expense'
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
