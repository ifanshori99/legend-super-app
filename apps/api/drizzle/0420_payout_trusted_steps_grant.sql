-- legend-i01jp (911, P1-1 file B; P1-2; P2-3): every trusted payout step takes a
-- one-time grant (0653) instead of an actor and a session as arguments.
-- - The nine public step functions and app.payout_attest are dropped (old
--   signatures end in text, text) and created again. legend_app can no longer
--   name an actor or a session: the function consumes the grant first
--   (app.payout_grant_consume: bound to tenant, kind, step, batch, item set,
--   key, ref and target; PAYOUT-70 when it is not valid) and reads the actor and
--   the session from the grant row. app.payout_assert_actor then runs on that
--   actor and session (codes 39 to 42 unchanged). Bodies are those of 0646,
--   0647 and 0648 with only that change, plus the two fixes below.
-- - Every attestation goes through app.payout_attest, which reads actor and
--   session from the grant row and writes grant_id (closure and posting source
--   used to insert by hand).
-- - Step two (correction approve, overpaid record, return confirm, closure
--   approve) refuses when the step-one attestation carries no grant: PAYOUT-71
--   (23514). A proposal made without a grant must be proposed again.
-- - An idempotent early return of the closure functions happens after the
--   consume: the grant is spent, nothing else changes.
-- - P1-2: an open correction or overpaid proposal never takes another proof key.
--   The old "the proposer replaces their proposal with another proof" is gone:
--   PAYOUT-73 (23514). The proposal must be withdrawn and proposed anew. (A
--   proposal with the same key is still PAYOUT-64, as before.)
-- - P2-3: app.payout_assert_proof also needs the uploaded proof record to belong
--   to the same batch and the same legal entity as the operation (PAYOUT-65).
-- - Last: no attestation after the cutover (app.payout_grants_since, 0653)
--   exists without a grant (CHECK).
-- New error codes: PAYOUT-71 step one of the operation has no grant, PAYOUT-73
-- an open proposal cannot take another proof. PAYOUT-70 (no valid grant) and
-- PAYOUT-72 (issue matrix) come from 0653. All other codes are unchanged.
-- Ownership: the functions of the payout role cannot be dropped or replaced by
-- the migrator (it holds no INHERIT on the role), so this file runs as the
-- payout role: grant, become, work, return, revoke (as 0644 and 0652). The
-- functions are created by the role itself and keep it as owner.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
DROP FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_correction_approve(uuid, varchar, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_return_confirm(uuid, varchar, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_proof_closure_propose(varchar, text, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_proof_closure_approve(uuid, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, text, text, jsonb);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Internal helper: the proof of one operation (0648 body, P2-3: the proof
-- record belongs to the same batch and legal entity). Signature and ACL stay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_assert_proof(
  p_tenant uuid, p_kind text, p_batch uuid, p_item_ids uuid[], p_key varchar
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_content varchar;
  v_stored varchar;
  v_file_batch uuid;
  v_binding uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof is checked in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_proof_key_closed(p_tenant, p_key) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payout proof key is closed'
      USING ERRCODE = '23514';
  END IF;
  SELECT f.content_sha256, f.stored_sha256, f.batch_id
    INTO v_content, v_stored, v_file_batch
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = p_tenant AND f.evidence_key = p_key;
  IF NOT FOUND OR v_content IS NULL OR v_stored IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-65: the payout proof has no complete record'
      USING ERRCODE = '23514';
  END IF;
  -- P2-3: the file was uploaded for this very batch, and so for its legal entity.
  IF v_file_batch IS DISTINCT FROM p_batch OR NOT EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_batches fb
      JOIN public.payroll_disbursement_batches ob
        ON ob.tenant_id = fb.tenant_id AND ob.legal_entity_id = fb.legal_entity_id
     WHERE fb.tenant_id = p_tenant AND fb.id = v_file_batch AND ob.id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the payout proof was uploaded for another batch'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_proof_history_pending() THEN
    RAISE EXCEPTION 'PAYOUT-65: payout proof history is still being reconciled'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_proof_contested(ARRAY[v_content, v_stored]::varchar[]) THEN
    RAISE EXCEPTION 'PAYOUT-65: payout proof is contested' USING ERRCODE = '23514';
  END IF;
  SELECT b.id INTO v_binding
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = p_tenant
     AND b.evidence_key = p_key
     AND b.kind = p_kind
     AND b.batch_id = p_batch
     AND b.item_set_hash = app.payout_item_set_hash(p_item_ids)
     AND b.legacy_duplicate = false
     AND b.content_sha256 = v_content
     AND b.stored_sha256 = v_stored;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-65: the payout proof is not bound to this operation'
      USING ERRCODE = '23514';
  END IF;
  RETURN v_binding;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Internal helper: one attestation row, written from a consumed grant. Actor and
-- session come from the grant row (never from an argument), the grant id is
-- stored (the composite foreign key ties kind, step, actor and session to it). A
-- step-one entry ('propose') of the same operation is replaced (and takes the
-- new grant); any other step is written once.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_attest(
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
BEGIN
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
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    assertion, attested_at, txid, grant_id)
  VALUES (
    p_tenant, p_kind, p_operation, p_step, p_batch, p_item_ids, p_key,
    p_binding, v_actor, v_session, v_created, v_mfa,
    p_assertion, pg_catalog.statement_timestamp(), pg_catalog.txid_current(), p_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_attestations_step_key DO UPDATE
     SET batch_id = EXCLUDED.batch_id, item_ids = EXCLUDED.item_ids,
         evidence_key = EXCLUDED.evidence_key, binding_id = EXCLUDED.binding_id,
         actor = EXCLUDED.actor, session_id = EXCLUDED.session_id,
         session_created_at = EXCLUDED.session_created_at,
         mfa_verified_at = EXCLUDED.mfa_verified_at,
         assertion = EXCLUDED.assertion, attested_at = EXCLUDED.attested_at,
         txid = EXCLUDED.txid, grant_id = EXCLUDED.grant_id
   WHERE payroll_payout_attestations.step = 'propose';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-66: the % step of this operation is already attested', p_step
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Correction, step one: an open proposal of every item (the first row carries
-- the operation's own id). An open proposal keeps its proof (P1-2). Returns the
-- operation id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_correction_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_existing integer;
  v_op uuid;
  v_binding uuid;
  v_content varchar;
  v_stored varchar;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_item uuid;
  v_first boolean := true;
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'correction', 'propose', p_batch,
           p_item_ids, p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of a correction must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-63: a correction needs a note of 1 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(SELECT i FROM pg_catalog.unnest(p_item_ids) AS i ORDER BY i);
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a correction is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot correct its items'
      USING ERRCODE = '42501';
  END IF;
  -- A reversed run freed its period: booking the old transfer would count twice.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_runs r
     WHERE r.tenant_id = v_tenant AND r.id = v_batch.payroll_run_id
       AND r.status IN ('locked', 'paid')
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: the payroll run is not payable any more' USING ERRCODE = '23514';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'failed' AND i.channel = 'manual_bank'
     AND i.resolution_outcome IS NOT DISTINCT FROM 'failed'
     AND i.resolved_by IS NOT NULL AND i.resolved_by_2 IS NOT NULL;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: only failed manual items resolved by two people can be corrected'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
       AND (i.resolved_by = v_actor OR i.resolved_by_2 = v_actor)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: a person who resolved the failure cannot correct it'
      USING ERRCODE = '42501';
  END IF;
  -- No other attempt of the payslip that is live, paid, paid back or overpaid.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_items i
      JOIN public.payroll_disbursement_items o
        ON o.tenant_id = i.tenant_id AND o.payslip_id = i.payslip_id AND o.id <> i.id
     WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
       AND o.status IN ('prepared', 'blocked', 'approved', 'sending', 'exported',
                        'unknown', 'succeeded', 'returned', 'overpaid')
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: another attempt of the payslip makes this a second payment'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'correction', p_batch, v_items, p_key);
  SELECT f.content_sha256, f.stored_sha256 INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key;

  SELECT pg_catalog.count(*) INTO v_existing
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items);
  IF v_existing = 0 THEN
    v_op := gen_random_uuid();
    FOR v_item IN SELECT i FROM pg_catalog.unnest(v_items) AS i ORDER BY i LOOP
      INSERT INTO public.payroll_payout_failed_corrections (
        id, tenant_id, batch_id, item_id, operation_id, evidence_key,
        content_sha256, stored_sha256, note, status, proposed_by, proposed_at)
      VALUES (
        CASE WHEN v_first THEN v_op ELSE gen_random_uuid() END,
        v_tenant, p_batch, v_item, v_op, p_key, v_content, v_stored, p_note,
        'proposed', v_actor, v_now);
      v_first := false;
    END LOOP;
  ELSIF v_existing <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: every item of a correction must be at the same step'
      USING ERRCODE = '23514';
  ELSE
    PERFORM c.id
      FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items)
     ORDER BY c.item_id
       FOR UPDATE;
    SELECT pg_catalog.min(c.operation_id::text)::uuid INTO v_op
      FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items);
    IF (SELECT pg_catalog.count(DISTINCT c.operation_id)
          FROM public.payroll_payout_failed_corrections c
         WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items)) <> 1
      OR (SELECT pg_catalog.count(*)
            FROM public.payroll_payout_failed_corrections c
           WHERE c.tenant_id = v_tenant AND c.operation_id = v_op) <> pg_catalog.cardinality(v_items)
      OR EXISTS (
        SELECT 1 FROM public.payroll_payout_failed_corrections c
         WHERE c.tenant_id = v_tenant AND c.operation_id = v_op AND c.status <> 'proposed') THEN
      RAISE EXCEPTION 'PAYOUT-63: the items do not form one open correction'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = v_op AND c.proposed_by <> v_actor) THEN
      RAISE EXCEPTION 'PAYOUT-64: only the proposer replaces an open correction proposal'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = v_op AND c.evidence_key = p_key) THEN
      RAISE EXCEPTION 'PAYOUT-64: this proposal was already made; the second step needs another person'
        USING ERRCODE = '42501';
    END IF;
    -- P1-2: an open proposal keeps its proof. Another key is not a replacement.
    RAISE EXCEPTION 'PAYOUT-73: an open correction proposal cannot take another proof'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'correction', v_op, 'propose', p_batch, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_op;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Correction, step two: another person, the same proof. Marks every proposal
