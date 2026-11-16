-- legend-xp8mc (934): the main approval of a payout batch needs a grant.
-- Until now only the later payout steps (0420 to 0429) spent a one-time step-up
-- grant; approveDisbursementBatch (pending_approval -> approved) did not, so a
-- main approval left no row in the approval log and the approver could not say
-- "not me" (0427). A second person still approves (the requester cannot); the
-- rule of two people is unchanged. No new table: the grant, the attestation and
-- the log row are the ones of 0419, 0420 and 0426.
-- 1. Kind 'batch_approve' (step approve, detail NULL, batch = the batch) is
--    allowed in payroll_payout_grants, payroll_payout_attestations and
--    payroll_payout_recon_exceptions (kind checks, as 0421). The detail check
--    of the grants already says NULL for every kind but four, so it is kept.
-- 2. app.payout_grant_issue (0429 body): also issues (batch_approve, approve).
--    The batch is required, waits for approval (pending_approval), is not frozen
--    (the read-only check that every kind has) and was not requested by the
--    actor (PAYOUT-16, 23514).
-- 3. app.payout_batch_approve_attest(batch, grant) RETURNS uuid (new, as
--    app.payout_bank_confirm of 0422): spends the grant (run row, then batch
--    row lock, as 0429), asserts the actor (payroll.disburse.approve), refuses
--    the requester (PAYOUT-16) and any batch that is not pending_approval
--    (PAYOUT-83), then app.payout_attest writes the attestation and the
--    append-only log row (kind batch_approve, item_count = items of the
--    batch). Returns the grant id. EXECUTE for legend_app only.
-- 4. Trigger payroll_disbursement_batches_approve_grant_trg (BEFORE UPDATE,
--    status pending_approval -> approved): the change needs a consumed
--    batch_approve grant of the same tenant and batch, spent in this very
--    transaction by the actor that becomes approved_by, else PAYOUT-83 (23514).
--    So plain SQL cannot approve a batch without the grant either. It reads
--    only the columns legend_app may read; SECURITY DEFINER, owned by the
--    migrator like the other table guards. It fires before the freeze (0428),
--    guard (0344) and source freeze (0355) triggers (trigger name order).
-- 5. app.payout_recon_flag (0421 body): also accepts kind batch_approve.
-- Error codes: PAYOUT-83 (23514) the batch approval needs its consumed grant,
-- or the batch is not waiting for approval.
-- Ownership: the migrator holds no INHERIT on the payout role, so the functions
-- are created as the role itself: grant, become, work, return, revoke (as
-- 0429); constraint and trigger DDL runs as the migrator.
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_kind_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'disown', 'unfreeze'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" DROP CONSTRAINT "payroll_payout_attestations_kind_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD CONSTRAINT "payroll_payout_attestations_kind_check" CHECK ("payroll_payout_attestations"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_exceptions" DROP CONSTRAINT "payroll_payout_recon_exceptions_kind_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_exceptions" ADD CONSTRAINT "payroll_payout_recon_exceptions_kind_check" CHECK ("payroll_payout_recon_exceptions"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve'));
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.payout_grant_issue(
  p_kind text, p_step text, p_batch uuid, p_item_ids uuid[], p_key varchar,
  p_ref uuid, p_target uuid, p_detail varchar, p_actor text, p_session text,
  p_method text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_assertion jsonb;
  v_secret text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_status varchar;
  v_requester text;
BEGIN
  IF NOT ((p_kind = 'correction' AND p_step IN ('propose', 'approve', 'withdraw'))
       OR (p_kind = 'overpaid' AND p_step IN ('propose', 'record', 'withdraw'))
       OR (p_kind = 'return' AND p_step IN ('propose', 'confirm'))
       OR (p_kind = 'closure' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'posting_source' AND p_step = 'record')
       OR (p_kind = 'resolve' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'bank_confirm' AND p_step = 'record')
       OR (p_kind = 'disown' AND p_step = 'record')
       OR (p_kind = 'unfreeze' AND p_step = 'approve')
       OR (p_kind = 'batch_approve' AND p_step = 'approve')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  -- The detail of a grant: the outcome for resolve, 'succeeded' for a bank
  -- confirmation, the sha256 (hex) of the reason for disown and unfreeze,
  -- nothing for every other kind (the table CHECK says the same).
  IF NOT ((p_kind = 'resolve' AND p_detail IN ('failed', 'not_sent'))
       OR (p_kind = 'bank_confirm' AND p_detail = 'succeeded')
       OR (p_kind IN ('disown', 'unfreeze') AND p_detail ~ '^[0-9a-f]{64}$')
       OR (p_kind NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze') AND p_detail IS NULL)) THEN
    RAISE EXCEPTION 'PAYOUT-72: the detail of this payout grant is not valid for its kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('password', 'mfa_challenge') THEN
    RAISE EXCEPTION 'PAYOUT-72: unknown step-up method for a payout grant'
      USING ERRCODE = '22023';
  END IF;
  -- Unfreeze is password only as well (PAYOUT-72): the one exception of the
  -- unfreeze rules (the disputant withdrawing their own claim) then always
  -- rests on a fresh password, never on an MFA challenge alone.
  IF p_kind = 'unfreeze' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: an unfreeze grant needs a password step-up'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'disown' THEN
    -- Password only, no payroll permission and no MFA age: a revoked approver
    -- can still say "not me". The ref is the log row, which must be this
    -- actor's own on this batch.
    IF p_method <> 'password' THEN
      RAISE EXCEPTION 'PAYOUT-72: a disown grant needs a password step-up'
        USING ERRCODE = '22023';
    END IF;
    v_assertion := app.payout_assert_session(v_tenant, p_actor, p_session);
    IF p_batch IS NULL OR p_ref IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.payroll_payout_approval_log l
       WHERE l.tenant_id = v_tenant AND l.id = p_ref
         AND l.actor = p_actor AND l.batch_id = p_batch
    ) THEN
      RAISE EXCEPTION 'PAYOUT-81: only the actor of an approval log row of this batch can disown it'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
    IF p_kind = 'unfreeze' THEN
      IF p_batch IS NULL OR NOT EXISTS (
        SELECT 1
          FROM public.role_assignments ra
          JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         WHERE ra.tenant_id = v_tenant AND ra.user_id = p_actor
           AND ra.scope_type = 'tenant'
           AND ra.valid_from <= v_now
           AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
           AND r.template_key IN ('owner', 'finance')
      ) THEN
        RAISE EXCEPTION 'PAYOUT-82: only a tenant-wide owner or finance role can unfreeze a batch'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF p_batch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-72: the batch of a payout grant is not in the tenant'
      USING ERRCODE = '22023';
  END IF;
  -- The main approval of a batch (PAYOUT-83): the grant names one batch that
  -- waits for approval, and its requester cannot hold it (PAYOUT-16).
  IF p_kind = 'batch_approve' THEN
    IF p_batch IS NULL THEN
      RAISE EXCEPTION 'PAYOUT-72: a batch approval grant needs a batch'
        USING ERRCODE = '22023';
    END IF;
    SELECT b.status, b.requested_by INTO v_status, v_requester
      FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch;
    IF v_requester IS NOT DISTINCT FROM p_actor THEN
      RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot approve it'
        USING ERRCODE = '23514';
    END IF;
    IF v_status IS DISTINCT FROM 'pending_approval' THEN
      RAISE EXCEPTION 'PAYOUT-72: only a batch that waits for approval can get an approval grant'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  -- No grant for a frozen batch (PAYOUT-79), for every kind but the two that
  -- end a freeze or start one. Read only: the grantor connection must not wait
  -- on a batch lock of the request it serves. Consume checks again, locked.
  IF p_kind NOT IN ('disown', 'unfreeze') THEN
    PERFORM app.payout_batch_assert_open_nolock(v_tenant, p_batch);
  END IF;
  v_secret := pg_catalog.encode(
    pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
      || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 'hex');
  INSERT INTO public.payroll_payout_grants (
    tenant_id, secret_sha256, kind, step, batch_id, item_set_hash, evidence_key,
    ref_id, target_id, detail, actor, session_id, step_up_method, assertion,
    issued_at, expires_at)
  VALUES (
    v_tenant,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(v_secret, 'hex')), 'hex'),
    p_kind, p_step, p_batch,
    app.payout_item_set_hash(COALESCE(p_item_ids, '{}'::uuid[])),
    p_key, p_ref, p_target, p_detail, p_actor, p_session, p_method, v_assertion,
    v_now, v_now + interval '2 minutes');
  RETURN v_secret;
END $$;
--> statement-breakpoint

CREATE FUNCTION app.payout_batch_approve_attest(p_batch uuid, p_grant text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
BEGIN
  -- Consume takes the run row, then the batch row (0429), and refuses a frozen
  -- batch. The grant is spent before anything else is read.
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'batch_approve', 'approve', p_batch,
           NULL, NULL, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'PAYOUT-83: only a batch that waits for approval can be approved'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot approve it'
      USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(
    SELECT i.id
      FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch
     ORDER BY i.id);
  PERFORM app.payout_attest(v_tenant, 'batch_approve', pg_catalog.gen_random_uuid(), 'approve',
    p_batch, v_items, NULL, NULL, v_grant, v_assertion);
  RETURN v_grant;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_approve_attest(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_batch_approve_attest(uuid, text) TO legend_app;
--> statement-breakpoint

-- Nightly reconciliation flag: the 0421 body with batch_approve in the accepted
-- list. Signature and ACL stay.
CREATE OR REPLACE FUNCTION app.payout_recon_flag(
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
  IF p_kind IS NULL OR p_kind NOT IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve')
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
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint

CREATE FUNCTION app.payroll_disbursement_batches_approve_grant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.approved_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_grants g
     WHERE g.tenant_id = NEW.tenant_id AND g.batch_id = NEW.id
       AND g.kind = 'batch_approve' AND g.step = 'approve'
       AND g.consumed_txid = pg_catalog.txid_current()
       AND g.actor = NEW.approved_by
  ) THEN
    RAISE EXCEPTION 'PAYOUT-83: batch approval needs the consumed batch_approve grant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_disbursement_batches_approve_grant_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_batches_approve_grant_trg
  BEFORE UPDATE ON public.payroll_disbursement_batches
  FOR EACH ROW
  WHEN (OLD.status = 'pending_approval' AND NEW.status = 'approved')
  EXECUTE FUNCTION app.payroll_disbursement_batches_approve_grant_guard();
