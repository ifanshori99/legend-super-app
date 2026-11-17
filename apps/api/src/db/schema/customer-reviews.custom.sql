-- Custom SQL migration file, put your code below! ---
-- legend-vqicf: hand SQL of migration 0545 (table in customer-reviews.ts).
-- Keep this file and the migration in step. The generated CREATE TABLE carries
-- every foreign key inline (pattern 1, docs/plan/contracts.md: the table is
-- empty, so FORCE RLS needs no lift). 0545 changes no data and lifts no FORCE.
SELECT app.enforce_tenant_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
-- Reviews are never deleted: moderation moves a review to `hidden`.
REVOKE DELETE, TRUNCATE ON TABLE public.customer_reviews FROM legend_app;
