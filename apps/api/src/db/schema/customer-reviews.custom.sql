-- Custom SQL migration file, put your code below! ---
-- legend-vqicf: hand SQL of migration 0455 (table in customer-reviews.ts).
-- Keep this file and the migration in step. The generated CREATE TABLE carries
-- every foreign key inline (pattern 1, docs/plan/contracts.md: the table is
-- empty, so FORCE RLS needs no lift). 0455 changes no data and lifts no FORCE.
SELECT app.enforce_tenant_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
-- legend-7jrh7: customer_profile_id is guarded by app.enforce_member_rls in
-- migration 0491 (0455 stays as applied); a fresh schema build must call
-- SELECT app.enforce_member_rls('public.customer_reviews'::regclass) too.
-- Reviews are never deleted: moderation moves a review to `hidden`.
REVOKE DELETE, TRUNCATE ON TABLE public.customer_reviews FROM legend_app;
