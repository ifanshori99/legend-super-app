-- legend-l2zru (918), file 2 of 2: a frozen batch refuses every payout step.
-- File 1 (0427) made app.payout_batch_assert_open(tenant, batch): it returns
-- when the batch is NULL or has no open dispute, and it raises PAYOUT-79 (batch
-- frozen) after taking FOR UPDATE on the batch row, so it serialises with the
-- disown function (FOR UPDATE). This file calls it from every place a payout
-- step can happen. The row triggers call the lock-free twin
-- app.payout_batch_assert_open_nolock (they already hold a row, and the project
-- lock order is batch first, then items); the trusted functions below take the
-- locked version:
-- 1. Triggers that also bind legend_app (plain SQL cannot go around them):
--    batches BEFORE UPDATE (status, approval, export, content hash, source bank,
--    cancel), items BEFORE UPDATE OF (status, settled_at, confirmation, resolve)
--    and BEFORE INSERT (the new batch and every earlier-attempt batch of the same
--    payslip, so a payslip of a frozen batch cannot get a fresh item elsewhere),
--    bank_transfer_files BEFORE INSERT (every batch of the run) and
--    payroll_payout_gl_postings BEFORE INSERT and BEFORE UPDATE.
-- 2. app.payout_grant_consume (0653 body): first check after the tenant check,
--    for every kind except disown and unfreeze. A refusal rolls back, so the
--    grant stays unspent. This covers the 17 functions that consume a grant.
-- 3. app.payout_attest (0426 body): first statement. Same functions, second door.
-- 4. app.payout_run_settle (0657 body): after the batch is loaded.
-- Left open on purpose: payout_recon_flag (it only restricts), the backfill,
-- contest and proof binding functions, and disown/unfreeze themselves.
-- Ownership: as 0654, the three functions are replaced by the payout role itself
-- (grant, become, work, return, revoke); trigger DDL runs as the migrator first.
CREATE FUNCTION app.payroll_disbursement_batches_freeze_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, NEW.id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_batches_freeze_trg
  BEFORE UPDATE ON public.payroll_disbursement_batches
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
     OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
     OR OLD.approval_expires_at IS DISTINCT FROM NEW.approval_expires_at
     OR OLD.exported_by IS DISTINCT FROM NEW.exported_by
     OR OLD.exported_at IS DISTINCT FROM NEW.exported_at
     OR OLD.export_checksum_sha256 IS DISTINCT FROM NEW.export_checksum_sha256
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
     OR OLD.source_bank_account_id IS DISTINCT FROM NEW.source_bank_account_id
     OR OLD.cancelled_by IS DISTINCT FROM NEW.cancelled_by
     OR OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at)
  EXECUTE FUNCTION app.payroll_disbursement_batches_freeze_guard();
--> statement-breakpoint
CREATE FUNCTION app.payroll_disbursement_items_freeze_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_batch uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The batch it joins, and the batch of every earlier attempt of the payslip.
    PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, NEW.batch_id);
    FOR v_batch IN
      SELECT DISTINCT i.batch_id
        FROM public.payroll_disbursement_items i
       WHERE i.tenant_id = NEW.tenant_id AND i.payslip_id = NEW.payslip_id
         AND i.batch_id <> NEW.batch_id
    LOOP
      PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, v_batch);
    END LOOP;
  ELSE
    IF OLD.status IS DISTINCT FROM NEW.status
       OR OLD.settled_at IS DISTINCT FROM NEW.settled_at
       OR OLD.confirmed_by IS DISTINCT FROM NEW.confirmed_by
       OR OLD.confirmation_ref IS DISTINCT FROM NEW.confirmation_ref
       OR OLD.confirmation_evidence_key IS DISTINCT FROM NEW.confirmation_evidence_key
       OR OLD.resolved_by IS DISTINCT FROM NEW.resolved_by
       OR OLD.resolved_by_2 IS DISTINCT FROM NEW.resolved_by_2
       OR OLD.resolution_note IS DISTINCT FROM NEW.resolution_note
       OR OLD.resolution_outcome IS DISTINCT FROM NEW.resolution_outcome
       OR OLD.resolution_evidence_key IS DISTINCT FROM NEW.resolution_evidence_key THEN
      PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, NEW.batch_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_freeze_ins_trg
  BEFORE INSERT ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_freeze_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_freeze_upd_trg
  BEFORE UPDATE OF status, settled_at, confirmed_by, confirmation_ref,
    confirmation_evidence_key, resolved_by, resolved_by_2, resolution_note,
    resolution_outcome, resolution_evidence_key
  ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_freeze_guard();
