-- Persetujuan kas keluar ditahan (legend-3l4q, legend-ym2kr). One guard change,
-- no table change. The guard of cash_movement_outcomes no longer refuses an
-- 'approved' outcome outright: it now lands like 'rejected', only while the
-- movement's shift is open (the close expires every undecided held movement, so
-- a closed shift's figures never change). New rule: an 'approved' or 'rejected'
-- outcome needs decided_by different from the movement's recorded_by. Every
-- other rule is unchanged (held movement, same shift and outlet, shift read
-- FOR SHARE, no UPDATE/DELETE). Source of truth: pos-shift.custom.sql.
-- CREATE OR REPLACE of the 0149 body; trigger unchanged.
CREATE OR REPLACE FUNCTION app.cash_movement_outcomes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  movement_shift uuid;
  movement_outlet uuid;
  movement_held boolean;
  movement_recorder text;
  shift_status text;
  shift_outlet uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: cash movement outcome % is history and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  SELECT m.shift_id, m.outlet_id, m.needs_approval, m.recorded_by
  INTO movement_shift, movement_outlet, movement_held, movement_recorder
  FROM public.cash_movements m
  WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.movement_id;
  IF movement_held IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POS-03: cash movement % is not held for review', NEW.movement_id
      USING ERRCODE = '23514';
  END IF;
  IF movement_shift <> NEW.shift_id OR movement_outlet <> NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement outcome differs from its movement'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome IN ('approved', 'rejected')
     AND lower(NEW.decided_by) = lower(movement_recorder) THEN
    RAISE EXCEPTION 'POS-03: cash movement % cannot be decided by the cashier who recorded it', NEW.movement_id
      USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.outlet_id INTO shift_status, shift_outlet
  FROM public.pos_shifts s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id
  FOR SHARE;
  IF shift_outlet IS DISTINCT FROM NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement outcome outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome <> 'expired' AND shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'POS-03: shift % is closed; its held cash movements expired', NEW.shift_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
