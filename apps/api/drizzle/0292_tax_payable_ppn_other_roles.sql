-- legend-xa9bc (538-G3 slice A): the sale journal books the tax of an order per
-- type: PBJT stays on tax_payable_pbjt (2201), PPN goes to the new
-- tax_payable_ppn role (2205 "Utang PPN") and any other tax to the new
-- tax_payable_other role (2206 "Utang Pajak Lainnya"). New entities get both
-- accounts and mappings from the standard chart (packages/shared coa.ts). An
-- entity provisioned earlier lacks them, so a mixed sale could not resolve the
-- role and would park ACCOUNT_MAPPING_MISSING. Backfill them for every already
-- provisioned (tenant_id, legal_entity_id) pair, meaning one that has at least
-- one account_mappings row. Unprovisioned entities get nothing: the
-- provisioning service seeds them. Old sale journals are not touched: they stay
-- all-PBJT.
--
-- Rules, all idempotent (a re-run changes nothing), never update or delete:
--   * an account is inserted only when the entity has no account with that
--     code (a custom 2205 or 2206 is kept as is);
--   * the parent is the parent of the entity's 2201 (the sibling, normally
--     2200) only when it is a liability (0027 assert_account_parent requires an
--     equal-type parent) with no journal line and no mapping on it; otherwise
--     the account is created top-level (NULL parent), never under an account
--     that already holds postings;
--   * a role is mapped only when it has no mapping yet AND the entity's 2205 /
--     2206 account is a liability, active and has no child account (a header
--     account is not postable, ACCOUNT_NOT_POSTABLE).
-- Runs as the migration owner, so it spans every tenant.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116 and 0147. journal_lines is only read (the parent has no
-- posting check), but its policy raises the same way, so it is lifted too
-- (merge train batch48k).
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.journal_lines NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
SELECT p.tenant_id, p.legal_entity_id, n.code, n.name, 'liability', 'current_liability', parent.id
FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM public.account_mappings) p
CROSS JOIN (VALUES
  ('2205', 'Utang PPN'),
  ('2206', 'Utang Pajak Lainnya')
) AS n(code, name)
LEFT JOIN public.chart_of_accounts sibling
  ON sibling.tenant_id = p.tenant_id
  AND sibling.legal_entity_id = p.legal_entity_id
  AND sibling.code = '2201'
LEFT JOIN public.chart_of_accounts parent
  ON parent.tenant_id = p.tenant_id
  AND parent.legal_entity_id = p.legal_entity_id
  AND parent.id = sibling.parent_id
  AND parent.type = 'liability'
  AND NOT EXISTS (
    SELECT 1 FROM public.journal_lines l
    WHERE l.tenant_id = parent.tenant_id AND l.account_id = parent.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings m
    WHERE m.tenant_id = parent.tenant_id AND m.account_id = parent.id
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts a
  WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.code = n.code
)
ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, m.role, a.id
FROM public.chart_of_accounts a
JOIN (VALUES
  ('tax_payable_ppn', '2205', 'liability'),
  ('tax_payable_other', '2206', 'liability')
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
ALTER TABLE public.journal_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY;
