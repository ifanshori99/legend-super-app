-- Custom SQL migration file, put your code below! ---
-- Tanya AI, MCP server and AI governance (beads legend-zfi4, xq8y, zw9r, xkbt;
-- PRD v1.7 §3 Fitur 38/39/40, §6 J): tenant RLS on every table (TEN-01/02).
-- Every outlet_id here is nullable (tenant-level rows are allowed), so, like
-- the other nullable-outlet tables (0032), outlet reach stays a service filter
-- and only tenant RLS is enforced.
SELECT app.enforce_tenant_rls('public.ai_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_usage_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_usage_daily'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_usage_monthly'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_response_cache'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_conversations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_messages'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_tool_calls'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.action_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.mcp_clients'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.mcp_tokens'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.mcp_auth_codes'::regclass);
--> statement-breakpoint
-- The tool-call audit is append-only for the application role (MCP-03): a call
-- is recorded once and never edited or removed.
REVOKE UPDATE, DELETE ON TABLE public.ai_tool_calls FROM legend_app;
--> statement-breakpoint

-- Pre-auth lookups (MCP-01/02). An MCP request arrives with a bearer token, and
-- an OAuth token request with an authorization code; neither carries a tenant,
-- so there is no app.tenant_id to read the row with. `mcp_tokens` and
-- `mcp_auth_codes` keep the full forced tenant RLS (provision-roles.ts accepts
-- no other policy shape) and are resolved through two narrow SECURITY DEFINER
-- functions instead:
--
--   SELECT id, tenant_id FROM app.mcp_resolve_token(<sha256 hex of the bearer>);
--   SELECT id, tenant_id FROM app.mcp_resolve_auth_code(<sha256 hex of the code>);
--
-- They return at most one row and only the row id and tenant id. The hash is a
-- 256-bit secret, so a caller that can name it already holds the credential;
-- nothing is scannable, nothing is written. The caller then re-reads the full
-- row (scopes, expiry, revoked_at, client status) through `withTenant` with
-- the tenant just resolved, so revocation and expiry are checked under RLS.
-- The functions run as the migration owner, which is a superuser or a
-- BYPASSRLS role (docs/deployment.md), so FORCE RLS does not hide the row from
-- them. search_path is pinned; EXECUTE is limited to legend_app.
CREATE FUNCTION app.mcp_resolve_token(p_token_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.tenant_id FROM public.mcp_tokens t WHERE t.token_hash = p_token_hash LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION app.mcp_resolve_auth_code(p_code_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.tenant_id FROM public.mcp_auth_codes c WHERE c.code_hash = p_code_hash LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mcp_resolve_token(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mcp_resolve_auth_code(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.mcp_resolve_token(text) TO legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.mcp_resolve_auth_code(text) TO legend_app;
