-- legend-7ui6v / Payroll 549 / G688h: maker-checker for new payroll runs and
-- actual changes to their creator or approvers. Historical creator = approver
-- rows stay unchanged and may complete the existing locked -> paid/reversed
-- lifecycle. NOT VALID CHECKs still validate every UPDATE, so use a trigger.
-- CTO explicitly amends this historical upgrade path: a later migration cannot
-- repair an upgrade which already fails or blocks legitimate transitions here.
ALTER TABLE "payroll_runs" DROP CONSTRAINT IF EXISTS "payroll_runs_distinct_approvers_check";--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_runs_approvers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Existing legacy identities may continue through the allowed run lifecycle.
  -- Assigning the same values is not a new approval decision.
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.created_by, NEW.approved_by_hr, NEW.approved_by_finance)
      IS NOT DISTINCT FROM ROW(OLD.created_by, OLD.approved_by_hr, OLD.approved_by_finance)
    THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW.approved_by_hr IS NOT NULL AND NEW.approved_by_hr = NEW.created_by)
    OR (NEW.approved_by_finance IS NOT NULL AND NEW.approved_by_finance = NEW.created_by)
    OR (NEW.approved_by_hr IS NOT NULL AND NEW.approved_by_finance IS NOT NULL
      AND NEW.approved_by_hr = NEW.approved_by_finance)
  THEN
    RAISE EXCEPTION 'PAYR-01: payroll run % creator, HR and finance approvers must be distinct', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'payroll_runs_distinct_approvers_check';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_runs_approvers_guard_trg" ON "payroll_runs";
--> statement-breakpoint
CREATE TRIGGER "payroll_runs_approvers_guard_trg"
  BEFORE INSERT OR UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_approvers_guard();
