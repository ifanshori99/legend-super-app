-- legend-wcd24 (P1): the salaries payable account of a payout is frozen on its
-- posting. The run's lock journal credits `salaries_payable` on account A; if
-- finance later remaps the role to B, a settle or a return must still debit and
-- credit A, never B. The posting stores the account (`salaries_payable_account_id`)
-- and the service uses it for settle, resolve of a pending settle and return.
--
-- Backfill of the existing `settle` postings, from the lock journal of the run
-- (`payroll-gl:locked:<run id>`, same tenant and legal entity). The account is
-- the `salaries_payable` role of the journal's own `posting_account_snapshot`
-- (written by the rule path with the journal), accepted only when the journal
-- really has a credit line on it and no other account is credited the same
-- amount (the role could not be told apart). Fail closed: a posting whose account cannot be
-- proven (no lock journal, no snapshot, no matching credit line) or whose settle
-- journal debited another account than the lock credited is put on hold
-- (`payable_account_hold`): a return on it is refused and finance sees it in the
-- payout recovery list. `settle_pending` / `settle_skipped` postings are not
-- touched: they take the account from the lock journal when they resolve.
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "salaries_payable_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "payable_account_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The account is recorded once (NULL -> account) when a pending/skipped settle
-- resolves; the guard below checks it against the lock journal.
GRANT UPDATE (salaries_payable_account_id) ON TABLE public.payroll_payout_gl_postings TO legend_app;
--> statement-breakpoint
-- Foreign key and backfill read rows through the RLS policies, which needs a
-- tenant context a migration owner without BYPASSRLS does not have. FORCE RLS is
-- lifted for these statements and restored right after, as in 0348, 0381, 0382.
ALTER TABLE "payroll_payout_gl_postings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_entries NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_lines NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payroll_disbursement_batches NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_payable_account_fk" FOREIGN KEY ("tenant_id","salaries_payable_account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The backfill is the one change the posting guard must not see (it refuses every
-- update outside its listed moves). Disabled for these two statements only, in
-- the migration transaction.
ALTER TABLE "payroll_payout_gl_postings" DISABLE TRIGGER payroll_payout_gl_postings_guard_trg;--> statement-breakpoint
WITH lock_entry AS (
  SELECT p.tenant_id,
         p.id AS posting_id,
         p.journal_key,
         j.id AS entry_id,
         CASE
           WHEN j.posting_account_snapshot ->> 'salaries_payable'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (j.posting_account_snapshot ->> 'salaries_payable')::uuid
         END AS account_id
    FROM public.payroll_payout_gl_postings p
    JOIN public.payroll_disbursement_batches b
      ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
    JOIN public.journal_entries j
      ON j.tenant_id = p.tenant_id
     AND j.idempotency_key = 'payroll-gl:locked:' || b.payroll_run_id::text
     AND j.legal_entity_id = b.legal_entity_id
     AND j.source_type = 'payroll'
   WHERE p.kind = 'settle'
), proven AS (
  SELECT l.tenant_id, l.posting_id, l.journal_key, l.account_id
    FROM lock_entry l
   WHERE l.account_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.chart_of_accounts c
        WHERE c.tenant_id = l.tenant_id AND c.id = l.account_id)
     AND EXISTS (
       SELECT 1 FROM public.journal_lines jl
        WHERE jl.tenant_id = l.tenant_id AND jl.entry_id = l.entry_id
          AND jl.account_id = l.account_id AND jl.credit_idr > 0)
     -- Not provable when another account is credited the same amount as the
     -- payable account (the role cannot be told apart from the amounts).
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_lines o
        WHERE o.tenant_id = l.tenant_id AND o.entry_id = l.entry_id
          AND o.account_id <> l.account_id AND o.credit_idr > 0
          AND o.credit_idr = (
            SELECT sum(jl.credit_idr) FROM public.journal_lines jl
             WHERE jl.tenant_id = l.tenant_id AND jl.entry_id = l.entry_id
               AND jl.account_id = l.account_id))
)
UPDATE public.payroll_payout_gl_postings p
   SET salaries_payable_account_id = pr.account_id,
       -- The settle journal must exist and debit only the lock's account.
       payable_account_hold = NOT (
         EXISTS (
           SELECT 1 FROM public.journal_entries s
            WHERE s.tenant_id = pr.tenant_id AND s.idempotency_key = pr.journal_key)
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_entries s
             JOIN public.journal_lines sl
               ON sl.tenant_id = s.tenant_id AND sl.entry_id = s.id
            WHERE s.tenant_id = pr.tenant_id AND s.idempotency_key = pr.journal_key
              AND sl.debit_idr > 0 AND sl.account_id <> pr.account_id)
       )
  FROM proven pr
 WHERE p.tenant_id = pr.tenant_id AND p.id = pr.posting_id;--> statement-breakpoint
UPDATE public.payroll_payout_gl_postings
   SET payable_account_hold = true
 WHERE kind = 'settle' AND salaries_payable_account_id IS NULL;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ENABLE TRIGGER payroll_payout_gl_postings_guard_trg;--> statement-breakpoint
ALTER TABLE public.payroll_disbursement_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_entries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Guard (0385 + two changes):
--  1. the salaries payable account of a pending/skipped posting may be recorded
--     once (NULL -> account), only when it is the `salaries_payable` account the
--     lock journal of the run credited (snapshot of the journal + a credit line
--     on it); it can never be replaced;
--  2. the flip to `settle` checks every DEBIT line against the account frozen on
--     the posting, no longer against today's mapping. No frozen account: no
--     debit line can match, the flip is refused (fail closed).
-- Everything else is as in 0385 (header, balance, source account of the credit),
-- and everything else about a posting stays frozen (PAYOUT-30).
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
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted') THEN
    RETURN NEW;
  END IF;
  IF OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND EXISTS (
      SELECT 1
        FROM public.journal_entries j
        JOIN public.payroll_disbursement_batches b
          ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
       WHERE j.tenant_id = NEW.tenant_id
         AND j.idempotency_key = NEW.journal_key
         AND j.legal_entity_id = b.legal_entity_id
         AND j.source_type = 'payroll'
         AND j.source_id = b.payroll_run_id::text
         AND (SELECT pg_catalog.sum(l.debit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
         AND (SELECT pg_catalog.sum(l.debit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
           = (SELECT pg_catalog.sum(l.credit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         -- Every debit line is on the salaries payable account frozen on the
         -- posting (the lock journal's), never on today's mapping.
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_lines l
            WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
              AND l.debit_idr > 0
              AND l.account_id IS DISTINCT FROM NEW.salaries_payable_account_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_lines l
            WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
              AND l.credit_idr > 0
              AND l.account_id IS DISTINCT FROM (
                CASE
                  WHEN b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL
                  THEN (SELECT ba.gl_account_id
                          FROM public.bank_accounts ba
                         WHERE ba.tenant_id = b.tenant_id
                           AND ba.legal_entity_id = b.legal_entity_id
                           AND ba.id = b.source_bank_account_id)
                  ELSE NEW.source_gl_account_id
                END)
         )
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD.source_gl_account_id IS NULL AND NEW.source_gl_account_id IS NOT NULL
    AND OLD.kind IN ('settle_pending', 'settle_skipped')
    AND (to_jsonb(NEW) - 'source_gl_account_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'source_gl_account_id') THEN
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
