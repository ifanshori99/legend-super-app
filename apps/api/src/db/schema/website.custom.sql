-- Custom SQL migration fragment for legend-qgr6 (WS-08 public brand website
-- content). Append AFTER the drizzle-generated CREATE TABLE for brand_websites.
--
-- Tenant-owned config without per-outlet reach: the featured outlet is data on
-- the row, not an access scope, so the tenant policy plus tenant_wide_only apply. Rows are
-- updated in place (draft/publish) and never deleted by the app role: an
-- unpublished site keeps its content for the next publish.
SELECT app.enforce_tenant_rls('public.brand_websites'::regclass);
--> statement-breakpoint
-- A restrictive policy makes the DB itself enforce what the service does with
-- assertTenantWide: a session whose outlet scope is not tenant-wide sees no
-- row and cannot write one.
CREATE POLICY tenant_wide_only ON public.brand_websites AS RESTRICTIVE FOR ALL USING ((SELECT app.outlet_scope_is_tenant())) WITH CHECK ((SELECT app.outlet_scope_is_tenant()));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.brand_websites FROM legend_app;
