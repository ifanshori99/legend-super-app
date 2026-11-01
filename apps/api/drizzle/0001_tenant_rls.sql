-- Migration connection must be a separate owner with CREATEROLE. Login roles
-- are provisioned separately and granted membership of this NOLOGIN role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_app') THEN
    CREATE ROLE legend_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_app' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'legend_app exists with unsafe privileges';
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA app;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, public TO legend_app;
--> statement-breakpoint
-- Existing starter/Better Auth tables are global, and retain their behavior.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", "session", "account", "verification", "notes" TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.require_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE tenant text;
BEGIN
  tenant := current_setting('app.tenant_id', true);
  IF tenant IS NULL OR tenant = '' THEN
    RAISE EXCEPTION 'tenant context is required' USING ERRCODE = '42501';
  END IF;
  RETURN tenant::uuid;
END $$;
--> statement-breakpoint
-- Call from each tenant table migration after creating tenant_id UUID NOT NULL.
-- Invoker must own the table; this does not confer DDL privileges on the app.
CREATE FUNCTION app.enforce_tenant_rls(target regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = target AND attname = 'tenant_id' AND atttypid = 'uuid'::regtype
      AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'tenant table % must have tenant_id UUID NOT NULL', target;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('CREATE POLICY tenant_access ON %s AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)', target);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s AS RESTRICTIVE FOR ALL USING (tenant_id = app.require_tenant_id()) WITH CHECK (tenant_id = app.require_tenant_id())', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO legend_app', target);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_tenant_rls(regclass) FROM PUBLIC;
