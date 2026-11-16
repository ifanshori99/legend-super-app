-- legend-r86qa (911 wave 2), file 2 of 3: every move out of `exported` is made by
-- the payout role, inside a trusted function that spends a one-time grant (0653,
-- kinds `resolve` and `bank_confirm` from 0655).
-- - app.payout_resolve_propose / app.payout_resolve_approve: the two-person
--   resolution of an exported item to failed or not_sent (step one: the proposal
--   with its proof; step two: another person, the move out of `exported`).
-- - app.payout_bank_confirm: the bank payment record (exported -> succeeded).
-- - Item guard (0648 body with four changes only): (a) a new attempt is refused
--   for a payslip that has an overpaid attempt (PAYOUT-62; the service said so,
--   now the database does); (b) exported -> succeeded|failed|not_sent needs
--   current_user = 'legend_payout'; (c) the resolution record changes only for
--   the payout role, except the withdraw clear of the app role (PAYOUT-74); (d)
--   the bank payment record changes only for the payout role, except the cash
--   handover of the app role (PAYOUT-74).
-- - Privileges: the payout role may write the resolution columns and
--   failure_class; the app role loses resolved_by_2, failure_class,
--   confirmation_ref and confirmation_evidence_key. It keeps status,
--   confirmed_by and settled_at (cash handover), the four step-one columns
--   (withdraw clear, shape enforced by (c)) and gl_posting_id.
-- Error codes: PAYOUT-62 (23514) a recon exception or an overpaid attempt holds
-- the payslip; PAYOUT-64 (42501) the same person twice; PAYOUT-65 (23514) the
-- proof; PAYOUT-69 (P0002) batch not found; PAYOUT-71 (23514) step one of an
-- item carries no grant, propose again; PAYOUT-74 (23514) the guard; PAYOUT-76
-- (23514) arguments or state of the batch and items; PAYOUT-18 and PAYOUT-16
-- (23514) the batch requester. PAYOUT-70 (no valid grant, 42501) comes from
-- app.payout_grant_consume (0653). Every refusal leaves the items unchanged.
-- Ownership: as 0654, the functions are created by the payout role itself
-- (grant, become, work, return, revoke).
GRANT UPDATE (resolved_by, resolved_by_2, resolution_outcome, resolution_evidence_key, resolution_note, failure_class)
  ON TABLE public.payroll_disbursement_items TO legend_payout;