--> statement-breakpoint
-- The legacy bank file has no batch column; it is tied to the run, so every
-- batch of the run is checked.
CREATE FUNCTION app.bank_transfer_files_freeze_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_batch uuid;
BEGIN
  FOR v_batch IN
    SELECT b.id
      FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.payroll_run_id
  LOOP
    PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, v_batch);
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_transfer_files_freeze_trg
  BEFORE INSERT ON public.bank_transfer_files
  FOR EACH ROW EXECUTE FUNCTION app.bank_transfer_files_freeze_guard();
--> statement-breakpoint
CREATE FUNCTION app.payroll_payout_gl_postings_freeze_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, NEW.batch_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_gl_postings_freeze_trg
  BEFORE INSERT ON public.payroll_payout_gl_postings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_gl_postings_freeze_guard();
--> statement-breakpoint
-- An existing posting of a frozen batch does not move either (source, state).
CREATE TRIGGER payroll_payout_gl_postings_freeze_upd_trg
  BEFORE UPDATE ON public.payroll_payout_gl_postings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_gl_postings_freeze_guard();
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- app.payroll_runs_payout_guard (0657 body; the migrator owns it, as in 0344,
-- so it is replaced before the payout role is assumed). New: a run cannot be
-- reversed while any batch of it is frozen (PAYOUT-79, the lock-free check, so
-- the trigger takes no batch lock). A failed or returned item does not stop the
-- reversal on its own; a "not me" claim on one of its payments must be cleared
-- first, or the reversal would free the period under an open dispute.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payroll_runs_payout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_batch uuid;
BEGIN
  IF NEW.status = 'reversed' THEN
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status NOT IN ('completed', 'partially_failed', 'cancelled')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('sending', 'exported', 'unknown', 'succeeded')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-21: payroll run % has a payout in progress or paid items and cannot be reversed', NEW.id
        USING ERRCODE = '23514';
    END IF;
    FOR v_batch IN
      SELECT b.id FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
       ORDER BY b.id
    LOOP
      PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, v_batch);
    END LOOP;
  ELSIF NEW.status = 'paid' THEN
    IF current_user IS DISTINCT FROM 'legend_payout' AND EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'PAYOUT-22: payroll run % has disbursement batches and becomes paid only when its items are paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
    -- L3: even the payout settle code cannot mark a run paid while a payment
    -- of it is still open. (That every net pay slip has a succeeded item is not
    -- checkable here: the net amount is sealed; the settle code checks it.)
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status IN ('pending_approval', 'approved', 'sending', 'exported')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('approved', 'sending', 'exported', 'unknown')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-23: payroll run % has a payout that is still open and cannot become paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- app.payout_grant_consume (0653 body, same signature and owner). New: the
-- batch freeze check right after the tenant check, before the grant is spent.
-- disown and unfreeze are the two kinds that must work on a frozen batch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_grant_consume(
  p_tenant uuid, p_grant text, p_kind text, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_ref uuid, p_target uuid, p_detail varchar)
