-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068, 0116 and 0145. Without
-- FORCE the owner skips RLS, so the statements still span every tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Founder Q63: a refund above the supervisor's Rp200.000 ceiling is approved by
-- the outlet manager (up to Rp1.000.000), the general manager (up to
-- Rp5.000.000) or the owner, but the default matrix (0140) named only the
-- supervisor, so a manager could never be the level-1 approver (an approver must
-- hold the exact role the matrix names, APPROVER_ROLE_MISMATCH). Give the
-- default refund matrix the same shape as cash_shift_close (0145): floor 0,
-- level 1, for supervisor, outlet_manager, general_manager and owner (same rows
-- as DEFAULT_REFUND_APPROVAL_POLICIES in packages/shared/src/access/approval.ts
-- and seedTenantRoleTemplates). The amount ceiling stays in code (Q63).
-- Only a tenant that still has the old default (no refund row, or exactly one
-- refund row: floor 0, level 1, supervisor template) gets the missing rows; a
-- tenant that configured its own refund matrix is never touched. A role that
-- does not exist adds no row. Idempotent: a row that exists is not added twice.
-- Spans every tenant because FORCE ROW LEVEL SECURITY is lifted above (the
-- owner skips RLS without FORCE).
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'refund', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key IN ('supervisor', 'outlet_manager', 'general_manager', 'owner')
  AND (
    NOT EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.tenant_id = r.tenant_id AND p.action_type = 'refund'
    )
    OR (
      (SELECT count(*) FROM public.approval_policies p
        WHERE p.tenant_id = r.tenant_id AND p.action_type = 'refund') = 1
      AND EXISTS (
        SELECT 1 FROM public.approval_policies p
        JOIN public.roles sr ON sr.id = p.approver_role_id
        WHERE p.tenant_id = r.tenant_id AND p.action_type = 'refund'
          AND p.threshold_idr = 0 AND p.levels = 1
          AND sr.is_template AND sr.template_key = 'supervisor'
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'refund'
      AND p.approver_role_id = r.id AND p.levels = 1
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
