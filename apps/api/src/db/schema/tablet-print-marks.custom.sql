-- Custom SQL migration file, put your code below! ---
-- Tablet print marks (P3, legend-wasr7.4). Tenant RLS (TEN-01/02) plus the
-- outlet backstop (TEN-03), as in drizzle/0533_tablet_print_marks.sql.
SELECT app.enforce_tenant_rls('public.tablet_print_marks'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.tablet_print_marks'::regclass);
