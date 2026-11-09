-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068. Without FORCE the owner skips RLS, so the
-- statements still span every tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-zw9r: AI and MCP write tools only propose; the approval matrix decides
-- (PRD v1.7 §3.7 "ai_action"/"mcp_action", AIG-03). Without a policy row the
-- approval service fails closed (APPROVAL_POLICY_MISSING), so no AI action
-- could ever be proposed. Give every existing tenant the default one-level
-- policy (approver: the tenant's outlet_manager template role, no amount
-- threshold, as in packages/shared/src/access/fixtures.ts) for each of the two
-- actions it has no policy for. Never touches a tenant that already configured
-- the action. New tenants get the same rows from seedTenantRoleTemplates.
-- Idempotent. Runs as the migration owner (BYPASSRLS), like earlier data
-- migrations, so it spans every tenant.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, a.action_type, NULL, r.id, 1, true
FROM public.roles r
CROSS JOIN (VALUES ('ai_action'), ('mcp_action')) AS a(action_type)
WHERE r.is_template
  AND r.template_key = 'outlet_manager'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = a.action_type
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
