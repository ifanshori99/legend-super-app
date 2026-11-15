-- legend-806: second-opinion fixes for the panic alarm web push (P0-1, P1-1,
-- P1-2, P1-3). Numbering: 0379 (journal idx 358). The only DELETE statements
-- sit inside function bodies, so no data-import-registry entry is needed.
--
-- delivered_push_subscription_ids: web push subscriptions of one delivery
-- attempt that already accepted the push, so a retry after a partial failure
-- sends only to the rest (a duplicate is acceptable, a lost alarm is not).
-- device_token_issued_at: devices.token_issued_at at registration; the worker
-- sends only while it still equals the device's current value, so reissuing a
-- device token silences the registrations made with the old one.
ALTER TABLE "delivery_attempts" ADD COLUMN "delivered_push_subscription_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "device_token_issued_at" timestamp with time zone;--> statement-breakpoint
-- P1-3: a browser endpoint belongs to one account at a time, across tenants.
-- The registering caller has proven they hold this endpoint, so every row for
-- the same endpoint hash that belongs to another account (user_id <> p_user)
-- is removed, in any tenant. The caller's own rows stay, also in other
-- tenants: one person can be a member of several tenants on one browser.
-- p_tenant is only validated, not used to filter. push_subscriptions forces
-- tenant RLS, so this runs as the migration owner like
-- app.delete_session_push_subscriptions. The advisory lock
-- serialises concurrent registrations of one endpoint, so two accounts racing
-- cannot both keep a row. Returns the number of rows removed.
CREATE FUNCTION app.claim_push_endpoint(p_tenant uuid, p_user uuid, p_endpoint_hash text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE removed integer;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL OR p_endpoint_hash IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('push-endpoint:' || p_endpoint_hash, 0));
  DELETE FROM public.push_subscriptions ps
  WHERE ps.endpoint_hash = p_endpoint_hash
    AND ps.user_id <> p_user;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_push_endpoint(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_push_endpoint(uuid, uuid, text) TO legend_app;
--> statement-breakpoint
-- P1-1: deleting every session of a user (revoke-sessions, password reset,
-- admin revoke or ban) must also delete subscriptions whose session is already
-- gone (session_id NULL after an expiry cleanup), which the per-session
-- function cannot reach. p_keep_session (revoke-other-sessions) spares the
-- subscriptions of the caller's current session; NULL spares none. Same owner,
-- pinned search_path and grant as app.delete_session_push_subscriptions.
CREATE FUNCTION app.delete_user_push_subscriptions(p_user uuid, p_keep_session text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE removed integer;
BEGIN
  IF p_user IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.push_subscriptions ps
  WHERE ps.user_id = p_user
    AND (p_keep_session IS NULL OR ps.session_id IS DISTINCT FROM p_keep_session);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_user_push_subscriptions(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_user_push_subscriptions(uuid, text) TO legend_app;