RETURNS TABLE (grant_id uuid, actor text, session_id text, assertion jsonb)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_id uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
BEGIN
  IF p_grant IS NULL OR p_grant !~ '^[0-9a-f]{64}$'
     OR p_tenant IS NULL
     OR p_tenant::text IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'PAYOUT-70: no valid payout grant for this step'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind IS DISTINCT FROM 'disown' AND p_kind IS DISTINCT FROM 'unfreeze' THEN
    PERFORM app.payout_batch_assert_open(p_tenant, p_batch);
  END IF;
  UPDATE public.payroll_payout_grants g
     SET consumed_at = v_now,
         consumed_txid = pg_catalog.txid_current()
   WHERE g.tenant_id = p_tenant
     AND g.secret_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(p_grant, 'hex')), 'hex')
     AND g.consumed_at IS NULL
     AND g.expires_at > v_now
     AND g.kind = p_kind
     AND g.step = p_step
     AND g.batch_id IS NOT DISTINCT FROM p_batch
     AND g.item_set_hash IS NOT DISTINCT FROM app.payout_item_set_hash(COALESCE(p_item_ids, '{}'::uuid[]))
     AND g.evidence_key IS NOT DISTINCT FROM p_key
     AND g.ref_id IS NOT DISTINCT FROM p_ref
     AND g.target_id IS NOT DISTINCT FROM p_target
     AND g.detail IS NOT DISTINCT FROM p_detail
  RETURNING g.id, g.actor, g.session_id, g.assertion
    INTO v_id, v_actor, v_session, v_assertion;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-70: no valid payout grant for this step'
      USING ERRCODE = '42501';
  END IF;
  grant_id := v_id;
  actor := v_actor;
  session_id := v_session;
  assertion := v_assertion;
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_grant_consume(uuid, text, text, text, uuid, uuid[], varchar, uuid, uuid, varchar) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- app.payout_attest (0426 body, same signature). New: the batch freeze check is
-- the first statement.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- app.payout_run_settle (0657 body, same signature). New: a frozen batch does
-- not settle its run; the check follows the batch load.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_run_settle(p_batch uuid, p_zero_net uuid[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_run_status text;
  v_zero uuid[] := COALESCE(p_zero_net, '{}'::uuid[]);
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-77: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.payout_batch_assert_open(v_tenant, p_batch);
  -- A run is not settled while ANY batch of it is frozen (read only on the
  -- others: their rows are not locked here).
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches o
     WHERE o.tenant_id = v_tenant AND o.payroll_run_id = v_batch.payroll_run_id
       AND o.id <> p_batch
       AND app.payout_batch_frozen(v_tenant, o.id)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-79: a payout batch of this run is frozen, a dispute on it is open'
      USING ERRCODE = '23514';
  END IF;
  SELECT r.status INTO v_run_status
    FROM public.payroll_runs r
   WHERE r.tenant_id = v_tenant AND r.id = v_batch.payroll_run_id
     FOR UPDATE;
  IF NOT FOUND OR v_run_status <> 'locked' THEN
    RETURN false;
  END IF;
  -- paid_by is the last approver of the batch: no approver, no paid run.
  IF v_batch.approved_by IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payslips s
     WHERE s.tenant_id = v_tenant AND s.payroll_run_id = v_batch.payroll_run_id
  ) THEN
    RETURN false;
  END IF;
  -- Every payslip has a succeeded item. The one exception is a payslip of net
  -- zero or less (the caller read the sealed net) with no item at all and no
  -- reconciliation exception.
  IF EXISTS (
    SELECT 1 FROM public.payslips s
     WHERE s.tenant_id = v_tenant AND s.payroll_run_id = v_batch.payroll_run_id
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_disbursement_items i
          WHERE i.tenant_id = s.tenant_id AND i.payslip_id = s.id
            AND i.status = 'succeeded')
       AND NOT (
         s.id = ANY (v_zero)
         AND NOT EXISTS (
           SELECT 1 FROM public.payroll_disbursement_items i
            WHERE i.tenant_id = s.tenant_id AND i.payslip_id = s.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.payroll_payout_recon_exceptions e
            WHERE e.tenant_id = s.tenant_id AND e.payslip_id = s.id))
  ) THEN
    RETURN false;
  END IF;
  -- L3: a payment of the run is still open.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.payroll_run_id = v_batch.payroll_run_id
       AND b.status IN ('pending_approval', 'approved', 'sending', 'exported')
  ) OR EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.payroll_run_id = v_batch.payroll_run_id
       AND i.status IN ('approved', 'sending', 'exported', 'unknown')
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.payroll_runs
     SET status = 'paid', paid_at = v_now, paid_by = v_batch.approved_by, updated_at = v_now
   WHERE tenant_id = v_tenant AND id = v_batch.payroll_run_id AND status = 'locked';
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_run_settle(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_run_settle(uuid, uuid[]) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
