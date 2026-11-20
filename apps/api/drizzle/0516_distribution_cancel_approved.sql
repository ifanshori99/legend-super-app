-- SO 1216 F-P1a review (card 1217): an approved run stuck by a reopen (it can
-- neither be paid, 0515, nor cancelled) blocks the reopen trigger forever.
-- distribution_runs_guard (latest definition: 0218) gains approved ->
-- cancelled when not one line is paid, with a reason of at least 10
-- characters. The service requires profit_share.distribution.approve.
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
      SELECT r.status, r.type, r.profit_entity_id, r.share_version INTO target
      FROM public.distribution_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.adjusts_run_id;
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
    ) THEN
      RAISE EXCEPTION 'SH-04: run % has a paid line and cannot be cancelled', OLD.id
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
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SH-04: distribution run cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END $$;
