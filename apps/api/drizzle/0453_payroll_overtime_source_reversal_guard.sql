-- legend-72nod (architect P0-1): a run that is the SOURCE of a settled overtime
-- correction ledger row cannot be reversed. The target run has to be reversed
-- first (its reversal turns the row `reversed`). Without it the reversed source
-- drops out of the plan and the same overtime is paid or taken a second time
-- by the next run. The target's lock holds FOR SHARE on the source row
-- (app.payroll_overtime_corrections_guard), so the two cannot interleave.
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
