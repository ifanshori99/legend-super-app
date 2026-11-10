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
-- legend-tm6pp: founder decision Q2 (2026-11-10). A share allocation version and
-- a statement-recipient change (matrix action shareholder_version) need one
-- approval from the Owner; with no policy the approval service fails closed
-- (APPROVAL_POLICY_MISSING). Give every existing tenant that has no
-- shareholder_version policy the default row (same as
-- DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES in
-- packages/shared/src/access/approval.ts and seedTenantRoleTemplates): floor 0,
-- level 1, the Owner template role, distinct actor required. A tenant that
-- already has any shareholder_version row (its own matrix) is never touched, and
-- a tenant without an Owner template role gets no row. Idempotent.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'shareholder_version', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'shareholder_version'
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
