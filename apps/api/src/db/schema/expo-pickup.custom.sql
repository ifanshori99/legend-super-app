-- Custom SQL migration fragment for legend-aiksz (expo runner assignment +
-- pickup call numbers). Append AFTER the drizzle-generated CREATE TABLE
-- statements for pickup_calls and expo_assignments (migration 0168).
--
-- Contract: @starter/shared/kitchen `PICKUP_CALL_TRANSITIONS` (assigned ->
-- called -> picked_up, picked_up terminal, repeats keep the first timestamp)
-- and `assignExpoRunner` / `markExpoOrderDelivered` (a delivered order keeps
-- its runner and its first deliveredAt). The CHECK constraints in
-- expo-pickup.ts hold per-row invariants; these triggers hold the ones that
-- compare OLD with NEW. The service still answers the 409s; the triggers are
-- the backstop (errcode 23514, like app.kds_append_only).

-- 1. pickup_calls: status never moves back; a set called_at / picked_up_at
--    is never changed.
CREATE OR REPLACE FUNCTION app.pickup_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  old_rank integer := array_position(ARRAY['assigned', 'called', 'picked_up'], OLD.status::text);
  new_rank integer := array_position(ARRAY['assigned', 'called', 'picked_up'], NEW.status::text);
BEGIN
  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'pickup_calls status cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.called_at IS NOT NULL AND NEW.called_at IS DISTINCT FROM OLD.called_at THEN
    RAISE EXCEPTION 'pickup_calls.called_at is kept once set' USING ERRCODE = '23514';
  END IF;
  IF OLD.picked_up_at IS NOT NULL AND NEW.picked_up_at IS DISTINCT FROM OLD.picked_up_at THEN
    RAISE EXCEPTION 'pickup_calls.picked_up_at is kept once set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pickup_calls_guard_trg"
  BEFORE UPDATE ON "pickup_calls"
  FOR EACH ROW EXECUTE FUNCTION app.pickup_call_guard();
--> statement-breakpoint
-- 2. expo_assignments: once delivered, the runner, delivered_at and
--    delivered_by never change and the row is never deleted
--    (EXPO_ORDER_DELIVERED). Before delivery the runner may be replaced.
CREATE OR REPLACE FUNCTION app.expo_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.delivered_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a delivered expo_assignments row cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.runner_id IS DISTINCT FROM OLD.runner_id
     OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     OR NEW.delivered_by IS DISTINCT FROM OLD.delivered_by THEN
    RAISE EXCEPTION 'a delivered expo_assignments row keeps its runner and delivery'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "expo_assignments_guard_trg"
  BEFORE UPDATE OR DELETE ON "expo_assignments"
  FOR EACH ROW EXECUTE FUNCTION app.expo_assignment_guard();
--> statement-breakpoint
-- 3. Tenant + outlet RLS (TEN-01/TEN-03). Both tables have outlet_id NOT NULL.
SELECT app.enforce_tenant_rls('public.pickup_calls'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pickup_calls'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.expo_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.expo_assignments'::regclass);
