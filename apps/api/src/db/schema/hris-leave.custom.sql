-- Custom SQL migration file, put your code below! ---
-- HRIS leave, balances, accrual, holidays, overtime (bead legend-hggk; PRD v1.7
-- §3 F29): tenant RLS on every table (TEN-01/02). leave_requests and
-- overtime_requests carry outlet_id NOT NULL, so they also get the TEN-03
-- outlet backstop; holidays.outlet_id is nullable (null = whole tenant) and
-- keeps the service-layer outlet filter only.
-- Every CHECK / unique constraint is expressed in schema/hris-leave.ts.
SELECT app.enforce_tenant_rls('public.leave_types'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.leave_balances'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.leave_accruals'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.leave_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.leave_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.holidays'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.overtime_formulas'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.overtime_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.overtime_requests'::regclass);
