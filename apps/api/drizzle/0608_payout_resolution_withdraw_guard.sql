-- Payout: withdraw a step-one resolve proposal (bead legend-5rh26; design
-- docs/design/payroll-disbursement.md 7.7). One guard change, no table change.
--
-- PAYOUT-18 refused any rewrite of a recorded resolution, so a proposal with a
-- wrong proof could never be finished nor replaced. The rewrite check now lets
-- exactly one move through: an exported item whose step one is recorded and
-- step two is not may have resolved_by, resolution_outcome,
-- resolution_evidence_key and resolution_note all set to NULL together, with
-- resolved_by_2, the status and every other column unchanged. The item stays
-- exported (same attempt, same idempotency key), so its payslip stays blocked.
-- Every other rewrite is still refused; the move to failed / not_sent still
-- needs two different non-requesters plus evidence.
--
-- CREATE OR REPLACE of the 0351 body with that change only; trigger unchanged.
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
    AND NOT (
      OLD.status = 'failed' AND NEW.status = 'overpaid'
      AND current_setting('app.payout_overpaid', true) IS NOT DISTINCT FROM 'on'
      AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'gl_posting_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'gl_posting_id')
    ) THEN
    RAISE EXCEPTION 'PAYOUT-12: disbursement item % is final (%) and cannot change', OLD.id, OLD.status
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
      OR (OLD.status = 'succeeded' AND NEW.status = 'returned')
      OR (OLD.status = 'failed' AND NEW.status = 'overpaid'
          AND current_setting('app.payout_overpaid', true) IS NOT DISTINCT FROM 'on'
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