-- corrected and moves failed -> succeeded with the payment record of the
-- corrector. Returns how many items moved. The settle journal is posted by the
-- caller after this call (checked at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_correction_approve(
  p_operation uuid, p_key varchar, p_grant text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_proposer text;
  v_binding uuid;
  v_n integer;
  v_moved integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  -- The grant binds the batch and the item set of the operation (read first,
  -- the set of an operation never changes).
  SELECT c.batch_id INTO v_batch_id
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: correction not found' USING ERRCODE = 'P0002';
  END IF;
  v_items := ARRAY(
    SELECT c.item_id FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation ORDER BY c.item_id);
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'correction', 'approve', v_batch_id,
           v_items, p_key, p_operation, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  PERFORM c.id
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
   ORDER BY c.item_id
     FOR UPDATE;
  v_n := pg_catalog.cardinality(v_items);
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a correction is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT c.batch_id)
        FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation) <> 1
    OR EXISTS (
      SELECT 1 FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation AND c.status <> 'proposed') THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction is not an open proposal' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation AND c.evidence_key <> p_key) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT c.proposed_by)
        FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation) <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction has more than one proposer' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.min(c.proposed_by) INTO v_proposer
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation;
  -- Two different people, neither the requester of the batch nor a resolver of
  -- the failure.
  IF v_proposer = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a correction needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR v_batch.requested_by = v_proposer THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot correct its items'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_runs r
     WHERE r.tenant_id = v_tenant AND r.id = v_batch.payroll_run_id
       AND r.status IN ('locked', 'paid')
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: the payroll run is not payable any more' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.count(*) INTO v_moved
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.id = ANY (v_items)
     AND i.status = 'failed' AND i.channel = 'manual_bank'
     AND i.resolution_outcome IS NOT DISTINCT FROM 'failed'
     AND i.resolved_by IS NOT NULL AND i.resolved_by_2 IS NOT NULL;
  IF v_moved <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: only failed manual items resolved by two people can be corrected'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
       AND (i.resolved_by IN (v_actor, v_proposer) OR i.resolved_by_2 IN (v_actor, v_proposer))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: a person who resolved the failure cannot correct it'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_items i
      JOIN public.payroll_disbursement_items o
        ON o.tenant_id = i.tenant_id AND o.payslip_id = i.payslip_id AND o.id <> i.id
     WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
       AND o.status IN ('prepared', 'blocked', 'approved', 'sending', 'exported',
                        'unknown', 'succeeded', 'returned', 'overpaid')
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: another attempt of the payslip makes this a second payment'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'correction', v_batch_id, v_items, p_key);
  -- The hashes of the proposals are those of the bound proof.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_failed_corrections c
      JOIN public.payroll_payout_proof_bindings b
        ON b.tenant_id = c.tenant_id AND b.id = v_binding
     WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
       AND (c.content_sha256 <> b.content_sha256 OR c.stored_sha256 <> b.stored_sha256)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proposal does not carry the hashes of its bound proof'
      USING ERRCODE = '23514';
  END IF;
  -- Step one was attested by the proposer, for this item set and proof.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'correction'
       AND a.operation_id = p_operation AND a.step = 'propose'
       AND a.actor = v_proposer AND a.evidence_key = p_key
       AND a.item_ids @> v_items AND a.item_ids <@ v_items
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the first step of this correction is not attested'
      USING ERRCODE = '42501';
  END IF;
  -- ... and with a grant (911).
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'correction'
       AND a.operation_id = p_operation AND a.step = 'propose'
       AND a.actor = v_proposer AND a.evidence_key = p_key
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this correction has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_failed_corrections
     SET status = 'corrected', corrected_by = v_actor, corrected_at = v_now
   WHERE tenant_id = v_tenant AND operation_id = p_operation AND status = 'proposed';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction changed while it was approved' USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items i
     SET status = 'succeeded', confirmed_by = v_actor,
         confirmation_ref = 'correction:' || c.id::text,
         confirmation_evidence_key = p_key, settled_at = v_now, updated_at = v_now
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
     AND i.tenant_id = c.tenant_id AND i.id = c.item_id AND i.status = 'failed';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the correction was approved'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'correction', p_operation, 'approve', v_batch_id, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_moved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_correction_approve(uuid, varchar, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_correction_approve(uuid, varchar, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overpaid, step one: one open proposal per item (one proposal per item, ever).
