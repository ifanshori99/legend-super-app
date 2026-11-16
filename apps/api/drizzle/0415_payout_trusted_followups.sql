-- legend-kjht5 (905 architect review, 16 Nov; follow-ups a, b, c). Function
-- bodies only; no row is edited by this migration.
-- (a) PAYOUT-70, posting insert guard: the source account of a settlement of a
--     cash batch, or of a bank batch without a frozen account, is NULL, or an
--     account the payout role (app.payout_posting_record_source) wrote, or the
--     account the service itself would name at this moment: the petty cash
--     account mapped for the legal entity (cash), the GL account of the
--     configured source bank account (unfrozen bank). Before this, any account
--     could be INSERTed there and the settle journal check (0409) compared the
--     journal with that written account. The frozen-bank rule (0400) is kept.
-- (b) PAYOUT-71, correction commit check: the settlement posting of a corrected
--     item carries the item set hash of the items of its own correction
--     operation, so another settlement of the batch cannot stand in for it.
--     The formula of app.payout_item_set_hash is written inline: the check runs
--     as legend_app, which cannot execute the payout role's function. A
--     mismatch raises PAYOUT-71; the other reasons stay PAYOUT-67.
-- (c) PAYOUT-72, closed proof key: an item whose resolution key is closed
--     (0413) cannot move to failed / not_sent, which would free its payslip for
--     a new attempt. The 0413 guard only reacted when a key column changed.
-- PAYOUT-73 and PAYOUT-74 are not used by this migration.
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.settle_net_idr IS NULL OR NEW.fee_idr IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-36: payout GL posting % needs its plain net and fee', NEW.id
      USING ERRCODE = '23514';
  END IF;
  -- (F4, 0400) a settlement of a non-cash batch with a frozen bank account
  -- carries that account's GL account as its source; NULL or another is refused.
  IF NEW.kind IN ('settle', 'settle_pending', 'settle_skipped')
    AND EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
        JOIN public.bank_accounts ba
          ON ba.tenant_id = b.tenant_id
         AND ba.legal_entity_id = b.legal_entity_id
         AND ba.id = b.source_bank_account_id
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND ba.gl_account_id = NEW.source_gl_account_id) THEN
    RAISE EXCEPTION 'PAYOUT-36: payout GL posting % needs the frozen source account of its batch', NEW.id
      USING ERRCODE = '23514';
  END IF;
  -- (0415, PAYOUT-70) a settlement of a cash batch, or of a bank batch without a
  -- frozen account, names no source, or the payout role's, or the mapped one.
  IF NEW.kind IN ('settle', 'settle_pending', 'settle_skipped')
    AND NEW.source_gl_account_id IS NOT NULL
    AND current_user IS DISTINCT FROM 'legend_payout'
    AND NOT EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND (
           (b.channel = 'cash' AND EXISTS (
              SELECT 1
                FROM public.account_mappings m
               WHERE m.tenant_id = b.tenant_id AND m.legal_entity_id = b.legal_entity_id
                 AND m.role = 'petty_cash' AND m.account_id = NEW.source_gl_account_id))
           OR (b.channel <> 'cash' AND b.source_bank_account_id IS NULL AND EXISTS (
              SELECT 1
                FROM public.payroll_payout_configs c
                JOIN public.bank_accounts ba
                  ON ba.tenant_id = c.tenant_id
                 AND ba.legal_entity_id = c.legal_entity_id
                 AND ba.id = c.manual_source_bank_account_id
               WHERE c.tenant_id = b.tenant_id AND c.legal_entity_id = b.legal_entity_id
                 AND ba.gl_account_id = NEW.source_gl_account_id))
           OR (b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL))) THEN
    RAISE EXCEPTION 'PAYOUT-70: payout GL posting % names a source account that is not the mapped one', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_item_money_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  v_item public.payroll_disbursement_items%ROWTYPE;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_posting public.payroll_payout_gl_postings%ROWTYPE;
  v_reason text := NULL;
  v_code text := 'PAYOUT-67';
  v_hash text;
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
      -- (0415, PAYOUT-71) the posting is the settlement of THIS operation: its item
      -- set hash is the hash of the items of the operation (the formula of
      -- app.payout_item_set_hash, written inline: this check runs as legend_app).
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.string_agg(c.item_id::text, E'\n' ORDER BY c.item_id::text COLLATE "C"),
               'UTF8')), 'hex')
        INTO v_hash
        FROM public.payroll_payout_failed_corrections c
       WHERE c.tenant_id = NEW.tenant_id AND c.operation_id = v_operation;
      IF v_operation IS NULL OR v_hash IS NULL OR v_posting.item_set_hash IS DISTINCT FROM v_hash THEN
        v_reason := 'the settlement posting of the corrected item is not the settlement of its correction';
        v_code := 'PAYOUT-71';
      ELSE
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
    RAISE EXCEPTION '%: disbursement item % does not match its trusted record at commit: %', v_code, NEW.id, v_reason
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
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
  -- (0415, PAYOUT-72) a closed resolution key frees no slip: the item does not
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
         AND c.status = 'proposed'
         AND app.payout_proof_key_closed(c.tenant_id, c.evidence_key))
    OR EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_items o
        JOIN public.payroll_payout_overpaid_proposals p
          ON p.tenant_id = o.tenant_id AND p.item_id = o.id
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND p.status = 'proposed'
         AND app.payout_proof_key_closed(p.tenant_id, p.evidence_key))) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payslip has an open proposal on a closed proof key'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_closed_key_trg ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_closed_key_trg
  BEFORE INSERT OR UPDATE OF resolution_evidence_key, confirmation_evidence_key, return_evidence_key, status
  ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_closed_key_guard();
