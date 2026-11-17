-- Custom SQL migration file, put your code below! ---
-- legend-wg5t: the migrator may also be a plain table owner (no SUPERUSER,
-- no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 on roles and
-- approval_policies. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068, 0116, 0140, 0145,
-- 0586 and 0587. Without FORCE the owner skips RLS, so the statements still
-- span every tenant.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-98etn: a supplier payment always needs a second person (Q27), so a
-- tenant's supplier_payment matrix must have a base tier: level 1 for every
-- amount (floor 0). A tenant that configured only higher tiers (for example
-- from 5,000,000) lets a smaller payment through with no approval; the
-- approval engine then falls back to the lowest tier with ALL its levels
-- (platform-approval.service.ts alwaysRequire). So for each tenant that has
-- supplier_payment rows but no level 1 row with floor null or 0, copy EVERY
-- row (all levels, all approver roles) of the lowest existing tier (lowest
-- floor) to floor 0, level kept as is, distinct actor required: a two-level
-- tenant keeps both levels, so nothing is loosened. A tenant whose lowest tier
-- has no level 1 row is skipped (fail closed, a manager fixes the matrix). This
-- only ADDS rows: none is deleted or updated, so no payment gets easier. A
-- tenant with no supplier_payment rows (0587 handled it), a tenant that
-- already has the base tier and every other action type are untouched.
-- Idempotent: after the insert the tenant has a base tier.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT DISTINCT p.tenant_id, 'supplier_payment', 0, p.approver_role_id, p.levels, true
FROM public.approval_policies p
WHERE p.action_type = 'supplier_payment'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies b
    WHERE b.tenant_id = p.tenant_id AND b.action_type = 'supplier_payment'
      AND b.levels = 1 AND coalesce(b.threshold_idr, 0) = 0
  )
  AND coalesce(p.threshold_idr, 0) = (
    SELECT min(coalesce(t.threshold_idr, 0)) FROM public.approval_policies t
    WHERE t.tenant_id = p.tenant_id AND t.action_type = 'supplier_payment'
  )
  AND EXISTS (
    SELECT 1 FROM public.approval_policies l
    WHERE l.tenant_id = p.tenant_id AND l.action_type = 'supplier_payment'
      AND l.levels = 1
      AND coalesce(l.threshold_idr, 0) = coalesce(p.threshold_idr, 0)
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
