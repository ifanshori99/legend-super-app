-- legend-so897 (second opinion 895-897), F6 and F7, the
-- `payroll_payout_gl_postings` guard:
-- F6: the fee flip (`fee_posted` false -> true) accepted ANY balanced fee journal
-- under the posting's key: a SQL writer could post Rp1 against a Rp5000 fee, or
-- on any account, and hide the owed fee from the recovery list. The service now
-- also writes the fee in plain (`fee_idr`, the figure the fee journal posts) at
-- insert, and the flip needs app.payout_fee_journal_ok: the journal of key
-- `payroll-payout-fee:<item_set_hash>` (entity, run, source type as before) is
-- balanced and above zero, debits exactly `fee_idr` (not checked for a row from
-- before this migration, whose fee is only sealed), debits only the entity's
-- `bank_charges` account, and credits only one of the three sources the fee is
-- posted from: the frozen bank account of the batch, the source account frozen
-- on the posting, or (a `settle` posting) an account the settle journal
-- credited. `fee_idr` has no column grant and the guard refuses any other
-- change, so it never moves after insert.
-- F7: every NEW posting carries `settle_net_idr` and `fee_idr` (PAYOUT-36). A
-- trigger, not a CHECK NOT VALID: a CHECK would also fire on the kind and
-- fee_posted flips of historical rows and block their recovery.
-- The guard below is 0392's with change 1 replaced; everything else verbatim.
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "fee_idr" bigint;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_fee_check" CHECK ("payroll_payout_gl_postings"."fee_idr" IS NULL OR "payroll_payout_gl_postings"."fee_idr" >= 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_fee_journal_ok(p_tenant_id uuid, p_posting_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_gl_postings p
      JOIN public.payroll_disbursement_batches b
        ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
      JOIN public.journal_entries j
        ON j.tenant_id = p.tenant_id
       AND j.idempotency_key = 'payroll-payout-fee:' || p.item_set_hash
       AND j.legal_entity_id = b.legal_entity_id
       AND j.source_type = 'payroll'
       AND j.source_id = b.payroll_run_id::text
     WHERE p.tenant_id = p_tenant_id AND p.id = p_posting_id
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         = (SELECT pg_catalog.sum(l.credit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
       -- The journal moves exactly the fee of the posting. NULL: a row from
       -- before 0397 (sealed fee unreadable here), accounts only.
       AND (p.fee_idr IS NULL
            OR (SELECT pg_catalog.sum(l.debit_idr)
                  FROM public.journal_lines l
                 WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
              = p.fee_idr)
       -- Every debit line is on the entity's bank charges account.
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.debit_idr > 0
            AND NOT EXISTS (
              SELECT 1
                FROM public.account_mappings m
               WHERE m.tenant_id = p.tenant_id
                 AND m.legal_entity_id = b.legal_entity_id
                 AND m.role = 'bank_charges'
                 AND m.account_id = l.account_id))
       -- Every credit line is on one of the fee's three sources (NULL counts
       -- as no match).
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.credit_idr > 0
            AND NOT COALESCE(
              (b.source_bank_account_id IS NOT NULL
               AND l.account_id = (
                 SELECT ba.gl_account_id
                   FROM public.bank_accounts ba
                  WHERE ba.tenant_id = b.tenant_id
                    AND ba.legal_entity_id = b.legal_entity_id
                    AND ba.id = b.source_bank_account_id))
              OR (p.source_gl_account_id IS NOT NULL
                  AND l.account_id = p.source_gl_account_id)
              OR (p.kind = 'settle'
                  AND EXISTS (
                    SELECT 1
                      FROM public.journal_entries s
                      JOIN public.journal_lines sl
                        ON sl.tenant_id = s.tenant_id AND sl.entry_id = s.id
                     WHERE s.tenant_id = p.tenant_id
                       AND s.legal_entity_id = b.legal_entity_id
                       AND s.idempotency_key = p.journal_key
                       AND sl.credit_idr > 0
                       AND sl.account_id = l.account_id)),
              false))
  )
$$;
--> statement-breakpoint
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
  -- posting, checked on amount and accounts by app.payout_fee_journal_ok.
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted')
    AND app.payout_fee_journal_ok(NEW.tenant_id, NEW.id) THEN
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.settle_net_idr IS NOT NULL AND NEW.fee_idr IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-36: payout GL posting % needs its plain net and fee', NEW.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_gl_postings_insert_guard_trg ON public.payroll_payout_gl_postings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_gl_postings_insert_guard_trg
  BEFORE INSERT ON public.payroll_payout_gl_postings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_gl_postings_insert_guard();
