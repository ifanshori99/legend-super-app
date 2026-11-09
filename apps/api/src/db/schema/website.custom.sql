-- Custom SQL migration fragment for legend-qgr6 (WS-08 public brand website
-- content). Append AFTER the drizzle-generated CREATE TABLE for brand_websites.
--
-- Tenant-owned config without per-outlet reach: the featured outlet is data on
-- the row, not an access scope, so only the tenant policy applies. Rows are
-- updated in place (draft/publish) and never deleted by the app role: an
-- unpublished site keeps its content for the next publish.
SELECT app.enforce_tenant_rls('public.brand_websites'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.brand_websites FROM legend_app;
