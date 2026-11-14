-- legend-ofq4f: a web push subscription is bound to the login session that
-- registered it, plus the outlet (and registered device) whose panic alarms it
-- may receive. registered_at has no default: every verified registration sets
-- it, so existing rows stay NULL and the worker ignores them until the browser
-- registers again. The session FK is SET NULL, not CASCADE: an idle staff
-- session that expires (and is cleaned up) must not take the alarm with it.
-- Deleting a still-valid session (sign-out, revoke, stop impersonating, any
-- direct delete) deletes its rows through the session_delete_push_subscriptions
-- trigger (below); a revoke that keeps the session row calls
-- app.delete_session_push_subscriptions itself (identity-session.service.ts).
-- Outlet and device FKs are tenant-composite (pattern of devices_outlet_fk).
-- Numbering: 0375 (journal idx 357); no INSERT/UPDATE statements, so no
-- data-import-registry entry.
-- The three FKs are NOT VALID: the production migrator is a plain table owner
-- without app.tenant_id, and validating existing rows scans push_subscriptions
-- (FORCE RLS), which raises "tenant context is required" and rolls the whole
-- run back on a populated database. Every pre-existing row has NULL in the new
-- columns, so nothing is left unchecked; new and updated rows are enforced.
ALTER TABLE "push_subscriptions" ADD COLUMN "outlet_id" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_outlet_idx" ON "push_subscriptions" USING btree ("tenant_id","user_id","outlet_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_session_idx" ON "push_subscriptions" USING btree ("session_id");--> statement-breakpoint
-- Session deletes run outside any tenant context, and a browser may hold rows
-- in several tenants for one session; push_subscriptions forces tenant RLS.
-- This function deletes every row of one session in any tenant and returns
-- the count. It first locks the session row, so a registration that is
-- checking the same session (FOR SHARE) commits first and its row is deleted
-- too. It runs as the migration
-- owner (superuser or BYPASSRLS, docs/deployment.md), search_path is pinned,
-- it deletes nothing for a NULL id, and EXECUTE is limited to legend_app.
CREATE FUNCTION app.delete_session_push_subscriptions(p_session_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE removed integer;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM 1 FROM public.session s WHERE s.id = p_session_id FOR UPDATE;
  DELETE FROM public.push_subscriptions ps WHERE ps.session_id = p_session_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_session_push_subscriptions(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_session_push_subscriptions(text) TO legend_app;
--> statement-breakpoint
-- A still-valid session that is deleted was ended on purpose (sign-out,
-- revoke-sessions, stop impersonating, merge, support cleanup): its browsers
-- stop receiving pushes in the same transaction. An expired session that is
-- cleaned up keeps them (the FK then nulls session_id), so a phone locked past
-- the 30-minute idle limit still gets its panic alarms. A revoked session
-- (revoke by UPDATE: offboarding, identity and control-plane events) is never
-- treated as expired: deleting it later deletes its rows, so they cannot come
-- back through the SET NULL path. Same owner, pinned
-- search_path and no PUBLIC EXECUTE as the function it calls.
CREATE FUNCTION app.session_delete_push_subscriptions()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR OLD.expires_at > now() THEN
    PERFORM app.delete_session_push_subscriptions(OLD.id);
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.session_delete_push_subscriptions() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER session_delete_push_subscriptions
BEFORE DELETE ON public.session
FOR EACH ROW EXECUTE FUNCTION app.session_delete_push_subscriptions();
