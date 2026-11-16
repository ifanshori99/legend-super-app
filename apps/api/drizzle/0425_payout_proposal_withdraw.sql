-- legend-xatux (915): withdraw an open correction / overpaid proposal.
-- A withdrawn proposal stays as a row (status `withdrawn`, withdrawn_by/at). The
-- item (payroll_disbursement_items) is not touched: its status, its live attempt
-- and the closed-key hold stay, so a payslip is never released to be paid twice.
-- Only the payout role writes: two trusted functions plus a one-time step grant
-- `withdraw`. The proof of a withdrawn proposal is spent for good (PAYOUT-75).
-- 1. Columns withdrawn_by/withdrawn_at on both proposal tables; overpaid status
--    becomes varchar(9); status and recorded/corrected CHECKs allow the third form;
--    UNIQUE (tenant, item) becomes a unique index over non-withdrawn rows.
-- 2. The two proposal guards (0633/0635) learn proposed -> withdrawn (payout role
--    only, every other column unchanged); withdrawn is final; INSERT must be an
--    open proposal on a proof that no withdrawn row holds.
-- 3. Closed-key hold: app.payout_proposal_closed_key_guard() (0647 body, but
--    proposed -> withdrawn on the same key may pass); the item guard (0649) holds
--    a payslip on a withdrawn proposal as on an open one.
-- 4. Grants and attestations accept step `withdraw`; app.payout_grant_issue (0655
--    body) gets correction/overpaid withdraw in the matrix.
-- 5. app.payout_correction_withdraw(operation, grant) and
--    app.payout_overpaid_withdraw(batch, items, key, grant), owner legend_payout,
--    EXECUTE for legend_app only. Step one needs no grant on the proposal and no
--    proof check, so an old or stuck proposal can still be withdrawn.
-- 6. payout_correction_propose, payout_overpaid_propose, payout_overpaid_record
--    (0654 bodies): reads per item skip withdrawn rows; a key held by a withdrawn
--    row is refused with PAYOUT-75.
-- The requester of the batch cannot withdraw (PAYOUT-64). Ownership: as 0654, the
-- functions are created by the payout role itself (grant, become, work, return,
-- revoke); table and trigger DDL runs as the migrator before that.
DROP TRIGGER IF EXISTS payroll_payout_failed_corrections_closed_key_trg ON public.payroll_payout_failed_corrections;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_overpaid_proposals_closed_key_trg ON public.payroll_payout_overpaid_proposals;
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" DROP CONSTRAINT "payroll_payout_failed_corrections_item_key";
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" DROP CONSTRAINT "payroll_payout_overpaid_proposals_item_key";
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" DROP CONSTRAINT "payroll_payout_attestations_step_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" DROP CONSTRAINT "payroll_payout_failed_corrections_status_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" DROP CONSTRAINT "payroll_payout_failed_corrections_corrected_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_step_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" DROP CONSTRAINT "payroll_payout_overpaid_proposals_status_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" DROP CONSTRAINT "payroll_payout_overpaid_proposals_recorded_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" ALTER COLUMN "status" SET DATA TYPE varchar(9);
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" ADD COLUMN "withdrawn_by" text;
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" ADD COLUMN "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" ADD COLUMN "withdrawn_by" text;
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" ADD COLUMN "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_failed_corrections_item_live_key" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","item_id") WHERE "payroll_payout_failed_corrections"."status" <> 'withdrawn';
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_overpaid_proposals_item_live_key" ON "payroll_payout_overpaid_proposals" USING btree ("tenant_id","item_id") WHERE "payroll_payout_overpaid_proposals"."status" <> 'withdrawn';
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD CONSTRAINT "payroll_payout_attestations_step_check" CHECK ("payroll_payout_attestations"."step" IN ('propose', 'approve', 'record', 'confirm', 'withdraw'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" ADD CONSTRAINT "payroll_payout_failed_corrections_status_check" CHECK ("payroll_payout_failed_corrections"."status" IN ('proposed', 'corrected', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_failed_corrections" ADD CONSTRAINT "payroll_payout_failed_corrections_corrected_check" CHECK (("payroll_payout_failed_corrections"."status" = 'proposed' AND "payroll_payout_failed_corrections"."corrected_by" IS NULL AND "payroll_payout_failed_corrections"."corrected_at" IS NULL AND "payroll_payout_failed_corrections"."withdrawn_by" IS NULL AND "payroll_payout_failed_corrections"."withdrawn_at" IS NULL) OR ("payroll_payout_failed_corrections"."status" = 'corrected' AND "payroll_payout_failed_corrections"."corrected_by" IS NOT NULL AND "payroll_payout_failed_corrections"."corrected_at" IS NOT NULL AND "payroll_payout_failed_corrections"."corrected_by" <> "payroll_payout_failed_corrections"."proposed_by" AND "payroll_payout_failed_corrections"."withdrawn_by" IS NULL AND "payroll_payout_failed_corrections"."withdrawn_at" IS NULL) OR ("payroll_payout_failed_corrections"."status" = 'withdrawn' AND "payroll_payout_failed_corrections"."corrected_by" IS NULL AND "payroll_payout_failed_corrections"."corrected_at" IS NULL AND "payroll_payout_failed_corrections"."withdrawn_by" IS NOT NULL AND "payroll_payout_failed_corrections"."withdrawn_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_step_check" CHECK ("payroll_payout_grants"."step" IN ('propose', 'approve', 'record', 'confirm', 'withdraw'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" ADD CONSTRAINT "payroll_payout_overpaid_proposals_status_check" CHECK ("payroll_payout_overpaid_proposals"."status" IN ('proposed', 'recorded', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_overpaid_proposals" ADD CONSTRAINT "payroll_payout_overpaid_proposals_recorded_check" CHECK (("payroll_payout_overpaid_proposals"."status" = 'proposed' AND "payroll_payout_overpaid_proposals"."recorded_by" IS NULL AND "payroll_payout_overpaid_proposals"."recorded_at" IS NULL AND "payroll_payout_overpaid_proposals"."withdrawn_by" IS NULL AND "payroll_payout_overpaid_proposals"."withdrawn_at" IS NULL) OR ("payroll_payout_overpaid_proposals"."status" = 'recorded' AND "payroll_payout_overpaid_proposals"."recorded_by" IS NOT NULL AND "payroll_payout_overpaid_proposals"."recorded_at" IS NOT NULL AND "payroll_payout_overpaid_proposals"."recorded_by" <> "payroll_payout_overpaid_proposals"."proposed_by" AND "payroll_payout_overpaid_proposals"."withdrawn_by" IS NULL AND "payroll_payout_overpaid_proposals"."withdrawn_at" IS NULL) OR ("payroll_payout_overpaid_proposals"."status" = 'withdrawn' AND "payroll_payout_overpaid_proposals"."recorded_by" IS NULL AND "payroll_payout_overpaid_proposals"."recorded_at" IS NULL AND "payroll_payout_overpaid_proposals"."withdrawn_by" IS NOT NULL AND "payroll_payout_overpaid_proposals"."withdrawn_at" IS NOT NULL));
--> statement-breakpoint
-- Guards (migrator-owned, invoker rights as in 0633/0635).
CREATE OR REPLACE FUNCTION app.payroll_payout_failed_corrections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' AND NEW.corrected_by IS NULL AND NEW.corrected_at IS NULL
      AND NEW.withdrawn_by IS NULL AND NEW.withdrawn_at IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.payroll_payout_failed_corrections w
         WHERE w.tenant_id = NEW.tenant_id AND w.evidence_key = NEW.evidence_key
           AND w.status = 'withdrawn') THEN
        RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PAYOUT-34: failed correction % must start as an open proposal', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'corrected'
    AND NEW.corrected_by IS NOT NULL AND NEW.corrected_by <> OLD.proposed_by
    AND NEW.corrected_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'corrected_by' - 'corrected_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'corrected_by' - 'corrected_at') THEN
    RETURN NEW;
  END IF;
  -- 915: withdrawn, by the payout role only; every other column stays as it was.
  IF OLD.status = 'proposed' AND NEW.status = 'withdrawn'
    AND current_user = 'legend_payout'
    AND NEW.withdrawn_by IS NOT NULL AND NEW.withdrawn_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'withdrawn_by' - 'withdrawn_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_by' - 'withdrawn_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed'
    AND (to_jsonb(NEW) - 'evidence_key' - 'content_sha256' - 'stored_sha256' - 'note' - 'proposed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'evidence_key' - 'content_sha256' - 'stored_sha256' - 'note' - 'proposed_at') THEN
    IF NEW.evidence_key IS DISTINCT FROM OLD.evidence_key AND EXISTS (
        SELECT 1 FROM public.payroll_payout_failed_corrections w
         WHERE w.tenant_id = NEW.tenant_id AND w.evidence_key = NEW.evidence_key
           AND w.status = 'withdrawn') THEN
      RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-34: failed correction % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_overpaid_proposals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' AND NEW.recorded_by IS NULL AND NEW.recorded_at IS NULL
      AND NEW.withdrawn_by IS NULL AND NEW.withdrawn_at IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.payroll_payout_overpaid_proposals w
         WHERE w.tenant_id = NEW.tenant_id AND w.evidence_key = NEW.evidence_key
           AND w.status = 'withdrawn') THEN
        RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PAYOUT-33: overpaid proposal % must start as an open proposal', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'recorded'
    AND NEW.recorded_by IS NOT NULL AND NEW.recorded_by <> OLD.proposed_by
    AND NEW.recorded_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'recorded_by' - 'recorded_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'recorded_by' - 'recorded_at') THEN
    RETURN NEW;
  END IF;
  -- 915: withdrawn, by the payout role only; every other column stays as it was.
  IF OLD.status = 'proposed' AND NEW.status = 'withdrawn'
    AND current_user = 'legend_payout'
    AND NEW.withdrawn_by IS NOT NULL AND NEW.withdrawn_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'withdrawn_by' - 'withdrawn_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_by' - 'withdrawn_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed'
    AND (to_jsonb(NEW) - 'evidence_key' - 'note' - 'proposed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'evidence_key' - 'note' - 'proposed_at') THEN
    IF NEW.evidence_key IS DISTINCT FROM OLD.evidence_key AND EXISTS (
        SELECT 1 FROM public.payroll_payout_overpaid_proposals w
         WHERE w.tenant_id = NEW.tenant_id AND w.evidence_key = NEW.evidence_key
           AND w.status = 'withdrawn') THEN
      RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-33: overpaid proposal % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_overpaid_proposals_guard_trg ON public.payroll_payout_overpaid_proposals;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_overpaid_proposals_guard_trg
  BEFORE INSERT OR UPDATE ON public.payroll_payout_overpaid_proposals
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_overpaid_proposals_guard();
--> statement-breakpoint

-- Closed-key hold. A proposal moves proposed -> withdrawn on its own key even when
-- the key was closed since; every other insert or change keeps the 0647 test.
CREATE OR REPLACE FUNCTION app.payout_proposal_closed_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'proposed' AND NEW.status = 'withdrawn'
    AND NEW.evidence_key IS NOT DISTINCT FROM OLD.evidence_key THEN
    RETURN NEW;
  END IF;
  IF app.payout_proof_key_closed(NEW.tenant_id, NEW.evidence_key) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payout proof key is closed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proposal_closed_key_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_failed_corrections_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_failed_corrections
  FOR EACH ROW EXECUTE FUNCTION app.payout_proposal_closed_key_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_overpaid_proposals_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_overpaid_proposals
  FOR EACH ROW EXECUTE FUNCTION app.payout_proposal_closed_key_guard();
--> statement-breakpoint

-- Item guard: the 0649 body; a withdrawn proposal on a closed key holds the slip
-- like an open one.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_closed_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.resolution_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.resolution_evidence_key))
    OR (NEW.confirmation_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.confirmation_evidence_key))
    OR (NEW.return_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.return_evidence_key)) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payout proof key is closed'
      USING ERRCODE = '23514';
  END IF;
  -- (0649, PAYOUT-72) a closed resolution key frees no slip: the item does not
  -- leave `exported` for failed / not_sent on it, whatever column changed.
  IF TG_OP = 'UPDATE'
    AND NEW.status IN ('failed', 'not_sent')
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NEW.resolution_evidence_key IS NOT NULL
    AND app.payout_proof_key_closed(NEW.tenant_id, NEW.resolution_evidence_key) THEN
    RAISE EXCEPTION 'PAYOUT-72: the payout proof key is closed, the payslip is not released for a new attempt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (
    EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_items o
        JOIN public.payroll_payout_failed_corrections c
          ON c.tenant_id = o.tenant_id AND c.item_id = o.id
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND c.status IN ('proposed', 'withdrawn')
         AND app.payout_proof_key_closed(c.tenant_id, c.evidence_key))
    OR EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_items o
        JOIN public.payroll_payout_overpaid_proposals p
          ON p.tenant_id = o.tenant_id AND p.item_id = o.id
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND p.status IN ('proposed', 'withdrawn')
         AND app.payout_proof_key_closed(p.tenant_id, p.evidence_key))) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payslip has an open proposal on a closed proof key'
      USING ERRCODE = '23514';
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

