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
