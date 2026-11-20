-- SO 1216 F-P1a (card 1217): an approved profit distribution was still paid at
-- its old figures after its fiscal period was reopened and closed again.
--
-- 1. distribution_lines_guard (latest definition: 0239) pays a line only while
--    the run's fiscal period is closed at the run's fiscal_period_version.
-- 2. A closed period with an APPROVED (not fully paid) run cannot reopen: such
--    a run can neither be cancelled nor recalculated. A paid run does not
--    block; its correction is an adjustment run. The service refuses first
--    with PERIOD_HAS_APPROVED_DISTRIBUTION; this trigger also catches the
--    SECURITY DEFINER reopen function and the table owner.
CREATE OR REPLACE FUNCTION app.distribution_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_fiscal_period_id uuid;
  run_fiscal_period_version integer;
  period_status text;
  period_version integer;
  payment_cols text[] := ARRAY['payment_status', 'payment_ref', 'paid_at', 'paid_by',
    'recipient_user_id'];
BEGIN
  -- redefine-drops: the 0239 status-only SELECT now also reads the run's fiscal period and version
  SELECT r.status, r.fiscal_period_id, r.fiscal_period_version
    INTO run_status, run_fiscal_period_id, run_fiscal_period_version
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
--> statement-breakpoint
CREATE FUNCTION app.fiscal_periods_reopen_distribution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.distribution_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.fiscal_period_id = NEW.id
      AND r.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'fiscal period % has an approved, unpaid profit distribution; pay it before a reopen (PERIOD_HAS_APPROVED_DISTRIBUTION)', OLD.period
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_reopen_distribution_guard
  BEFORE UPDATE OF status ON public.fiscal_periods
  FOR EACH ROW
  WHEN (OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION app.fiscal_periods_reopen_distribution_guard();
