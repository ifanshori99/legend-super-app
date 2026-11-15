-- legend-kjht5 (905, card 2b): the source account of a cash / unfrozen-bank
-- settlement posting was filled by anyone with UPDATE on the posting (guard
-- PAYOUT-30, 0642 ELSE branch): `legend_app` could name an account the money
-- never left from. Now:
-- - app.payout_posting_record_source (SECURITY DEFINER, owned by the NOLOGIN
--   payout role legend_payout, 0644) is the only writer of that branch. It
--   re-checks everything in SQL: the actor (user, live MFA session, finance
--   permission, app.payout_assert_actor); the posting is pending/skipped
--   without a source; the batch is cash, or bank without a frozen account; the
--   actor is not the batch requester; the account belongs to the batch legal
--   entity and is postable (active, no children) and, for cash, a cash and
--   equivalents asset account, for bank an active bank account's GL account.
--   One attestation row is written (kind posting_source).
-- - the guard's ELSE branch adds `current_user = 'legend_payout'`; the frozen
--   bank branch stays open to legend_app (its account is fixed by the batch).
-- Errors: P0002 not found, 42501 actor / requester, 23514 any state or account
-- refusal; messages PAYOUT-50..PAYOUT-58.

GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
-- What the function reads and writes (idempotent grants; 0644 grants the rest).
GRANT SELECT ON TABLE public."session" TO legend_payout;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_disbursement_batches, public.payroll_payout_gl_postings,
  public.bank_accounts, public.chart_of_accounts TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (source_gl_account_id) ON TABLE public.payroll_payout_gl_postings TO legend_payout;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_attestations TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_posting_record_source(
  p_batch uuid, p_posting uuid, p_gl_account uuid, p_actor text, p_session text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_posting public.payroll_payout_gl_postings%ROWTYPE;
  v_is_cash boolean;
  v_session_created timestamptz;
  v_session_mfa timestamptz;
BEGIN
  PERFORM app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-50: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- The requester never names the source of their own batch.
  IF v_batch.requested_by = p_actor THEN
    RAISE EXCEPTION 'PAYOUT-51: the requester of a batch cannot record its source'
      USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'PAYOUT-50: payout posting not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_posting.kind NOT IN ('settle_pending', 'settle_skipped') THEN
    RAISE EXCEPTION 'PAYOUT-52: payout posting % is already settled', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  v_is_cash := v_batch.channel = 'cash';
  IF NOT v_is_cash AND v_batch.source_bank_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-53: the source of batch % is frozen on its bank account', v_batch.id
      USING ERRCODE = '23514';
  END IF;
  IF v_posting.source_gl_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-54: payout posting % already has a source', v_posting.id
      USING ERRCODE = '23514';
  END IF;
  -- The account: same entity, active, postable (no child accounts).
  IF NOT EXISTS (
    SELECT 1
      FROM public.chart_of_accounts c
     WHERE c.tenant_id = v_tenant
       AND c.legal_entity_id = v_batch.legal_entity_id
       AND c.id = p_gl_account
       AND c.is_active = true
       AND NOT EXISTS (
         SELECT 1
           FROM public.chart_of_accounts ch
          WHERE ch.tenant_id = v_tenant AND ch.parent_id = c.id)
       -- Cash: a cash and equivalents asset account, not any asset account.
       AND (NOT v_is_cash
            OR (c.type = 'asset' AND c.report_group = 'cash_and_equivalents'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-55: the source account is not usable for batch %', v_batch.id
      USING ERRCODE = '23514';
  END IF;
  -- Bank: the GL account of an active bank account of the same entity.
  IF NOT v_is_cash AND NOT EXISTS (
    SELECT 1
      FROM public.bank_accounts ba
     WHERE ba.tenant_id = v_tenant
       AND ba.legal_entity_id = v_batch.legal_entity_id
       AND ba.gl_account_id = p_gl_account
       AND ba.is_active = true
  ) THEN
    RAISE EXCEPTION 'PAYOUT-56: the source account is not an active bank account of the entity'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_gl_postings
     SET source_gl_account_id = p_gl_account
   WHERE tenant_id = v_tenant AND id = v_posting.id
     AND source_gl_account_id IS NULL
     AND kind IN ('settle_pending', 'settle_skipped');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-57: payout posting % changed while recording its source', v_posting.id
      USING ERRCODE = '23514';
  END IF;

  SELECT s.created_at, s.mfa_verified_at INTO v_session_created, v_session_mfa
    FROM public."session" s
   WHERE s.id = p_session;
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    attested_at, txid)
  VALUES (
    v_tenant, 'posting_source', v_posting.id, 'record', v_batch.id,
    ARRAY[]::uuid[], NULL, NULL, p_actor, p_session, v_session_created,
    v_session_mfa, pg_catalog.statement_timestamp(), pg_catalog.txid_current());
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text, text) TO legend_app;
--> statement-breakpoint
-- ACL first (the migrator stops being able to change it once the owner moves).
ALTER FUNCTION app.payout_posting_record_source(uuid, uuid, uuid, text, text) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
-- The 0642 guard, verbatim except the ELSE branch of the source fill.
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
