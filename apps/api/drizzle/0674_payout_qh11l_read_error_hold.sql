-- 1057 (bead legend-qh11l): a read error of the proof file that is not "not found"
-- (storage down, timeout, permission) was only counted by the reconciliation and
-- left no trace, so a clearance of an evidence flag kept releasing the slip while
-- nobody could tell whether the file was still intact. Fail closed at once: the
-- error is recorded as an observation, it holds the slips of the flags of the
-- operation until a later successful read, and the earlier clearance releases
-- them again after that read (it matches the old fingerprint again).
-- 1. The observation CHECK accepts the state 'error' (observed_sha256 NULL).
-- 2. app.payout_recon_evidence_observe (0663 body) accepts 'error'. A row is not
--    written when state and sha256 equal the LAST observation of the operation,
--    whatever its state; an 'ok' is recorded after any earlier observation (an
--    error alone counts), and is ignored only when there is none. The episode
--    follows the latest observation that is not an error: a problem after an 'ok'
--    starts the next episode, an 'ok' or an error keeps the episode it follows.
-- 3. app.payout_recon_flag_fingerprint (0663 body): the "evidence" object still
--    comes from the latest observation that is neither 'ok' nor 'error' (an error
--    is never a mismatch or missing episode), with the seq of the FIRST row of
--    its run (rows that are not errors, same state and sha256, no other state
--    between), so the same problem read again after an error keeps its
--    fingerprint; without an error row the run is one row and the object is the
--    0663 object byte for byte. The key "read_error" (seq of the error row) is
--    added only while the LAST observation of the operation is an error: a later
--    successful read removes it and the fingerprint is the one before the error.
--    An operation with no error observation keeps exactly its fingerprint.
-- 4. app.payout_recon_clear_approve (0464 body): refused while the last
--    observation of the operation of the flag is an error (PAYOUT-91), so a
--    clearance proposed during an error cannot release the slip either.
-- 5. Who may record 'ok' (CTO decision F1, bead legend-qh11l). An 'ok' observation
--    is what releases a slip again after an error, so it is limited to the
--    reconciliation path: the 0663 body becomes app.payout_recon_evidence_observe_internal
--    (owner legend_payout, no grant to legend_app or PUBLIC);
--    app.payout_recon_evidence_observe (legend_app, same signature) refuses 'ok'
--    (PAYOUT-92) and passes missing, mismatch and error, which only hold a slip;
--    app.payout_recon_evidence_observe_ok(tenant, operation) records 'ok' and may
--    be run by the NOLOGIN role legend_payout_recon only. legend_app is a member of
--    that role WITH INHERIT FALSE, SET TRUE: it does not inherit EXECUTE, only
--    SET ROLE legend_payout_recon reaches the function (pattern of
--    legend_payout_grantor, drizzle/0419 and src/db/grantor.ts). The tenant check
--    of 0663 (PAYOUT-68) holds on both paths. The reconciliation service calls it
--    through recordReadOk (payroll-payout-recon.service.ts). Remaining limit: code
--    that runs free SQL on the application login can still SET ROLE; a full
--    separation needs its own login like the grantor (bead legend-qh11l).
--    Restrictive rule (CTO decision, bead legend-tiw2h): a caller other than the
--    reconciliation role never turns a held slip into a released one. The internal
--    function takes a fifth argument p_by_recon (the wrapper passes false, observe_ok
--    and observe_difference pass true) and, under the advisory lock and after reading
--    the last observation, refuses 'ok' and refuses missing or mismatch right after an
--    error (PAYOUT-92), before the same-state shortcut and before the insert; without
--    that, the same problem read again after an error would restore the old
--    fingerprint and release the slip with no storage read. A problem read after an
--    error is recorded through app.payout_recon_evidence_observe_difference (missing
--    or mismatch only, legend_payout_recon only, same grant pattern as observe_ok);
--    the service calls it through recordProblemRead. An error from any caller still
--    only holds.
-- No amount, item, payslip or clearance row is touched. An error holds a slip back.
-- Unlike 0663 ("the observe function can only hold a slip, never release one"), an
-- 'ok' observation after an error now releases the slip again, but only back to the
-- state two people already approved (the old fingerprint matches its approved
-- clearance again); it never releases a slip no clearance covers, and only the
-- reconciliation role can record it. Ownership and ACL as 0663 and 0464 (CREATE OR
-- REPLACE keeps them) except the new functions, whose ACL is set below.
ALTER TABLE "payroll_payout_recon_evidence_observations" DROP CONSTRAINT "payroll_payout_recon_evidence_observations_state_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_evidence_observations" ADD CONSTRAINT "payroll_payout_recon_evidence_observations_state_check" CHECK ("payroll_payout_recon_evidence_observations"."state" IN ('missing', 'mismatch', 'ok') OR ("payroll_payout_recon_evidence_observations"."state" = 'error' AND "payroll_payout_recon_evidence_observations"."observed_sha256" IS NULL));--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout_recon') THEN
    CREATE ROLE legend_payout_recon NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout_recon' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
                 OR rolcanlogin OR rolinherit)) THEN
    RAISE EXCEPTION 'legend_payout_recon exists with unsafe privileges';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.roleid = 'legend_payout_recon'::regrole AND m.member = 'legend_app'::regrole) THEN
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m
       WHERE m.roleid = 'legend_payout_recon'::regrole AND m.member = 'legend_app'::regrole
         AND (m.inherit_option OR m.admin_option OR NOT m.set_option)) THEN
      RAISE EXCEPTION 'legend_app is a member of legend_payout_recon with INHERIT, ADMIN or without SET; it must be INHERIT FALSE, SET TRUE, no ADMIN';
    END IF;
  ELSE
    GRANT legend_payout_recon TO legend_app WITH INHERIT FALSE, SET TRUE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO legend_payout_recon;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Record what the reconciliation observed of the proof file of an operation
