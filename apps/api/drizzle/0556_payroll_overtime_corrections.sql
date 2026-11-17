-- Define FKs while this new table is empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "payroll_overtime_corrections" (
	"tenant_id" uuid NOT NULL,
	"target_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" varchar(10) DEFAULT 'settled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "payroll_overtime_corrections_pkey" PRIMARY KEY("tenant_id","target_run_id","employee_id","source_run_id"),
	CONSTRAINT "payroll_overtime_corrections_amount_check" CHECK ("payroll_overtime_corrections"."amount_idr" > 0),
	CONSTRAINT "payroll_overtime_corrections_direction_check" CHECK ("payroll_overtime_corrections"."direction" IN ('positive', 'negative')),
	CONSTRAINT "payroll_overtime_corrections_status_check" CHECK ("payroll_overtime_corrections"."status" IN ('settled', 'reversed')),
	CONSTRAINT "payroll_overtime_corrections_runs_check" CHECK ("payroll_overtime_corrections"."source_run_id" <> "payroll_overtime_corrections"."target_run_id"),
	CONSTRAINT "payroll_overtime_corrections_reversed_check" CHECK (("payroll_overtime_corrections"."status" = 'reversed') = ("payroll_overtime_corrections"."reversed_at" IS NOT NULL)),
	CONSTRAINT "payroll_overtime_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_overtime_corrections_target_fk" FOREIGN KEY ("tenant_id","target_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_overtime_corrections_source_fk" FOREIGN KEY ("tenant_id","source_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_overtime_corrections_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_overtime_corrections_source_idx" ON "payroll_overtime_corrections" USING btree ("tenant_id","employee_id","source_run_id");
--> statement-breakpoint
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
