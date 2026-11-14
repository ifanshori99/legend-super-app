-- Custom SQL migration fragment for legend-6c0 (WS-04 cashier shift, cash
-- movements, end-of-day close). Append AFTER the drizzle-generated CREATE
-- TABLE statements for pos_shifts, cash_movements and pos_daily_closes.
--
-- PRD v1.7 POS-03: "Tutup shift memakai blind count; selisih kas tidak dapat
-- disembunyikan atau diubah setelah disetujui". The service checks the same
-- rules first (contract closeShift / assertShiftCountEditable /
-- assertCashMovementAllowed); these triggers are the database backstop.

-- 1. A shift's identity never changes, a closed shift never changes at all,
--    and no shift is ever deleted (the variance stays on record).
CREATE OR REPLACE FUNCTION app.pos_shifts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  count_shift uuid;
  count_counted bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS-03: shift % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'POS-03: shift % is closed; its count and variance are locked', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.outlet_id <> OLD.outlet_id
    OR NEW.device_id <> OLD.device_id
    OR NEW.cashier_id <> OLD.cashier_id
    OR NEW.business_date <> OLD.business_date
    OR NEW.opened_at <> OLD.opened_at
    OR NEW.opening_float_idr <> OLD.opening_float_idr
    OR NEW.open_key <> OLD.open_key
    OR NEW.open_fingerprint <> OLD.open_fingerprint
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'POS-03: shift % identity and opening float cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- The close must use a count of this very shift with the same counted cash.
  IF NEW.status = 'closed' THEN
    SELECT c.shift_id, c.counted_idr INTO count_shift, count_counted
    FROM public.pos_shift_counts c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.count_id;
    IF count_shift IS DISTINCT FROM NEW.id
      OR count_counted IS DISTINCT FROM NEW.counted_idr
    THEN
      RAISE EXCEPTION 'POS-03: shift % must close with its own count', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_shifts_guard_trg"
  BEFORE UPDATE OR DELETE ON "pos_shifts"
  FOR EACH ROW EXECUTE FUNCTION app.pos_shifts_guard();
--> statement-breakpoint

-- 2. Cash movements are append-only and only land on an open shift of the
--    same outlet ("kas masuk dan keluar dengan alasan", F8 Shift Kasir).
CREATE OR REPLACE FUNCTION app.cash_movements_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  shift_status text;
  shift_outlet uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: cash movement % is history and cannot change', OLD.id
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
    RAISE EXCEPTION 'TEN-03: cash movement outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "cash_movements_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_movements"
  FOR EACH ROW EXECUTE FUNCTION app.cash_movements_guard();
--> statement-breakpoint

-- 3. A closed business day is history (POS-05: the figures WS-07 and WS-06
--    read never move after the close).
CREATE OR REPLACE FUNCTION app.pos_daily_closes_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-05: business day close % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_daily_closes_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pos_daily_closes"
  FOR EACH ROW EXECUTE FUNCTION app.pos_daily_closes_immutable();
--> statement-breakpoint

-- 4. Tenant + outlet RLS (TEN-01/TEN-03).
SELECT app.enforce_tenant_rls('public.pos_shifts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_shifts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.cash_movements'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movements'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_daily_closes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_daily_closes'::regclass);
--> statement-breakpoint

-- 5. Blind count submissions are append-only history and only land on an open
--    shift of the same outlet, submitted by that shift's cashier (forced
--    supervisor counts, U9, by anyone but that cashier).
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
  IF NOT NEW.forced AND lower(NEW.submitted_by) <> lower(shift_cashier) THEN
    RAISE EXCEPTION 'POS-03: shift count must be submitted by the shift cashier'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.forced AND lower(NEW.submitted_by) = lower(shift_cashier) THEN
    RAISE EXCEPTION 'POS-03: a forced shift count cannot be submitted by the shift cashier'
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
--> statement-breakpoint

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
--> statement-breakpoint

-- legend-y9bf: Tenant + outlet RLS (TEN-01/TEN-03) for the decisions on held
-- cash movements.
SELECT app.enforce_tenant_rls('public.cash_movement_outcomes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movement_outcomes'::regclass);
--> statement-breakpoint

-- A decision on a held cash movement is append-only history (enforce_tenant_rls
-- grants the app role UPDATE/DELETE, so the trigger and the REVOKE below close
-- that). It names a held movement (needs_approval) of the same shift and
-- outlet. 'approved' (booked into the drawer figures, legend-3l4q) and
-- 'rejected' (not booked, like 'expired') land only while that shift is open:
-- the close expires every undecided held movement. A decider is never the
-- cashier who recorded the movement (decided_by <> recorded_by, compared
-- case-insensitively like the shift approval check). The shift row is read FOR
-- SHARE so a decision waits for an in-flight close holding it FOR UPDATE. The
-- unique movement key refuses a second decision on the same movement,
-- including one on an expired movement.
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
--> statement-breakpoint
CREATE TRIGGER "cash_movement_outcomes_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_movement_outcomes"
  FOR EACH ROW EXECUTE FUNCTION app.cash_movement_outcomes_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.cash_movement_outcomes FROM legend_app;
