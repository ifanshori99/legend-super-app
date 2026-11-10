-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068 and 0116. Without
-- FORCE the owner skips RLS, so the statements still span every tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-zi9o: a refund needs the supervisor's PIN or approval (PRD §3.6
-- "Override Supervisor", D14). The refund chain only opens at the first
-- decision of a payment.reconcile holder, and a refund below every tier skips
-- the chain, so a supervisor never saw it in the inbox. Give every existing
-- tenant the default refund matrix (same row as
-- DEFAULT_REFUND_APPROVAL_POLICIES in packages/shared/src/access/approval.ts
-- and seedTenantRoleTemplates): floor 0, level 1, supervisor. Floor 0 rather
-- than NULL: both match an amount of 0, 0 states "from Rp0". Higher tiers are
-- tenant configuration.
-- Only a tenant with no refund policy row and a supervisor template role gets
-- the row; a tenant that configured refunds is never touched. Idempotent.
-- Spans every tenant because FORCE ROW LEVEL SECURITY is lifted above (the
-- owner skips RLS without FORCE).
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'refund', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key = 'supervisor'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'refund'
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
