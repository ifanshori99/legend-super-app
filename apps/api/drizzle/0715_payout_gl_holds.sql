-- ---------------------------------------------------------------------------
-- Payout GL holds (bead legend-3xzop, legend-6qp12; brief docs/briefs/sub-1184-payout-gl-holds.md).
-- Two finance resolutions on a payout GL posting, each written once with the
-- actor and a note:
--   * fee_opening_balance_*: the fee of a skipped settlement is already in the
--     opening balance; no path ever journals it (card 3xzop).
--   * payable_hold_released_* : payable_account_hold true -> false (card 6qp12).
-- No data backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "fee_opening_balance_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "fee_opening_balance_by" text;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "fee_opening_balance_note" text;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "payable_hold_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "payable_hold_released_by" text;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "payable_hold_release_note" text;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_fee_opening_trio_check" CHECK (("payroll_payout_gl_postings"."fee_opening_balance_at" IS NULL) = ("payroll_payout_gl_postings"."fee_opening_balance_by" IS NULL) AND ("payroll_payout_gl_postings"."fee_opening_balance_at" IS NULL) = ("payroll_payout_gl_postings"."fee_opening_balance_note" IS NULL));--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_fee_opening_note_check" CHECK ("payroll_payout_gl_postings"."fee_opening_balance_note" IS NULL OR char_length(btrim("payroll_payout_gl_postings"."fee_opening_balance_note")) BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_hold_release_trio_check" CHECK (("payroll_payout_gl_postings"."payable_hold_released_at" IS NULL) = ("payroll_payout_gl_postings"."payable_hold_released_by" IS NULL) AND ("payroll_payout_gl_postings"."payable_hold_released_at" IS NULL) = ("payroll_payout_gl_postings"."payable_hold_release_note" IS NULL));--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_hold_release_note_check" CHECK ("payroll_payout_gl_postings"."payable_hold_release_note" IS NULL OR char_length(btrim("payroll_payout_gl_postings"."payable_hold_release_note")) BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_hold_release_hold_check" CHECK ("payroll_payout_gl_postings"."payable_hold_released_at" IS NULL OR "payroll_payout_gl_postings"."payable_account_hold" = false);--> statement-breakpoint
-- legend_app had no UPDATE on payable_account_hold (0390 set it in the migration
-- only). The guard below accepts exactly the transitions named here.
GRANT UPDATE (payable_account_hold, fee_opening_balance_at, fee_opening_balance_by, fee_opening_balance_note, payable_hold_released_at, payable_hold_released_by, payable_hold_release_note) ON TABLE public.payroll_payout_gl_postings TO legend_app;
--> statement-breakpoint
-- The 0412 guard, verbatim except: the fee_posted flip needs an unmarked
-- posting, and two new transitions (fee mark, hold release) before the refusal.
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND NEW.pii_key_version > OLD.pii_key_version
    AND NEW.total_encrypted IS DISTINCT FROM OLD.total_encrypted
    AND (to_jsonb(NEW) - 'total_encrypted' - 'pii_key_version')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'total_encrypted' - 'pii_key_version') THEN
    RETURN NEW;
  END IF;
  -- (change 1, 0397) fee_posted false -> true only with the fee journal of the
  -- posting, checked on amount and accounts by app.payout_fee_journal_ok
  -- (re-checked at commit, 0400).
  -- (0715) a posting marked as already in the opening balance never gets a
  -- fee journal, so it never flips either.
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND OLD.fee_opening_balance_at IS NULL
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted')
    AND app.payout_fee_journal_ok(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  -- (F3, 0400) the settle journal checks moved to app.payout_settle_journal_ok
  -- (re-checked at commit). The row read there is OLD, equal to NEW here except
  -- the kind, which the helper does not read.
  IF OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND app.payout_settle_journal_ok(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  -- (F4, 0400) on a non-cash batch with a frozen bank account the source is
  -- filled only with that account's GL account (settle included). (905, card 2)
  -- any other batch (cash, or bank without a frozen account) is filled only by
  -- the payout role through app.payout_posting_record_source.
  IF OLD.source_gl_account_id IS NULL AND NEW.source_gl_account_id IS NOT NULL
    AND (to_jsonb(NEW) - 'source_gl_account_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'source_gl_account_id')
    -- Parenthesised: PL/pgSQL ends an IF condition at its first bare THEN.
    AND (CASE
      WHEN EXISTS (
        SELECT 1
          FROM public.payroll_disbursement_batches b
         WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
           AND b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL)
      THEN OLD.kind IN ('settle', 'settle_pending', 'settle_skipped')
        AND EXISTS (
          SELECT 1
            FROM public.payroll_disbursement_batches b
            JOIN public.bank_accounts ba
              ON ba.tenant_id = b.tenant_id
             AND ba.legal_entity_id = b.legal_entity_id
             AND ba.id = b.source_bank_account_id
           WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
             AND ba.gl_account_id = NEW.source_gl_account_id)
      -- (905) the cash / unfrozen bank branch: only the trusted payout role
      -- (app.payout_posting_record_source) fills it; legend_app is refused.
      ELSE OLD.kind IN ('settle_pending', 'settle_skipped')
        AND current_user = 'legend_payout'
    END) THEN
    RETURN NEW;
  END IF;
  IF OLD.salaries_payable_account_id IS NULL AND NEW.salaries_payable_account_id IS NOT NULL
    AND OLD.kind IN ('settle_pending', 'settle_skipped')
    AND OLD.payable_account_hold = false
    AND (to_jsonb(NEW) - 'salaries_payable_account_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'salaries_payable_account_id')
    AND EXISTS (
      SELECT 1
        FROM public.journal_entries j
        JOIN public.payroll_disbursement_batches b
          ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
       WHERE j.tenant_id = NEW.tenant_id
         AND j.idempotency_key = 'payroll-gl:locked:' || b.payroll_run_id::text
         AND j.legal_entity_id = b.legal_entity_id
         AND j.source_type = 'payroll'
         AND j.posting_account_snapshot ->> 'salaries_payable' = NEW.salaries_payable_account_id::text
         AND EXISTS (
           SELECT 1
             FROM public.journal_lines l
            WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
              AND l.account_id = NEW.salaries_payable_account_id
              AND l.credit_idr > 0)
         -- Not provable when another account is credited the same amount.
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_lines o
            WHERE o.tenant_id = j.tenant_id AND o.entry_id = j.id
              AND o.account_id <> NEW.salaries_payable_account_id
              AND o.credit_idr > 0
              AND o.credit_idr = (
                SELECT pg_catalog.sum(l.credit_idr)
                  FROM public.journal_lines l
                 WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
                   AND l.account_id = NEW.salaries_payable_account_id))
    ) THEN
    RETURN NEW;
  END IF;
  -- (0715, legend-3xzop) finance marks the fee of a skipped settlement as
  -- already held in the opening balance: once (null -> set), never undone, only
  -- while no fee journal exists, by someone other than the batch requester.
  -- fee_posted and every other column stay as they are.
  -- (F2) The same state the service lists as accounting_was_off
  -- (payoutRecoveryReason): a skipped settlement (fee_posted either way: it
  -- owes its fee journal even when true), not on payable hold, with a real
  -- fee (fee_idr > 0, or NULL on a row from before 0397: the sealed fee is
  -- checked by the service; a zero fee never journals anyway), and its run
  -- has NO lock journal (payrollGlKeys.locked(run id)). With a lock journal the
  -- resolver journals the fee, so a mark would lose it.
  IF OLD.fee_opening_balance_at IS NULL AND NEW.fee_opening_balance_at IS NOT NULL
    AND NEW.fee_opening_balance_at = pg_catalog.now()
    AND OLD.kind = 'settle_skipped'
    AND OLD.payable_account_hold = false
    AND (OLD.fee_idr IS NULL OR OLD.fee_idr > 0)
    AND (to_jsonb(NEW) - 'fee_opening_balance_at' - 'fee_opening_balance_by' - 'fee_opening_balance_note')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_opening_balance_at' - 'fee_opening_balance_by' - 'fee_opening_balance_note')
    AND NOT EXISTS (
      SELECT 1
        FROM public.journal_entries j
       WHERE j.tenant_id = NEW.tenant_id
         AND j.idempotency_key = 'payroll-payout-fee:' || NEW.item_set_hash)
    AND EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND b.requested_by <> NEW.fee_opening_balance_by
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_entries lk
            WHERE lk.tenant_id = NEW.tenant_id
              AND lk.idempotency_key = 'payroll-gl:locked:' || b.payroll_run_id::text)) THEN
    RETURN NEW;
  END IF;
  -- (0715, legend-6qp12) finance releases the payable account hold: once
  -- (true -> false with the release columns), only when the posting carries a
  -- frozen payable account (a return never uses today's mapping), by someone
  -- other than the batch requester. No other column moves.
  -- (F1) Proof, mirroring the 0390 "proven" test: the settle journal of the
  -- posting (journal_key, same tenant) exists, debits the frozen account on at
  -- least one line, and no debit line is on another account. Otherwise the
  -- posting stays held (the settle debited an account other than the frozen one).
  IF OLD.payable_account_hold = true AND NEW.payable_account_hold = false
    AND OLD.payable_hold_released_at IS NULL AND NEW.payable_hold_released_at IS NOT NULL
    AND NEW.payable_hold_released_at = pg_catalog.now()
    AND OLD.salaries_payable_account_id IS NOT NULL
    AND (to_jsonb(NEW) - 'payable_account_hold' - 'payable_hold_released_at' - 'payable_hold_released_by' - 'payable_hold_release_note')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'payable_account_hold' - 'payable_hold_released_at' - 'payable_hold_released_by' - 'payable_hold_release_note')
    AND EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND b.requested_by <> NEW.payable_hold_released_by)
    AND EXISTS (
      SELECT 1
        FROM public.journal_entries s
        JOIN public.journal_lines sl
          ON sl.tenant_id = s.tenant_id AND sl.entry_id = s.id
       WHERE s.tenant_id = NEW.tenant_id
         AND s.idempotency_key = OLD.journal_key
         AND sl.debit_idr > 0
         AND sl.account_id = OLD.salaries_payable_account_id)
    AND NOT EXISTS (
      SELECT 1
        FROM public.journal_entries s
        JOIN public.journal_lines sl
          ON sl.tenant_id = s.tenant_id AND sl.entry_id = s.id
       WHERE s.tenant_id = NEW.tenant_id
         AND s.idempotency_key = OLD.journal_key
         AND sl.debit_idr > 0
         AND sl.account_id <> OLD.salaries_payable_account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;

--> statement-breakpoint
-- (0715) the 0415 insert guard, verbatim, plus the refusal of the six new columns.
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
  -- (0715) the six hold-resolution columns are written only by the update guard
  -- transitions (fee mark, hold release), never on INSERT.
  IF NEW.fee_opening_balance_at IS NOT NULL OR NEW.fee_opening_balance_by IS NOT NULL
    OR NEW.fee_opening_balance_note IS NOT NULL OR NEW.payable_hold_released_at IS NOT NULL
    OR NEW.payable_hold_released_by IS NOT NULL OR NEW.payable_hold_release_note IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot start resolved', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