-- An open proposal keeps its proof (P1-2). Returns a fresh id for this call's
-- attestation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_overpaid_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_existing integer;
  v_op uuid := gen_random_uuid();
  v_binding uuid;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_item uuid;
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'overpaid', 'propose', p_batch,
           p_item_ids, p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of an overpaid record must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-63: an overpaid record needs a note of 1 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(SELECT i FROM pg_catalog.unnest(p_item_ids) AS i ORDER BY i);
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: an overpaid record is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot record its overpaid items'
      USING ERRCODE = '42501';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'failed';
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: only failed items of the batch can be recorded as overpaid'
      USING ERRCODE = '23514';
  END IF;
  -- Double paid means another attempt of the payslip was paid.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_disbursement_items o
          WHERE o.tenant_id = i.tenant_id AND o.payslip_id = i.payslip_id
            AND o.id <> i.id AND o.status = 'succeeded')
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: the payslip has no other paid attempt, so this is not a double payment'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'overpaid', p_batch, v_items, p_key);

  SELECT pg_catalog.count(*) INTO v_existing
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items);
  IF v_existing = 0 THEN
    FOR v_item IN SELECT i FROM pg_catalog.unnest(v_items) AS i ORDER BY i LOOP
      INSERT INTO public.payroll_payout_overpaid_proposals (
        tenant_id, batch_id, item_id, evidence_key, note, status, proposed_by, proposed_at)
      VALUES (v_tenant, p_batch, v_item, p_key, p_note, 'proposed', v_actor, v_now);
    END LOOP;
  ELSIF v_existing <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: every item of an overpaid record must be at the same step'
      USING ERRCODE = '23514';
  ELSE
    PERFORM p.id
      FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items)
     ORDER BY p.item_id
       FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'proposed') THEN
      RAISE EXCEPTION 'PAYOUT-63: the double payment of this item is already recorded'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.proposed_by <> v_actor) THEN
      RAISE EXCEPTION 'PAYOUT-64: only the proposer replaces an open overpaid proposal'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.evidence_key = p_key) THEN
      RAISE EXCEPTION 'PAYOUT-64: this proposal was already made; the second step needs another person'
        USING ERRCODE = '42501';
    END IF;
    -- P1-2: an open proposal keeps its proof. Another key is not a replacement.
    RAISE EXCEPTION 'PAYOUT-73: an open overpaid proposal cannot take another proof'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'overpaid', v_op, 'propose', p_batch, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_op;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overpaid, step two, one item: another person, the same proof, the overpaid
