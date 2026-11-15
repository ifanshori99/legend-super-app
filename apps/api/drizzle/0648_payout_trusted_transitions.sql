-- legend-i01jp (905, card 1, chunk C0d): the money steps of a failed-item
-- correction, an overpaid record and a return move behind trusted functions of
-- the NOLOGIN payout role legend_payout (0644). The application role can no
-- longer write those rows, and a setting (GUC) is no longer an authorisation.
-- - Internal helpers (owner legend_payout, no EXECUTE for the app role):
--   app.payout_assert_proof (key not closed, stored record complete, global gate
--   clear, hashes not contested, one binding of the right kind / batch / item
--   set) and app.payout_attest (one attestation row per step).
-- - app.payout_correction_propose / _approve, app.payout_overpaid_propose /
--   _record, app.payout_return_propose / _confirm. Each step re-checks in SQL:
--   the actor (app.payout_assert_actor: user, live MFA session, finance
--   permission), the item status, two different people (the actor is neither
--   the proposer, nor the requester of the batch, nor a resolver of the
--   failure), the binding, the gates, and writes one attestation. The proof
--   hashes are read from the stored proof record, never from an argument.
-- - app.payout_recon_flag: the nightly reconciliation (insert-only exceptions).
-- - Item guard (0636 body, rewritten): failed -> succeeded, failed -> overpaid,
--   succeeded -> returned and every change of the returned_* / return_* columns
--   need current_user = 'legend_payout'; ANY status move out of succeeded,
--   overpaid or returned needs it too (amendment A1: succeeded -> failed would
--   open a retry, a second payment); a new attempt is refused for a payslip with
--   a recon exception. The old settings app.payout_correction and
--   app.payout_overpaid are not read any more.
-- - Constraint trigger app.payout_item_money_commit_check (deferred): at COMMIT
--   a corrected / overpaid / returned item has the right posting (settle
--   journal ok, overpaid journal, return journal) and two attestations of two
--   different actors, the last one written in this transaction.
-- - REVOKE from legend_app: INSERT/UPDATE on corrections, overpaid proposals and
--   return claims; INSERT on proof bindings; UPDATE of the return columns of an
--   item (the status and payment columns stay granted for the normal flow, the
--   guard keeps them).
-- Error codes (all 23514 unless noted):
--   60 status leaves succeeded/overpaid/returned outside the payout role
--   61 return columns outside the payout role
--   62 payslip held back by a recon exception (new attempt refused)
--   63 state of the batch / items / proposal refuses the step
--   64 two-person rule (42501)
--   65 proof refused: closed, incomplete, gate pending, contested, no binding
--   66 posting / attestation refused
--   67 commit-time check of a corrected / overpaid / returned item failed
--   68 recon flag refused
--   69 batch / claim / item not found (P0002)
-- PAYOUT_PROOF_CLOSED keeps the code text of 0647.

