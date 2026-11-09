-- Tenant + outlet RLS (TEN-01/TEN-03) for the refusal idempotency record.
SELECT app.enforce_tenant_rls('public.cash_movement_refusals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movement_refusals'::regclass);
--> statement-breakpoint

-- A refusal record is append-only history (enforce_tenant_rls grants the app
-- role UPDATE/DELETE, so the trigger and the REVOKE below close that) and only
-- lands on an open shift of the same outlet, like cash_movements.
CREATE OR REPLACE FUNCTION app.cash_movement_refusals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  shift_status text;
  shift_outlet uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: cash movement refusal % is history and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.outlet_id INTO shift_status, shift_outlet
  FROM public.pos_shifts s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id;
  IF shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'POS-03: shift % is not open', NEW.shift_id
      USING ERRCODE = '23514';
  END IF;
  IF shift_outlet <> NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement refusal outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "cash_movement_refusals_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_movement_refusals"
  FOR EACH ROW EXECUTE FUNCTION app.cash_movement_refusals_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.cash_movement_refusals FROM legend_app;
