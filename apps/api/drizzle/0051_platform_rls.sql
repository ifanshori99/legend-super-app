-- Custom SQL migration file, put your code below! ---
-- Platform BE squad (legend-0yp, legend-cv3): tenant RLS on the new tables
-- (TEN-01/02). consents is append-only for the app role (LOY-04).
SELECT app.enforce_tenant_rls('public.usage_costs_daily'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.text_overrides'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.consents'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.consents FROM legend_app;
