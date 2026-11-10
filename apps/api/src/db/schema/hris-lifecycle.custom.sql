-- Custom SQL migration file, put your code below! ---
-- HRIS lifecycle and KPI (bead legend-ovxw; PRD v1.7 F24, F29): tenant RLS on
-- every table (TEN-01/02). None carries a NOT NULL `outlet_id`, so outlet
-- reach is enforced in services/hris-*.ts through the employee's home outlet
-- (like `employees`). The task action trail is append-only.
SELECT app.enforce_tenant_rls('public.hris_checklist_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_offboardings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_checklist_tasks'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_checklist_task_actions'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.hris_checklist_task_actions FROM legend_app;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_definitions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_reviews'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_scores'::regclass);
