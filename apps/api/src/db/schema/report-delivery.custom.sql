-- WS-11 F12 (legend-ay6e6): saved reports, schedules and export jobs are
-- tenant-owned rows without an outlet column (one report spans outlets; the
-- outlet scope is checked by the service against the caller's reach).
SELECT app.enforce_tenant_rls('public.saved_reports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.report_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.report_exports'::regclass);
