-- Define FKs while this new table is empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "payroll_loan_deductions" (
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_loan_deductions_pkey" PRIMARY KEY("tenant_id","payroll_run_id","loan_id"),
	CONSTRAINT "payroll_loan_deductions_amount_check" CHECK ("payroll_loan_deductions"."amount_idr" > 0),
	CONSTRAINT "payroll_loan_deductions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_loan_deductions_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_loan_deductions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_loan_deductions_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."employee_loans"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- legend-xo0xx: the kasbon installment a payroll run deducts, one row per
-- (run, loan). Rows are written while the run is draft/simulated, never edited,
-- and deleted only while the run is draft/simulated or while its reversal is
-- pending approval (the approved reversal restores each loan by exactly the
-- recorded amount, then deletes the rows, so a second approval finds none).
-- The amount never exceeds the loan's outstanding balance at write time.
SELECT app.enforce_tenant_rls('public.payroll_loan_deductions'::regclass);
--> statement-breakpoint
REVOKE TRUNCATE, UPDATE ON TABLE public.payroll_loan_deductions FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_loan_deductions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_reversal text;
  loan_employee uuid;
  loan_status text;
  loan_outstanding bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PAYR-02: payroll loan deductions of run % are never edited', OLD.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  SELECT r.status, r.reversal ->> 'status' INTO run_status, run_reversal
    FROM public.payroll_runs r
    WHERE r.tenant_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END
      AND r.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.payroll_run_id ELSE OLD.payroll_run_id END
    FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF run_status IS NULL
      OR NOT (run_status IN ('draft', 'simulated')
        OR (run_status = 'locked' AND run_reversal = 'pending'))
    THEN
      RAISE EXCEPTION 'PAYR-02: payroll loan deductions of run % are frozen', OLD.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF run_status IS NULL OR run_status NOT IN ('draft', 'simulated') THEN
    RAISE EXCEPTION 'PAYR-02: payroll loan deductions of run % are frozen after approval', NEW.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  SELECT l.employee_id, l.status, l.outstanding_idr
    INTO loan_employee, loan_status, loan_outstanding
    FROM public.employee_loans l
    WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.loan_id
    FOR SHARE;
  IF loan_employee IS NULL OR loan_employee <> NEW.employee_id THEN
    RAISE EXCEPTION 'PAYR-02: loan % does not belong to the deducted employee', NEW.loan_id
      USING ERRCODE = '23514';
  END IF;
  IF loan_status <> 'disbursed' THEN
    RAISE EXCEPTION 'PAYR-02: loan % is not disbursed and cannot be deducted', NEW.loan_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_idr > loan_outstanding THEN
    RAISE EXCEPTION 'PAYR-02: deduction for loan % exceeds its outstanding balance', NEW.loan_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_loan_deductions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_loan_deductions FOR EACH ROW EXECUTE FUNCTION app.payroll_loan_deductions_guard();
