-- Custom SQL migration fragment for legend-4b5 (order_issues). Append AFTER the
-- drizzle-generated CREATE TABLE statement for order_issues.
--
-- Tenant + outlet RLS (TEN-01/TEN-03). order_issues has outlet_id NOT NULL.
-- Rows are updated when an open issue is resolved; the API never deletes one.
SELECT app.enforce_tenant_rls('public.order_issues'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issues'::regclass);
