-- legend-72nod: the overtime correction ledger (one row per target run,
-- employee and source run). Tenant RLS, no DELETE and no TRUNCATE for the app
-- role, and a guard: a row is written only for a locked run correcting an
-- earlier locked or paid run of the same legal entity, and is never edited
-- except settled -> reversed (the reversal of the target run).
SELECT app.enforce_tenant_rls('public.payroll_overtime_corrections'::regclass);
--> statement-breakpoint
REVOKE TRUNCATE, DELETE ON TABLE public.payroll_overtime_corrections FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_overtime_corrections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_status text;
  target_entity uuid;
  target_start date;
  source_status text;
  source_entity uuid;
  source_end date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'settled' AND NEW.status = 'reversed'
      AND NEW.reversed_at IS NOT NULL
      AND NEW.tenant_id = OLD.tenant_id AND NEW.target_run_id = OLD.target_run_id
      AND NEW.employee_id = OLD.employee_id AND NEW.source_run_id = OLD.source_run_id
      AND NEW.direction = OLD.direction AND NEW.amount_idr = OLD.amount_idr
      AND NEW.created_at = OLD.created_at
    THEN
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
--> statement-breakpoint
CREATE TRIGGER payroll_overtime_corrections_guard_trg BEFORE INSERT OR UPDATE ON public.payroll_overtime_corrections FOR EACH ROW EXECUTE FUNCTION app.payroll_overtime_corrections_guard();
--> statement-breakpoint
-- legend-72nod (architect P0-1, migration 0453): a run that is the SOURCE of a
-- settled correction row is never reversed; its target is reversed first. The
-- guard above holds the source row FOR SHARE when a row is inserted, so the
-- insert and the reversal cannot interleave.
CREATE OR REPLACE FUNCTION app.payroll_runs_overtime_source_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payroll_overtime_corrections c
      WHERE c.tenant_id = NEW.tenant_id
        AND c.source_run_id = NEW.id
        AND c.status = 'settled'
  ) THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % is the source of a settled overtime correction', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_overtime_source_reversal_trg BEFORE UPDATE OF status ON public.payroll_runs FOR EACH ROW WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed') EXECUTE FUNCTION app.payroll_runs_overtime_source_reversal_guard();
--> statement-breakpoint
-- legend-72nod (architect R1, migration 0454): the per-tenant start of the
-- correction (`payroll_overtime_correction_activations`). Tenant RLS; read-only
-- for the app role, rows come from the migration only.
SELECT app.enforce_tenant_rls('public.payroll_overtime_correction_activations'::regclass);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_overtime_correction_activations FROM legend_app;
