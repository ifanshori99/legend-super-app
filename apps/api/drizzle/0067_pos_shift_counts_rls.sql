-- Hand-copied from src/db/schema/pos-shift.custom.sql section 5 (legend-6c0).
-- 5. Blind count submissions are append-only history and only land on an open
--    shift of the same outlet, submitted by that shift's cashier.
CREATE OR REPLACE FUNCTION app.pos_shift_counts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  shift_status text;
  shift_outlet uuid;
  shift_cashier text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: shift count % is history and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.outlet_id, s.cashier_id
  INTO shift_status, shift_outlet, shift_cashier
  FROM public.pos_shifts s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id;
  IF shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'POS-03: shift % is not open', NEW.shift_id
      USING ERRCODE = '23514';
  END IF;
  IF shift_outlet <> NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: shift count outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  IF lower(NEW.submitted_by) <> lower(shift_cashier) THEN
    RAISE EXCEPTION 'POS-03: shift count must be submitted by the shift cashier'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_shift_counts_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "pos_shift_counts"
  FOR EACH ROW EXECUTE FUNCTION app.pos_shift_counts_guard();
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_shift_counts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_shift_counts'::regclass);
