-- legend-qcioh (second opinion 971): the ledger guard allowed settled ->
-- reversed for any caller. Now the row is reversed only when its target run
-- is already `reversed` (the official order: the run is written first, then the
-- ledger is synced). The target row is held FOR SHARE so the check and the
-- update cannot interleave with a run status change. Identity and amount stay
-- immutable. The trigger from 0556 keeps pointing at this function.
CREATE OR REPLACE FUNCTION app.payroll_overtime_corrections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_status text;
  target_entity uuid;
  target_start date;
  source_status text;
  source_entity uuid;
  source_end date;
  settled_target_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'settled' AND NEW.status = 'reversed'
      AND NEW.reversed_at IS NOT NULL
      AND NEW.tenant_id = OLD.tenant_id AND NEW.target_run_id = OLD.target_run_id
      AND NEW.employee_id = OLD.employee_id AND NEW.source_run_id = OLD.source_run_id
      AND NEW.direction = OLD.direction AND NEW.amount_idr = OLD.amount_idr
      AND NEW.created_at = OLD.created_at
    THEN
      SELECT r.status INTO settled_target_status
        FROM public.payroll_runs r
        WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.target_run_id
        FOR SHARE;
      IF settled_target_status IS DISTINCT FROM 'reversed' THEN
        RAISE EXCEPTION 'PAYR-02: overtime correction of run % is reversed only after that run is reversed', OLD.target_run_id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PAYR-02: overtime correction of run % is never edited', OLD.target_run_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'settled' THEN
    RAISE EXCEPTION 'PAYR-02: overtime correction of run % starts settled', NEW.target_run_id
      USING ERRCODE = '23514';
  END IF;
  SELECT r.status, r.legal_entity_id, r.period_start INTO target_status, target_entity, target_start
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.target_run_id
    FOR SHARE;
  SELECT r.status, r.legal_entity_id, r.period_end INTO source_status, source_entity, source_end
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.source_run_id
    FOR SHARE;
  IF target_status IS NULL OR target_status <> 'locked'
    OR source_status IS NULL OR source_status NOT IN ('locked', 'paid')
    OR target_entity <> source_entity
    OR source_end >= target_start
  THEN
    RAISE EXCEPTION 'PAYR-02: overtime correction of run % does not match its runs', NEW.target_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
