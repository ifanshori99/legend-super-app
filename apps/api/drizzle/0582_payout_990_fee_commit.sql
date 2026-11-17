-- payout 990 (B): the overpaid commit check also demands the fee journal.
--
-- Copied from 0415 (latest definition; 0416 does not redefine it). Only the
-- `failed -> overpaid` branch changes. The service (payroll-payout-overpaid
-- .service.ts) journals the transfer fee `payroll-payout-overpaid-fee:<item id>`
-- exactly when the fee it journaled is > 0, and writes that same value to the
-- posting as plain `fee_idr` (0 when nothing was journaled: no locked journal
-- and accounting off, or fee 0). So the condition here is `fee_idr > 0` on the
-- linked overpaid posting; a NULL fee_idr (rows from before PAYOUT-36) asks for
-- nothing. The fee journal must exist and balance for the same legal entity and
-- run as the net journal (app.payout_item_journal_ok). PAYOUT-90 is the new code.
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
    ELSIF COALESCE(v_posting.fee_idr, 0) > 0
      AND NOT app.payout_item_journal_ok(
        NEW.tenant_id, 'payroll-payout-overpaid-fee:' || NEW.id::text,
        v_batch.legal_entity_id, v_batch.payroll_run_id) THEN
      v_reason := 'the transfer fee journal of the overpaid item is missing or unbalanced';
      v_code := 'PAYOUT-90';
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
