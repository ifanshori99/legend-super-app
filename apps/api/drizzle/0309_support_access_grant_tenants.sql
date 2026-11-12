-- legend-ca4l (TEN-04): the platform support-access lookups no longer open one
-- transaction per tenant to find a grant. support_access_grants keeps its FORCE
-- tenant RLS and is still read by the service through withTenant, one tenant at
-- a time, but only for the tenants this function names:
--
--   SELECT app.support_access_grant_tenants(<grant id>);                 -- the tenant of that grant
--   SELECT app.support_access_grant_tenants(NULL, <admin>, <instant>);   -- tenants where <admin> holds a grant live at <instant>
--   SELECT app.support_access_grant_tenants();                           -- tenants with any grant
--
-- It returns tenant ids only, never a grant row, reason or timestamp, and
-- writes nothing. Live means started_at <= at < expires_at and not ended
-- before at. The function runs as the migration owner, which is a superuser
-- or a BYPASSRLS role (docs/deployment.md), so FORCE RLS does not hide the rows
-- from it (same shape as app.mcp_resolve_token, 0114). search_path is pinned;
-- EXECUTE is limited to legend_app.
CREATE FUNCTION app.support_access_grant_tenants(
  p_grant_id uuid DEFAULT NULL,
  p_admin_user_id text DEFAULT NULL,
  p_at timestamptz DEFAULT NULL
) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT g.tenant_id
  FROM public.support_access_grants g
  WHERE (p_grant_id IS NULL OR g.id = p_grant_id)
    AND (p_admin_user_id IS NULL OR g.super_admin_user_id = p_admin_user_id)
    AND (
      p_at IS NULL
      OR (
        g.started_at <= p_at
        AND p_at < g.expires_at
        AND (g.ended_at IS NULL OR g.ended_at > p_at)
      )
    )
  ORDER BY g.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.support_access_grant_tenants(uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.support_access_grant_tenants(uuid, text, timestamptz) TO legend_app;
