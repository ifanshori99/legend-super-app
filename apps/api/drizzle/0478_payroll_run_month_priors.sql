CREATE TABLE "payroll_run_month_priors" (
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"prior_payroll_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_run_month_priors_pkey" PRIMARY KEY("tenant_id","payroll_run_id","prior_payroll_run_id"),
	CONSTRAINT "payroll_run_month_priors_distinct_check" CHECK ("payroll_run_month_priors"."payroll_run_id" <> "payroll_run_month_priors"."prior_payroll_run_id")
);
--> statement-breakpoint
ALTER TABLE "payroll_run_month_priors" ADD CONSTRAINT "payroll_run_month_priors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_month_priors" ADD CONSTRAINT "payroll_run_month_priors_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_month_priors" ADD CONSTRAINT "payroll_run_month_priors_prior_fk" FOREIGN KEY ("tenant_id","prior_payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_run_month_priors_prior_idx" ON "payroll_run_month_priors" USING btree ("tenant_id","prior_payroll_run_id");
--> statement-breakpoint
-- legend-ihjan: month-dependency edges written once in the lock transaction
-- (PAYR-05). Tenant RLS, append-only for the app role. A reversal of a prior
-- run is refused while a live (locked/paid) dependent exists.
SELECT app.enforce_tenant_rls('public.payroll_run_month_priors'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_run_month_priors FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_run_month_priors_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_entity uuid;
  run_pay_date date;
  prior_status text;
  prior_entity uuid;
  prior_pay_date date;
BEGIN
  SELECT r.status, r.legal_entity_id, r.pay_date
    INTO run_status, run_entity, run_pay_date
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id;
  IF run_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'PAYR-05: a month dependency needs a locked run (run % is %)', NEW.payroll_run_id, run_status
      USING ERRCODE = '23514';
  END IF;
  SELECT r.status, r.legal_entity_id, r.pay_date
    INTO prior_status, prior_entity, prior_pay_date
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.prior_payroll_run_id;
  IF prior_status IS NULL OR prior_status NOT IN ('locked', 'paid') THEN
    RAISE EXCEPTION 'PAYR-05: prior run % must be locked or paid (it is %)', NEW.prior_payroll_run_id, prior_status
      USING ERRCODE = '23514';
  END IF;
  IF prior_entity IS DISTINCT FROM run_entity
    OR date_trunc('month', prior_pay_date::timestamp) IS DISTINCT FROM date_trunc('month', run_pay_date::timestamp)
  THEN
    RAISE EXCEPTION 'PAYR-05: prior run % is not in the same legal entity and tax month as run %', NEW.prior_payroll_run_id, NEW.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_run_month_priors_guard_trg BEFORE INSERT ON public.payroll_run_month_priors FOR EACH ROW EXECUTE FUNCTION app.payroll_run_month_priors_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_runs_reversal_dependency_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payroll_run_month_priors d
      JOIN public.payroll_runs r ON r.tenant_id = d.tenant_id AND r.id = d.payroll_run_id
      WHERE d.tenant_id = NEW.tenant_id
        AND d.prior_payroll_run_id = NEW.id
        AND r.status IN ('locked', 'paid')
  ) THEN
    RAISE EXCEPTION 'PAYR-05: payroll run % has later runs of its tax month computed on it', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.bank_transfer_files f
      WHERE f.tenant_id = NEW.tenant_id
        AND f.payroll_run_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'PAYR-05: payroll run % has a bank transfer file', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_reversal_dependency_trg BEFORE UPDATE OF status ON public.payroll_runs FOR EACH ROW WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed') EXECUTE FUNCTION app.payroll_runs_reversal_dependency_guard();
