-- Custom SQL migration file, put your code below! ---
-- EDC bridge (B2, legend-wasr7.21), as in drizzle/0541_edc_bridge.sql. Tenant
-- RLS (TEN-01/02) plus the outlet backstop (TEN-03). Nothing is ever deleted
-- by the app role: a device is revoked, a lease expires, a command is history.
SELECT app.enforce_tenant_rls('public.edc_bridge_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_bridge_terminal_leases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_terminal_leases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_bridge_commands'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_commands'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_devices FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_terminal_leases FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_commands FROM legend_app;
--> statement-breakpoint
-- Pre-auth lookup (as app.mcp_resolve_token, 0114): a WSS upgrade carries only
-- the device token, no tenant. Returns at most the row id and tenant id of the
-- token's SHA-256 hash (a 256-bit secret: naming it means holding the token).
-- The caller re-reads the row under tenant RLS and compares the hash in
-- constant time, so revocation is checked there.
CREATE FUNCTION app.edc_bridge_resolve_token(p_token_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id, d.tenant_id FROM public.edc_bridge_devices d WHERE d.token_hash = p_token_hash LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.edc_bridge_resolve_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.edc_bridge_resolve_token(text) TO legend_app;
