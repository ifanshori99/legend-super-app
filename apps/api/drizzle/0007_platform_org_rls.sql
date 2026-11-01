-- Platform & organisation isolation (PRD v1.7 §6 A, TEN-01/02/03/04).
-- Runs after the generated table migration. Every statement is idempotent so
-- a re-run on an existing database cannot diverge.

-- ---------------------------------------------------------------- tenant (T)
-- tenant_id NOT NULL + RESTRICTIVE tenant_isolation policy + DML grants to the
-- non-bypass application role. Children in the same tenant are reachable
-- through composite (tenant_id, id) foreign keys.
SELECT app.enforce_tenant_rls('public.brands'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.legal_entities'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.outlets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tenant_integrations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tenant_themes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.support_access_grants'::regclass);
--> statement-breakpoint

-- ------------------------------------------------------- tenant_domains (T*)
-- Host-name resolution runs before a tenant exists (TEN-02: the tenant comes
-- from the domain), so this table cannot use require_tenant_id() for reads.
-- Reads are therefore open to the app role (host names and their tenant are
-- public DNS information); every write still requires app.tenant_id to equal
-- tenant_id. RLS is ENABLED but not FORCED so the migration owner can repair
-- rows. apps/api/src/db/rls.test.ts allowlists exactly this table.
ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.tenant_domains'::regclass AND polname = 'tenant_domain_read'
  ) THEN
    CREATE POLICY tenant_domain_read ON public.tenant_domains
      AS PERMISSIVE FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.tenant_domains'::regclass AND polname = 'tenant_domain_insert'
  ) THEN
    CREATE POLICY tenant_domain_insert ON public.tenant_domains
      AS PERMISSIVE FOR INSERT WITH CHECK (tenant_id = app.require_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.tenant_domains'::regclass AND polname = 'tenant_domain_update'
  ) THEN
    CREATE POLICY tenant_domain_update ON public.tenant_domains
      AS PERMISSIVE FOR UPDATE
      USING (tenant_id = app.require_tenant_id())
      WITH CHECK (tenant_id = app.require_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.tenant_domains'::regclass AND polname = 'tenant_domain_delete'
  ) THEN
    CREATE POLICY tenant_domain_delete ON public.tenant_domains
      AS PERMISSIVE FOR DELETE USING (tenant_id = app.require_tenant_id());
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_domains TO legend_app;
--> statement-breakpoint

-- -------------------------------------------------------------- global tables
-- Least privilege: nothing is granted by default. The API needs to read the
-- tenant registry (flags, resolution), packages (plan validation), platform
-- admins (support access) and regions (address lookup); it creates and updates
-- tenants and never deletes one (archive instead).
GRANT SELECT, INSERT, UPDATE ON TABLE public.tenants TO legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.platform_packages TO legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.platform_admins TO legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.regions TO legend_app;
--> statement-breakpoint

-- ------------------------------------------------- worker tenant registry view
-- Exact definition of ACTIVE_TENANT_REGISTRY in @starter/shared/platform: the
-- queue role reads only active tenant ids, so a suspended or archived tenant's
-- outbox is neither relayed nor delivered. The view is owned by the migration
-- owner; legend_app and the provisioned worker role get SELECT, PUBLIC nothing.
DROP VIEW IF EXISTS app.active_tenant_registry;
--> statement-breakpoint
CREATE VIEW app.active_tenant_registry AS
  SELECT id FROM public.tenants WHERE status = 'active';
--> statement-breakpoint
REVOKE ALL ON app.active_tenant_registry FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON app.active_tenant_registry TO legend_app;
--> statement-breakpoint

-- ------------------------------------------------- bootstrap lookup retirement
-- The synthetic dev tenant now lives in tenants/brands/outlets, so the
-- one-row bootstrap table and its allowlist entry are gone (TEN-06: a tenant
-- is data, not a bootstrap insert). app.ts reads the seeded tenant instead.
DROP TABLE IF EXISTS app.dev_tenant_lookup;
