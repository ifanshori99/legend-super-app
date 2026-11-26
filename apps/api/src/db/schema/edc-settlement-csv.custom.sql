-- Custom SQL migration file, put your code below! ---
-- EDC settlement CSV (X2, legend-wasr7.11). Tenant RLS (TEN-01/02) plus the
-- outlet backstop (TEN-03), append-only for the app role, as in
-- drizzle/0538_edc_settlement_csv.sql.
SELECT app.enforce_tenant_rls('public.edc_settlement_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_settlement_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_settlement_rows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_settlement_rows'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.edc_settlement_files FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.edc_settlement_rows FROM legend_app;
