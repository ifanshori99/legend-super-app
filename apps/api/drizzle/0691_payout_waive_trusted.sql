-- legend-1089 (second opinion 1089, P1-1): the waive of a settle_skipped cash
-- handover (0690) was a pure flip of `kind` that any legend_app UPDATE could do,
-- with no journal required: the reserve fell by the net while GL 1102 kept it.
-- Now the flip needs the correcting journal, and only the payout role flips it.
-- 1. legend_payout may UPDATE postings.kind and read what the checks read.
-- 2. app.payout_waive_journal_ok: journal `payroll-payout-waive:<posting>` of the
--    batch entity, debit sum = credit sum > 0, equal to settle_net_idr when it is known, credits only
--    on the posting's frozen source (1102) account, which must still be the
--    entity's current petty_cash mapping, debits only on the entity's
--    salary_expense mapping account.
-- 3. app.payout_waive_skipped (SECURITY DEFINER, owner legend_payout): actor
--    (live MFA session, accounting.petty_cash.manage), lock order batch row,
--    advisory lock, posting row; cash batch, kind settle_skipped, no
--    payroll.locked journal of the run, journal ok; flips the kind. Errors
--    PAYOUT-60..PAYOUT-65 (P0002 not found, 42501 actor, 23514 any state refusal).
-- 4. The 0690 guard, verbatim except the waive branch (needs current_user =
--    legend_payout and the journal helper).
-- 5. Commit-time checks (pattern 0400): the posting check also fires on the
--    waive flip, the journal-line check also re-checks waived postings when a
--    line is added to a waive journal.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_disbursement_batches, public.payroll_payout_gl_postings,
  public.journal_entries, public.journal_lines, public.account_mappings TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (kind) ON TABLE public.payroll_payout_gl_postings TO legend_payout;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_waive_journal_ok(p_tenant_id uuid, p_posting_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_gl_postings p
      JOIN public.payroll_disbursement_batches b
        ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
      JOIN public.journal_entries j
        ON j.tenant_id = p.tenant_id
       AND j.idempotency_key = 'payroll-payout-waive:' || p.id::text
       AND j.legal_entity_id = b.legal_entity_id
       AND j.source_type = 'payroll'
       AND j.source_id = b.payroll_run_id::text
     WHERE p.tenant_id = p_tenant_id AND p.id = p_posting_id
       AND p.source_gl_account_id IS NOT NULL
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
       AND (SELECT pg_catalog.sum(l.debit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         = (SELECT pg_catalog.sum(l.credit_idr)
              FROM public.journal_lines l
             WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
       -- The journal moves exactly the net of the posting. NULL: a row from
       -- before 0392 (sealed total unreadable here; the service books the
       -- sealed net, same rule as app.payout_settle_journal_ok).
       AND (p.settle_net_idr IS NULL
            OR (p.settle_net_idr > 0
                AND (SELECT pg_catalog.sum(l.debit_idr)
                       FROM public.journal_lines l
                      WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
                  = p.settle_net_idr))
       -- Every credit line is on the 1102 account frozen on the posting, and
       -- that account is still the entity's current petty_cash mapping (the
       -- account the reserve and every 1102 guard watch).
       AND p.source_gl_account_id IN (
         SELECT m.account_id
           FROM public.account_mappings m
          WHERE m.tenant_id = b.tenant_id
            AND m.legal_entity_id = b.legal_entity_id
            AND m.role = 'petty_cash')
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.credit_idr > 0
            AND l.account_id IS DISTINCT FROM p.source_gl_account_id)
       -- Every debit line is on the entity's salary expense account.
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines l
          WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
            AND l.debit_idr > 0
            AND (l.account_id IS NULL OR l.account_id NOT IN (
              SELECT m.account_id
                FROM public.account_mappings m
               WHERE m.tenant_id = b.tenant_id
                 AND m.legal_entity_id = b.legal_entity_id
                 AND m.role = 'salary_expense')))
  )
$$;
--> statement-breakpoint
CREATE FUNCTION app.payout_waive_skipped(
  p_batch uuid, p_posting uuid, p_actor text, p_session text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_posting public.payroll_payout_gl_postings%ROWTYPE;
BEGIN
  PERFORM app.payout_assert_actor(v_tenant, p_actor, p_session, 'accounting.petty_cash.manage');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-60: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- Same advisory key as the services (payroll-payout-gl:<tenant>:<batch>),
  -- taken before the posting row, as the TS lock order does.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('payroll-payout-gl:' || v_tenant::text || ':' || v_batch.id::text));
  SELECT p.* INTO v_posting
    FROM public.payroll_payout_gl_postings p
   WHERE p.tenant_id = v_tenant AND p.batch_id = v_batch.id AND p.id = p_posting
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-60: payout posting not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.channel <> 'cash' THEN
    RAISE EXCEPTION 'PAYOUT-61: only a cash batch can be waived (batch %)', v_batch.id
      USING ERRCODE = '23514';
  END IF;
  IF v_posting.kind <> 'settle_skipped' THEN
    RAISE EXCEPTION 'PAYOUT-62: payout posting % is not settle_skipped', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  -- The run's payroll.locked journal exists: the salary expense is already
  -- booked there, so a waive would book it twice (same check as the service).
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries j
     WHERE j.tenant_id = v_tenant
       AND j.idempotency_key = 'payroll-gl:locked:' || v_batch.payroll_run_id::text) THEN
    RAISE EXCEPTION 'PAYOUT-65: payroll run % already has its locked journal', v_batch.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT app.payout_waive_journal_ok(v_tenant, v_posting.id) THEN
    RAISE EXCEPTION 'PAYOUT-63: payout posting % has no valid waive journal', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_payout_gl_postings
     SET kind = 'settle_waived'
   WHERE tenant_id = v_tenant AND id = v_posting.id
     AND kind = 'settle_skipped';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-64: payout posting % changed while waiving', v_posting.id
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_waive_skipped(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_waive_skipped(uuid, uuid, text, text) TO legend_app;
--> statement-breakpoint
-- ACL first (the migrator stops being able to change it once the owner moves).
ALTER FUNCTION app.payout_waive_skipped(uuid, uuid, text, text) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
-- The 0690 guard, verbatim except the waive branch.
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
  -- (legend-1089, 0691) the pure flip settle_skipped -> settle_waived on a cash
  -- batch, now only by the payout role (app.payout_waive_skipped) and only with
  -- the correcting journal of the posting, checked on net and accounts by
  -- app.payout_waive_journal_ok (re-checked at commit). legend_app is refused.
  -- settle_waived is terminal: no branch accepts it as OLD.kind.
  IF OLD.kind = 'settle_skipped' AND NEW.kind = 'settle_waived'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND current_user = 'legend_payout'
    AND EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
         AND b.channel = 'cash')
    AND app.payout_waive_journal_ok(NEW.tenant_id, NEW.id) THEN
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
--> statement-breakpoint
-- (0400 commit checks, plus the waive flip.) Defined by the migrator, run as the
-- session user; the tenant of the row is set locally inside.
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
  IF ok AND OLD.kind = 'settle_skipped' AND NEW.kind = 'settle_waived' THEN
    ok := app.payout_waive_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF NOT ok THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_gl_postings_commit_check ON public.payroll_payout_gl_postings;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_payout_gl_postings_commit_check
  AFTER UPDATE ON public.payroll_payout_gl_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((OLD.fee_posted = false AND NEW.fee_posted = true)
        OR (OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle')
        OR (OLD.kind = 'settle_skipped' AND NEW.kind = 'settle_waived'))
  EXECUTE FUNCTION app.payroll_payout_gl_postings_commit_check();
--> statement-breakpoint
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
  ELSIF entry_key LIKE 'payroll-payout-waive:%' THEN
    SELECT p.id INTO failed
      FROM public.payroll_payout_gl_postings p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.id::text = pg_catalog.substr(entry_key, 22)
       AND p.kind = 'settle_waived'
       AND NOT app.payout_waive_journal_ok(p.tenant_id, p.id)
     LIMIT 1;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', failed
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
