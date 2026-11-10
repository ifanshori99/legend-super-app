-- Custom SQL migration file, put your code below! ---
-- legend-75kr: payroll custom deductions (koperasi dues etc.) now credit the new
-- payroll_custom_deduction posting role instead of salary_expense. The standard
-- chart maps the role to 6101 together with salary_expense for new entities. An
-- entity provisioned earlier has a salary_expense mapping but no
-- payroll_custom_deduction mapping, so the payroll journal could not resolve the
-- role. Backfill it: for every (tenant_id, legal_entity_id) with a
-- salary_expense mapping and no payroll_custom_deduction mapping, map the role
-- to the SAME account_id as salary_expense. Copying that account (not code 6101)
-- keeps exactly today's posting, also for a tenant that remapped salary_expense.
--
-- Idempotent (a re-run changes nothing), never updates or deletes.
--
-- The migrator may also be a plain table owner (no BYPASSRLS): FORCE ROW LEVEL
-- SECURITY would apply the tenant policies to it, and with no app.tenant_id set
-- they raise 42501. Lift FORCE for this transaction only and restore it before
-- commit, as in 0116 and 0147.
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT s.tenant_id, s.legal_entity_id, 'payroll_custom_deduction', s.account_id
FROM public.account_mappings s
WHERE s.role = 'salary_expense'
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = s.tenant_id AND x.legal_entity_id = s.legal_entity_id AND x.role = 'payroll_custom_deduction'
  )
ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY;
