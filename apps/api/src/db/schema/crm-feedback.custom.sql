-- Custom SQL migration file, put your code below! ---
-- legend-ts50: hand SQL of migration 0209 (tables in crm-feedback.ts and
-- crm-segments.ts). Keep this file and the migration in step. The generated
-- CREATE TABLE statements carry every foreign key inline (pattern 1,
-- docs/plan/contracts.md: the new tables are empty, so FORCE RLS needs no
-- lift). 0209 changes no data and lifts no FORCE.
SELECT app.enforce_tenant_rls('public.feedback'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.feedback'::regclass);
--> statement-breakpoint
-- Member RLS (design §M4): a member reads only feedback of their own profile.
-- Rows with a NULL profile (QR guests) never match, so members cannot see
-- them. Staff and worker paths never set app.customer_profile_id, so the
-- RESTRICTIVE policy is inert for them.
SELECT app.enforce_member_rls('public.feedback'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.segments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.segment_members'::regclass);
--> statement-breakpoint
-- Feedback and segments are never deleted: feedback moves through its status
-- and a segment is refreshed in place. segment_members keeps DELETE so a
-- refresh can replace the materialized rows.
REVOKE DELETE, TRUNCATE ON TABLE public.feedback FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.segments FROM legend_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE public.segment_members FROM legend_app;
