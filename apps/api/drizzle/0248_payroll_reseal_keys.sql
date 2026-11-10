-- PAYR-KEY: payroll sealed values ride the HRIS key ring, so the reseal job
-- (worker/hris-pii-reseal.job.ts) must be able to move a sealed pay amount and
-- a sealed payslip calculation to the active key version. Everything else on
-- these rows stays frozen (HR-03 / PAYR-02 / PAYR-04).
GRANT UPDATE (amount_encrypted, pii_key_version) ON TABLE public.employee_pay_components TO legend_app;
--> statement-breakpoint
GRANT UPDATE (calculation_encrypted, pii_key_version) ON TABLE public.payslips TO legend_app;
--> statement-breakpoint
-- A change of the sealed amount or its key version is allowed only inside the
-- reseal job's transaction (transaction-local flag app.payroll_reseal = 'on'),
-- only when both change together to a positive version, and only when no other
-- column changes. The key version can only go up, and never above the target
-- version the job sets in the transaction-local app.payroll_reseal_target_version.
-- Closing a pay window behaves exactly as before.
CREATE OR REPLACE FUNCTION app.employee_pay_components_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_text text;
  target_version integer;
BEGIN
  IF NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version
  THEN
    IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % sealed amount can only be resealed by the reseal job', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.amount_encrypted IS NOT DISTINCT FROM OLD.amount_encrypted
      OR NEW.pii_key_version IS NOT DISTINCT FROM OLD.pii_key_version
      OR NEW.pii_key_version IS NULL
      OR NEW.pii_key_version <= 0
    THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % reseal must change the sealed amount and the key version together', OLD.id
        USING ERRCODE = '23514';
    END IF;
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % reseal target version missing', OLD.id
        USING ERRCODE = '23514';
    END IF;
    target_version := target_text::integer;
    IF NEW.pii_key_version <= OLD.pii_key_version THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % key version can only go up', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.pii_key_version > target_version THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % key version is above the active key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
      OR NEW.component_id IS DISTINCT FROM OLD.component_id
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'PAYR-KEY: pay component % reseal must not change any other column', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL THEN
    RAISE EXCEPTION 'PAYR-02: pay window % can only be closed once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payslips_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_text text;
  target_version integer;
BEGIN
  IF NEW.calculation_encrypted IS DISTINCT FROM OLD.calculation_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version
  THEN
    IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % sealed calculation can only be resealed by the reseal job', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.calculation_encrypted IS NOT DISTINCT FROM OLD.calculation_encrypted
      OR NEW.pii_key_version IS NOT DISTINCT FROM OLD.pii_key_version
      OR NEW.pii_key_version IS NULL
      OR NEW.pii_key_version <= 0
    THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % reseal must change the sealed calculation and the key version together', OLD.id
        USING ERRCODE = '23514';
    END IF;
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % reseal target version missing', OLD.id
        USING ERRCODE = '23514';
    END IF;
    target_version := target_text::integer;
    IF NEW.pii_key_version <= OLD.pii_key_version THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % key version can only go up', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.pii_key_version > target_version THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % key version is above the active key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
      OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
      OR NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key
      OR NEW.viewed_at IS DISTINCT FROM OLD.viewed_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'PAYR-KEY: payslip % reseal must not change any other column', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key)
    OR (OLD.viewed_at IS NOT NULL AND NEW.viewed_at IS DISTINCT FROM OLD.viewed_at)
  THEN
    RAISE EXCEPTION 'PAYR-04: payslip % PDF key and first view are set once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
