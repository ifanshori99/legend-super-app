-- SO 1216 F-P1a review round 3 (card 1217), on the 0516/0515 definitions:
-- 1. distribution_runs_guard (latest definition: 0516): approved -> cancelled
--    is refused while an adjustment of the run is not cancelled, and a zero
--    line settled by the carry (POTONG-KEKURANGAN) does not count as paid; an
--    adjustment is approved or paid only while its target is not cancelled;
--    draft/pending -> cancelled carries no approval (0517 widened the check).
-- 2. distribution_lines_guard (latest definition: 0515): an adjustment line
--    is paid only while its target is not cancelled.
CREATE OR REPLACE FUNCTION app.distribution_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  entity_legal_entity uuid;
  period_row record;
  version_status text;
  target record;
  frozen_cols text[] := ARRAY['status', 'approved_by', 'approved_at', 'paid_at',
    'cancelled_by', 'cancelled_at', 'cancel_reason', 'journal_entry_id',
    'reversal_journal_entry_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SH-04: distribution run % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-04: a distribution run starts as a draft'
        USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(pe.legal_entity_id, o.legal_entity_id) INTO entity_legal_entity
    FROM public.profit_entities pe
    LEFT JOIN public.outlets o ON o.tenant_id = pe.tenant_id AND o.id = pe.outlet_id
    WHERE pe.tenant_id = NEW.tenant_id AND pe.id = NEW.profit_entity_id;
    SELECT fp.status, fp.legal_entity_id, fp.period, fp.version INTO period_row
    FROM public.fiscal_periods fp
    WHERE fp.tenant_id = NEW.tenant_id AND fp.id = NEW.fiscal_period_id;
    IF period_row.status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'SH-02: distribution needs a closed fiscal period'
        USING ERRCODE = '23514';
    END IF;
    IF period_row.legal_entity_id IS DISTINCT FROM entity_legal_entity THEN
      RAISE EXCEPTION 'SH-02: fiscal period belongs to another legal entity'
        USING ERRCODE = '23514';
    END IF;
    IF period_row.period IS DISTINCT FROM NEW.period
       OR period_row.version IS DISTINCT FROM NEW.fiscal_period_version THEN
      RAISE EXCEPTION 'SH-02: run period and period version must match its fiscal period'
        USING ERRCODE = '23514';
    END IF;
    SELECT v.status INTO version_status FROM public.share_allocation_versions v
    WHERE v.tenant_id = NEW.tenant_id AND v.profit_entity_id = NEW.profit_entity_id
      AND v.version = NEW.share_version;
    IF version_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'SH-03: distribution needs an approved share version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.type = 'adjustment' THEN
      -- redefine-drops: target SELECT now locks FOR SHARE (0518)
      SELECT r.status, r.type, r.profit_entity_id, r.share_version INTO target
      FROM public.distribution_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.adjusts_run_id
      -- 0518: a concurrent cancel-approved of the target waits for this row.
      FOR SHARE;
      -- One correction tree per regular run: the claw-back room is counted
      -- against the regular run, never against another adjustment.
      IF target.status IS NULL OR target.status NOT IN ('approved', 'paid')
         OR target.type <> 'regular'
         OR target.profit_entity_id <> NEW.profit_entity_id
         OR target.share_version <> NEW.share_version THEN
        RAISE EXCEPTION 'SH-04: an adjustment corrects an approved run with its split'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  -- The period, its version and the share version were checked at INSERT;
  -- they can never change afterwards, not even on a draft.
  IF (NEW.tenant_id, NEW.id, NEW.profit_entity_id, NEW.type, NEW.basis,
      NEW.requested_by, NEW.idempotency_key, NEW.adjusts_run_id,
      NEW.fiscal_period_id, NEW.fiscal_period_version, NEW.period, NEW.share_version)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.profit_entity_id, OLD.type,
      OLD.basis, OLD.requested_by, OLD.idempotency_key, OLD.adjusts_run_id,
      OLD.fiscal_period_id, OLD.fiscal_period_version, OLD.period, OLD.share_version) THEN
    RAISE EXCEPTION 'SH-04: distribution run identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'pending_approval', 'cancelled') THEN
      RAISE EXCEPTION 'SH-04: distribution run cannot move from draft to %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'draft' THEN
      RETURN NEW;
    END IF;
    -- 0518: a draft is never approved; submit or cancel carries no approval.
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'SH-04: distribution run % carries no approval before it is approved', OLD.id
        USING ERRCODE = '23514';
    END IF;
    -- Submit or cancel: amounts stay as calculated.
    IF (to_jsonb(NEW) - frozen_cols) <> (to_jsonb(OLD) - frozen_cols) THEN
      RAISE EXCEPTION 'SH-04: amounts cannot change on submit or cancel'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - frozen_cols) <> (to_jsonb(OLD) - frozen_cols) THEN
    RAISE EXCEPTION 'SH-04: distribution run % is frozen (status %)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SH-04: distribution run % is frozen (status %)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'cancelled') THEN
    IF NEW.journal_entry_id IS NOT NULL OR NEW.reversal_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SH-04: journals are posted on completion only'
        USING ERRCODE = '23514';
    END IF;
    -- 0518: a rejected (cancelled) pending run carries no approval.
    IF NEW.status = 'cancelled'
       AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'SH-04: rejected run % carries no approval', OLD.id
        USING ERRCODE = '23514';
    END IF;
    -- 0518: an adjustment is approved only while the run it corrects stands.
    IF NEW.status = 'approved' AND NEW.adjusts_run_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.distribution_runs t
         WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.adjusts_run_id
           AND t.status = 'cancelled'
       ) THEN
      RAISE EXCEPTION 'SH-04: run % corrects a cancelled run (ADJUSTMENT_TARGET_INVALID)', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' THEN
      -- A reopen (or a reopen + re-close) bumps the period version: the profit
      -- figure the run was calculated from may have changed (PERIOD_CHANGED).
      SELECT fp.status, fp.version INTO period_row FROM public.fiscal_periods fp
      WHERE fp.tenant_id = NEW.tenant_id AND fp.id = NEW.fiscal_period_id
      FOR SHARE;
      IF period_row.status IS DISTINCT FROM 'closed'
         OR period_row.version IS DISTINCT FROM NEW.fiscal_period_version THEN
        RAISE EXCEPTION 'SH-02: fiscal period changed since run % was calculated', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- 0516 (SO 1216 F-P1a): an approved run with not one line paid may be
  -- withdrawn with a reason (>= 10 characters) by whoever cancels it.
  IF OLD.status = 'approved' AND NEW.status = 'cancelled' THEN
    IF (OLD.approved_by, OLD.approved_at) IS DISTINCT FROM (NEW.approved_by, NEW.approved_at)
       OR NEW.journal_entry_id IS NOT NULL OR NEW.reversal_journal_entry_id IS NOT NULL
       OR NEW.paid_at IS NOT NULL OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL
       OR length(btrim(coalesce(NEW.cancel_reason, ''))) < 10 THEN
      RAISE EXCEPTION 'SH-04: approved run % is cancelled only with a reason, nothing else changing', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.distribution_lines l
      WHERE l.tenant_id = NEW.tenant_id AND l.distribution_run_id = NEW.id
        AND l.payment_status = 'paid'
        -- 0518: a zero line settled by the carry on approval is no payment.
        AND NOT (l.gross_idr = 0 AND l.payment_ref = 'POTONG-KEKURANGAN')
    ) THEN
      RAISE EXCEPTION 'SH-04: run % has a paid line and cannot be cancelled', OLD.id
        USING ERRCODE = '23514';
    END IF;
    -- 0518: a live adjustment (any status but cancelled) corrects this run.
    IF EXISTS (
      SELECT 1 FROM public.distribution_runs a
      WHERE a.tenant_id = NEW.tenant_id AND a.adjusts_run_id = NEW.id
        AND a.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'SH-04: run % has a live adjustment and cannot be cancelled', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF (OLD.approved_by, OLD.approved_at) IS DISTINCT FROM (NEW.approved_by, NEW.approved_at)
       OR OLD.journal_entry_id IS NOT NULL OR OLD.reversal_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SH-04: distribution run % approval is frozen', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.distribution_lines l
      WHERE l.tenant_id = NEW.tenant_id AND l.distribution_run_id = NEW.id
        AND l.payment_status <> 'paid'
    ) THEN
      RAISE EXCEPTION 'SH-04: run % is paid only when every line is paid', OLD.id
        USING ERRCODE = '23514';
    END IF;
    -- 0518: an adjustment is paid only while the run it corrects stands.
    IF NEW.adjusts_run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.distribution_runs t
      WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.adjusts_run_id
        AND t.status = 'cancelled'
    ) THEN
      RAISE EXCEPTION 'SH-04: run % corrects a cancelled run (ADJUSTMENT_TARGET_INVALID)', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SH-04: distribution run cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.distribution_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_fiscal_period_id uuid;
  run_fiscal_period_version integer;
  run_adjusts_run_id uuid;
  period_status text;
  period_version integer;
  payment_cols text[] := ARRAY['payment_status', 'payment_ref', 'paid_at', 'paid_by',
    'recipient_user_id'];