-- posting the caller wrote. Marks the proposal recorded and moves
-- failed -> overpaid linked to the posting. The journal is the caller's (checked
-- at commit). The grant binds the posting as its ref.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_overpaid_record(
  p_item uuid, p_key varchar, p_posting uuid, p_grant text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_item public.payroll_disbursement_items%ROWTYPE;
  v_proposal public.payroll_payout_overpaid_proposals%ROWTYPE;
  v_set uuid[];
  v_binding uuid;
  v_rows integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT i.batch_id INTO v_batch_id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'overpaid', 'record', v_batch_id,
           ARRAY[p_item], p_key, p_posting, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch_id
     FOR UPDATE;
  SELECT i.* INTO v_item
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = p_item
     FOR UPDATE;
  SELECT p.* INTO v_proposal
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.item_id = p_item
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-63: the item has no overpaid proposal' USING ERRCODE = '23514';
  END IF;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: an overpaid record is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_item.status <> 'failed' OR v_proposal.status <> 'proposed' THEN
    RAISE EXCEPTION 'PAYOUT-63: only a failed item with an open proposal can be recorded as overpaid'
      USING ERRCODE = '23514';
  END IF;
  IF v_proposal.evidence_key <> p_key THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded'
      USING ERRCODE = '23514';
  END IF;
  -- Two different people, neither the requester of the batch.
  IF v_proposal.proposed_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of an overpaid record needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR v_batch.requested_by = v_proposal.proposed_by THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot record its overpaid items'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items o
     WHERE o.tenant_id = v_tenant AND o.payslip_id = v_item.payslip_id
       AND o.id <> v_item.id AND o.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-63: the payslip has no other paid attempt, so this is not a double payment'
      USING ERRCODE = '23514';
  END IF;
  -- The operation of this proof: the proposals of the batch under the key.
  v_set := ARRAY(
    SELECT p.item_id FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.batch_id = v_batch_id AND p.evidence_key = p_key
     ORDER BY p.item_id);
  v_binding := app.payout_assert_proof(v_tenant, 'overpaid', v_batch_id, v_set, p_key);
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'overpaid' AND a.step = 'propose'
       AND a.actor = v_proposal.proposed_by AND a.evidence_key = p_key
       AND a.item_ids @> ARRAY[p_item]
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the first step of this overpaid record is not attested'
      USING ERRCODE = '42501';
  END IF;
  -- ... and with a grant (911).
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'overpaid' AND a.step = 'propose'
       AND a.actor = v_proposal.proposed_by AND a.evidence_key = p_key
       AND a.item_ids @> ARRAY[p_item]
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this overpaid record has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;
  -- The posting: the overpaid posting of this item alone, nobody else's.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_gl_postings g
     WHERE g.tenant_id = v_tenant AND g.id = p_posting AND g.batch_id = v_batch_id
       AND g.kind = 'overpaid'
       AND g.journal_key = 'payroll-payout-overpaid:' || p_item::text
       AND g.item_set_hash = pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(p_item::text, 'UTF8')), 'hex')
  ) OR EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items o
     WHERE o.tenant_id = v_tenant AND o.gl_posting_id = p_posting
  ) THEN
    RAISE EXCEPTION 'PAYOUT-66: the posting is not the unlinked overpaid posting of this item'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_overpaid_proposals
     SET status = 'recorded', recorded_by = v_actor, recorded_at = v_now
   WHERE tenant_id = v_tenant AND id = v_proposal.id AND status = 'proposed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the proposal changed while it was recorded' USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET status = 'overpaid', gl_posting_id = p_posting, updated_at = v_now
   WHERE tenant_id = v_tenant AND id = p_item AND status = 'failed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the item changed while it was recorded' USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'overpaid', v_proposal.id, 'record', v_batch_id,
    ARRAY[p_item], p_key, v_binding, v_grant, v_assertion);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step one: the claim of the proof (carries the item set and both
-- hashes) and the first person on every item. Returns the claim id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_binding uuid;
  v_content varchar;
  v_stored varchar;
  v_claim uuid;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return', 'propose', p_batch,
           p_item_ids, p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of a return must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-63: a return needs a note of 1 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(SELECT i FROM pg_catalog.unnest(p_item_ids) AS i ORDER BY i);
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a return is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot return its items'
      USING ERRCODE = '42501';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'succeeded'
     AND i.returned_by IS NULL AND i.returned_by_2 IS NULL
     AND i.return_evidence_key IS NULL AND i.return_claim_id IS NULL;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: only paid items without a return can be returned'
      USING ERRCODE = '23514';
  END IF;
  -- One proof, one claim.
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_return_claims c
     WHERE c.tenant_id = v_tenant AND c.evidence_key = p_key
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof already backs a return claim' USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'return', p_batch, v_items, p_key);
  SELECT f.content_sha256, f.stored_sha256 INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key;

  -- A taken hash raises its unique violation here (the service maps it).
  INSERT INTO public.payroll_payout_return_claims (
    tenant_id, batch_id, evidence_key, item_set_hash, status, created_by,
    created_at, content_sha256, stored_sha256)
  VALUES (
    v_tenant, p_batch, p_key, app.payout_item_set_hash(v_items), 'open', v_actor,
    v_now, v_content, v_stored)
  RETURNING id INTO v_claim;
  UPDATE public.payroll_disbursement_items
     SET returned_by = v_actor, return_evidence_key = p_key, return_note = p_note,
         return_claim_id = v_claim, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', v_claim, 'propose', p_batch, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_claim;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step two: another person, the same claim and proof. Consumes the
