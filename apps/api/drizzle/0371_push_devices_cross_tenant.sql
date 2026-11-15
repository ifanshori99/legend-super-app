-- legend-fonnr: a user must see and revoke the push alarm devices they
-- registered in any tenant, not only the tenant of the current session or
-- domain. Numbering: 0380 (journal idx 359). The only DELETE statement sits
-- inside a function body, so no data-import-registry entry is needed.
--
-- push_subscriptions forces tenant RLS, so these two functions run as the
-- migration owner (SECURITY DEFINER, pinned search_path). The owner is never a
-- parameter: it is derived inside the function from the caller's live login
-- session (p_session, verified by the server): session.user_id of a row that is
-- not revoked and not expired at p_now nor at the database clock (a stale
-- p_now cannot revive an expired session). A dead or unknown session returns no
-- rows / deletes nothing. They never return endpoint, keys, ciphertext or hash.
--
-- list_own_push_devices: the caller's own subscriptions in every tenant that
-- are still deliverable (SQL twin of deliverablePushSubscription in
-- src/worker/web-push-provider.ts), newest registration first. session_active
-- tells whether the registering session still belongs to the same user, is not
-- revoked and is not expired.
CREATE FUNCTION app.list_own_push_devices(p_session text, p_now timestamptz)
RETURNS TABLE(id uuid, tenant_id uuid, device_label varchar(100), registered_at timestamptz, created_at timestamptz, session_id text, session_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT ps.id, ps.tenant_id, ps.device_label, ps.registered_at, ps.created_at, ps.session_id,
    EXISTS (
      SELECT 1 FROM public.session rs
      WHERE rs.id = ps.session_id
        AND rs.user_id = ps.user_id::text
        AND rs.revoked_at IS NULL
        AND rs.expires_at > p_now
    ) AS session_active
  FROM public.push_subscriptions ps
  JOIN public.session s ON s.user_id = ps.user_id::text
  WHERE s.id = p_session
    AND s.revoked_at IS NULL
    AND s.expires_at > greatest(p_now, now())
    AND ps.registered_at IS NOT NULL
    AND ps.registered_at > p_now - interval '30 days'
    AND (ps.session_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.session ds
        WHERE ds.id = ps.session_id
          AND ds.user_id = ps.user_id::text
          AND ds.revoked_at IS NULL))
    AND (ps.device_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.devices d
        WHERE d.id = ps.device_id
          AND d.tenant_id = ps.tenant_id
          AND d.status = 'active'
          AND d.revoked_at IS NULL
          AND d.token_issued_at IS NOT NULL
          AND ps.device_token_issued_at = d.token_issued_at))
  ORDER BY coalesce(ps.registered_at, ps.created_at) DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.list_own_push_devices(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_own_push_devices(text, timestamptz) TO legend_app;
--> statement-breakpoint
-- delete_own_push_device: removes one subscription owned by the session's user,
-- in any tenant. Same owner derivation as the list function. Returns the number
-- of rows removed (0 when the session is dead or the id is not the user's).
CREATE FUNCTION app.delete_own_push_device(p_session text, p_id uuid, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  owner text;
  removed integer;
BEGIN
  SELECT s.user_id INTO owner
  FROM public.session s
  WHERE s.id = p_session
    AND s.revoked_at IS NULL
    AND s.expires_at > greatest(p_now, now());
  IF owner IS NULL OR p_id IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.push_subscriptions ps
  WHERE ps.id = p_id
    AND ps.user_id::text = owner;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_own_push_device(text, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_own_push_device(text, uuid, timestamptz) TO legend_app;
