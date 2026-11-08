-- Tenant RLS for payroll_pph21_policies (payroll-pph21-policy.ts, bead
-- legend-y4wp). Tenant-owned config without an outlet, so only the tenant
-- policy applies. A policy version is immutable: the app role keeps SELECT and
-- INSERT only, so a stored version never changes. A run that keeps the version
-- id can reproduce its tax with that exact version (PRD R21); keeping the id
-- in the run snapshot is the payroll run's work (follow-up bead).
SELECT app.enforce_tenant_rls('public.payroll_pph21_policies'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_pph21_policies FROM legend_app;
