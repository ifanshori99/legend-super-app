-- 1175 Kartu B (bead legend-1e9py, tier K: money): the advisory-lock check that
-- 0706 added to app.payout_recon_clear_approve read pg_locks of the whole cluster. A
-- staging copy in the same cluster with the same tenant and operation ids could hold the
-- same advisory key and block an approval here. The check now counts only locks of the
-- current database (pg_locks.database = oid of current_database()). Body otherwise
-- identical to 0706; it only holds a slip back less often when a foreign database holds
-- the key, and a lock of this database is still refused.
-- 1175 Kartu C (bead legend-9cx64, tier K: money): app.payout_attest (0428 body) took
-- attested_at = statement_timestamp() but read session.mfa_verified_at later. An MFA
-- re-verify by a concurrent request in between left mfa_verified_at > attested_at, and
-- the night recon flagged mfa_stale on a good attestation (safe direction: the slip was
-- held). attested_at is now clock_timestamp() read AFTER mfa_verified_at, in the INSERT
-- and in the ON CONFLICT update, so attested_at >= mfa_verified_at. No new column.
-- Function bodies only: ownership and ACL are kept by CREATE OR REPLACE, no row is
-- edited, nobody is paid by it.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
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
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = v_tenant AND e.id = v_row.exception_id
       AND e.reason LIKE 'evidence\_read\_locked:%'
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_locks l,
                pg_catalog.hashtextextended(
                  'payout_recon_evidence_observe:' || e.tenant_id::text || ':' || e.operation_id::text,
                  0) AS k
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d
                               WHERE d.datname = pg_catalog.current_database())
            AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
            AND l.objsubid = 1
            AND l.classid::bigint = ((k >> 32) & 4294967295)
            AND l.objid::bigint = (k & 4294967295))) THEN
    RAISE EXCEPTION 'PAYOUT-91: the proof file of the operation is still being read by a run that holds its lock; clear after that run has ended'
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
CREATE OR REPLACE FUNCTION app.payout_attest(
  p_tenant uuid, p_kind text, p_operation uuid, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_binding uuid, p_grant uuid, p_assertion jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text;
  v_session text;
  v_created timestamptz;
  v_mfa timestamptz;
  v_rows integer;
  v_attestation uuid;
  v_at timestamptz;
BEGIN
  PERFORM app.payout_batch_assert_open(p_tenant, p_batch);
  SELECT g.actor, g.session_id INTO v_actor, v_session
    FROM public.payroll_payout_grants g
   WHERE g.tenant_id = p_tenant AND g.id = p_grant
     AND g.kind = p_kind AND g.step = p_step AND g.consumed_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-66: an attestation needs the consumed grant of its step'
      USING ERRCODE = '23514';
  END IF;
  SELECT s.created_at, s.mfa_verified_at INTO v_created, v_mfa
    FROM public."session" s
   WHERE s.id = v_session AND s.user_id = v_actor;
  IF NOT FOUND OR v_mfa IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-66: an attestation needs the live MFA session of the actor'
      USING ERRCODE = '23514';
  END IF;
  v_at := pg_catalog.clock_timestamp();
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    assertion, attested_at, txid, grant_id)
  VALUES (
    p_tenant, p_kind, p_operation, p_step, p_batch, p_item_ids, p_key,
    p_binding, v_actor, v_session, v_created, v_mfa,
    p_assertion, v_at, pg_catalog.txid_current(), p_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_attestations_step_key DO UPDATE
     SET batch_id = EXCLUDED.batch_id, item_ids = EXCLUDED.item_ids,
         evidence_key = EXCLUDED.evidence_key, binding_id = EXCLUDED.binding_id,
         actor = EXCLUDED.actor, session_id = EXCLUDED.session_id,
         session_created_at = EXCLUDED.session_created_at,
         mfa_verified_at = EXCLUDED.mfa_verified_at,
         assertion = EXCLUDED.assertion, attested_at = EXCLUDED.attested_at,
         txid = EXCLUDED.txid, grant_id = EXCLUDED.grant_id
   WHERE payroll_payout_attestations.step = 'propose'
  RETURNING id INTO v_attestation;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR v_attestation IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-66: the % step of this operation is already attested', p_step
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_approval_log (
    tenant_id, grant_id, attestation_id, kind, step, operation_id, batch_id,
    item_count, actor, session_id)
  VALUES (
    p_tenant, p_grant, v_attestation, p_kind, p_step, p_operation, p_batch,
    COALESCE(pg_catalog.cardinality(p_item_ids), 0), v_actor, v_session);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
