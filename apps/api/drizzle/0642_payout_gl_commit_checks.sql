-- legend-p2v4s (second opinion 897), F3, F4 and F5, the
-- `payroll_payout_gl_postings` checks:
-- F3: the fee flip and the settle flip were checked BEFORE UPDATE, so lines
-- added to the same journal later in the transaction were never seen. The
-- journal checks are now two helpers (app.payout_fee_journal_ok and the
-- extracted app.payout_settle_journal_ok, both read the CURRENT posting row by
-- id). The guard keeps them as immediate checks, and two DEFERRABLE INITIALLY
-- DEFERRED constraint triggers re-run them at commit (PAYOUT-37): one on the
-- posting flip, one on every journal line added to a fee journal or to the
-- settle journal of a settled posting (SET CONSTRAINTS ... IMMEDIATE fires the
-- posting check early; the line check still sees the late lines).
-- F4: the fee credit has ONE proven source account: on a non-cash batch with a
-- frozen bank account, that account's GL account, and the posting must carry
-- it as its source (insert guard PAYOUT-36, fill branch); else on a settle
-- posting the single account the settle journal credited; else the source
-- frozen on the posting.
-- F5: a posting from before 0639 (fee_idr NULL) never flips: its fee amount
-- cannot be proven here.
-- The guard and the insert guard below are 0639's with only the F3 and F4
-- branches changed; everything else verbatim.
CREATE OR REPLACE FUNCTION app.payout_settle_journal_ok(p_tenant_id uuid, p_posting_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_gl_postings p
      JOIN public.payroll_disbursement_batches b
        ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
      JOIN public.journal_entries j
        ON j.tenant_id = p.tenant_id
       AND j.idempotency_key = p.journal_key
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
       -- (change 2) the journal moves exactly the principal of the posting.
       -- NULL: a row from before 0634 (sealed total unreadable here).
       AND (p.settle_net_idr IS NULL
            OR (SELECT pg_catalog.sum(l.debit_idr)
                  FROM public.journal_lines l
                 WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
              = p.settle_net_idr)
       -- Every debit line is on the salaries payable account frozen on the
       -- posting (the lock journal's), never on today's mapping.
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.debit_idr > 0
            AND l.account_id IS DISTINCT FROM p.salaries_payable_account_id
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
                ELSE p.source_gl_account_id
              END)
       )
  )
