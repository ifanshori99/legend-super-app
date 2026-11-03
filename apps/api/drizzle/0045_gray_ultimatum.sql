CREATE TABLE "access_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source" varchar(20) NOT NULL,
	"entitlement_ledger_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cleaning_ends_at" timestamp with time zone NOT NULL,
	"grace_minutes" integer NOT NULL,
	"addons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(20) NOT NULL,
	"issued_offline" boolean DEFAULT false NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"overtime_fee_idr" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(120),
	"request_fingerprint" varchar(64),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tickets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "access_tickets_status_check" CHECK ("access_tickets"."status" IN ('pending_payment', 'issued', 'in_use', 'completed', 'no_show', 'cancelled', 'refunded')),
	CONSTRAINT "access_tickets_source_check" CHECK ("access_tickets"."source" IN ('purchase', 'package', 'min_spend', 'tier_benefit', 'subscription', 'staff_issue')),
	CONSTRAINT "access_tickets_slot_check" CHECK ("access_tickets"."ends_at" > "access_tickets"."starts_at" AND "access_tickets"."cleaning_ends_at" >= "access_tickets"."ends_at"),
	CONSTRAINT "access_tickets_overtime_check" CHECK ("access_tickets"."overtime_minutes" >= 0 AND "access_tickets"."overtime_fee_idr" >= 0 AND "access_tickets"."grace_minutes" >= 0),
	CONSTRAINT "access_tickets_fingerprint_check" CHECK (("access_tickets"."idempotency_key" IS NULL) = ("access_tickets"."request_fingerprint" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"session_minutes" integer NOT NULL,
	"cleaning_minutes" integer NOT NULL,
	"arrival_grace_minutes" integer NOT NULL,
	"operating_hours" jsonb NOT NULL,
	"overtime_policy" jsonb NOT NULL,
	"cancellation_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilities_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facilities_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "facilities_type_check" CHECK ("facilities"."type" IN ('shower', 'locker', 'meeting_room', 'coworking')),
	CONSTRAINT "facilities_minutes_check" CHECK ("facilities"."session_minutes" BETWEEN 1 AND 480 AND "facilities"."cleaning_minutes" BETWEEN 0 AND 240 AND "facilities"."arrival_grace_minutes" BETWEEN 0 AND 1440 AND "facilities"."session_minutes" + "facilities"."cleaning_minutes" <= 720)
);
--> statement-breakpoint
CREATE TABLE "facility_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"entrance_lock_device_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_areas_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_areas_tenant_facility_id_key" UNIQUE("tenant_id","facility_id","id"),
	CONSTRAINT "facility_areas_tenant_facility_name_key" UNIQUE("tenant_id","facility_id","name"),
	CONSTRAINT "facility_areas_sort_check" CHECK ("facility_areas"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "facility_queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_queue_entries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_queue_entries_status_check" CHECK ("facility_queue_entries"."status" IN ('waiting', 'notified', 'converted', 'expired')),
	CONSTRAINT "facility_queue_entries_notified_check" CHECK (("facility_queue_entries"."status" <> 'notified') OR "facility_queue_entries"."notified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "facility_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"lock_device_id" uuid,
	"panic_device_id" uuid,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_units_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_units_tenant_facility_id_key" UNIQUE("tenant_id","facility_id","id"),
	CONSTRAINT "facility_units_tenant_facility_code_key" UNIQUE("tenant_id","facility_id","code"),
	CONSTRAINT "facility_units_status_check" CHECK ("facility_units"."status" IN ('available', 'in_use', 'needs_cleaning', 'cleaning', 'maintenance')),
	CONSTRAINT "facility_units_sort_check" CHECK ("facility_units"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "access_tickets" ADD CONSTRAINT "access_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tickets" ADD CONSTRAINT "access_tickets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tickets" ADD CONSTRAINT "access_tickets_unit_fk" FOREIGN KEY ("tenant_id","facility_id","unit_id") REFERENCES "public"."facility_units"("tenant_id","facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tickets" ADD CONSTRAINT "access_tickets_area_fk" FOREIGN KEY ("tenant_id","facility_id","area_id") REFERENCES "public"."facility_areas"("tenant_id","facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tickets" ADD CONSTRAINT "access_tickets_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_areas" ADD CONSTRAINT "facility_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_areas" ADD CONSTRAINT "facility_areas_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_areas" ADD CONSTRAINT "facility_areas_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_queue_entries" ADD CONSTRAINT "facility_queue_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_queue_entries" ADD CONSTRAINT "facility_queue_entries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_queue_entries" ADD CONSTRAINT "facility_queue_entries_area_fk" FOREIGN KEY ("tenant_id","facility_id","area_id") REFERENCES "public"."facility_areas"("tenant_id","facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_queue_entries" ADD CONSTRAINT "facility_queue_entries_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_units" ADD CONSTRAINT "facility_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_units" ADD CONSTRAINT "facility_units_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_units" ADD CONSTRAINT "facility_units_area_fk" FOREIGN KEY ("tenant_id","facility_id","area_id") REFERENCES "public"."facility_areas"("tenant_id","facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_units" ADD CONSTRAINT "facility_units_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_tickets_idempotency_key" ON "access_tickets" USING btree ("tenant_id","customer_profile_id","idempotency_key") WHERE "access_tickets"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "access_tickets_ledger_key" ON "access_tickets" USING btree ("tenant_id","entitlement_ledger_id") WHERE "access_tickets"."entitlement_ledger_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "access_tickets_unit_slot_idx" ON "access_tickets" USING btree ("tenant_id","unit_id","starts_at");--> statement-breakpoint
CREATE INDEX "access_tickets_customer_idx" ON "access_tickets" USING btree ("tenant_id","customer_profile_id","starts_at");--> statement-breakpoint
CREATE INDEX "access_tickets_hold_expiry_idx" ON "access_tickets" USING btree ("tenant_id","hold_expires_at") WHERE "access_tickets"."status" = 'pending_payment';--> statement-breakpoint
CREATE INDEX "facilities_tenant_outlet_idx" ON "facilities" USING btree ("tenant_id","outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_queue_entries_active_key" ON "facility_queue_entries" USING btree ("tenant_id","facility_id","customer_profile_id") WHERE "facility_queue_entries"."status" IN ('waiting', 'notified');--> statement-breakpoint
CREATE INDEX "facility_queue_entries_order_idx" ON "facility_queue_entries" USING btree ("tenant_id","facility_id","area_id","status","joined_at");--> statement-breakpoint
CREATE INDEX "facility_units_tenant_area_idx" ON "facility_units" USING btree ("tenant_id","area_id","sort_order");