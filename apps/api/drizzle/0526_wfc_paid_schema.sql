-- Brief 1270 W1: paid WFC schema (seats, hourly quota, business settings, seat
-- claims, product split). Nothing sells yet (WFC_SALES_ENABLED is off).
-- FKs are defined while the new tables are empty: a later ADD CONSTRAINT would
-- scan the FORCE-RLS parents as a plain owner without a tenant context (0519).
-- The composite floor_zones key comes first: wfc_seats references it.
ALTER TABLE "floor_zones" ADD CONSTRAINT "floor_zones_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id");
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "wfc_kind" varchar(20);
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "wfc_access" varchar(10);
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "seat_fee_idr" bigint;
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "credit_idr" bigint;
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "duration_minutes" smallint;
--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_wfc_check" CHECK (("facility_products"."wfc_kind" IS NULL AND "facility_products"."wfc_access" IS NULL AND "facility_products"."seat_fee_idr" IS NULL AND "facility_products"."credit_idr" IS NULL AND "facility_products"."duration_minutes" IS NULL) OR ("facility_products"."wfc_kind" IS NOT NULL AND "facility_products"."wfc_kind" IN ('day_pass', 'seat_reservation') AND "facility_products"."wfc_access" IS NOT NULL AND "facility_products"."wfc_access" IN ('off_peak', 'all_day') AND "facility_products"."type" = 'single' AND "facility_products"."menu_item_id" IS NULL AND "facility_products"."sessions" = 1 AND "facility_products"."max_per_day" IS NULL AND "facility_products"."seat_fee_idr" IS NOT NULL AND "facility_products"."seat_fee_idr" > 0 AND "facility_products"."credit_idr" IS NOT NULL AND "facility_products"."credit_idr" > 0 AND "facility_products"."price_idr" = "facility_products"."seat_fee_idr" + "facility_products"."credit_idr" AND ("facility_products"."wfc_kind" = 'seat_reservation') = ("facility_products"."duration_minutes" IS NOT NULL) AND ("facility_products"."duration_minutes" IS NULL OR "facility_products"."duration_minutes" BETWEEN 1 AND 1440)));
--> statement-breakpoint
CREATE TABLE "wfc_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_seats_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_seats_zone_code_key" UNIQUE("tenant_id","outlet_id","zone_id","code"),
	CONSTRAINT "wfc_seats_status_check" CHECK ("wfc_seats"."status" IN ('active', 'inactive')),
	CONSTRAINT "wfc_seats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seats_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seats_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seats_zone_fk" FOREIGN KEY ("tenant_id","outlet_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "wfc_business_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"total_seats" integer NOT NULL,
	"wfc_seats" integer NOT NULL,
	"open_hours_per_month" integer NOT NULL,
	"fixed_cost_idr" bigint NOT NULL,
	"target_revenue_idr" bigint NOT NULL,
	"target_profit_idr" bigint NOT NULL,
	"target_occupancy_bp" integer NOT NULL,
	"spend_per_person_idr" bigint NOT NULL,
	"cogs_bp" integer NOT NULL,
	"avg_stay_minutes" integer NOT NULL,
	"no_show_minutes" integer DEFAULT 30 NOT NULL,
	"reason" varchar(500) NOT NULL,
	"proposed_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_business_settings_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_business_settings_version_key" UNIQUE("tenant_id","outlet_id","version"),
	CONSTRAINT "wfc_business_settings_two_person_check" CHECK ("wfc_business_settings"."proposed_by" <> "wfc_business_settings"."approved_by"),
	CONSTRAINT "wfc_business_settings_seats_check" CHECK ("wfc_business_settings"."wfc_seats" BETWEEN 1 AND "wfc_business_settings"."total_seats"),
	CONSTRAINT "wfc_business_settings_amount_check" CHECK ("wfc_business_settings"."fixed_cost_idr" > 0 AND "wfc_business_settings"."target_revenue_idr" > 0 AND "wfc_business_settings"."target_profit_idr" >= 0 AND "wfc_business_settings"."spend_per_person_idr" > 0),
	CONSTRAINT "wfc_business_settings_range_check" CHECK ("wfc_business_settings"."version" >= 1 AND "wfc_business_settings"."open_hours_per_month" BETWEEN 1 AND 744 AND "wfc_business_settings"."target_occupancy_bp" BETWEEN 1 AND 10000 AND "wfc_business_settings"."cogs_bp" BETWEEN 1 AND 9999 AND "wfc_business_settings"."avg_stay_minutes" BETWEEN 1 AND 1440 AND "wfc_business_settings"."no_show_minutes" BETWEEN 1 AND 240),
	CONSTRAINT "wfc_business_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_business_settings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_business_settings_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_business_settings_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_business_settings_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "wfc_hourly_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"hour" smallint NOT NULL,
	"seats" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_hourly_quotas_cell_key" UNIQUE("tenant_id","outlet_id","day_of_week","hour"),
	CONSTRAINT "wfc_hourly_quotas_cell_check" CHECK ("wfc_hourly_quotas"."day_of_week" BETWEEN 0 AND 6 AND "wfc_hourly_quotas"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "wfc_hourly_quotas_seats_check" CHECK ("wfc_hourly_quotas"."seats" BETWEEN 0 AND 1000),
	CONSTRAINT "wfc_hourly_quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_hourly_quotas_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_hourly_quotas_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_hourly_quotas_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "wfc_seat_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"access" varchar(10) NOT NULL,
	"business_date" date NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"starts_at" timestamp with time zone GENERATED ALWAYS AS (lower(slot)) STORED NOT NULL,
	"ends_at" timestamp with time zone GENERATED ALWAYS AS (upper(slot)) STORED NOT NULL,
	"status" varchar(20) NOT NULL,
	"seat_fee_idr" bigint NOT NULL,
	"credit_idr" bigint NOT NULL,
	"price_idr" bigint NOT NULL,
	"settings_version_id" uuid NOT NULL,
	"floor_per_hour_idr" bigint NOT NULL,
	"paid_idr" bigint DEFAULT 0 NOT NULL,
	"refunded_idr" bigint DEFAULT 0 NOT NULL,
	"payment_link_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_seat_reservations_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_seat_reservations_kind_check" CHECK ("wfc_seat_reservations"."kind" IN ('day_pass', 'seat_reservation') AND "wfc_seat_reservations"."access" IN ('off_peak', 'all_day')),
	CONSTRAINT "wfc_seat_reservations_status_check" CHECK ("wfc_seat_reservations"."status" IN ('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'refunded')),
	CONSTRAINT "wfc_seat_reservations_slot_check" CHECK (NOT isempty("wfc_seat_reservations"."slot") AND NOT lower_inf("wfc_seat_reservations"."slot") AND NOT upper_inf("wfc_seat_reservations"."slot") AND lower_inc("wfc_seat_reservations"."slot") AND NOT upper_inc("wfc_seat_reservations"."slot")),
	CONSTRAINT "wfc_seat_reservations_amount_check" CHECK ("wfc_seat_reservations"."seat_fee_idr" > 0 AND "wfc_seat_reservations"."credit_idr" > 0 AND "wfc_seat_reservations"."price_idr" = "wfc_seat_reservations"."seat_fee_idr" + "wfc_seat_reservations"."credit_idr" AND "wfc_seat_reservations"."floor_per_hour_idr" > 0 AND "wfc_seat_reservations"."paid_idr" >= 0 AND "wfc_seat_reservations"."paid_idr" <= "wfc_seat_reservations"."price_idr" AND "wfc_seat_reservations"."refunded_idr" >= 0 AND "wfc_seat_reservations"."refunded_idr" <= "wfc_seat_reservations"."paid_idr"),
	CONSTRAINT "wfc_seat_reservations_paid_check" CHECK ("wfc_seat_reservations"."status" NOT IN ('confirmed', 'checked_in', 'completed', 'no_show', 'refunded') OR ("wfc_seat_reservations"."paid_idr" = "wfc_seat_reservations"."price_idr" AND "wfc_seat_reservations"."payment_link_id" IS NOT NULL)),
	CONSTRAINT "wfc_seat_reservations_refund_check" CHECK (("wfc_seat_reservations"."status" <> 'refunded' OR "wfc_seat_reservations"."refunded_idr" = "wfc_seat_reservations"."paid_idr") AND ("wfc_seat_reservations"."status" NOT IN ('pending_payment', 'confirmed', 'checked_in') OR "wfc_seat_reservations"."refunded_idr" = 0)),
	CONSTRAINT "wfc_seat_reservations_hold_check" CHECK (("wfc_seat_reservations"."status" = 'pending_payment') = ("wfc_seat_reservations"."hold_expires_at" IS NOT NULL)),
	CONSTRAINT "wfc_seat_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_seat_fk" FOREIGN KEY ("tenant_id","outlet_id","seat_id") REFERENCES "public"."wfc_seats"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_product_fk" FOREIGN KEY ("tenant_id","outlet_id","product_id") REFERENCES "public"."facility_products"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_customer_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_settings_fk" FOREIGN KEY ("tenant_id","outlet_id","settings_version_id") REFERENCES "public"."wfc_business_settings"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_seat_reservations_link_fk" FOREIGN KEY ("tenant_id","payment_link_id") REFERENCES "public"."payment_links"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wfc_seat_reservations_payment_link_key" ON "wfc_seat_reservations" USING btree ("tenant_id","payment_link_id") WHERE "wfc_seat_reservations"."payment_link_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "wfc_seat_reservations_customer_idx" ON "wfc_seat_reservations" USING btree ("tenant_id","customer_profile_id","starts_at");
--> statement-breakpoint
CREATE INDEX "wfc_seat_reservations_outlet_idx" ON "wfc_seat_reservations" USING btree ("tenant_id","outlet_id","starts_at");
--> statement-breakpoint
CREATE INDEX "wfc_seat_reservations_hold_idx" ON "wfc_seat_reservations" USING btree ("tenant_id","hold_expires_at") WHERE "wfc_seat_reservations"."status" = 'pending_payment';
--> statement-breakpoint
CREATE INDEX "wfc_business_settings_effective_idx" ON "wfc_business_settings" USING btree ("tenant_id","outlet_id","effective_from","version");
--> statement-breakpoint
-- Hand SQL of the paid WFC tables (brief 1270 W1, migration 0526; PRD v1.7 §3
-- F25/F39, FAC-14). btree_gist comes from 0044.
--
-- A seat cannot be double-booked. Only claims that still occupy the seat count;
-- cancelled / no_show / refunded / completed drop out. The list is
-- WFC_ACTIVE_RESERVATION_STATUSES of @starter/shared/wfc.
ALTER TABLE "wfc_seat_reservations"
  ADD CONSTRAINT "wfc_seat_reservations_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "seat_id" WITH =,
    "slot" WITH &&
  ) WHERE (status IN ('pending_payment','confirmed','checked_in'));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML: a settings version is
-- append-only and a claim or seat (the base of a claim) is never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.wfc_business_settings FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seat_reservations FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seats FROM legend_app;
--> statement-breakpoint
CREATE TRIGGER "wfc_business_settings_append_only_trg"
  BEFORE UPDATE OR DELETE ON "wfc_business_settings"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