--> statement-breakpoint
REVOKE UPDATE (resolved_by_2, failure_class, confirmation_ref, confirmation_evidence_key)
  ON TABLE public.payroll_disbursement_items FROM legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The item guard: the 0648 body with the four changes above.
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
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Resolve, step one: the first person records the proposal on every item (the
-- item stays exported). Binding of the grant: kind resolve, step propose, batch,
-- item set, proof key, outcome. Returns the id of the operation (the attestation).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_resolve_propose(
  p_batch uuid, p_item_ids uuid[], p_outcome text, p_key varchar, p_note text, p_grant text
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
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'resolve', 'propose', p_batch,
           p_item_ids, p_key, NULL, NULL, p_outcome) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_outcome IS NULL OR p_outcome NOT IN ('failed', 'not_sent') THEN
    RAISE EXCEPTION 'PAYOUT-76: the outcome of a resolution is failed or not_sent'
      USING ERRCODE = '23514';
  END IF;
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items of a resolution must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 1 AND 500
    OR p_key IS NULL OR pg_catalog.char_length(p_key) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution needs a note and a proof key of 1 to 500 characters'
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
  IF v_batch.channel <> 'manual_bank' OR v_batch.status <> 'exported' THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution is only for an exported manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve its items'
      USING ERRCODE = '23514';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'exported'
     AND i.resolved_by IS NULL AND i.resolved_by_2 IS NULL
     AND i.resolution_outcome IS NULL AND i.resolution_evidence_key IS NULL;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: only exported items without a proposal can be proposed'
      USING ERRCODE = '23514';
  END IF;
  -- The proof was uploaded for this very batch and is not closed.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_evidence_files f
     WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key AND f.batch_id = p_batch
  ) OR app.payout_proof_key_closed(v_tenant, p_key) THEN
    RAISE EXCEPTION 'PAYOUT-65: the resolution needs an open proof uploaded for this batch'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET resolved_by = v_actor, resolution_outcome = p_outcome,
         resolution_evidence_key = p_key, resolution_note = p_note, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'exported' AND resolved_by IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items changed while the resolution was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'resolve', v_operation, 'propose', p_batch, v_items,
    p_key, NULL, v_grant, v_assertion);
  RETURN v_operation;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_resolve_propose(uuid, uuid[], text, varchar, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_resolve_propose(uuid, uuid[], text, varchar, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Resolve, step two: another person moves every item out of `exported` to the
-- outcome of the proposal. Binding of the grant: kind resolve, step approve,
-- batch, item set, proof key, outcome (a grant for failed cannot be spent on
-- not_sent). Returns the number of items moved.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_resolve_approve(
  p_batch uuid, p_item_ids uuid[], p_outcome text, p_key varchar, p_grant text
) RETURNS integer
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
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'resolve', 'approve', p_batch,
           p_item_ids, p_key, NULL, NULL, p_outcome) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_outcome IS NULL OR p_outcome NOT IN ('failed', 'not_sent') THEN
    RAISE EXCEPTION 'PAYOUT-76: the outcome of a resolution is failed or not_sent'
      USING ERRCODE = '23514';
  END IF;
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items of a resolution must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_key IS NULL OR pg_catalog.char_length(p_key) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution needs a proof key of 1 to 500 characters'
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
  IF v_batch.channel <> 'manual_bank' OR v_batch.status <> 'exported' THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution is only for an exported manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  -- Every item is exported with a step-one proposal of the same outcome.
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'exported'
     AND i.resolved_by IS NOT NULL AND i.resolved_by_2 IS NULL
     AND i.resolution_outcome = p_outcome;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: only exported items with a proposal of this outcome can be approved'
      USING ERRCODE = '23514';
  END IF;
  -- The proof is the one the first person recorded.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolution_evidence_key IS DISTINCT FROM p_key
  ) OR NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_evidence_files f
     WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key AND f.batch_id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded for this batch'
      USING ERRCODE = '23514';
  END IF;
  -- A closed key frees no slip: same refusal code as the item guard (0649).
  IF app.payout_proof_key_closed(v_tenant, p_key) THEN
    RAISE EXCEPTION 'PAYOUT-72: the payout proof key is closed, the payslip is not released for a new attempt'
      USING ERRCODE = '23514';
  END IF;
  -- Two different people, neither the requester of the batch.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolved_by = v_actor
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a resolution needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolved_by = v_batch.requested_by
  ) THEN
    RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve its items'
      USING ERRCODE = '23514';
  END IF;
  -- Step one was made under a grant of this outcome, by the person on the item.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_attestations a
           JOIN public.payroll_payout_grants gr
             ON gr.tenant_id = a.tenant_id AND gr.id = a.grant_id
          WHERE a.tenant_id = v_tenant AND a.kind = 'resolve' AND a.step = 'propose'
            AND a.grant_id IS NOT NULL
            AND a.batch_id = p_batch
            AND a.actor = i.resolved_by
            AND a.evidence_key = i.resolution_evidence_key
            AND i.id = ANY (a.item_ids)
            AND gr.detail = i.resolution_outcome)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this resolution has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;
  -- A payslip held by the reconciliation, or settled by hand as overpaid, is not
  -- freed for a new payment here.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND (EXISTS (
              SELECT 1 FROM public.payroll_payout_recon_exceptions e
               WHERE e.tenant_id = i.tenant_id AND e.payslip_id = i.payslip_id)
         OR EXISTS (
              SELECT 1 FROM public.payroll_disbursement_items o
               WHERE o.tenant_id = i.tenant_id AND o.payslip_id = i.payslip_id
                 AND o.status = 'overpaid'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-62: a payslip of these items is held back or settled as overpaid'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET resolved_by_2 = v_actor, status = p_outcome,
         failure_class = CASE WHEN p_outcome = 'failed' THEN 'definitive' END,
         updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'exported' AND resolved_by IS NOT NULL AND resolved_by_2 IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items changed while the resolution was approved'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'resolve', v_operation, 'approve', p_batch, v_items,
    p_key, NULL, v_grant, v_assertion);
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_resolve_approve(uuid, uuid[], text, varchar, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_resolve_approve(uuid, uuid[], text, varchar, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Bank confirmation: the bank payment record of exported items (exported ->
-- succeeded). Binding of the grant: kind bank_confirm, step record, batch, item
-- set, detail 'succeeded'. The references and proof keys are not bound (the
-- secret never leaves the API process); the actor, the batch and the item set
-- are. Not held by the reconciliation: the money already left. Returns the number
-- of items moved.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_bank_confirm(
  p_batch uuid, p_item_ids uuid[], p_refs text[], p_keys varchar[], p_grant text
) RETURNS integer
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
  v_key varchar;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'bank_confirm', 'record', p_batch,
           p_item_ids, NULL, NULL, NULL, 'succeeded') AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items of a confirmation must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_refs IS NULL OR p_keys IS NULL
    OR pg_catalog.cardinality(p_refs) <> pg_catalog.cardinality(p_item_ids)
    OR pg_catalog.cardinality(p_keys) <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-76: a confirmation needs one reference and one proof key (or NULL) per item'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_refs) AS r
     WHERE r IS NULL OR pg_catalog.char_length(pg_catalog.btrim(r)) NOT BETWEEN 1 AND 100
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_keys) AS k
     WHERE k IS NOT NULL AND pg_catalog.char_length(k) NOT BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'PAYOUT-76: a bank reference is 1 to 100 characters, a proof key at most 500'
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
  IF v_batch.channel <> 'manual_bank' OR v_batch.status <> 'exported' THEN
    RAISE EXCEPTION 'PAYOUT-76: a bank confirmation is only for an exported manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot confirm payment of its items'
      USING ERRCODE = '23514';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'exported';
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: only exported items of the batch can be confirmed'
      USING ERRCODE = '23514';
  END IF;
  -- Every proof a confirmation names was uploaded for this very batch.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_keys) AS k
     WHERE k IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_evidence_files f
        WHERE f.tenant_id = v_tenant AND f.evidence_key = k AND f.batch_id = p_batch)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: a confirmation proof was not uploaded for this batch'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items i
     SET status = 'succeeded', settled_at = v_now, confirmed_by = v_actor,
         confirmation_ref = pg_catalog.btrim(u.ref), confirmation_evidence_key = u.k,
         updated_at = v_now
    FROM ROWS FROM (pg_catalog.unnest(p_item_ids), pg_catalog.unnest(p_refs), pg_catalog.unnest(p_keys)) AS u(item_id, ref, k)
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = u.item_id
     AND i.status = 'exported';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items changed while the payment was confirmed'
      USING ERRCODE = '23514';
  END IF;
  -- The proof of the attestation: the one key all items share, else none.
  SELECT CASE WHEN pg_catalog.count(*) = pg_catalog.cardinality(p_keys)
              AND pg_catalog.count(DISTINCT k) = 1 THEN pg_catalog.min(k) END
    INTO v_key
    FROM pg_catalog.unnest(p_keys) AS k
   WHERE k IS NOT NULL;
  PERFORM app.payout_attest(v_tenant, 'bank_confirm', v_operation, 'record', p_batch, v_items,
    v_key, NULL, v_grant, v_assertion);
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_bank_confirm(uuid, uuid[], text[], varchar[], text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_bank_confirm(uuid, uuid[], text[], varchar[], text) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
