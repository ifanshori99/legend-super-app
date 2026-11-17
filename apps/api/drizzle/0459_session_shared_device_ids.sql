-- legend-jqurl: a login session remembers every shared-mode device it was used
-- on (newest 8, capped by the service), replacing the single shared_device_id
-- of 0458. Existing marks carry over as one-element arrays. No FK: a revoked or
-- deleted device just lets the mark lapse.
ALTER TABLE "session" ADD COLUMN "shared_device_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
UPDATE "session" SET "shared_device_ids" = ARRAY["shared_device_id"] WHERE "shared_device_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "shared_device_id";
--> statement-breakpoint

-- Cross-tenant mark check. The session cookie is shared across tenants, and
-- `devices` has forced tenant RLS, so a request in tenant B cannot read a
-- device of tenant A that the session was marked on. This narrow SECURITY
-- DEFINER function answers only a boolean (is any of these ids an active
-- device flagged shared) for ids the caller already holds from its own session
-- row; nothing is scannable, listed or written. It runs as the migration owner
-- (superuser or BYPASSRLS, docs/deployment.md), search_path is pinned and
-- EXECUTE is limited to legend_app, like app.mcp_resolve_token (0114).
CREATE FUNCTION app.shared_device_active(p_device_ids uuid[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = ANY(p_device_ids) AND d.status = 'active' AND d.shared_mode)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.shared_device_active(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.shared_device_active(uuid[]) TO legend_app;
--> statement-breakpoint

-- Shared mode exists only on POS devices (the acting-cashier rule is a POS
-- rule). Clear any other type, then enforce it.
UPDATE "devices" SET "shared_mode" = false WHERE "shared_mode" AND "type" <> 'pos';
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_shared_mode_pos_only" CHECK (NOT "shared_mode" OR "type" = 'pos');
