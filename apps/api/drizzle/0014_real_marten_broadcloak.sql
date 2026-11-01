CREATE TABLE "floor_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"payment_mode" varchar(20) NOT NULL,
	"service_charge_bp" integer DEFAULT 0 NOT NULL,
	"minimum_spend_idr" bigint DEFAULT 0 NOT NULL,
	"hours" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floor_zones_tenant_outlet_name_key" UNIQUE("tenant_id","outlet_id","name"),
	CONSTRAINT "floor_zones_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "floor_zones_payment_mode_check" CHECK ("floor_zones"."payment_mode" IN ('pay_first', 'open_bill')),
	CONSTRAINT "floor_zones_status_check" CHECK ("floor_zones"."status" IN ('active', 'inactive')),
	CONSTRAINT "floor_zones_service_charge_check" CHECK ("floor_zones"."service_charge_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "floor_zones_minimum_spend_check" CHECK ("floor_zones"."minimum_spend_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"device_hash" varchar(128) NOT NULL,
	"user_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_participants_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "session_participants_device_key" UNIQUE("tenant_id","table_session_id","device_hash")
);
--> statement-breakpoint
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"pax" smallint NOT NULL,
	"payment_mode" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"session_token_hash" varchar(64) NOT NULL,
	"session_token_sealed" text NOT NULL,
	"confirmed_by" uuid,
	"reservation_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bill_requested_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_sessions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "table_sessions_token_hash_key" UNIQUE("tenant_id","session_token_hash"),
	CONSTRAINT "table_sessions_pax_check" CHECK ("table_sessions"."pax" BETWEEN 1 AND 30),
	CONSTRAINT "table_sessions_payment_mode_check" CHECK ("table_sessions"."payment_mode" IN ('pay_first', 'open_bill')),
	CONSTRAINT "table_sessions_status_check" CHECK ("table_sessions"."status" IN ('pending_confirmation', 'open', 'bill_requested', 'closed', 'voided')),
	CONSTRAINT "table_sessions_closed_reason_check" CHECK ("table_sessions"."closed_reason" IS NULL OR "table_sessions"."closed_reason" IN ('paid_and_cleaned', 'voided', 'expired')),
	CONSTRAINT "table_sessions_closed_pair_check" CHECK (("table_sessions"."status" IN ('closed', 'voided')) = ("table_sessions"."closed_at" IS NOT NULL AND "table_sessions"."closed_reason" IS NOT NULL)),
	CONSTRAINT "table_sessions_bill_requested_check" CHECK ("table_sessions"."status" <> 'bill_requested' OR "table_sessions"."bill_requested_at" IS NOT NULL),
	CONSTRAINT "table_sessions_open_bill_confirmation_check" CHECK ("table_sessions"."status" <> 'pending_confirmation' OR "table_sessions"."payment_mode" = 'open_bill')
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"capacity" smallint NOT NULL,
	"type" varchar(20) NOT NULL,
	"qr_token_hash" varchar(64),
	"qr_token_sealed" text,
	"layout" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tables_tenant_outlet_code_key" UNIQUE("tenant_id","outlet_id","code"),
	CONSTRAINT "tables_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tables_code_check" CHECK ("tables"."code" ~ '^[A-Z0-9-]{1,20}$'),
	CONSTRAINT "tables_capacity_check" CHECK ("tables"."capacity" BETWEEN 1 AND 50),
	CONSTRAINT "tables_type_check" CHECK ("tables"."type" IN ('regular', 'bar', 'sofa', 'private_room')),
	CONSTRAINT "tables_status_check" CHECK ("tables"."status" IN ('available', 'occupied', 'reserved', 'dirty', 'inactive')),
	CONSTRAINT "tables_qr_pair_check" CHECK (("tables"."qr_token_hash" IS NULL) = ("tables"."qr_token_sealed" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "floor_zones" ADD CONSTRAINT "floor_zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_zones" ADD CONSTRAINT "floor_zones_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_zones" ADD CONSTRAINT "floor_zones_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."tables"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "floor_zones_outlet_order_idx" ON "floor_zones" USING btree ("tenant_id","outlet_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "session_participants_session_idx" ON "session_participants" USING btree ("tenant_id","table_session_id","joined_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "table_sessions_active_table_key" ON "table_sessions" USING btree ("tenant_id","table_id") WHERE "table_sessions"."status" NOT IN ('closed', 'voided');--> statement-breakpoint
CREATE INDEX "table_sessions_outlet_status_idx" ON "table_sessions" USING btree ("tenant_id","outlet_id","status","opened_at");--> statement-breakpoint
CREATE INDEX "tables_outlet_zone_idx" ON "tables" USING btree ("tenant_id","outlet_id","zone_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tables_tenant_qr_hash_key" ON "tables" USING btree ("tenant_id","qr_token_hash") WHERE "tables"."qr_token_hash" IS NOT NULL;--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.floor_zones'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tables'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.table_sessions'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.session_participants'::regclass);
