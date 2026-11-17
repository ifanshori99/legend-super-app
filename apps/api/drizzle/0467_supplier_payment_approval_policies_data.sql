-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068, 0116, 0140, 0145 and
-- 0586. Without FORCE the owner skips RLS, so the statements still span every
-- tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-xxqz3: CTO money decision (2026-11-17). Every supplier payment waits
-- for one approval from someone other than the requester. Give every existing
-- tenant the default supplier_payment matrix (same rows as
-- DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES in
-- packages/shared/src/access/approval.ts and seedTenantRoleTemplates): floor 0
-- (all amounts), level 1, for the Finance and Owner template roles, distinct
-- actor required. Only a tenant with no supplier_payment policy row gets rows
-- (a tenant without those template roles adds none and stays fail closed); a
-- tenant that configured its own matrix is never touched. Idempotent.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'supplier_payment', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key IN ('finance', 'owner')
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'supplier_payment'
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
