-- Custom SQL migration file, put your code below! ---
-- HRIS attendance (bead legend-wh71; PRD v1.7 §3 F25, HR-02): tenant RLS on
-- every table (TEN-01/02). Tables with outlet_id NOT NULL also get the TEN-03
-- outlet backstop; attendance_policies.outlet_id is nullable (null = tenant
-- default) and attendance_devices belongs to the employee, so both keep the
-- service-layer outlet filter only. Every CHECK / unique constraint is
-- expressed in schema/hris-attendance.ts.
SELECT app.enforce_tenant_rls('public.attendance_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_corrections'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_corrections'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_qr_secrets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_qr_secrets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_duty_meals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_duty_meals'::regclass);
