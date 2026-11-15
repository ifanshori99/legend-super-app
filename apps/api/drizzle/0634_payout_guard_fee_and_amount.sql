-- legend-8vcsg (second opinion, final payout area review), two guard gaps of the
-- `payroll_payout_gl_postings` trigger:
--  1. `fee_posted` false -> true was accepted without any proof: a SQL writer in
--     the tenant could hide an owed bank fee (the recovery list only selects
--     `fee_posted = false`). The flip is now accepted only when the fee journal
--     of the posting exists: same tenant, key `payroll-payout-fee:<item_set_hash>`,
--     entity and run of the posting's batch, source type `payroll`, balanced and
--     above zero.
--  2. The flip to `settle` (0385) could not compare the AMOUNT: the principal is
--     sealed in `total_encrypted`, which SQL cannot open. The service now also
--     writes the principal in `settle_net_idr` when it inserts the posting (the
--     same figure the journal posts; the settle journal itself already holds it
--     in plain, so no new exposure). The column never changes after insert (every
--     update outside the listed moves is refused, PAYOUT-30), and the flip needs
--     the debit total of the settle journal to equal it. NULL stays only on the
--     rows written before this migration, whose sealed total cannot be read in
--     SQL: for them the guard keeps its 0385/0632 checks (accounts, balance).
-- The function below is 0632's (frozen salaries payable account), not 0385's, with
-- the two changes marked.
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "settle_net_idr" bigint;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_settle_net_check" CHECK ("payroll_payout_gl_postings"."settle_net_idr" IS NULL OR "payroll_payout_gl_postings"."settle_net_idr" >= 0);--> statement-breakpoint
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
  -- (change 1) fee_posted false -> true only with the fee journal of the posting.
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted')
    AND EXISTS (
      SELECT 1
        FROM public.journal_entries j
        JOIN public.payroll_disbursement_batches b
          ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
       WHERE j.tenant_id = NEW.tenant_id
         AND j.idempotency_key = 'payroll-payout-fee:' || NEW.item_set_hash
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
    ) THEN
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
         -- (change 2) the journal moves exactly the principal of the posting.
         -- NULL: a row from before this migration (sealed total unreadable here).
         AND (NEW.settle_net_idr IS NULL
              OR (SELECT pg_catalog.sum(l.debit_idr)
                    FROM public.journal_lines l
                   WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
                = NEW.settle_net_idr)
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
