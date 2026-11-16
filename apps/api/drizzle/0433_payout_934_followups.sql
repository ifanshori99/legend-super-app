-- legend-s20iu and legend-dz8ci (947, follow-ups of 934): after "not me" on the
-- main approval the batch is reopened, and the approval columns cannot move
-- without the approval path.
-- 1. s20iu: app.payout_batch_unfreeze (0430 body). After the unfreeze rows are
--    written, a batch that is still approved and whose released dispute targets
--    its latest batch_approve log row goes back to pending_approval in the same
--    transaction: approved_by, approved_at, approval_expires_at and
--    source_bank_account_id are cleared, its approved items are prepared again.
--    Every other status is left alone (exported or paid money is not touched).
--    Exception: when an item is already past approved (cash handed over), the
--    batch is not reopened (it could never finish): its approved items become
--    not_sent and it closes partially_failed (as the cancel path), approval
--    columns unchanged.
--    The trace: the unfreeze row, its dispute and the append-only log row stay.
-- 2. Proof of the reopening. app.payout_unfreeze_revert_proof(tenant, batch) is
--    true only when payroll_payout_batch_unfreezes holds a row of this very
--    transaction (txid default txid_current(), a table only the payout role can
--    insert into) whose dispute points at the latest batch_approve log row of
--    the batch. No setting or session value is used, so legend_app cannot fake
--    it. The guards below accept the backward move only with that proof, from
--    the payout role, with nothing else changed: batch guard (PAYOUT-03 and
--    PAYOUT-04, 0344), source freeze (PAYOUT-07, 0355), item guard (PAYOUT-14,
--    0422), and the two freeze guards (0428: reopening only takes power away,
--    so an open dispute of a sibling batch does not stop it). The payout role
--    gets UPDATE on the five batch columns; the guards bound it.
-- 3. A new person approves again (PAYOUT-84, 42501): app.payout_grant_issue (0432
--    body) and app.payout_batch_approve_attest refuse anyone who has a dispute
--    on a batch_approve log row of the batch (app.payout_batch_approval_disowned_by),
--    besides the requester (PAYOUT-16). A batch whose dispute is not on a main
--    approval is not affected.
-- 4. dz8ci: trigger payroll_disbursement_batches_approval_cols_trg (BEFORE UPDATE,
--    any status, halted too): approved_by, approved_at, approval_expires_at or
--    source_bank_account_id change only (a) in the main approval, pending_approval
--    to approved with the batch_approve grant spent in this transaction by the new
--    approved_by, (b) when export freezes the source account of a batch approved
--    before 0355 (approved to exported, NULL to a value, approval unchanged), or
--    (c) in the reopening of item 1. Anything else is PAYOUT-83 (23514).
-- Error codes: PAYOUT-84 (42501) the disowner cannot approve again, PAYOUT-83
-- (23514) a change of the approval columns without its path.
-- Ownership: as 0432, the three payout functions are created by the payout role
-- itself (grant, become, work, return, revoke); guards, trigger and proof
-- function (SECURITY DEFINER) are owned by the migrator. No row is written and no
-- amount changes; the migration only blocks approvals and reopens one.
GRANT UPDATE (status, approved_by, approved_at, approval_expires_at, source_bank_account_id)
  ON TABLE public.payroll_disbursement_batches TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_unfreeze_revert_proof(p_tenant uuid, p_batch uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_batch_unfreezes u
      JOIN public.payroll_payout_batch_disputes d
        ON d.tenant_id = u.tenant_id AND d.id = u.dispute_id AND d.batch_id = u.batch_id
      JOIN public.payroll_payout_approval_log l
        ON l.tenant_id = d.tenant_id AND l.id = d.log_id AND l.batch_id = u.batch_id
     WHERE u.tenant_id = p_tenant AND u.batch_id = p_batch
       AND u.txid = pg_catalog.txid_current()
       AND l.kind = 'batch_approve'
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_payout_approval_log n
          WHERE n.tenant_id = l.tenant_id AND n.batch_id = l.batch_id
            AND n.kind = 'batch_approve'
            AND (n.logged_at, n.id) > (l.logged_at, l.id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_unfreeze_revert_proof(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_unfreeze_revert_proof(uuid, uuid) TO legend_app, legend_payout;
--> statement-breakpoint

CREATE FUNCTION app.payout_batch_approval_disowned_by(p_tenant uuid, p_batch uuid, p_actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_batch_disputes d
      JOIN public.payroll_payout_approval_log l
        ON l.tenant_id = d.tenant_id AND l.id = d.log_id
     WHERE d.tenant_id = p_tenant AND d.batch_id = p_batch AND d.actor = p_actor
       AND l.kind = 'batch_approve')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_approval_disowned_by(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_batch_approval_disowned_by(uuid, uuid, text) TO legend_app, legend_payout;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_disbursement_batches_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_entity uuid;
  target_text text;
  v_reopen boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'PAYOUT-01: a disbursement batch starts as a draft (got %)', NEW.status
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status, r.legal_entity_id INTO run_status, run_entity
      FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('locked', 'paid') THEN
      RAISE EXCEPTION 'PAYOUT-01: a disbursement batch needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    IF run_entity IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'PAYOUT-01: batch legal entity differs from the entity of run %', NEW.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    -- H1 (double pay): a bank or provider batch and the legacy bank file of the
    -- same run are mutually exclusive. The run row lock above serialises this
    -- with the bank file trigger below.
    IF NEW.channel <> 'cash' AND EXISTS (
      SELECT 1 FROM public.bank_transfer_files f
        WHERE f.tenant_id = NEW.tenant_id AND f.payroll_run_id = NEW.payroll_run_id
    ) THEN
      RAISE EXCEPTION 'PAYOUT-06: payroll run % already has a legacy bank transfer file and cannot also be paid by a payout batch', NEW.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYOUT-02: the identity of disbursement batch % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.totals_encrypted IS DISTINCT FROM OLD.totals_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version
  THEN
    -- Reseal bypass (PAYR-KEY, as 0248): the sealed totals and the key version
    -- move together, only inside the reseal job's transaction, only upward and
    -- never above the active version, with no other column changed. Valid for
    -- any status, including a final batch.
    IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
      IF OLD.status NOT IN ('draft', 'pending_approval') THEN
        RAISE EXCEPTION 'PAYOUT-04: the sealed totals of batch % are frozen after submission', OLD.id
          USING ERRCODE = '23514';
      END IF;
    ELSE
      target_text := current_setting('app.payroll_reseal_target_version', true);
      IF NEW.totals_encrypted IS NOT DISTINCT FROM OLD.totals_encrypted
        OR NEW.pii_key_version IS NOT DISTINCT FROM OLD.pii_key_version
        OR NEW.pii_key_version IS NULL
        OR NEW.pii_key_version <= OLD.pii_key_version
      THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % reseal must change the sealed totals and raise the key version together', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % key version is above the active key version', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF (to_jsonb(NEW) - 'updated_at' - 'totals_encrypted' - 'pii_key_version')
        IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'totals_encrypted' - 'pii_key_version') THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % reseal must not change any other column', OLD.id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF OLD.status IN ('completed', 'partially_failed', 'cancelled') THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'PAYOUT-02: disbursement batch % is final (%) and cannot change', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- (947) The one way back from approved: the unfreeze after "not me" on the main
  -- approval (app.payout_batch_unfreeze). The payout role only, the approval
  -- columns cleared and nothing else changed, with an unfreeze row of this
  -- transaction that releases a dispute of the latest batch_approve log row.
  IF OLD.status = 'approved' AND NEW.status = 'pending_approval'
    AND current_user = 'legend_payout'
    AND NEW.approved_by IS NULL AND NEW.approved_at IS NULL
    AND NEW.approval_expires_at IS NULL AND NEW.source_bank_account_id IS NULL
    AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'approved_by' - 'approved_at' - 'approval_expires_at' - 'source_bank_account_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'approved_by' - 'approved_at' - 'approval_expires_at' - 'source_bank_account_id') THEN
    v_reopen := app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.id);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sending', 'exported', 'completed', 'partially_failed', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'pending_approval' AND v_reopen)
    OR (OLD.status = 'sending' AND NEW.status IN ('completed', 'partially_failed', 'halted'))
    OR (OLD.status = 'exported' AND NEW.status IN ('completed', 'partially_failed'))
    OR (OLD.status = 'halted' AND NEW.status IN ('sending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-03: disbursement batch % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('draft', 'pending_approval', 'halted')
    AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'PAYOUT-04: the content hash of approved batch % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('pending_approval', 'halted') AND NOT v_reopen
    AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_expires_at IS DISTINCT FROM OLD.approval_expires_at) THEN
    RAISE EXCEPTION 'PAYOUT-04: batch % approval can only be recorded by the approval step', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.exported_at IS NOT NULL AND (
       NEW.exported_at IS DISTINCT FROM OLD.exported_at
    OR NEW.exported_by IS DISTINCT FROM OLD.exported_by
    OR NEW.export_checksum_sha256 IS DISTINCT FROM OLD.export_checksum_sha256) THEN
    RAISE EXCEPTION 'PAYOUT-05: the file of batch % was already exported', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
    AND NOT (OLD.status = 'approved' AND NEW.status = 'exported') THEN
    RAISE EXCEPTION 'PAYOUT-05: batch % can be exported only once, from approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_disbursement_batches_source_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.source_bank_account_id IS NOT DISTINCT FROM OLD.source_bank_account_id THEN
    RETURN NEW;
  END IF;
  -- (947) cleared only by the reopening of an approved batch (see the batch guard).
  IF NEW.source_bank_account_id IS NULL AND OLD.status = 'approved'
    AND NEW.status = 'pending_approval' AND current_user = 'legend_payout'
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  IF OLD.source_bank_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-07: the source bank account of batch % is frozen', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'PAYOUT-07: the source bank account of batch % can only be frozen at approve or export', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
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
    -- (911) a payslip with an overpaid attempt is settled by hand, never by a
    -- new attempt (the service said so; now the database does).
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items o
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND o.status = 'overpaid'
    ) THEN
      RAISE EXCEPTION 'PAYOUT-62: payslip % has an overpaid attempt and is settled by hand, never by a new attempt', NEW.payslip_id
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
  -- (947) approved -> prepared: only the reopening of its batch after "not me" on
  -- the main approval (app.payout_batch_unfreeze): the payout role, nothing but
  -- the status changes, the batch is pending_approval again, and an unfreeze row
  -- of this transaction releases a dispute of the batch_approve log row.
  IF OLD.status = 'approved' AND NEW.status = 'prepared'
    AND current_user = 'legend_payout'
    AND (to_jsonb(NEW) - 'updated_at' - 'status') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status')
    AND EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches rb
       WHERE rb.tenant_id = NEW.tenant_id AND rb.id = NEW.batch_id
         AND rb.status = 'pending_approval')
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.batch_id) THEN
    RETURN NEW;
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
      -- (911) out of `exported`: the payout role only (app.payout_bank_confirm,
      -- app.payout_resolve_approve), each under a one-time grant.
      OR (OLD.status = 'exported' AND NEW.status IN ('succeeded', 'failed', 'not_sent')
          AND current_user = 'legend_payout')
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
  -- (911) the resolution record is written by the payout role only
  -- (app.payout_resolve_propose / app.payout_resolve_approve, each under a
  -- grant). The one exception is the withdraw of a step-one proposal by the app
  -- role: all four step-one columns go to NULL at once, nothing else changes
  -- (this only lowers payout).
  IF (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
      OR NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2
      OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
      OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note)
    AND current_user IS DISTINCT FROM 'legend_payout'
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
    RAISE EXCEPTION 'PAYOUT-74: the resolution record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- (911) the bank payment record is written by the payout role only
  -- (app.payout_bank_confirm). The one exception is the cash handover by the app
  -- role: approved -> succeeded on a cash item, with no reference and no proof.
  IF (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
      OR NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
      OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key
      OR NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    AND current_user IS DISTINCT FROM 'legend_payout'
    AND NOT (
      OLD.status = 'approved' AND NEW.status = 'succeeded' AND NEW.channel = 'cash'
      AND NEW.confirmation_ref IS NULL
      AND NEW.confirmation_evidence_key IS NULL
    ) THEN
    RAISE EXCEPTION 'PAYOUT-74: the payment record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
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
CREATE OR REPLACE FUNCTION app.payroll_disbursement_batches_freeze_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- (947) the reopening only takes power away, so a sibling's freeze does not stop it.
  IF OLD.status = 'approved' AND NEW.status IN ('pending_approval', 'partially_failed')
    AND current_user = 'legend_payout'
    AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'approved_by' - 'approved_at' - 'approval_expires_at' - 'source_bank_account_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'approved_by' - 'approved_at' - 'approval_expires_at' - 'source_bank_account_id')
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  PERFORM app.payout_batch_assert_open_nolock(NEW.tenant_id, NEW.id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_freeze_guard() RETURNS trigger
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
  ELSIF OLD.status = 'approved' AND NEW.status IN ('prepared', 'not_sent')
    AND current_user = 'legend_payout'
    AND (to_jsonb(NEW) - 'updated_at' - 'status') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status')
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.batch_id) THEN
    -- (947) the reopening or the stop of the batch (see the batch freeze guard).
    RETURN NEW;
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
  -- waits for approval, and its requester (PAYOUT-16) and anyone who said "not
  -- me" to a main approval of it (PAYOUT-84) cannot hold it.
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
    IF app.payout_batch_approval_disowned_by(v_tenant, p_batch, p_actor) THEN
      RAISE EXCEPTION 'PAYOUT-84: the disowner of a batch approval cannot approve it again'
        USING ERRCODE = '42501';
    END IF;
    IF v_status IS DISTINCT FROM 'pending_approval' THEN
      RAISE EXCEPTION 'PAYOUT-83: only a batch that waits for approval can get an approval grant'
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

CREATE OR REPLACE FUNCTION app.payout_batch_approve_attest(p_batch uuid, p_grant text)
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
  IF app.payout_batch_approval_disowned_by(v_tenant, p_batch, v_actor) THEN
    RAISE EXCEPTION 'PAYOUT-84: the disowner of a batch approval cannot approve it again'
      USING ERRCODE = '42501';
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

CREATE OR REPLACE FUNCTION app.payout_batch_unfreeze(p_batch uuid, p_grant text, p_reason text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_template text;
  v_open integer;
  v_mine integer;
  v_involved boolean;
  v_rows integer;
  v_partial boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-82: an unfreeze needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'unfreeze', 'approve', p_batch,
           NULL, NULL, NULL, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(p_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  PERFORM app.payout_lock_run_of_batch(v_tenant, p_batch);
  -- Catch-up can recover a lower-id sibling after this function returns. Take
  -- every batch of the locked run in id order before taking the target row.
  PERFORM 1
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant
     AND b.payroll_run_id = (
       SELECT target.payroll_run_id
         FROM public.payroll_disbursement_batches target
        WHERE target.tenant_id = v_tenant AND target.id = p_batch)
   ORDER BY b.id
     FOR UPDATE;
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   ORDER BY (r.template_key = 'owner') DESC
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-82: only a tenant-wide owner or finance role can unfreeze a batch'
      USING ERRCODE = '23514';
  END IF;
  -- A claim is withdrawn only from the session that filed it: a stolen login
  -- of the disputant, on another session, cannot lift its own owner's freeze.
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (WHERE d.actor = v_actor AND d.session_id = v_session)
    INTO v_open, v_mine
    FROM public.payroll_payout_batch_disputes d
   WHERE d.tenant_id = v_tenant AND d.batch_id = p_batch
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_batch_unfreezes u
        WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id);
  IF v_open = 0 THEN
    RAISE EXCEPTION 'PAYOUT-82: the payout batch has no open dispute'
      USING ERRCODE = '23514';
  END IF;
  -- "Took part" covers every batch that shares a payslip with this one (the
  -- retry batch of the same pay, made before or after the claim), not only
  -- this batch: the person who asked for or approved the sibling batch moved
  -- the same pay.
  v_involved := EXISTS (
      WITH related AS (
        SELECT p_batch AS batch_id
        UNION
        SELECT sibling.batch_id
          FROM public.payroll_disbursement_items mine
          JOIN public.payroll_disbursement_items sibling
            ON sibling.tenant_id = mine.tenant_id
           AND sibling.payslip_id = mine.payslip_id
         WHERE mine.tenant_id = v_tenant AND mine.batch_id = p_batch
      )
      SELECT 1 FROM public.payroll_disbursement_batches rb
        JOIN related r ON r.batch_id = rb.id
       WHERE rb.tenant_id = v_tenant
         AND (rb.requested_by = v_actor OR rb.approved_by = v_actor
              OR rb.exported_by = v_actor)
      UNION ALL
      SELECT 1 FROM public.payroll_disbursement_items i
        JOIN related r ON r.batch_id = i.batch_id
       WHERE i.tenant_id = v_tenant
         AND (i.confirmed_by = v_actor OR i.resolved_by = v_actor
              OR i.resolved_by_2 = v_actor OR i.returned_by = v_actor
              OR i.returned_by_2 = v_actor)
      UNION ALL
      SELECT 1 FROM public.payroll_payout_approval_log l
        JOIN related r ON r.batch_id = l.batch_id
       WHERE l.tenant_id = v_tenant AND l.actor = v_actor
      UNION ALL
      -- Steps attested before the approval log existed (0426).
      SELECT 1 FROM public.payroll_payout_attestations att
        JOIN related r ON r.batch_id = att.batch_id
       WHERE att.tenant_id = v_tenant AND att.actor = v_actor
  );
  IF v_involved AND v_mine <> v_open THEN
    RAISE EXCEPTION 'PAYOUT-82: a person who took part in this batch cannot unfreeze it'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.payroll_payout_batch_unfreezes (
    tenant_id, batch_id, dispute_id, grant_id, actor, session_id, role_template, reason)
  SELECT v_tenant, p_batch, d.id, v_grant, v_actor, v_session, v_template, p_reason
    FROM public.payroll_payout_batch_disputes d
   WHERE d.tenant_id = v_tenant AND d.batch_id = p_batch
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_batch_unfreezes u
        WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- (947) "Not me" on the main approval: an approved batch goes back to waiting
  -- for approval, in this same transaction, so nothing can leave it before a new
  -- approval by a new person (PAYOUT-84). The approver, the time, the expiry and
  -- the source account are cleared, and its approved items are prepared again.
  -- A batch in any other status keeps it. The trace stays: the unfreeze row just
  -- written, its dispute and the append-only batch_approve log row.
  -- Cash already handed over (an item past approved, e.g. succeeded) cannot be
  -- taken back, and a reopened batch could never finish: the rule that limits
  -- payment applies, as in the cancel path: the approved items are stopped
  -- (not_sent), the batch closes partially_failed, the approval columns stay.
  IF v_batch.status = 'approved' AND app.payout_unfreeze_revert_proof(v_tenant, p_batch) THEN
    v_partial := EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
       WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch
         AND i.status NOT IN ('approved', 'prepared', 'cancelled'));
    IF v_partial THEN
      UPDATE public.payroll_disbursement_items i
         SET status = 'not_sent', updated_at = v_now
       WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.status = 'approved';
      UPDATE public.payroll_disbursement_batches b
         SET status = 'partially_failed', updated_at = v_now
       WHERE b.tenant_id = v_tenant AND b.id = p_batch AND b.status = 'approved';
    ELSE
      UPDATE public.payroll_disbursement_batches b
         SET status = 'pending_approval', approved_by = NULL, approved_at = NULL,
             approval_expires_at = NULL, source_bank_account_id = NULL, updated_at = v_now
       WHERE b.tenant_id = v_tenant AND b.id = p_batch AND b.status = 'approved';
      UPDATE public.payroll_disbursement_items i
         SET status = 'prepared', updated_at = v_now
       WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.status = 'approved';
    END IF;
  END IF;
  RETURN v_rows;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint

CREATE FUNCTION app.payroll_disbursement_batches_approval_cols_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- (a) the main approval, with the grant spent in this transaction.
  IF OLD.status = 'pending_approval' AND NEW.status = 'approved'
    AND NEW.approved_by IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.payroll_payout_grants g
       WHERE g.tenant_id = NEW.tenant_id AND g.batch_id = NEW.id
         AND g.kind = 'batch_approve' AND g.step = 'approve'
         AND g.consumed_txid = pg_catalog.txid_current()
         AND g.actor = NEW.approved_by
    ) THEN
    RETURN NEW;
  END IF;
  -- (b) export freezes the source account of a batch approved before 0355.
  IF OLD.status = 'approved' AND NEW.status = 'exported'
    AND OLD.source_bank_account_id IS NULL AND NEW.source_bank_account_id IS NOT NULL
    AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
    AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
    AND NEW.approval_expires_at IS NOT DISTINCT FROM OLD.approval_expires_at THEN
    RETURN NEW;
  END IF;
  -- (c) the reopening after "not me" (app.payout_batch_unfreeze). This function
  -- is SECURITY DEFINER, so current_user is its owner here: the proof carries it.
  IF OLD.status = 'approved' AND NEW.status = 'pending_approval'
    AND NEW.approved_by IS NULL AND NEW.approved_at IS NULL
    AND NEW.approval_expires_at IS NULL AND NEW.source_bank_account_id IS NULL
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-83: the approval of batch % can only change in the approval step', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_disbursement_batches_approval_cols_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_batches_approval_cols_trg
  BEFORE UPDATE ON public.payroll_disbursement_batches
  FOR EACH ROW
  WHEN (OLD.approved_by IS DISTINCT FROM NEW.approved_by
     OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
     OR OLD.approval_expires_at IS DISTINCT FROM NEW.approval_expires_at
     OR OLD.source_bank_account_id IS DISTINCT FROM NEW.source_bank_account_id)
  EXECUTE FUNCTION app.payroll_disbursement_batches_approval_cols_guard();