$$;
--> statement-breakpoint
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
      -- (F4, 0642) the one account the fee may be credited to. NULL when it
      -- cannot be proven: the fee is refused.
      CROSS JOIN LATERAL (
        SELECT CASE
          -- A non-cash batch with a frozen bank account: that account's GL
          -- account, and the posting must carry it as its source.
          WHEN b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL
          THEN (SELECT ba.gl_account_id
                  FROM public.bank_accounts ba
                 WHERE ba.tenant_id = b.tenant_id
                   AND ba.legal_entity_id = b.legal_entity_id
                   AND ba.id = b.source_bank_account_id
                   AND ba.gl_account_id = p.source_gl_account_id)
          -- A legacy unfrozen settled batch: the single account the settle
          -- journal credited (more than one is not provable).
          WHEN p.kind = 'settle'
          THEN (SELECT CASE
                         WHEN pg_catalog.count(DISTINCT sl.account_id) = 1
                         THEN (pg_catalog.array_agg(DISTINCT sl.account_id))[1]
                       END
                  FROM public.journal_entries s
                  JOIN public.journal_lines sl
                    ON sl.tenant_id = s.tenant_id AND sl.entry_id = s.id
                 WHERE s.tenant_id = p.tenant_id
                   AND s.legal_entity_id = b.legal_entity_id
                   AND s.idempotency_key = p.journal_key
                   AND s.source_type = 'payroll'
                   AND s.source_id = b.payroll_run_id::text
                   AND sl.credit_idr > 0)
          -- Else the source frozen on the posting (legacy pending or skipped).
          ELSE p.source_gl_account_id
        END AS account_id
      ) expected
     WHERE p.tenant_id = p_tenant_id AND p.id = p_posting_id
       AND expected.account_id IS NOT NULL
       -- (F5, 0642) a row from before 0639 has no plain fee: never flipped.
       AND p.fee_idr IS NOT NULL
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         = (SELECT pg_catalog.sum(l.credit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
       -- The journal moves exactly the fee of the posting.
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         = p.fee_idr
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
       -- Every credit line is on the expected account.
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.credit_idr > 0
            AND l.account_id IS DISTINCT FROM expected.account_id)
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
  -- (change 1, 0639) fee_posted false -> true only with the fee journal of the
  -- posting, checked on amount and accounts by app.payout_fee_journal_ok
  -- (re-checked at commit, 0642).
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted')
    AND app.payout_fee_journal_ok(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  -- (F3, 0642) the settle journal checks moved to app.payout_settle_journal_ok
  -- (re-checked at commit). The row read there is OLD, equal to NEW here except
  -- the kind, which the helper does not read.
  IF OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND app.payout_settle_journal_ok(NEW.tenant_id, NEW.id) THEN
    RETURN NEW;
  END IF;
  -- (F4, 0642) on a non-cash batch with a frozen bank account the source is
  -- filled only with that account's GL account (settle included); any other
  -- batch keeps the 0639 rule.
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
      ELSE OLD.kind IN ('settle_pending', 'settle_skipped')
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.settle_net_idr IS NULL OR NEW.fee_idr IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-36: payout GL posting % needs its plain net and fee', NEW.id
      USING ERRCODE = '23514';
  END IF;
  -- (F4, 0642) a settlement of a non-cash batch with a frozen bank account
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
  RETURN NEW;
END $$;
--> statement-breakpoint
-- (F3) Commit-time checks. Both run in the tenant of the row (a local setting,
-- restored after), so a transaction that moved to another tenant is checked
-- against the right rows instead of seeing none.
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  ok boolean := true;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_id', NEW.tenant_id::text, true);
  IF OLD.fee_posted = false AND NEW.fee_posted = true THEN
    ok := app.payout_fee_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  IF ok AND OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle' THEN
    ok := app.payout_settle_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF NOT ok THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payroll_payout_gl_postings_commit_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_gl_postings_commit_check ON public.payroll_payout_gl_postings;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_payout_gl_postings_commit_check
  AFTER UPDATE ON public.payroll_payout_gl_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((OLD.fee_posted = false AND NEW.fee_posted = true)
        OR (OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle'))
  EXECUTE FUNCTION app.payroll_payout_gl_postings_commit_check();
--> statement-breakpoint
-- A line added to a fee journal re-checks every flipped posting of that item
-- set; a line added to the journal of a settled posting re-checks it. One
-- primary-key lookup of the entry per line; the postings only for payout keys.
CREATE OR REPLACE FUNCTION app.journal_lines_payout_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  entry_key text;
  failed uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT e.idempotency_key INTO entry_key
    FROM public.journal_entries e
   WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.entry_id;
  IF entry_key LIKE 'payroll-payout-fee:%' THEN
    SELECT p.id INTO failed
      FROM public.payroll_payout_gl_postings p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.item_set_hash = pg_catalog.substr(entry_key, 20)
       AND p.fee_posted = true
       AND NOT app.payout_fee_journal_ok(p.tenant_id, p.id)
     LIMIT 1;
  ELSIF entry_key LIKE 'payroll-payout:%' THEN
    SELECT p.id INTO failed
      FROM public.payroll_payout_gl_postings p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.journal_key = entry_key
       AND p.kind = 'settle'
       AND NOT app.payout_settle_journal_ok(p.tenant_id, p.id)
     LIMIT 1;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', failed
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.journal_lines_payout_commit_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_payout_commit_check ON public.journal_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_payout_commit_check
  AFTER INSERT ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION app.journal_lines_payout_commit_check();
