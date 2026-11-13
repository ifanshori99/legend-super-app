CREATE TABLE "payroll_run_results" (
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"simulation_no" integer NOT NULL,
	"payment_method" varchar(20) NOT NULL,
	"result_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_run_results_pkey" PRIMARY KEY("tenant_id","payroll_run_id","employee_id"),
	CONSTRAINT "payroll_run_results_payslip_key" UNIQUE("tenant_id","payslip_id"),
	CONSTRAINT "payroll_run_results_simulation_no_check" CHECK ("payroll_run_results"."simulation_no" >= 1),
	CONSTRAINT "payroll_run_results_payment_method_check" CHECK ("payroll_run_results"."payment_method" IN ('bank_transfer', 'cash')),
	CONSTRAINT "payroll_run_results_key_version_check" CHECK ("payroll_run_results"."pii_key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payroll_run_results" ADD CONSTRAINT "payroll_run_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_results" ADD CONSTRAINT "payroll_run_results_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_results" ADD CONSTRAINT "payroll_run_results_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- legend-c2yca: sealed per-employee simulation results of a payroll run. The
-- simulation writes them (delete + insert) while the run is draft/simulated;
-- the lock reads them instead of caller numbers. From approval on they are
-- frozen (PAYR-02): no insert, no delete, and an update only from the reseal
-- job, which moves the sealed value + key version together (same contract as
-- payslip_bank_snapshots, 0472).
SELECT app.enforce_tenant_rls('public.payroll_run_results'::regclass);
--> statement-breakpoint
REVOKE TRUNCATE, UPDATE ON TABLE public.payroll_run_results FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (result_encrypted, pii_key_version) ON TABLE public.payroll_run_results TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_run_results_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_simulation_count integer;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    SELECT r.status, r.simulation_count INTO run_status, run_simulation_count
      FROM public.payroll_runs r
      WHERE r.tenant_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END
        AND r.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.payroll_run_id ELSE OLD.payroll_run_id END
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('draft', 'simulated') THEN
      RAISE EXCEPTION 'PAYR-02: payroll run % results are frozen after approval',
        CASE WHEN TG_OP = 'INSERT' THEN NEW.payroll_run_id ELSE OLD.payroll_run_id END
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW.simulation_no IS DISTINCT FROM run_simulation_count THEN
      RAISE EXCEPTION 'PAYR-02: payroll run % results must belong to its latest simulation', NEW.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only the reseal job re-keys a result; every other column stays.
  IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % results are frozen after approval', OLD.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.result_encrypted IS NOT DISTINCT FROM OLD.result_encrypted
    OR NEW.pii_key_version IS NULL
    OR NEW.pii_key_version <= OLD.pii_key_version
  THEN
    RAISE EXCEPTION 'PAYR-KEY: payroll run % result reseal must change the sealed value and raise the key version', OLD.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  target_text := current_setting('app.payroll_reseal_target_version', true);
  IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
    RAISE EXCEPTION 'PAYR-KEY: payroll run % result key version is above the active key version', OLD.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
    OR NEW.simulation_no IS DISTINCT FROM OLD.simulation_no
    OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % results are frozen after approval', OLD.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_run_results_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_run_results FOR EACH ROW EXECUTE FUNCTION app.payroll_run_results_guard();
