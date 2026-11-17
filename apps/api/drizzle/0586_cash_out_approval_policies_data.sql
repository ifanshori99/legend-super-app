-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068, 0116, 0140 and 0145.
-- Without FORCE the owner skips RLS, so the statements still span every tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-4qowr: founder decision Q7 (2026-11-13). A cash out above the tenant
-- limit (or past it by the anti-split sum) waits as `pending_approval` and is
-- decided from the approval inbox. Give every existing tenant the default
-- cash_out matrix (same row as DEFAULT_CASH_OUT_APPROVAL_POLICIES in
-- packages/shared/src/access/approval.ts and seedTenantRoleTemplates): floor 0,
-- level 1, for the Finance template (it holds accounting.cash_bank.approve,
-- granted by 0331). The tenant limit and anti-split decide WHETHER an entry
-- waits; this matrix only names who decides, so floor 0 matches every amount.
-- Only a tenant with no cash_out policy row gets the row (a tenant without a
-- Finance template role adds none); a tenant that configured its own matrix is
-- never touched. Idempotent.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'cash_out', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key = 'finance'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'cash_out'
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
