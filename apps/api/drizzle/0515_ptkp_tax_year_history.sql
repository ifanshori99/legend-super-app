-- Define FKs while this new table is empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "employee_ptkp_history" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"ptkp_status" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_ptkp_history_pkey" PRIMARY KEY("tenant_id","employee_id","effective_from"),
	CONSTRAINT "employee_ptkp_history_status_check" CHECK ("employee_ptkp_history"."ptkp_status" IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3', 'K/I/0', 'K/I/1', 'K/I/2', 'K/I/3')),
	CONSTRAINT "employee_ptkp_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "employee_ptkp_history_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Backfill: every employee with a status gets it from his join date (no older
-- row exists, so it is the status of every tax year until HR changes it).
-- employees is FORCE RLS and the migrator is a plain owner without a tenant
-- context: FORCE is lifted for this migration only (one transaction, see 0258)
-- and restored right after. The new table has no RLS yet.
ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.employee_ptkp_history (tenant_id, employee_id, effective_from, ptkp_status)
SELECT e.tenant_id, e.id, e.join_date, e.ptkp_status
  FROM public.employees e
 WHERE e.ptkp_status IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Bead 1223 (SO 1221 A P2-1, PMK 168/2023): PTKP status history. The trigger
-- on employees is the only writer: an INSERT records the status from the join
-- date, a status change records it from the Jakarta date of the change (never
-- before the join date, so a change before the first working day replaces the
-- joining status). Two changes on one day keep the last. A NULL status is not
-- recorded. Tenant RLS, no DELETE or TRUNCATE for the app role.
SELECT app.enforce_tenant_rls('public.employee_ptkp_history'::regclass);
--> statement-breakpoint
REVOKE TRUNCATE, DELETE ON TABLE public.employee_ptkp_history FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_ptkp_history_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  effective date;
BEGIN
  IF NEW.ptkp_status IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.ptkp_status IS NOT DISTINCT FROM OLD.ptkp_status THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    effective := NEW.join_date;
  ELSE
    effective := GREATEST((now() AT TIME ZONE 'Asia/Jakarta')::date, NEW.join_date);
  END IF;
  INSERT INTO public.employee_ptkp_history (tenant_id, employee_id, effective_from, ptkp_status)
  VALUES (NEW.tenant_id, NEW.id, effective, NEW.ptkp_status)
  ON CONFLICT (tenant_id, employee_id, effective_from)
  DO UPDATE SET ptkp_status = EXCLUDED.ptkp_status, created_at = now();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER employees_ptkp_history_trg
  AFTER INSERT OR UPDATE OF ptkp_status ON public.employees
  FOR EACH ROW EXECUTE FUNCTION app.employee_ptkp_history_record();
