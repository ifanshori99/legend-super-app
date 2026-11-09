-- legend-aiksz. Foreign keys are declared inside CREATE TABLE (pattern 1 in
-- migration-fk-force-rls.test.ts): an ALTER TABLE ... ADD FOREIGN KEY into the
-- FORCE RLS tables outlets/orders fails for a non-superuser migration owner.
CREATE TABLE "expo_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"runner_assigned_at" timestamp with time zone NOT NULL,
	"assigned_by" uuid,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expo_assignments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "expo_assignments_tenant_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "expo_assignments_delivered_by_check" CHECK (("expo_assignments"."delivered_at" IS NULL) = ("expo_assignments"."delivered_by" IS NULL)),
	CONSTRAINT "expo_assignments_delivered_order_check" CHECK ("expo_assignments"."delivered_at" IS NULL OR "expo_assignments"."delivered_at" >= "expo_assignments"."runner_assigned_at"),
	CONSTRAINT "expo_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "expo_assignments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "expo_assignments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id"),
	CONSTRAINT "expo_assignments_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "pickup_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"number" smallint NOT NULL,
	"business_date" date NOT NULL,
	"status" varchar(20) NOT NULL,
	"called_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_calls_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_calls_tenant_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "pickup_calls_outlet_day_number_key" UNIQUE("tenant_id","outlet_id","business_date","number"),
	CONSTRAINT "pickup_calls_status_check" CHECK ("pickup_calls"."status" IN ('assigned', 'called', 'picked_up')),
	CONSTRAINT "pickup_calls_channel_check" CHECK ("pickup_calls"."channel" IN ('takeaway', 'gofood', 'grabfood', 'shopeefood')),
	CONSTRAINT "pickup_calls_number_check" CHECK ("pickup_calls"."number" BETWEEN 1 AND 999),
	CONSTRAINT "pickup_calls_called_at_check" CHECK (("pickup_calls"."status" = 'assigned') = ("pickup_calls"."called_at" IS NULL)),
	CONSTRAINT "pickup_calls_picked_up_at_check" CHECK (("pickup_calls"."status" = 'picked_up') = ("pickup_calls"."picked_up_at" IS NOT NULL)),
	CONSTRAINT "pickup_calls_order_check" CHECK ("pickup_calls"."picked_up_at" IS NULL OR "pickup_calls"."picked_up_at" >= "pickup_calls"."called_at"),
	CONSTRAINT "pickup_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "pickup_calls_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "pickup_calls_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id"),
	CONSTRAINT "pickup_calls_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "expo_assignments_runner_idx" ON "expo_assignments" USING btree ("tenant_id","outlet_id","runner_id");--> statement-breakpoint
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
