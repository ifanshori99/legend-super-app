-- RBAC isolation (PRD v1.7 §3.7 RBAC, §6 B roles / role_assignments /
-- approval_policies, TEN-03). Every table is tenant-owned: tenant_id NOT NULL
-- with a RESTRICTIVE tenant_isolation policy, plus DML grants to the
-- non-bypass application role. The composite (tenant_id, id) foreign keys in
-- 0008 already stop a privileged writer from pointing an assignment or policy
-- at another tenant's role.
--
-- Run order: after the generated tables migration (0008). Never replay the
-- 119connect migrations; this is the Legend policy.
SELECT app.enforce_tenant_rls('public.roles'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.role_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.approval_policies'::regclass);
