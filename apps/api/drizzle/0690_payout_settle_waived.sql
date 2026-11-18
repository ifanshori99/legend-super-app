-- legend-5qqb9 (P2): a cash payroll handover done while accounting was off ends
-- as `settle_skipped` and keeps counting as a pending credit against GL 1102.
-- Its catch-up journal is impossible without the payroll.locked journal (the
-- skipped posting has no salaries payable account; app.payout_settle_journal_ok
-- needs it), so finance gets an official manual waive instead: new terminal
-- kind `settle_waived`, set once with a reason and an audit row, no journal.
-- 1. The kind check accepts `settle_waived` (varchar(14) holds it).
-- 2. The waive is cash-only (F1, architect): a bank handover is never waivable,
--    mirrored by the EXISTS on the batch channel below. (The service also refuses
--    a run with a locked journal or a queued lock event, which the resolver
--    catches up; that part is not a trigger condition.)
-- 3. The 0412 guard of app.payroll_payout_gl_postings_guard, verbatim except one
--    new branch: the pure flip settle_skipped -> settle_waived (only `kind`
--    changes) on a cash batch. The settle commit checks (0400) are untouched:
--    they fire only on a flip to `settle`. A waived row matches no branch as
--    OLD.kind, so it can never go back to pending/skipped/settle nor be
--    journaled.
ALTER TABLE "payroll_payout_gl_postings" DROP CONSTRAINT "payroll_payout_gl_postings_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_kind_check" CHECK ("payroll_payout_gl_postings"."kind" IN ('settle', 'settle_pending', 'settle_skipped', 'settle_waived', 'return', 'overpaid'));--> statement-breakpoint
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
  IF OLD.fee_posted = false AND NEW.fee_posted = true
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
  -- (legend-5qqb9, 0690) finance waives a settle_skipped cash handover: the
  -- kind alone flips settle_skipped -> settle_waived, nothing else changes. No
  -- journal is written or required (the run has no payroll.locked journal, so no
  -- payable exists to settle). settle_waived is terminal: no branch above or
  -- below accepts it as OLD.kind, so it never flips back or gets journaled.
  IF OLD.kind = 'settle_skipped' AND NEW.kind = 'settle_waived'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND b.channel = 'cash') THEN
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
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
