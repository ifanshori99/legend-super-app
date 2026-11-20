-- Bead 1223 (SO 1221 A P2-1, PMK 168/2023): PTKP status history. The trigger
-- on employees is the only writer: an INSERT records the status from the join
-- date, a status change records it from the Jakarta date of the change (never
-- before the join date, so a change before the first working day replaces the
-- joining status). Two changes on one day keep the last. A NULL status is not
-- recorded. Tenant RLS; the app role only reads (migration 0516): the trigger
-- writes as its owner (SECURITY DEFINER). An HR correction sets
-- app.ptkp_effective_from to the day in force (never before the join date).
SELECT app.enforce_tenant_rls('public.employee_ptkp_history'::regclass);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.employee_ptkp_history FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_ptkp_history_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  effective date;
  requested text := current_setting('app.ptkp_effective_from', true);
BEGIN
  -- redefine-drops: now SECURITY DEFINER (the app role cannot write the
  -- history), and the unchanged-status skip moved below the HR correction branch.
  IF NEW.ptkp_status IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    effective := NEW.join_date;
  ELSIF requested IS NOT NULL AND requested <> '' THEN
    -- HR correction (hris-employee-ptkp.service.ts): the day it is in force,
    -- recorded even when the status itself is unchanged.
    effective := requested::date;
    IF effective < NEW.join_date THEN
      RAISE EXCEPTION 'HR-PTKP: PTKP status of employee % cannot start before the join date', NEW.id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.ptkp_status IS NOT DISTINCT FROM OLD.ptkp_status THEN
    RETURN NULL;
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
--> statement-breakpoint
-- A trigger function needs no EXECUTE grant to fire; nobody may call it.
REVOKE ALL ON FUNCTION app.employee_ptkp_history_record() FROM PUBLIC;
