-- Custom SQL migration file, put your code below! ---
-- EDC bridge pairing codes (B4, legend-wasr7.24), as in
-- drizzle/0543_edc_bridge_pair_codes.sql. Tenant RLS (TEN-01/02) plus the
-- outlet backstop (TEN-03) on the codes; nothing is deleted by the app role
-- (a code is used, cancelled or expires).
SELECT app.enforce_tenant_rls('public.edc_bridge_pair_codes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_pair_codes'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_pair_codes FROM legend_app;
--> statement-breakpoint
-- The per-IP slots have no tenant (the tablet is anonymous before pairing).
-- The app role never touches the table; the two functions below do.
REVOKE ALL ON TABLE public.edc_bridge_pair_ip_slots FROM legend_app;
--> statement-breakpoint
-- The 5 below (and in the failed_attempts CHECK) is
-- EDC_BRIDGE_PAIRING_MAX_ATTEMPTS: change them together, in a new migration
-- (edc-bridge-contract.test.ts pins them).
-- Pre-auth redeem lookup (as app.edc_bridge_resolve_token, 0541). Returns the
-- id and tenant of the live, unlocked code whose selector AND keyed hash both
-- match, or nothing. On no match, every live code of that selector counts one
-- wrong attempt (locked at 5, so the right code is refused afterwards). The
-- caller re-reads the row under tenant RLS FOR UPDATE, compares the hash in
-- constant time and consumes it in the same transaction. The owner is a
-- superuser or BYPASSRLS role (docs/deployment.md), so FORCE RLS does not hide
-- the rows. search_path pinned; EXECUTE for legend_app only.
CREATE FUNCTION app.edc_bridge_pair_resolve_code(p_selector text, p_code_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_selector !~ '^[2-9A-HJKMNP-Z]{4}$' OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c.id, c.tenant_id FROM public.edc_bridge_pair_codes c
     WHERE c.code_selector = p_selector AND c.code_hash = p_code_hash
       AND c.used_at IS NULL AND c.revoked_at IS NULL
       AND c.expires_at > now() AND c.failed_attempts < 5
     LIMIT 1;
  IF FOUND THEN
    RETURN;
  END IF;
  UPDATE public.edc_bridge_pair_codes c
     SET failed_attempts = c.failed_attempts + 1
   WHERE c.code_selector = p_selector AND c.code_hash <> p_code_hash
     AND c.used_at IS NULL AND c.revoked_at IS NULL
     AND c.expires_at > now() AND c.failed_attempts < 5;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.edc_bridge_pair_resolve_code(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.edc_bridge_pair_resolve_code(text, text) TO legend_app;
--> statement-breakpoint
-- Per-IP slot (5 per 15 minutes by default, sliding): taken before the code is
-- checked, under an advisory lock per IP so parallel guesses cannot all slip
-- under the limit; given back when the code was right. Returns the slot id, or
-- a null id and the seconds until the oldest slot leaves the window. Sweeps a
-- bounded number of expired slots per call.
CREATE FUNCTION app.edc_bridge_pair_take_ip_slot(p_ip_hash text, p_limit integer, p_window_seconds integer)
RETURNS TABLE (slot_id uuid, retry_after_seconds integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_since timestamptz;
  v_count integer;
  v_oldest timestamptz;
BEGIN
  IF p_ip_hash !~ '^[0-9a-f]{64}$' OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid EDC pair slot request' USING ERRCODE = '22023';
  END IF;
  v_since := now() - make_interval(secs => p_window_seconds);
  PERFORM pg_advisory_xact_lock(hashtextextended('edc-bridge-pair-ip:' || p_ip_hash, 0));
  DELETE FROM public.edc_bridge_pair_ip_slots s
   WHERE s.id IN (SELECT o.id FROM public.edc_bridge_pair_ip_slots o
                   WHERE o.taken_at < v_since ORDER BY o.taken_at LIMIT 100);
  SELECT count(*)::integer, min(s.taken_at) INTO v_count, v_oldest
    FROM public.edc_bridge_pair_ip_slots s
   WHERE s.ip_hash = p_ip_hash AND s.taken_at >= v_since;
  IF v_count >= p_limit THEN
    RETURN QUERY SELECT NULL::uuid, GREATEST(1, ceil(extract(epoch FROM
      v_oldest + make_interval(secs => p_window_seconds) - now())))::integer;
    RETURN;
  END IF;
  RETURN QUERY INSERT INTO public.edc_bridge_pair_ip_slots (ip_hash)
    VALUES (p_ip_hash) RETURNING edc_bridge_pair_ip_slots.id, NULL::integer;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.edc_bridge_pair_take_ip_slot(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.edc_bridge_pair_take_ip_slot(text, integer, integer) TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.edc_bridge_pair_release_ip_slot(p_slot_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.edc_bridge_pair_ip_slots s WHERE s.id = p_slot_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.edc_bridge_pair_release_ip_slot(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.edc_bridge_pair_release_ip_slot(uuid) TO legend_app;