-- ---------------------------------------------------------------------------
-- Journal helper for the commit check (invoker, reads under the tenant policy).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_item_journal_ok(p_tenant uuid, p_key text, p_entity uuid, p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.journal_entries j
     WHERE j.tenant_id = p_tenant
       AND j.idempotency_key = p_key
       AND j.legal_entity_id = p_entity
       AND j.source_type = 'payroll'
       AND j.source_id = p_run::text
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         = (SELECT pg_catalog.sum(l.credit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
  )
$$;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
-- What the functions read and write (idempotent grants; 0644/0645 grant the rest).
GRANT SELECT ON TABLE public."session", public.payroll_runs, public.payroll_disbursement_batches,
  public.payroll_disbursement_items, public.payroll_payout_gl_postings,
  public.payroll_payout_evidence_files, public.payroll_payout_proof_bindings,
  public.payroll_payout_failed_corrections, public.payroll_payout_overpaid_proposals,
  public.payroll_payout_return_claims, public.payroll_payout_attestations,
  public.payroll_payout_recon_exceptions
  TO legend_payout;
--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE public.payroll_payout_failed_corrections,
  public.payroll_payout_overpaid_proposals, public.payroll_payout_return_claims,
  public.payroll_payout_attestations
  TO legend_payout;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_recon_exceptions TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_history_pending() TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contested(varchar[]) TO legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Internal helper: the proof of one operation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_assert_proof(
  p_tenant uuid, p_kind text, p_batch uuid, p_item_ids uuid[], p_key varchar
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_content varchar;
  v_stored varchar;
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
  SELECT f.content_sha256, f.stored_sha256
    INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = p_tenant AND f.evidence_key = p_key;
  IF NOT FOUND OR v_content IS NULL OR v_stored IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-65: the payout proof has no complete record'
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
REVOKE ALL ON FUNCTION app.payout_assert_proof(uuid, text, uuid, uuid[], varchar) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Internal helper: one attestation row. A step-one entry ('propose') of the same
-- operation is replaced (the proposer re-proposes with another proof); any other
-- step is written once.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_attest(
  p_tenant uuid, p_kind text, p_operation uuid, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_binding uuid, p_actor text, p_session text,
  p_assertion jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_created timestamptz;
  v_mfa timestamptz;
  v_rows integer;
BEGIN
  SELECT s.created_at, s.mfa_verified_at INTO v_created, v_mfa
    FROM public."session" s
   WHERE s.id = p_session AND s.user_id = p_actor;
  IF NOT FOUND OR v_mfa IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-66: an attestation needs the live MFA session of the actor'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    assertion, attested_at, txid)
  VALUES (
    p_tenant, p_kind, p_operation, p_step, p_batch, p_item_ids, p_key,
    p_binding, p_actor, p_session, v_created, v_mfa,
    p_assertion, pg_catalog.statement_timestamp(), pg_catalog.txid_current())
  ON CONFLICT ON CONSTRAINT payroll_payout_attestations_step_key DO UPDATE
     SET batch_id = EXCLUDED.batch_id, item_ids = EXCLUDED.item_ids,
         evidence_key = EXCLUDED.evidence_key, binding_id = EXCLUDED.binding_id,
         actor = EXCLUDED.actor, session_id = EXCLUDED.session_id,
         session_created_at = EXCLUDED.session_created_at,
         mfa_verified_at = EXCLUDED.mfa_verified_at,
         assertion = EXCLUDED.assertion, attested_at = EXCLUDED.attested_at,
         txid = EXCLUDED.txid
   WHERE payroll_payout_attestations.step = 'propose';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-66: the % step of this operation is already attested', p_step
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Correction, step one: an open proposal of every item (the first row carries
-- the operation's own id). The same proposer replaces their open proposal with
-- another proof. Returns the operation id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_correction_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_actor text, p_session text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
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
  IF v_batch.requested_by = p_actor THEN
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
       AND (i.resolved_by = p_actor OR i.resolved_by_2 = p_actor)
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
        'proposed', p_actor, v_now);
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
    -- Only the proposer replaces their own open proposal, with another proof.
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = v_op AND c.proposed_by <> p_actor) THEN
      RAISE EXCEPTION 'PAYOUT-64: only the proposer replaces an open correction proposal'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = v_op AND c.evidence_key = p_key) THEN
      RAISE EXCEPTION 'PAYOUT-64: this proposal was already made; the second step needs another person'
        USING ERRCODE = '42501';
    END IF;
    UPDATE public.payroll_payout_failed_corrections
       SET evidence_key = p_key, content_sha256 = v_content, stored_sha256 = v_stored,
           note = p_note, proposed_at = v_now
     WHERE tenant_id = v_tenant AND operation_id = v_op AND status = 'proposed';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'correction', v_op, 'propose', p_batch, v_items,
    p_key, v_binding, p_actor, p_session, v_assertion);
  RETURN v_op;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Correction, step two: another person, the same proof. Marks every proposal
-- corrected and moves failed -> succeeded with the payment record of the
-- corrector. Returns how many items moved. The settle journal is posted by the
-- caller after this call (checked at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_correction_approve(
  p_operation uuid, p_key varchar, p_actor text, p_session text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT c.batch_id INTO v_batch_id
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: correction not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  v_items := ARRAY(
    SELECT c.item_id FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation ORDER BY c.item_id);
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
  IF v_proposer = p_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a correction needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = p_actor OR v_batch.requested_by = v_proposer THEN
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
       AND (i.resolved_by IN (p_actor, v_proposer) OR i.resolved_by_2 IN (p_actor, v_proposer))
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

  UPDATE public.payroll_payout_failed_corrections
     SET status = 'corrected', corrected_by = p_actor, corrected_at = v_now
   WHERE tenant_id = v_tenant AND operation_id = p_operation AND status = 'proposed';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction changed while it was approved' USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items i
     SET status = 'succeeded', confirmed_by = p_actor,
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
    p_key, v_binding, p_actor, p_session, v_assertion);
  RETURN v_moved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_correction_approve(uuid, varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_correction_approve(uuid, varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overpaid, step one: one open proposal per item (one proposal per item, ever).
-- The same proposer replaces their open proposal with another proof. Returns a
-- fresh id for this call's attestation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_overpaid_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_actor text, p_session text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
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
  IF v_batch.requested_by = p_actor THEN
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
      VALUES (v_tenant, p_batch, v_item, p_key, p_note, 'proposed', p_actor, v_now);
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
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.proposed_by <> p_actor) THEN
      RAISE EXCEPTION 'PAYOUT-64: only the proposer replaces an open overpaid proposal'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.evidence_key = p_key) THEN
      RAISE EXCEPTION 'PAYOUT-64: this proposal was already made; the second step needs another person'
        USING ERRCODE = '42501';
    END IF;
    UPDATE public.payroll_payout_overpaid_proposals
       SET evidence_key = p_key, note = p_note, proposed_at = v_now
     WHERE tenant_id = v_tenant AND item_id = ANY (v_items) AND status = 'proposed';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'overpaid', v_op, 'propose', p_batch, v_items,
    p_key, v_binding, p_actor, p_session, v_assertion);
  RETURN v_op;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overpaid, step two, one item: another person, the same proof, the overpaid
-- posting the caller wrote. Marks the proposal recorded and moves
-- failed -> overpaid linked to the posting. The journal is the caller's (checked
-- at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_overpaid_record(
  p_item uuid, p_key varchar, p_posting uuid, p_actor text, p_session text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT i.batch_id INTO v_batch_id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout item not found' USING ERRCODE = 'P0002';
  END IF;
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
  IF v_proposal.proposed_by = p_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of an overpaid record needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = p_actor OR v_batch.requested_by = v_proposal.proposed_by THEN
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
     SET status = 'recorded', recorded_by = p_actor, recorded_at = v_now
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
    ARRAY[p_item], p_key, v_binding, p_actor, p_session, v_assertion);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step one: the claim of the proof (carries the item set and both
-- hashes) and the first person on every item. Returns the claim id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_actor text, p_session text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
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
  IF v_batch.requested_by = p_actor THEN
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
    v_tenant, p_batch, p_key, app.payout_item_set_hash(v_items), 'open', p_actor,
    v_now, v_content, v_stored)
  RETURNING id INTO v_claim;
  UPDATE public.payroll_disbursement_items
     SET returned_by = p_actor, return_evidence_key = p_key, return_note = p_note,
         return_claim_id = v_claim, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', v_claim, 'propose', p_batch, v_items,
    p_key, v_binding, p_actor, p_session, v_assertion);
  RETURN v_claim;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step two: another person, the same claim and proof. Consumes the
