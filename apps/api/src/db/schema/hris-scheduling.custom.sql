-- Custom SQL migration file, put your code below! ---
-- HRIS shift scheduling (bead legend-jstx; PRD v1.7 §3 F26, HR-05): tenant RLS
-- on every table (TEN-01/02). Tables with outlet_id NOT NULL also get the
-- TEN-03 outlet backstop; shift_compliance_policies.outlet_id is nullable
-- (null = tenant default) and keeps the service-layer outlet filter only.
-- Every CHECK / unique constraint is expressed in schema/hris-scheduling.ts.
SELECT app.enforce_tenant_rls('public.shift_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.roster_publications'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.roster_publications'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.roster_copies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.roster_copies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_swap_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_swap_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_compliance_policies'::regclass);