-- Issue a grant (grantor only): the 0655 body with `withdraw` in the matrix.
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
BEGIN
  IF NOT ((p_kind = 'correction' AND p_step IN ('propose', 'approve', 'withdraw'))
       OR (p_kind = 'overpaid' AND p_step IN ('propose', 'record', 'withdraw'))
       OR (p_kind = 'return' AND p_step IN ('propose', 'confirm'))
       OR (p_kind = 'closure' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'posting_source' AND p_step = 'record')
       OR (p_kind = 'resolve' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'bank_confirm' AND p_step = 'record')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  -- The detail of a grant: the outcome for resolve, 'succeeded' for a bank
  -- confirmation, nothing for every other kind (the table CHECK says the same).
  IF NOT ((p_kind = 'resolve' AND p_detail IN ('failed', 'not_sent'))
       OR (p_kind = 'bank_confirm' AND p_detail = 'succeeded')
       OR (p_kind NOT IN ('resolve', 'bank_confirm') AND p_detail IS NULL)) THEN
    RAISE EXCEPTION 'PAYOUT-72: the detail of this payout grant is not valid for its kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('password', 'mfa_challenge') THEN
    RAISE EXCEPTION 'PAYOUT-72: unknown step-up method for a payout grant'
      USING ERRCODE = '22023';
  END IF;
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  IF p_batch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-72: the batch of a payout grant is not in the tenant'
      USING ERRCODE = '22023';
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

-- Step one of a correction and of an overpaid record, and step two of an overpaid record: the 0654 bodies; live rows only, a spent proof refused.
CREATE OR REPLACE FUNCTION app.payout_correction_propose(
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
  -- 915: the proof of a withdrawn proposal is spent for good.
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.evidence_key = p_key AND c.status = 'withdrawn'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'correction', p_batch, v_items, p_key);
  SELECT f.content_sha256, f.stored_sha256 INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key;

  SELECT pg_catalog.count(*) INTO v_existing
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items) AND c.status <> 'withdrawn';
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
     WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items) AND c.status <> 'withdrawn'
     ORDER BY c.item_id
       FOR UPDATE;
    SELECT pg_catalog.min(c.operation_id::text)::uuid INTO v_op
      FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items) AND c.status <> 'withdrawn';
    IF (SELECT pg_catalog.count(DISTINCT c.operation_id)
          FROM public.payroll_payout_failed_corrections c
         WHERE c.tenant_id = v_tenant AND c.item_id = ANY (v_items) AND c.status <> 'withdrawn') <> 1
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
CREATE OR REPLACE FUNCTION app.payout_overpaid_propose(
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
  -- 915: the proof of a withdrawn proposal is spent for good.
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.evidence_key = p_key AND p.status = 'withdrawn'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'overpaid', p_batch, v_items, p_key);

  SELECT pg_catalog.count(*) INTO v_existing
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'withdrawn';
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
     WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'withdrawn'
     ORDER BY p.item_id
       FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'withdrawn' AND p.status <> 'proposed') THEN
      RAISE EXCEPTION 'PAYOUT-63: the double payment of this item is already recorded'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'withdrawn' AND p.proposed_by <> v_actor) THEN
      RAISE EXCEPTION 'PAYOUT-64: only the proposer replaces an open overpaid proposal'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.payroll_payout_overpaid_proposals p
       WHERE p.tenant_id = v_tenant AND p.item_id = ANY (v_items) AND p.status <> 'withdrawn' AND p.evidence_key = p_key) THEN
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
CREATE OR REPLACE FUNCTION app.payout_overpaid_record(
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
  -- 915: the proof of a withdrawn proposal is spent for good.
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.evidence_key = p_key AND p.status = 'withdrawn'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-75: this proof belonged to a withdrawn proposal and cannot be used again'
      USING ERRCODE = '23514';
  END IF;
  SELECT p.* INTO v_proposal
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.item_id = p_item AND p.status <> 'withdrawn'
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

-- ---------------------------------------------------------------------------
-- Withdraw a correction proposal (the whole operation). The grant binds the
-- batch, the item set, the key and the operation as its ref. Needs no grant on
-- the proposal and no proof check. Returns how many proposals were withdrawn.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_correction_withdraw(
  p_operation uuid, p_grant text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_key varchar;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_moved integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT c.batch_id, c.evidence_key INTO v_batch_id, v_key
    FROM public.payroll_payout_failed_corrections c
   WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
   ORDER BY (c.id = p_operation) DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: correction not found' USING ERRCODE = 'P0002';
  END IF;
  v_items := ARRAY(
    SELECT c.item_id FROM public.payroll_payout_failed_corrections c
     WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation ORDER BY c.item_id);
  v_n := pg_catalog.cardinality(v_items);
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'correction', 'withdraw', v_batch_id,
           v_items, v_key, p_operation, NULL, NULL) AS g;
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
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a correction is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot withdraw its correction'
      USING ERRCODE = '42501';
  END IF;
  IF (SELECT pg_catalog.count(*)
        FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = v_tenant AND c.operation_id = p_operation
         AND c.batch_id = v_batch_id AND c.status = 'proposed') <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction is not an open proposal' USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_payout_failed_corrections
     SET status = 'withdrawn', withdrawn_by = v_actor, withdrawn_at = v_now
   WHERE tenant_id = v_tenant AND operation_id = p_operation AND status = 'proposed';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the correction changed while it was withdrawn' USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'correction', p_operation, 'withdraw', v_batch_id, v_items,
    v_key, NULL, v_grant, v_assertion);
  RETURN v_moved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_correction_withdraw(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_correction_withdraw(uuid, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Withdraw an overpaid proposal group: every non-withdrawn proposal of (batch,
-- key) must be exactly the given items and all still open. The grant binds the
-- batch, the item set and the key (no ref). Returns how many were withdrawn.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_overpaid_withdraw(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_grant text
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
  v_live uuid[];
  v_op uuid;
  v_moved integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.batch_id = p_batch AND p.evidence_key = p_key
  ) THEN
    RAISE EXCEPTION 'PAYOUT-69: overpaid proposal not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'overpaid', 'withdraw', p_batch,
           p_item_ids, p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of an overpaid withdrawal must be a non-empty set of distinct items'
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
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  PERFORM p.id
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.batch_id = p_batch AND p.evidence_key = p_key
   ORDER BY p.item_id
     FOR UPDATE;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: an overpaid record is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot withdraw its overpaid proposal'
      USING ERRCODE = '42501';
  END IF;
  v_live := ARRAY(
    SELECT p.item_id FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.batch_id = p_batch AND p.evidence_key = p_key
       AND p.status <> 'withdrawn'
     ORDER BY p.item_id);
  IF pg_catalog.cardinality(v_live) = 0 OR NOT (v_live @> v_items AND v_live <@ v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items are not the open overpaid proposal of this proof'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_overpaid_proposals p
     WHERE p.tenant_id = v_tenant AND p.batch_id = p_batch AND p.evidence_key = p_key
       AND p.status NOT IN ('proposed', 'withdrawn')) THEN
    RAISE EXCEPTION 'PAYOUT-63: the overpaid proposal is not open any more' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.min(p.id::text)::uuid INTO v_op
    FROM public.payroll_payout_overpaid_proposals p
   WHERE p.tenant_id = v_tenant AND p.batch_id = p_batch AND p.evidence_key = p_key
     AND p.item_id = ANY (v_items);
  UPDATE public.payroll_payout_overpaid_proposals
     SET status = 'withdrawn', withdrawn_by = v_actor, withdrawn_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND evidence_key = p_key
     AND item_id = ANY (v_items) AND status = 'proposed';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: the overpaid proposal changed while it was withdrawn'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'overpaid', v_op, 'withdraw', p_batch, v_items,
    p_key, NULL, v_grant, v_assertion);
  RETURN v_moved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_overpaid_withdraw(uuid, uuid[], varchar, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_overpaid_withdraw(uuid, uuid[], varchar, text) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