-- claim and moves succeeded -> returned. Returns how many items moved. The
-- caller posts the return journal afterwards (checked at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_confirm(
  p_claim uuid, p_key varchar, p_actor text, p_session text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT c.batch_id INTO v_batch_id
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: return claim not found' USING ERRCODE = 'P0002';
  END IF;
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
  IF v_claim.created_by = p_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a return needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = p_actor OR v_batch.requested_by = v_claim.created_by THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot return its items'
      USING ERRCODE = '42501';
  END IF;
  v_items := ARRAY(
    SELECT i.id FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.return_claim_id = p_claim
     ORDER BY i.id);
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

  UPDATE public.payroll_payout_return_claims
     SET status = 'consumed', consumed_at = v_now
   WHERE tenant_id = v_tenant AND id = p_claim AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the return claim changed while it was confirmed'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET returned_by_2 = p_actor, status = 'returned', returned_at = v_now, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = v_batch_id AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by = v_claim.created_by AND returned_by_2 IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was confirmed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', p_claim, 'confirm', v_batch_id, v_items,
    p_key, v_binding, p_actor, p_session, v_assertion);
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_confirm(uuid, varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_confirm(uuid, varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Nightly reconciliation: flags one item (insert-only). The tenant is the one in
-- force; the payslip comes from the item. A repeated flag is a no-op.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_flag(
  p_tenant uuid, p_kind text, p_operation uuid, p_item uuid, p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_payslip uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a flag is raised in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('correction', 'overpaid', 'return', 'posting_source', 'closure')
    OR p_operation IS NULL OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'PAYOUT-68: the flag needs a kind, an operation and a reason'
      USING ERRCODE = '23514';
  END IF;
  SELECT i.payslip_id INTO v_payslip
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-68: the flagged item is not an item of the tenant'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_recon_exceptions (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, flagged_at)
  VALUES (
    p_tenant, p_kind, p_operation, p_item, v_payslip,
    pg_catalog.left(p_reason, 200), pg_catalog.statement_timestamp())
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_exceptions_flag_key DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_flag(uuid, text, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_flag(uuid, text, uuid, uuid, text) TO legend_app;
--> statement-breakpoint

-- ACL first (the migrator stops being able to change it once the owner moves).
ALTER FUNCTION app.payout_assert_proof(uuid, text, uuid, uuid[], varchar) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, text, text, jsonb) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_correction_propose(uuid, uuid[], varchar, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_correction_approve(uuid, varchar, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_overpaid_propose(uuid, uuid[], varchar, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_overpaid_record(uuid, varchar, uuid, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_return_confirm(uuid, varchar, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_recon_flag(uuid, text, uuid, uuid, text) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The item guard: the 0636 body with these changes only.
-- (1) The two settings app.payout_correction / app.payout_overpaid are gone;
--     failed -> succeeded (correction), failed -> overpaid and succeeded ->
--     returned need current_user = 'legend_payout' (the functions above).
-- (2) A1: any status move out of succeeded, overpaid or returned needs it too.
-- (3) The returned_* / return_* columns change only for the payout role (also
--     on insert: a new item has none).
-- (4) A new attempt is refused for a payslip with a recon exception.
-- The two-person return rule (PAYOUT-32) and the posting link rule (PAYOUT-31)
-- live in app.payroll_disbursement_items_payout_gl_guard (0351), unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  slip_run uuid;
  slip_employee uuid;
  slip_method text;
  batch_status text;
  batch_requester text;
  batch_approver text;
  sealed_changed boolean;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('prepared', 'blocked') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item starts prepared or blocked (got %)', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.returned_by IS NOT NULL OR NEW.returned_by_2 IS NOT NULL
        OR NEW.return_evidence_key IS NOT NULL OR NEW.return_note IS NOT NULL
        OR NEW.return_claim_id IS NOT NULL OR NEW.returned_at IS NOT NULL)
      AND current_user IS DISTINCT FROM 'legend_payout' THEN
      RAISE EXCEPTION 'PAYOUT-61: a new disbursement item carries no return record'
        USING ERRCODE = '23514';
    END IF;
    SELECT b.status INTO batch_status FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'PAYOUT-11: items can only be added to a draft batch (batch % is %)', NEW.batch_id, batch_status
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status INTO run_status FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('locked', 'paid') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    SELECT s.payroll_run_id, s.employee_id, s.payment_method
      INTO slip_run, slip_employee, slip_method
      FROM public.payslips s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.payslip_id;
    IF slip_run IS DISTINCT FROM NEW.payroll_run_id
      OR slip_employee IS DISTINCT FROM NEW.employee_id
      OR slip_method IS DISTINCT FROM (CASE WHEN NEW.channel = 'cash' THEN 'cash' ELSE 'bank_transfer' END)
    THEN
      RAISE EXCEPTION 'PAYOUT-11: item % does not match the run, employee and payment method of its payslip', NEW.id
        USING ERRCODE = '23514';
    END IF;
    -- (905) the nightly reconciliation held this payslip back: no new attempt.
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_recon_exceptions e
       WHERE e.tenant_id = NEW.tenant_id AND e.payslip_id = NEW.payslip_id
    ) THEN
      RAISE EXCEPTION 'PAYOUT-62: payslip % is held back by a reconciliation exception', NEW.payslip_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYOUT-12: the identity of disbursement item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND (NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
      OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
      OR NEW.inquiry_account_name_encrypted IS DISTINCT FROM OLD.inquiry_account_name_encrypted
      OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version)
  THEN
    -- Reseal bypass (PAYR-KEY, as 0248): the sealed amount, fee and inquiry
    -- name move together with a higher key version, only inside the reseal
    -- job's transaction, never above the active version, with no other column
    -- changed. Valid for any status, including a final item.
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF NEW.pii_key_version IS NULL
      OR NEW.pii_key_version <= OLD.pii_key_version
      OR NEW.amount_encrypted IS NOT DISTINCT FROM OLD.amount_encrypted
    THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must change the sealed amount and raise the key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
      RAISE EXCEPTION 'PAYR-KEY: item % key version is above the active key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version')
      IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version') THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must not change any other column', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('failed', 'not_sent', 'cancelled', 'returned', 'overpaid')
    AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
    -- (905) failed -> overpaid: only the payout role (app.payout_overpaid_record);
    -- only the status and the posting link move.
    AND NOT (
      OLD.status = 'failed' AND NEW.status = 'overpaid'
      AND current_user = 'legend_payout'
      AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'gl_posting_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'gl_posting_id')
    )
    -- (legend-mejr2, 905) the one other way out of `failed`: a correction, by
    -- the payout role (app.payout_correction_approve). Only the status and the
    -- payment record of the corrected payment move.
    AND NOT (
      OLD.status = 'failed' AND NEW.status = 'succeeded'
      AND current_user = 'legend_payout'
      AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'confirmed_by' - 'confirmation_ref' - 'confirmation_evidence_key' - 'settled_at')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'confirmed_by' - 'confirmation_ref' - 'confirmation_evidence_key' - 'settled_at')
    ) THEN
    RAISE EXCEPTION 'PAYOUT-12: disbursement item % is final (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  -- (905, amendment A1) a paid, overpaid or returned item changes status only
  -- through a trusted function: succeeded -> failed would reopen a retry and
  -- pay the employee a second time.
  IF OLD.status IN ('succeeded', 'overpaid', 'returned')
    AND NEW.status IS DISTINCT FROM OLD.status
    AND current_user IS DISTINCT FROM 'legend_payout' THEN
    RAISE EXCEPTION 'PAYOUT-60: item % leaves % only through the payout role', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  -- (905) the return record is written by the payout role only.
  IF (NEW.returned_by IS DISTINCT FROM OLD.returned_by
      OR NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2
      OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
      OR NEW.return_note IS DISTINCT FROM OLD.return_note
      OR NEW.return_claim_id IS DISTINCT FROM OLD.return_claim_id
      OR NEW.returned_at IS DISTINCT FROM OLD.returned_at)
    AND current_user IS DISTINCT FROM 'legend_payout' THEN
    RAISE EXCEPTION 'PAYOUT-61: the return record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('prepared', 'blocked')
    AND (NEW.bank_snapshot_id IS DISTINCT FROM OLD.bank_snapshot_id
      OR NEW.bank_code IS DISTINCT FROM OLD.bank_code) THEN
    RAISE EXCEPTION 'PAYOUT-13: the payee of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  sealed_changed := NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
    OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version;
  IF sealed_changed AND OLD.status NOT IN ('prepared', 'blocked') THEN
    RAISE EXCEPTION 'PAYOUT-13: the amount of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'prepared' AND NEW.status IN ('blocked', 'approved', 'cancelled'))
      OR (OLD.status = 'blocked' AND NEW.status = 'cancelled')
      OR (OLD.status = 'approved' AND NEW.status IN ('not_sent', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status = 'exported' AND NEW.channel = 'manual_bank')
      OR (OLD.status = 'approved' AND NEW.status = 'succeeded' AND NEW.channel = 'cash')
      OR (OLD.status = 'exported' AND NEW.status IN ('succeeded', 'failed', 'not_sent'))
      -- (905) succeeded -> returned: the payout role (app.payout_return_confirm).
      OR (OLD.status = 'succeeded' AND NEW.status = 'returned'
          AND current_user = 'legend_payout')
      -- (905) failed -> overpaid: the payout role, with the overpaid posting of
      -- this item, on a payslip that another attempt paid.
      OR (OLD.status = 'failed' AND NEW.status = 'overpaid'
          AND current_user = 'legend_payout'
          AND NEW.gl_posting_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.payroll_payout_gl_postings p
            WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.gl_posting_id
              AND p.kind = 'overpaid'
              AND p.journal_key = 'payroll-payout-overpaid:' || NEW.id::text)
          AND EXISTS (
            SELECT 1 FROM public.payroll_disbursement_items o
            WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
              AND o.id <> NEW.id AND o.status = 'succeeded'))
      -- (legend-mejr2, 905) failed -> succeeded only through a `corrected` row of
      -- this item (two different people, neither the batch requester nor either
      -- resolver of the failure), by the payout role, on a manual bank item whose
      -- payslip has no other attempt that is live, paid back, or overpaid. The
      -- payment record of the item is the correction's: the corrector, its
      -- proof, the time.
      OR (OLD.status = 'failed' AND NEW.status = 'succeeded'
          AND current_user = 'legend_payout'
          AND NEW.channel = 'manual_bank'
          AND OLD.resolution_outcome IS NOT DISTINCT FROM 'failed'
          AND OLD.resolved_by IS NOT NULL
          AND OLD.resolved_by_2 IS NOT NULL
          AND NEW.confirmed_by IS NOT NULL
          AND NEW.confirmation_ref IS NOT NULL
          AND NEW.settled_at IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM public.payroll_payout_failed_corrections c
              JOIN public.payroll_disbursement_batches b
                ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
             WHERE c.tenant_id = NEW.tenant_id AND c.item_id = NEW.id
               AND c.batch_id = NEW.batch_id
               AND c.status = 'corrected'
               AND c.corrected_by IS NOT NULL
               AND c.corrected_by <> c.proposed_by
               AND NEW.confirmed_by = c.corrected_by
               AND NEW.confirmation_evidence_key IS NOT DISTINCT FROM c.evidence_key
               AND c.corrected_by IS DISTINCT FROM OLD.resolved_by
               AND c.corrected_by IS DISTINCT FROM OLD.resolved_by_2
               AND c.proposed_by IS DISTINCT FROM OLD.resolved_by
               AND c.proposed_by IS DISTINCT FROM OLD.resolved_by_2
               AND c.corrected_by IS DISTINCT FROM b.requested_by
               AND c.proposed_by IS DISTINCT FROM b.requested_by)
          AND EXISTS (
            SELECT 1 FROM public.payroll_runs r
            WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
              AND r.status IN ('locked', 'paid'))
          AND NOT EXISTS (
            SELECT 1 FROM public.payroll_disbursement_items o
            WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
              AND o.id <> NEW.id
              AND o.status IN ('prepared', 'blocked', 'approved', 'sending', 'exported',
                               'unknown', 'succeeded', 'returned', 'overpaid')))
    ) THEN
      RAISE EXCEPTION 'PAYOUT-14: item % cannot move from % to % on channel %', OLD.id, OLD.status, NEW.status, NEW.channel
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' THEN
      SELECT b.status, b.approved_by, b.requested_by
        INTO batch_status, batch_approver, batch_requester
        FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
      IF batch_status IS DISTINCT FROM 'approved'
        OR batch_approver IS NULL
        OR batch_approver = batch_requester THEN
        RAISE EXCEPTION 'PAYOUT-15: item % can be approved only by an approved batch with a second person', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'succeeded' AND (
       NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
    -- L4: the record of a payment is evidence; only returned_at and the
    -- succeeded -> returned status move after it.
    RAISE EXCEPTION 'PAYOUT-19: the payment record of succeeded item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.confirmed_by = batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot confirm payment of item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- H2: a manual resolution (failed / not_sent) frees the payslip for a new
  -- payment, so it takes two different people, both other than the batch
  -- requester, plus evidence. The first one records the proposal and the item
  -- stays exported; once recorded, the proposal cannot be rewritten.
  IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    OR NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2
    OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
    OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
    IF OLD.status NOT IN ('exported', 'unknown') THEN
      RAISE EXCEPTION 'PAYOUT-18: item % can be resolved only while exported or unknown (is %)', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    IF ((OLD.resolved_by IS NOT NULL AND (
           NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
        OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
        OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note))
      OR (OLD.resolved_by_2 IS NOT NULL AND NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2))
      -- Withdraw (legend-5rh26): a step-one proposal on an exported item may be
      -- cleared as a whole (all four columns NULL at once), only while no step
      -- two exists, with the status and every other column unchanged.
      AND NOT (
        OLD.status = 'exported'
        AND NEW.status IS NOT DISTINCT FROM OLD.status
        AND OLD.resolved_by IS NOT NULL
        AND OLD.resolved_by_2 IS NULL
        AND NEW.resolved_by_2 IS NULL
        AND NEW.resolved_by IS NULL
        AND NEW.resolution_outcome IS NULL
        AND NEW.resolution_evidence_key IS NULL
        AND NEW.resolution_note IS NULL
        AND (to_jsonb(NEW) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
          IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
      ) THEN
      RAISE EXCEPTION 'PAYOUT-18: the recorded resolution of item % cannot be rewritten', OLD.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NOT DISTINCT FROM batch_requester
      OR NEW.resolved_by_2 IS NOT DISTINCT FROM batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('failed', 'not_sent') AND NEW.status IS DISTINCT FROM OLD.status AND OLD.status = 'exported' THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NULL
      OR NEW.resolved_by_2 IS NULL
      OR NEW.resolved_by = NEW.resolved_by_2
      OR NEW.resolved_by = batch_requester
      OR NEW.resolved_by_2 = batch_requester
      OR NEW.resolution_evidence_key IS NULL
      OR NEW.resolution_outcome IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'PAYOUT-18: exported item % can become % only after two different people (not the requester) resolved it with evidence', OLD.id, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Commit check of a corrected / overpaid / returned item (PAYOUT-67). Runs in the
-- tenant of the row (a local setting, restored after), reads the item again (its
-- posting link is set by the settle that follows the status move), and requires:
-- - correction (failed -> succeeded): the item is linked to a settlement
--   posting; a `settle` posting passes app.payout_settle_journal_ok. Two
--   attestations (propose, approve) of two different actors; the approver is
--   the confirmer; the approval was written in this transaction.
-- - overpaid (failed -> overpaid): linked to its overpaid posting; the journal
--   of that posting is balanced with debits whenever the run has a lock journal
--   (a run without one has no salary side, like the service). Attestations
--   propose / record of two different actors, record in this transaction.
-- - return (succeeded -> returned): linked to a settlement posting; for a
--   `settle` posting with a principal, the return journal of the item is
--   balanced with debits (a pending or skipped settlement has none to reverse).
--   Attestations propose / confirm of two different actors, confirm in this
--   transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_item_money_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  v_item public.payroll_disbursement_items%ROWTYPE;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_posting public.payroll_payout_gl_postings%ROWTYPE;
  v_reason text := NULL;
  v_operation uuid;
  v_first text;
  v_last text;
  v_proposal public.payroll_payout_overpaid_proposals%ROWTYPE;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT i.* INTO v_item
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.id;
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
  SELECT p.* INTO v_posting
    FROM public.payroll_payout_gl_postings p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = v_item.gl_posting_id
     AND p.batch_id = NEW.batch_id;

  IF OLD.status = 'failed' AND NEW.status = 'succeeded' THEN
    IF v_posting.id IS NULL OR v_posting.kind NOT IN ('settle', 'settle_pending', 'settle_skipped') THEN
      v_reason := 'the corrected item has no settlement posting';
    ELSIF v_posting.kind = 'settle'
      AND NOT app.payout_settle_journal_ok(NEW.tenant_id, v_posting.id) THEN
      v_reason := 'the settle journal of the corrected item does not match its posting';
    ELSE
      SELECT c.operation_id INTO v_operation
        FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = NEW.tenant_id AND c.item_id = NEW.id AND c.status = 'corrected';
      SELECT a.actor INTO v_first
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'correction'
         AND a.operation_id = v_operation AND a.step = 'propose'
         AND a.item_ids @> ARRAY[NEW.id];
      SELECT a.actor INTO v_last
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'correction'
         AND a.operation_id = v_operation AND a.step = 'approve'
         AND a.item_ids @> ARRAY[NEW.id]
         AND a.txid = pg_catalog.txid_current();
      IF v_first IS NULL OR v_last IS NULL OR v_first = v_last
        OR v_last IS DISTINCT FROM v_item.confirmed_by THEN
        v_reason := 'the correction is not attested by two different people';
      END IF;
    END IF;
  ELSIF OLD.status = 'failed' AND NEW.status = 'overpaid' THEN
    IF v_posting.id IS NULL OR v_posting.kind <> 'overpaid'
      OR v_posting.journal_key <> 'payroll-payout-overpaid:' || NEW.id::text THEN
      v_reason := 'the overpaid item is not linked to its overpaid posting';
    ELSIF EXISTS (
        SELECT 1 FROM public.journal_entries j
         WHERE j.tenant_id = NEW.tenant_id
           AND j.idempotency_key = 'payroll-gl:locked:' || NEW.payroll_run_id::text)
      AND NOT app.payout_item_journal_ok(
        NEW.tenant_id, v_posting.journal_key, v_batch.legal_entity_id, v_batch.payroll_run_id) THEN
      v_reason := 'the overpaid journal of the item is missing or unbalanced';
    ELSE
      SELECT p.* INTO v_proposal
        FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = NEW.tenant_id AND p.item_id = NEW.id AND p.status = 'recorded';
      SELECT a.actor INTO v_first
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'overpaid' AND a.step = 'propose'
         AND a.item_ids @> ARRAY[NEW.id] AND a.evidence_key = v_proposal.evidence_key
         AND a.actor = v_proposal.proposed_by
       ORDER BY a.attested_at DESC
       LIMIT 1;
      SELECT a.actor INTO v_last
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'overpaid'
         AND a.operation_id = v_proposal.id AND a.step = 'record'
         AND a.item_ids @> ARRAY[NEW.id]
         AND a.txid = pg_catalog.txid_current();
      IF v_proposal.id IS NULL OR v_first IS NULL OR v_last IS NULL OR v_first = v_last
        OR v_last IS DISTINCT FROM v_proposal.recorded_by THEN
        v_reason := 'the overpaid record is not attested by two different people';
      END IF;
    END IF;
  ELSIF OLD.status = 'succeeded' AND NEW.status = 'returned' THEN
    IF v_posting.id IS NULL OR v_posting.kind NOT IN ('settle', 'settle_pending', 'settle_skipped') THEN
      v_reason := 'the returned item has no settlement posting';
    ELSIF v_posting.kind = 'settle' AND COALESCE(v_posting.settle_net_idr, 1) > 0
      AND NOT app.payout_item_journal_ok(
        NEW.tenant_id, 'payroll-payout-return:' || NEW.id::text,
        v_batch.legal_entity_id, v_batch.payroll_run_id) THEN
      v_reason := 'the return journal of the item is missing or unbalanced';
    ELSE
      SELECT a.actor INTO v_first
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'return'
         AND a.operation_id = v_item.return_claim_id AND a.step = 'propose'
         AND a.item_ids @> ARRAY[NEW.id];
      SELECT a.actor INTO v_last
        FROM public.payroll_payout_attestations a
       WHERE a.tenant_id = NEW.tenant_id AND a.kind = 'return'
         AND a.operation_id = v_item.return_claim_id AND a.step = 'confirm'
         AND a.item_ids @> ARRAY[NEW.id]
         AND a.txid = pg_catalog.txid_current();
      IF v_first IS NULL OR v_last IS NULL OR v_first = v_last
        OR v_first IS DISTINCT FROM v_item.returned_by
        OR v_last IS DISTINCT FROM v_item.returned_by_2 THEN
        v_reason := 'the return is not attested by two different people';
      END IF;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-67: disbursement item % does not match its trusted record at commit: %', NEW.id, v_reason
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_item_money_commit_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payout_item_money_commit_check ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payout_item_money_commit_check
  AFTER UPDATE OF status ON public.payroll_disbursement_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        AND ((OLD.status = 'failed' AND NEW.status IN ('succeeded', 'overpaid'))
             OR (OLD.status = 'succeeded' AND NEW.status = 'returned')))
  EXECUTE FUNCTION app.payout_item_money_commit_check();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The app role stops writing these rows. Proposals, claims, corrections and
-- bindings: the functions above (and 0645) are the writers. Items: the status and
-- payment columns stay granted for the normal flow (the guard keeps them); the
-- return record columns are the payout role's alone.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON TABLE public.payroll_payout_failed_corrections,
  public.payroll_payout_overpaid_proposals, public.payroll_payout_return_claims
  FROM legend_app;
--> statement-breakpoint
REVOKE INSERT ON TABLE public.payroll_payout_proof_bindings FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.payroll_disbursement_items FROM legend_app;
--> statement-breakpoint
DO $$
DECLARE
  cols text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.payroll_disbursement_items'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('returned_by', 'returned_by_2', 'return_evidence_key',
                           'return_note', 'return_claim_id', 'returned_at');
  EXECUTE pg_catalog.format('GRANT UPDATE (%s) ON TABLE public.payroll_disbursement_items TO legend_app', cols);
END $$;
