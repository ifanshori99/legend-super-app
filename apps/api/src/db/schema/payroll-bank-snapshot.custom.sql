-- legend-89cl7: payee bank snapshot per bank_transfer payslip, written once in
-- the lock transaction (the run is `locked` and the payslip exists). Tenant
-- RLS, never deleted by the app role, never rewritten: only the sealed value +
-- key version move together, in the reseal job's transaction (same contract as
-- payslips, 0248).
SELECT app.enforce_tenant_rls('public.payslip_bank_snapshots'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, UPDATE ON TABLE public.payslip_bank_snapshots FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (snapshot_encrypted, pii_key_version) ON TABLE public.payslip_bank_snapshots TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payslip_bank_snapshots_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  slip_run uuid;
  slip_employee uuid;
  slip_method text;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.status INTO run_status FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id;
    IF run_status IS DISTINCT FROM 'locked' THEN
      RAISE EXCEPTION 'PAYR-01: a bank snapshot needs a locked run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    SELECT s.payroll_run_id, s.employee_id, s.payment_method
      INTO slip_run, slip_employee, slip_method
      FROM public.payslips s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.payslip_id;
    IF slip_run IS DISTINCT FROM NEW.payroll_run_id
      OR slip_employee IS DISTINCT FROM NEW.employee_id
      OR slip_method IS DISTINCT FROM 'bank_transfer'
    THEN
      RAISE EXCEPTION 'PAYR-04: bank snapshot % does not match a bank_transfer payslip of its run', NEW.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PAYR-04: bank snapshot % is frozen; only the reseal job may re-key it', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.snapshot_encrypted IS NOT DISTINCT FROM OLD.snapshot_encrypted
    OR NEW.pii_key_version IS NULL
    OR NEW.pii_key_version <= OLD.pii_key_version
  THEN
    RAISE EXCEPTION 'PAYR-KEY: bank snapshot % reseal must change the sealed value and raise the key version', OLD.id
      USING ERRCODE = '23514';
  END IF;
  target_text := current_setting('app.payroll_reseal_target_version', true);
  IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
    RAISE EXCEPTION 'PAYR-KEY: bank snapshot % key version is above the active key version', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYR-KEY: bank snapshot % reseal must not change any other column', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payslip_bank_snapshots_guard_trg BEFORE INSERT OR UPDATE ON public.payslip_bank_snapshots FOR EACH ROW EXECUTE FUNCTION app.payslip_bank_snapshots_guard();