BEGIN
  -- redefine-drops: the 0515 SELECT now also reads the run's adjusts_run_id (0518)
  SELECT r.status, r.fiscal_period_id, r.fiscal_period_version, r.adjusts_run_id
    INTO run_status, run_fiscal_period_id, run_fiscal_period_version, run_adjusts_run_id
    FROM public.distribution_runs r
  WHERE r.tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
    AND r.id = coalesce(NEW.distribution_run_id, OLD.distribution_run_id)
  FOR SHARE;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.id, NEW.distribution_run_id)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.distribution_run_id) THEN
    RAISE EXCEPTION 'SH-04: distribution line identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF run_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Pay once, on an approved run, nothing else changing.
    IF run_status = 'approved' AND OLD.payment_status = 'pending'
       AND NEW.payment_status = 'paid'
       AND (to_jsonb(NEW) - payment_cols) = (to_jsonb(OLD) - payment_cols) THEN
      -- 0515 (SO 1216 F-P1a): pay only at the figures the run was approved
      -- on: its fiscal period closed at the run's version (a reopen or a
      -- reopen + re-close bumps it).
      SELECT fp.status, fp.version INTO period_status, period_version
        FROM public.fiscal_periods fp
        WHERE fp.tenant_id = NEW.tenant_id AND fp.id = run_fiscal_period_id
        FOR SHARE;
      IF period_status IS DISTINCT FROM 'closed'
         OR period_version IS DISTINCT FROM run_fiscal_period_version THEN
        RAISE EXCEPTION 'SH-02: fiscal period changed since run % was approved; no payment (PERIOD_CHANGED)',
          NEW.distribution_run_id
          USING ERRCODE = '23514';
      END IF;
      -- 0518: an adjustment line is paid only while the run it corrects stands.
      IF run_adjusts_run_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.distribution_runs t
        WHERE t.tenant_id = NEW.tenant_id AND t.id = run_adjusts_run_id
          AND t.status = 'cancelled'
      ) THEN
        RAISE EXCEPTION 'SH-04: run % corrects a cancelled run; no payment (ADJUSTMENT_TARGET_INVALID)',
          NEW.distribution_run_id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    -- Attach a paid line's statement once.
    IF run_status IN ('approved', 'paid') AND OLD.payment_status = 'paid'
       AND OLD.statement_file_key IS NULL AND NEW.statement_file_key IS NOT NULL
       AND (to_jsonb(NEW) - 'statement_file_key') = (to_jsonb(OLD) - 'statement_file_key') THEN
      RETURN NEW;
    END IF;
    -- Reconcile an unverified recipient once, nothing else changing.
    IF OLD.recipient_unverified = true AND OLD.recipient_user_id IS NULL
       AND NEW.recipient_unverified = false
       AND (to_jsonb(NEW) - ARRAY['recipient_user_id', 'recipient_unverified'])
         = (to_jsonb(OLD) - ARRAY['recipient_user_id', 'recipient_unverified']) THEN
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SH-04: lines of distribution run % are frozen (status %)',
    coalesce(NEW.distribution_run_id, OLD.distribution_run_id), run_status
    USING ERRCODE = '23514';
END $$;