-- (0663 body, plus the state 'error'). Internal: no caller but the three wrappers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_evidence_observe_internal(
  p_tenant uuid, p_operation uuid, p_state text, p_observed_sha text, p_by_recon boolean
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_last_state text;
  v_last_sha text;
  v_last_found boolean;
  v_prev_state text;
  v_prev_episode integer;
  v_prev_found boolean;
  v_episode integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: an observation is recorded in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_operation IS NULL OR p_state IS NULL OR p_by_recon IS NULL
    OR p_state NOT IN ('missing', 'mismatch', 'ok', 'error')
    OR (p_state = 'mismatch' AND (p_observed_sha IS NULL OR p_observed_sha !~ '^[0-9a-f]{64}$'))
    OR (p_state <> 'mismatch' AND p_observed_sha IS NOT NULL) THEN
    RAISE EXCEPTION 'PAYOUT-68: the observation needs an operation, a state and, for a mismatch, the sha256 read'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_evidence_observe:' || p_tenant::text || ':' || p_operation::text, 0));
  SELECT o.state, o.observed_sha256
    INTO v_last_state, v_last_sha
    FROM public.payroll_payout_recon_evidence_observations o
   WHERE o.tenant_id = p_tenant AND o.operation_id = p_operation
   ORDER BY o.seq DESC
   LIMIT 1;
  v_last_found := FOUND;
  -- Checked here, under the lock and after the last observation is read: an error
  -- that lands between a check outside the lock and the insert cannot be missed.
  IF NOT p_by_recon AND p_state = 'ok' THEN
    RAISE EXCEPTION 'PAYOUT-92: an ok observation is recorded by the reconciliation role only'
      USING ERRCODE = '42501';
  END IF;
  IF NOT p_by_recon AND v_last_found AND v_last_state = 'error'
     AND p_state IN ('missing', 'mismatch') THEN
    RAISE EXCEPTION 'PAYOUT-92: a problem read after a read error is recorded by the reconciliation role only'
      USING ERRCODE = '42501';
  END IF;
  IF v_last_found THEN
    IF v_last_state = p_state AND v_last_sha IS NOT DISTINCT FROM p_observed_sha THEN
      RETURN;
    END IF;
  ELSIF p_state = 'ok' THEN
    RETURN;
  END IF;
  SELECT o.state, o.episode
    INTO v_prev_state, v_prev_episode
    FROM public.payroll_payout_recon_evidence_observations o
   WHERE o.tenant_id = p_tenant AND o.operation_id = p_operation AND o.state <> 'error'
   ORDER BY o.seq DESC
   LIMIT 1;
  v_prev_found := FOUND;
  IF NOT v_prev_found THEN
    v_episode := 1;
  ELSIF p_state IN ('missing', 'mismatch') AND v_prev_state = 'ok' THEN
    v_episode := v_prev_episode + 1;
  ELSE
    v_episode := v_prev_episode;
  END IF;
  INSERT INTO public.payroll_payout_recon_evidence_observations (
    tenant_id, operation_id, state, observed_sha256, episode, observed_at)
  VALUES (p_tenant, p_operation, p_state, p_observed_sha, v_episode,
          pg_catalog.clock_timestamp());
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.payout_recon_evidence_observe_internal(uuid, uuid, text, text, boolean) FROM PUBLIC, legend_app, legend_payout_recon;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The caller's door: holds a slip (missing, mismatch, error), never releases one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_evidence_observe(
  p_tenant uuid, p_operation uuid, p_state text, p_observed_sha text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state IS NOT DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'PAYOUT-92: an ok observation is recorded by the reconciliation role only'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app.payout_recon_evidence_observe_internal(p_tenant, p_operation, p_state, p_observed_sha, false);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_evidence_observe(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_evidence_observe(uuid, uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The reconciliation's door: records a successful read of the proof file. Only
-- legend_payout_recon (SET ROLE from legend_app) may run it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_evidence_observe_ok(p_tenant uuid, p_operation uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.payout_recon_evidence_observe_internal(p_tenant, p_operation, 'ok', NULL, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_evidence_observe_ok(uuid, uuid) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_evidence_observe_ok(uuid, uuid) TO legend_payout_recon;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The reconciliation's door for a problem it read (missing, mismatch): the only
-- way to record one right after a read error. Only legend_payout_recon (SET ROLE
-- from legend_app) may run it. The sha256 rule (PAYOUT-68) is the internal one's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_evidence_observe_difference(
  p_tenant uuid, p_operation uuid, p_state text, p_observed_sha text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('missing', 'mismatch') THEN
    RAISE EXCEPTION 'PAYOUT-92: only a missing or mismatch observation is recorded here'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app.payout_recon_evidence_observe_internal(p_tenant, p_operation, p_state, p_observed_sha, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_evidence_observe_difference(uuid, uuid, text, text) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_evidence_observe_difference(uuid, uuid, text, text) TO legend_payout_recon;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The fingerprint of the data behind a flag (0663 body), with the first-row seq
-- of the evidence run and the read_error key. Signature, owner and ACL stay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_flag_fingerprint(p_tenant uuid, p_exception uuid)
RETURNS varchar
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (pg_catalog.jsonb_build_object(
      'item', (
        SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
          FROM public.payroll_disbursement_items it,
               pg_catalog.jsonb_each(pg_catalog.to_jsonb(it)) AS f(key, value)
         WHERE it.tenant_id = e.tenant_id AND it.id = e.item_id
           AND f.key NOT IN ('updated_at', 'pii_key_version')
           AND f.key NOT LIKE '%\_encrypted'),
      'attestations', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.id)
          FROM public.payroll_payout_attestations a
         WHERE a.tenant_id = e.tenant_id AND a.operation_id = e.operation_id),
        '[]'::jsonb),
      'postings', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 (SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
                    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(p)) AS f(key, value)
                   WHERE f.key NOT IN ('updated_at', 'pii_key_version')
                     AND f.key NOT LIKE '%\_encrypted')
                 ORDER BY p.id)
          FROM public.payroll_payout_gl_postings p
          JOIN public.payroll_disbursement_items it
            ON it.tenant_id = e.tenant_id AND it.id = e.item_id
         WHERE p.tenant_id = e.tenant_id
           AND (p.id = it.gl_posting_id
             OR p.item_set_hash = pg_catalog.encode(pg_catalog.sha256(
                  pg_catalog.convert_to(it.id::text, 'UTF8')), 'hex'))),
        '[]'::jsonb)
    ) || COALESCE((
        SELECT pg_catalog.jsonb_build_object('evidence', pg_catalog.jsonb_build_object(
                 'state', l.state,
                 'observed_sha256', l.observed_sha256,
                 'episode', l.episode,
                 'seq', (
                   SELECT pg_catalog.min(r.seq)
                     FROM public.payroll_payout_recon_evidence_observations r
                    WHERE r.tenant_id = e.tenant_id AND r.operation_id = e.operation_id
                      AND r.state <> 'error' AND r.seq <= l.seq
                      AND r.seq > COALESCE((
                        SELECT pg_catalog.max(d.seq)
                          FROM public.payroll_payout_recon_evidence_observations d
                         WHERE d.tenant_id = e.tenant_id AND d.operation_id = e.operation_id
                           AND d.state <> 'error' AND d.seq < l.seq
                           AND (d.state, d.observed_sha256)
                                 IS DISTINCT FROM (l.state, l.observed_sha256)), 0))))
          FROM (
            SELECT o.state, o.observed_sha256, o.episode, o.seq
              FROM public.payroll_payout_recon_evidence_observations o
             WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
               AND o.state NOT IN ('ok', 'error')
             ORDER BY o.seq DESC
             LIMIT 1) l),
        '{}'::jsonb)
      || COALESCE((
        SELECT pg_catalog.jsonb_build_object('read_error', x.seq)
          FROM (
            SELECT o.state, o.seq
              FROM public.payroll_payout_recon_evidence_observations o
             WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
             ORDER BY o.seq DESC
             LIMIT 1) x
         WHERE x.state = 'error'),
        '{}'::jsonb))::text, 'UTF8')), 'hex')::varchar
    FROM public.payroll_payout_recon_exceptions e
   WHERE e.tenant_id = p_tenant AND e.id = p_exception
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Clearance, step two (0464 body): refused while the last observation of the
-- proof file of the flag's operation is a read error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_clear_approve(p_clearance uuid, p_grant text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_reason text;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_row public.payroll_payout_recon_clearances%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT it.batch_id, c.reason INTO v_batch, v_reason
    FROM public.payroll_payout_recon_clearances c
    JOIN public.payroll_payout_recon_exceptions e
      ON e.tenant_id = c.tenant_id AND e.id = c.exception_id
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = e.tenant_id AND it.id = e.item_id
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation clearance not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'recon_clear', 'approve', v_batch,
           NULL, NULL, p_clearance, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(v_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
      USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_row
    FROM public.payroll_payout_recon_clearances c
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance
     FOR UPDATE;
  IF v_row.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-87: the reconciliation clearance is already approved'
      USING ERRCODE = '23514';
  END IF;
  IF v_row.proposed_by = v_actor OR v_row.proposed_session_id = v_session THEN
    RAISE EXCEPTION 'PAYOUT-86: the proposer of a reconciliation clearance cannot approve it'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = v_tenant AND e.id = v_row.exception_id
       AND (SELECT o.state
              FROM public.payroll_payout_recon_evidence_observations o
             WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
             ORDER BY o.seq DESC
             LIMIT 1) = 'error') THEN
    RAISE EXCEPTION 'PAYOUT-91: the proof file of the operation could not be read; clear after a successful read'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_recon_flag_fingerprint(v_tenant, v_row.exception_id)
       IS DISTINCT FROM v_row.flag_sha256 THEN
    RAISE EXCEPTION 'PAYOUT-91: the flagged data changed since the clearance was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_recon_flag_see(v_tenant, v_row.exception_id);
  UPDATE public.payroll_payout_recon_clearances
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_clearance AND approved_at IS NULL;
  RETURN p_clearance;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
