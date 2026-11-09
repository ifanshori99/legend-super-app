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

-- 0. Both tables: a row belongs to the outlet of its order. The composite
--    FK only checks (tenant_id, order_id), and FK checks ignore RLS, so
--    without this an outlet-A session could point a row at an outlet-B order.
--    Runs as the invoker: the order must also be visible under the session's
--    tenant + outlet RLS. Identity columns are frozen on UPDATE (below), so
--    INSERT is the only place to check.
CREATE OR REPLACE FUNCTION app.order_outlet_match() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.tenant_id = NEW.tenant_id
      AND o.id = NEW.order_id
      AND o.outlet_id = NEW.outlet_id
  ) THEN
    RAISE EXCEPTION '% row must belong to the outlet of its order', TG_TABLE_NAME
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pickup_calls_order_outlet_trg"
  BEFORE INSERT ON "pickup_calls"
  FOR EACH ROW EXECUTE FUNCTION app.order_outlet_match();
--> statement-breakpoint
CREATE TRIGGER "expo_assignments_order_outlet_trg"
  BEFORE INSERT ON "expo_assignments"
  FOR EACH ROW EXECUTE FUNCTION app.order_outlet_match();
--> statement-breakpoint
-- 1. pickup_calls: the order, outlet, number, business date and channel never
--    change; status moves one step at a time and never back (assigned ->
--    called -> picked_up, PICKUP_CALL_NOT_CALLED / PICKUP_CALL_CLOSED); a set
--    called_at / picked_up_at is never changed.
CREATE OR REPLACE FUNCTION app.pickup_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  old_rank integer := array_position(ARRAY['assigned', 'called', 'picked_up'], OLD.status::text);
  new_rank integer := array_position(ARRAY['assigned', 'called', 'picked_up'], NEW.status::text);
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.outlet_id IS DISTINCT FROM OLD.outlet_id
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'pickup_calls order, outlet, number, business_date and channel are fixed'
      USING ERRCODE = '23514';
  END IF;
  IF new_rank < old_rank OR new_rank > old_rank + 1 THEN
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
-- 2. expo_assignments: the order and outlet never change. Once delivered, the
--    runner, its assignment and the delivery never change and the row is never
--    deleted (EXPO_ORDER_DELIVERED). Before delivery the runner may be replaced.
CREATE OR REPLACE FUNCTION app.expo_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'a delivered expo_assignments row cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.outlet_id IS DISTINCT FROM OLD.outlet_id THEN
    RAISE EXCEPTION 'expo_assignments order and outlet are fixed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND (
       NEW.runner_id IS DISTINCT FROM OLD.runner_id
       OR NEW.runner_assigned_at IS DISTINCT FROM OLD.runner_assigned_at
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
       OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
       OR NEW.delivered_by IS DISTINCT FROM OLD.delivered_by) THEN
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
