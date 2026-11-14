-- legend-xdlxa (863 delta 2): a browser push endpoint belongs to the account
-- that registered it first. Registering an endpoint that another account
-- already holds, in any tenant, is refused by the service (409) instead of
-- moving or deleting the owner's row (app.claim_push_endpoint stays in place
-- but is no longer called). Only a row still being sent to counts as an owner
-- (registered_at within 30 days, the same filter as the web push worker), so a
-- stale row of another account does not lock the endpoint. Invariant: at most
-- one owner of an endpoint is still being sent to. push_subscriptions forces tenant RLS, so the
-- cross-tenant check needs owner rights, like app.claim_push_endpoint. The
-- advisory lock is the same one claim_push_endpoint takes, so concurrent
-- registrations of one endpoint serialise. NULL arguments answer false.
CREATE FUNCTION app.push_endpoint_owned_by_other(p_user uuid, p_endpoint_hash text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user IS NULL OR p_endpoint_hash IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('push-endpoint:' || p_endpoint_hash, 0));
  RETURN EXISTS (
    SELECT 1 FROM public.push_subscriptions ps
    WHERE ps.endpoint_hash = p_endpoint_hash
      AND ps.user_id <> p_user
      AND ps.registered_at IS NOT NULL
      AND ps.registered_at > now() - interval '30 days'
  );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.push_endpoint_owned_by_other(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.push_endpoint_owned_by_other(uuid, text) TO legend_app;
