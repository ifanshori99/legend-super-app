-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets and stations. Lift FORCE on those two for this
-- transaction only; it is restored right after the last foreign key, before
-- commit (drizzle applies pending migrations in one transaction, so no other
-- session ever sees the lifted state). tenants never had FORCE, so it is left
-- alone.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "device_training_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by" text,
	"ended_by" text,
	CONSTRAINT "device_training_periods_range_check" CHECK ("device_training_periods"."ended_at" IS NULL OR "device_training_periods"."ended_at" > "device_training_periods"."started_at")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"station_id" uuid,
	"label" varchar(255) NOT NULL,
	"version" varchar(255) DEFAULT 'unknown' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"training_mode" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" varchar(500),
	"enrolled_by" text,
	"token_issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "devices_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "devices_type_check" CHECK ("devices"."type" IN ('pos', 'kds', 'waiter_phone', 'printer', 'display', 'smart_lock', 'panic_button', 'edc')),
	CONSTRAINT "devices_status_check" CHECK (("devices"."status" = 'active' AND "devices"."revoked_at" IS NULL) OR ("devices"."status" = 'revoked' AND "devices"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "device_training_periods" ADD CONSTRAINT "device_training_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_training_periods" ADD CONSTRAINT "device_training_periods_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_training_periods" ADD CONSTRAINT "device_training_periods_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.stations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "device_training_periods_open_key" ON "device_training_periods" USING btree ("tenant_id","device_id") WHERE "device_training_periods"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "device_training_periods_device_idx" ON "device_training_periods" USING btree ("tenant_id","device_id","started_at");--> statement-breakpoint
CREATE INDEX "devices_sync_idx" ON "devices" USING btree ("tenant_id","outlet_id","updated_at","id");
--> statement-breakpoint
-- Device registry (bead legend-165; PRD v1.7 §3 F5 Registri Perangkat, Mode
-- Latihan, EDG-03). Fold into the generated migration after the CREATE TABLE
-- statements. CHECK constraints live in the drizzle schema (device.ts); this
-- file holds RLS and the invariants drizzle cannot express. Same migration on
-- the cloud and on every edge node.

-- TEN-01/TEN-03: both tables are tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.device_training_periods'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.device_training_periods'::regclass);
--> statement-breakpoint

-- Revocation is terminal (EDG-03): a revoked device never becomes active again,
-- its revocation record and token floor are frozen, and its identity (tenant,
-- outlet, id, type) never changes. A replacement device is a new enrollment.
CREATE FUNCTION app.guard_device_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'device identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked'
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
     OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at) THEN
    RAISE EXCEPTION 'a revoked device cannot be reactivated (EDG-03)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER devices_guard BEFORE UPDATE ON public.devices
FOR EACH ROW EXECUTE FUNCTION app.guard_device_update();

