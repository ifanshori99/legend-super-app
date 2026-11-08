-- TEN-09 (legend-34c). config_imports is tenant data: tenant RLS like every
-- other tenant table (the helper also grants SELECT/INSERT/UPDATE/DELETE to
-- legend_app). It has no outlet_id, so only the tenant policy applies.
SELECT app.enforce_tenant_rls('public.config_imports'::regclass);
--> statement-breakpoint
-- config_templates is global (like platform_packages): no RLS. Least
-- privilege: the API reads templates and inserts new versions; a template is
-- immutable and never deleted by the app role.
GRANT SELECT, INSERT ON TABLE public.config_templates TO legend_app;
