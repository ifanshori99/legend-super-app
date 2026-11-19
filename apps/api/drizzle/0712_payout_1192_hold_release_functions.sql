-- 1192 (legend-6o7pc, tier K: money). Part 3 of 3: the functions that release a hold.
-- No row is edited by the migration; when called they insert and approve a release row
-- (two different finance people, password step-up grants of kind hold_release, 0711).
-- A release only lifts a hold of a flag that could not be written; nobody is paid by it,
-- and when in doubt the slip stays held.
-- 1. app.payout_recon_hold_status(tenant, hold) (new, read only, invoker): 'released' (an
--    approved release exists), 'taken_over' (a flag of the same kind, operation, item and
--    reason took the hold over, the 0709 rule; that flag and its clearance decide now),
--    'clean' (ONLY a hold of an evidence reason: evidence_missing, evidence_hash_mismatch or
--    evidence_read_locked:<day>; AND a clean read of the operation (0710,
--    payroll_payout_recon_hold_clean_reads) was recorded after the hold; AND the latest
--    recon observation, if any, is 'ok') or 'unclean' (anything else, a hold of another
--    reason, e.g. net_mismatch, or with no reason included); NULL when the hold does not
--    exist in the tenant.
-- 2. app.payout_recon_hold_release_propose(hold, grant, reason) -> release id. Reason 10 to
--    500 characters (PAYOUT-85), hold not found (PAYOUT-69), tenant-wide owner or finance
--    (PAYOUT-42), released already (PAYOUT-87), taken over (PAYOUT-96), evidence not clean
--    (PAYOUT-97). An open proposal of the hold returns its id again (the reason stays as first
--    proposed; no second row). The advisory lock payout_recon_hold:<tenant>:<operation>
--    (the one of hold_unwritten) is taken before the status check.
-- 3. app.payout_recon_hold_release_approve(release, grant) -> release id. The proposer and
--    the session that proposed are PAYOUT-86, an approved release PAYOUT-87. The advisory
--    lock payout_recon_hold:<tenant>:<operation> is taken first, then the lock of the
--    operation (the key of the recon read and of observe) with pg_try_advisory_xact_lock; a run that holds it makes the approval PAYOUT-97 (the proof
--    is being read). Taken over (PAYOUT-96) and not clean (PAYOUT-97) are checked again
--    UNDER that lock: this is the authoritative check. Basis: clean_evidence.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_recon_hold_status(p_tenant uuid, p_hold uuid)
RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM public.payroll_payout_recon_hold_releases r
       WHERE r.tenant_id = h.tenant_id AND r.hold_id = h.id
         AND r.approved_at IS NOT NULL) THEN 'released'
    WHEN EXISTS (
      SELECT 1
        FROM public.payroll_payout_recon_exceptions e
       WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
         AND e.operation_id = h.operation_id AND e.item_id = h.item_id
         AND (h.reason IS NULL OR e.reason = h.reason
              OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
         AND (e.flagged_at >= h.created_at
              OR NOT EXISTS (
                SELECT 1
                  FROM public.payroll_payout_recon_clearances c
                 WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                   AND c.approved_at IS NOT NULL
                   AND c.approved_at < h.created_at))) THEN 'taken_over'
    WHEN (h.reason IN ('evidence_missing', 'evidence_hash_mismatch')
          OR h.reason LIKE 'evidence\_read\_locked:%')
     AND EXISTS (
       SELECT 1
         FROM public.payroll_payout_recon_hold_clean_reads cr
        WHERE cr.tenant_id = h.tenant_id AND cr.operation_id = h.operation_id
          AND cr.read_at > h.created_at)
     AND NOT EXISTS (
       SELECT 1
         FROM (SELECT o.state
                 FROM public.payroll_payout_recon_evidence_observations o
                WHERE o.tenant_id = h.tenant_id AND o.operation_id = h.operation_id
                ORDER BY o.seq DESC
                LIMIT 1) lo
        WHERE lo.state <> 'ok') THEN 'clean'
    ELSE 'unclean'
  END
    FROM public.payroll_payout_recon_unwritten_holds h
   WHERE h.tenant_id = p_tenant AND h.id = p_hold
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_hold_status(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_hold_status(uuid, uuid) TO legend_app;
--> statement-breakpoint

CREATE FUNCTION app.payout_recon_hold_release_propose(p_hold uuid, p_grant text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_operation uuid;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_status text;
  v_id uuid;
  v_done timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-85: a release of a hold needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT it.batch_id, h.operation_id INTO v_batch, v_operation
    FROM public.payroll_payout_recon_unwritten_holds h
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = h.tenant_id AND it.id = h.item_id
   WHERE h.tenant_id = v_tenant AND h.id = p_hold;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation hold not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'hold_release', 'propose', v_batch,
           NULL, NULL, p_hold, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(p_reason, 'UTF8')), 'hex')) AS g;
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
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can release a hold'
      USING ERRCODE = '42501';
  END IF;
  -- One writer per operation (hold_unwritten and clean_read take it too).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_hold:' || v_tenant::text || ':' || v_operation::text, 0));
  v_status := app.payout_recon_hold_status(v_tenant, p_hold);
  IF v_status = 'released' THEN
    RAISE EXCEPTION 'PAYOUT-87: the hold is already released' USING ERRCODE = '23514';
  END IF;
  IF v_status = 'taken_over' THEN
    RAISE EXCEPTION 'PAYOUT-96: the hold was taken over by a flag' USING ERRCODE = '23514';
  END IF;
  IF v_status IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'PAYOUT-97: the recon evidence of the hold is not clean yet'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_recon_hold_releases (
    tenant_id, hold_id, reason, proposed_by, proposed_session_id, proposed_grant_id)
  VALUES (v_tenant, p_hold, p_reason, v_actor, v_session, v_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_hold_releases_hold_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT r.id, r.approved_at INTO v_id, v_done
      FROM public.payroll_payout_recon_hold_releases r
     WHERE r.tenant_id = v_tenant AND r.hold_id = p_hold;
    IF v_done IS NOT NULL THEN
      RAISE EXCEPTION 'PAYOUT-87: the hold is already released' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_hold_release_propose(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_hold_release_propose(uuid, text, text) TO legend_app;
--> statement-breakpoint

CREATE FUNCTION app.payout_recon_hold_release_approve(p_release uuid, p_grant text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_reason text;
  v_hold uuid;
  v_operation uuid;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_status text;
  v_row public.payroll_payout_recon_hold_releases%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT it.batch_id, r.reason, h.id, h.operation_id
    INTO v_batch, v_reason, v_hold, v_operation
    FROM public.payroll_payout_recon_hold_releases r
    JOIN public.payroll_payout_recon_unwritten_holds h
      ON h.tenant_id = r.tenant_id AND h.id = r.hold_id
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = h.tenant_id AND it.id = h.item_id
   WHERE r.tenant_id = v_tenant AND r.id = p_release;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: hold release not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'hold_release', 'approve', v_batch,
           NULL, NULL, p_release, NULL,
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
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can release a hold'
      USING ERRCODE = '42501';
  END IF;
  -- One writer per operation (hold_unwritten, clean_read and propose take it too).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_hold:' || v_tenant::text || ':' || v_operation::text, 0));
  SELECT r.* INTO v_row
    FROM public.payroll_payout_recon_hold_releases r
   WHERE r.tenant_id = v_tenant AND r.id = p_release
     FOR UPDATE;
  IF v_row.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-87: the hold release is already approved' USING ERRCODE = '23514';
  END IF;
  IF v_row.proposed_by = v_actor OR v_row.proposed_session_id = v_session THEN
    RAISE EXCEPTION 'PAYOUT-86: the proposer of a hold release cannot approve it'
      USING ERRCODE = '42501';
  END IF;
  -- The advisory lock of the operation (same key as the recon read and observe), kept to
  -- the end of this transaction. A run that holds it is reading the proof: the evidence
  -- is not known to be clean, so the hold stays. The checks below run under the lock.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
       'payout_recon_evidence_observe:' || v_tenant::text || ':' || v_operation::text, 0)) THEN
    RAISE EXCEPTION 'PAYOUT-97: the proof file of the operation is being read by a run that holds its lock; release after that run has ended'
      USING ERRCODE = '23514';
  END IF;
  v_status := app.payout_recon_hold_status(v_tenant, v_hold);
  IF v_status = 'taken_over' THEN
    RAISE EXCEPTION 'PAYOUT-96: the hold was taken over by a flag' USING ERRCODE = '23514';
  END IF;
  IF v_status IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'PAYOUT-97: the recon evidence of the hold is not clean'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_payout_recon_hold_releases
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now, basis = 'clean_evidence'
   WHERE tenant_id = v_tenant AND id = p_release AND approved_at IS NULL;
  RETURN p_release;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_hold_release_approve(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_hold_release_approve(uuid, text) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