-- claim and moves succeeded -> returned. Returns how many items moved. The
-- caller posts the return journal afterwards (checked at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_confirm(
  p_claim uuid, p_key varchar, p_grant text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_claim public.payroll_payout_return_claims%ROWTYPE;
  v_items uuid[];
  v_binding uuid;
  v_n integer;
  v_rows integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  -- The grant binds the batch and the items of the claim (read first; the items
  -- are tied to a claim in the transaction that creates it).
  SELECT c.batch_id INTO v_batch_id
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: return claim not found' USING ERRCODE = 'P0002';
  END IF;
  v_items := ARRAY(
    SELECT i.id FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.return_claim_id = p_claim
     ORDER BY i.id);
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return', 'confirm', v_batch_id,
           v_items, p_key, p_claim, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch_id
     FOR UPDATE;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.return_claim_id = p_claim
   ORDER BY i.id
     FOR UPDATE;
  SELECT c.* INTO v_claim
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim
     FOR UPDATE;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a return is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.status <> 'open' THEN
    RAISE EXCEPTION 'PAYOUT-63: the return claim is already consumed' USING ERRCODE = '23514';
  END IF;
  IF v_claim.evidence_key <> p_key THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.created_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a return needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR v_batch.requested_by = v_claim.created_by THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot return its items'
      USING ERRCODE = '42501';
  END IF;
  v_n := pg_catalog.cardinality(v_items);
  IF v_n = 0 OR app.payout_item_set_hash(v_items) <> v_claim.item_set_hash THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of the claim are not the items of the request'
      USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.count(*) INTO v_rows
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
     AND i.status = 'succeeded' AND i.returned_by = v_claim.created_by
     AND i.returned_by_2 IS NULL AND i.return_evidence_key = p_key;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: there are items that are not paid or are already returned'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'return', v_batch_id, v_items, p_key);
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'return'
       AND a.operation_id = p_claim AND a.step = 'propose'
       AND a.actor = v_claim.created_by AND a.evidence_key = p_key
       AND a.item_ids @> v_items AND a.item_ids <@ v_items
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the first step of this return is not attested'
      USING ERRCODE = '42501';
  END IF;
  -- ... and with a grant (911).
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'return'
       AND a.operation_id = p_claim AND a.step = 'propose'
       AND a.actor = v_claim.created_by AND a.evidence_key = p_key
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this return has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_return_claims
     SET status = 'consumed', consumed_at = v_now
   WHERE tenant_id = v_tenant AND id = p_claim AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the return claim changed while it was confirmed'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET returned_by_2 = v_actor, status = 'returned', returned_at = v_now, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = v_batch_id AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by = v_claim.created_by AND returned_by_2 IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was confirmed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', p_claim, 'confirm', v_batch_id, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_confirm(uuid, varchar, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_confirm(uuid, varchar, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Proof closure, step one (0647 body). The grant binds the batch the stuck proof
-- is stuck on; the idempotent early returns come after the consume.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_proof_closure_propose(
  p_key varchar, p_note text, p_grant text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_stuck public.payroll_payout_proof_backfill_stuck%ROWTYPE;
  v_closure public.payroll_payout_proof_closures%ROWTYPE;
  v_id uuid;
  v_binding uuid;
BEGIN
  SELECT s.batch_id INTO v_batch_id
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'closure', 'propose', v_batch_id,
           ARRAY[]::uuid[], p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT z.* INTO v_closure
    FROM public.payroll_payout_proof_closures z
   WHERE z.tenant_id = v_tenant AND z.evidence_key = p_key;
  IF FOUND THEN
    IF v_closure.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'PAYOUT_CLOSURE_ALREADY_CLOSED: the payout proof key is already closed'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_closure.id;
  END IF;
  SELECT s.* INTO v_stuck
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = p_key AND s.resolved_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO public.payroll_payout_proof_closures (id, tenant_id, evidence_key, note, proposed_by, proposed_at)
  VALUES (v_id, v_tenant, p_key, p_note, v_actor, pg_catalog.statement_timestamp());
  SELECT b.id INTO v_binding
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = v_tenant AND b.evidence_key = p_key;
  PERFORM app.payout_attest(v_tenant, 'closure', v_id, 'propose', v_stuck.batch_id,
    ARRAY[]::uuid[], p_key, v_binding, v_grant, v_assertion);
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_proof_closure_propose(varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_closure_propose(varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Proof closure, step two (0647 body). The grant binds the batch of the stuck
-- proof, the key of the closure and the closure as its ref; the idempotent
-- early return of a closed closure comes after the consume.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_proof_closure_approve(
  p_closure uuid, p_grant text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_closure public.payroll_payout_proof_closures%ROWTYPE;
  v_stuck public.payroll_payout_proof_backfill_stuck%ROWTYPE;
  v_binding uuid;
BEGIN
  SELECT z.* INTO v_closure
    FROM public.payroll_payout_proof_closures z
   WHERE z.tenant_id = v_tenant AND z.id = p_closure;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no such payout proof closure'
      USING ERRCODE = 'P0002';
  END IF;
  SELECT s.batch_id INTO v_batch_id
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = v_closure.evidence_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'closure', 'approve', v_batch_id,
           ARRAY[]::uuid[], v_closure.evidence_key, p_closure, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT z.* INTO v_closure
    FROM public.payroll_payout_proof_closures z
   WHERE z.tenant_id = v_tenant AND z.id = p_closure
     FOR UPDATE;
  -- Idempotent: a closed closure only answers the gate again.
  IF v_closure.closed_at IS NOT NULL THEN
    RETURN app.payout_proof_history_pending();
  END IF;
  IF v_closure.proposed_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT_CLOSURE_SAME_PERSON: the closure needs a second person'
      USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_stuck
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = v_closure.evidence_key
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  -- The approver requested none of the batches the key backs or is stuck on.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.requested_by = v_actor
       AND (b.id = v_stuck.batch_id
            OR b.id IN (SELECT o.batch_id FROM app.payout_proof_operations() o
                         WHERE o.evidence_key = v_closure.evidence_key)
            OR b.id IN (SELECT pb.batch_id FROM public.payroll_payout_proof_bindings pb
                         WHERE pb.tenant_id = v_tenant AND pb.evidence_key = v_closure.evidence_key))
  ) THEN
    RAISE EXCEPTION 'PAYOUT_CLOSURE_REQUESTER: the requester of the batch cannot close its proof'
      USING ERRCODE = '42501';
  END IF;
  -- Step one carries a grant (911): a proposal without one is proposed again.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'closure'
       AND a.operation_id = v_closure.id AND a.step = 'propose'
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this closure has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;
  -- Freeze every hash the key is known by, in every tenant.
  INSERT INTO public.payroll_payout_proof_hash_contests (sha256, contested_at)
  SELECT DISTINCT h.sha, pg_catalog.statement_timestamp()
    FROM (
      SELECT x.sha
        FROM public.payroll_payout_proof_bindings b
        CROSS JOIN LATERAL (VALUES (b.content_sha256), (b.stored_sha256)) AS x(sha)
       WHERE b.tenant_id = v_tenant AND b.evidence_key = v_closure.evidence_key
      UNION ALL
      SELECT x.sha
        FROM public.payroll_payout_evidence_files f
        CROSS JOIN LATERAL (VALUES (f.content_sha256), (f.stored_sha256)) AS x(sha)
       WHERE f.tenant_id = v_tenant AND f.evidence_key = v_closure.evidence_key
      UNION ALL
      SELECT x.sha
        FROM public.payroll_payout_return_claims c
        CROSS JOIN LATERAL (VALUES (c.content_sha256), (c.stored_sha256)) AS x(sha)
       WHERE c.tenant_id = v_tenant AND c.evidence_key = v_closure.evidence_key
    ) h
   WHERE h.sha IS NOT NULL
     AND h.sha <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ON CONFLICT (sha256) DO NOTHING;
  UPDATE public.payroll_payout_proof_closures
     SET closed_at = pg_catalog.statement_timestamp(), closed_by = v_actor
   WHERE tenant_id = v_tenant AND id = v_closure.id AND closed_at IS NULL;
  UPDATE public.payroll_payout_proof_backfill_stuck
     SET resolved_at = pg_catalog.statement_timestamp()
   WHERE tenant_id = v_tenant AND evidence_key = v_closure.evidence_key AND resolved_at IS NULL;
  SELECT b.id INTO v_binding
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = v_tenant AND b.evidence_key = v_closure.evidence_key;
  PERFORM app.payout_attest(v_tenant, 'closure', v_closure.id, 'approve', v_stuck.batch_id,
    ARRAY[]::uuid[], v_closure.evidence_key, v_binding, v_grant, v_assertion);
  RETURN app.payout_proof_history_pending();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_proof_closure_approve(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_closure_approve(uuid, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Posting source (0646 body): fills the source account of a pending / skipped
-- settlement posting. The grant binds batch, posting (ref) and account (target).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_posting_record_source(
  p_batch uuid, p_posting uuid, p_gl_account uuid, p_grant text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_posting public.payroll_payout_gl_postings%ROWTYPE;
  v_is_cash boolean;
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'posting_source', 'record', p_batch,
           ARRAY[]::uuid[], NULL, p_posting, p_gl_account, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-50: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- The requester never names the source of their own batch.
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-51: the requester of a batch cannot record its source'
      USING ERRCODE = '42501';
  END IF;
  -- Same advisory key as the services (payroll-payout-gl:<tenant>:<batch>),
  -- taken before the posting row, as the TS lock order does.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('payroll-payout-gl:' || v_tenant::text || ':' || v_batch.id::text));
  SELECT p.* INTO v_posting
    FROM public.payroll_payout_gl_postings p
   WHERE p.tenant_id = v_tenant AND p.batch_id = v_batch.id AND p.id = p_posting
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-50: payout posting not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_posting.kind NOT IN ('settle_pending', 'settle_skipped') THEN
    RAISE EXCEPTION 'PAYOUT-52: payout posting % is already settled', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  v_is_cash := v_batch.channel = 'cash';
  IF NOT v_is_cash AND v_batch.source_bank_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-53: the source of batch % is frozen on its bank account', v_batch.id
      USING ERRCODE = '23514';
  END IF;
  IF v_posting.source_gl_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-54: payout posting % already has a source', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  -- The account: same entity, active, postable (no child accounts).
  IF NOT EXISTS (
    SELECT 1
      FROM public.chart_of_accounts c
     WHERE c.tenant_id = v_tenant
       AND c.legal_entity_id = v_batch.legal_entity_id
       AND c.id = p_gl_account
       AND c.is_active = true
       AND NOT EXISTS (
         SELECT 1
           FROM public.chart_of_accounts ch
          WHERE ch.tenant_id = v_tenant AND ch.parent_id = c.id)
       -- Cash: a cash and equivalents asset account, not any asset account.
       AND (NOT v_is_cash
            OR (c.type = 'asset' AND c.report_group = 'cash_and_equivalents'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-55: the source account is not usable for batch %', v_batch.id
      USING ERRCODE = '23514';
  END IF;
  -- Bank: the GL account of an active bank account of the same entity.
  IF NOT v_is_cash AND NOT EXISTS (
    SELECT 1
      FROM public.bank_accounts ba
     WHERE ba.tenant_id = v_tenant
       AND ba.legal_entity_id = v_batch.legal_entity_id
       AND ba.gl_account_id = p_gl_account
       AND ba.is_active = true
  ) THEN
    RAISE EXCEPTION 'PAYOUT-56: the source account is not an active bank account of the entity'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_gl_postings
     SET source_gl_account_id = p_gl_account
   WHERE tenant_id = v_tenant AND id = v_posting.id
     AND source_gl_account_id IS NULL
     AND kind IN ('settle_pending', 'settle_skipped');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-57: payout posting % changed while recording its source', v_posting.id
      USING ERRCODE = '23514';
  END IF;

  PERFORM app.payout_attest(v_tenant, 'posting_source', v_posting.id, 'record', v_batch.id,
    ARRAY[]::uuid[], NULL, NULL, v_grant, v_assertion);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
-- Last (D7): no attestation after the cutover without a grant. Rows written
-- before app.payout_grants_since() (0653) have none and stay valid.
ALTER TABLE public.payroll_payout_attestations
  ADD CONSTRAINT payroll_payout_attestations_grant_check
  CHECK (grant_id IS NOT NULL OR attested_at < app.payout_grants_since());
