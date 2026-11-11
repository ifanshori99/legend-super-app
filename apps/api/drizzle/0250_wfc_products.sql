CREATE TABLE "wfc_day_pass_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"payment_ref" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'paid' NOT NULL,
	"price_idr" bigint NOT NULL,
	"paid_idr" bigint NOT NULL,
	"refunded_idr" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_day_pass_purchases_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_day_pass_purchases_payment_ref_key" UNIQUE("tenant_id","payment_ref"),
	CONSTRAINT "wfc_day_pass_purchases_status_check" CHECK ("wfc_day_pass_purchases"."status" IN ('paid', 'refunded')),
	CONSTRAINT "wfc_day_pass_purchases_amount_check" CHECK ("wfc_day_pass_purchases"."price_idr" >= 0 AND "wfc_day_pass_purchases"."paid_idr" = "wfc_day_pass_purchases"."price_idr" AND "wfc_day_pass_purchases"."refunded_idr" >= 0 AND "wfc_day_pass_purchases"."refunded_idr" <= "wfc_day_pass_purchases"."paid_idr")
);
--> statement-breakpoint
CREATE TABLE "wfc_seat_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"starts_at" timestamp with time zone GENERATED ALWAYS AS (lower(slot)) STORED NOT NULL,
	"ends_at" timestamp with time zone GENERATED ALWAYS AS (upper(slot)) STORED NOT NULL,
	"status" varchar(20) NOT NULL,
	"price_idr" bigint NOT NULL,
	"paid_idr" bigint DEFAULT 0 NOT NULL,
	"refunded_idr" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_seat_reservations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_seat_reservations_status_check" CHECK ("wfc_seat_reservations"."status" IN ('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'refunded')),
	CONSTRAINT "wfc_seat_reservations_slot_check" CHECK (NOT isempty("wfc_seat_reservations"."slot") AND NOT lower_inf("wfc_seat_reservations"."slot") AND NOT upper_inf("wfc_seat_reservations"."slot")),
	CONSTRAINT "wfc_seat_reservations_amount_check" CHECK ("wfc_seat_reservations"."price_idr" >= 0 AND "wfc_seat_reservations"."paid_idr" >= 0 AND "wfc_seat_reservations"."paid_idr" <= "wfc_seat_reservations"."price_idr" AND "wfc_seat_reservations"."refunded_idr" >= 0 AND "wfc_seat_reservations"."refunded_idr" <= "wfc_seat_reservations"."paid_idr")
);
--> statement-breakpoint
CREATE TABLE "wfc_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_seats_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_seats_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_seats_zone_code_key" UNIQUE("tenant_id","outlet_id","zone_id","code"),
	CONSTRAINT "wfc_seats_status_check" CHECK ("wfc_seats"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "wfc_bundle_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"product_id" uuid,
	"plan_id" uuid,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_bundle_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_bundle_items_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_bundle_items_component_check" CHECK (("wfc_bundle_items"."product_id" IS NULL) <> ("wfc_bundle_items"."plan_id" IS NULL)),
	CONSTRAINT "wfc_bundle_items_quantity_check" CHECK ("wfc_bundle_items"."quantity" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "wfc_bundle_purchase_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"allocated_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_bundle_purchase_allocations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_bundle_purchase_allocations_item_key" UNIQUE("tenant_id","purchase_id","item_id"),
	CONSTRAINT "wfc_bundle_purchase_allocations_amount_check" CHECK ("wfc_bundle_purchase_allocations"."allocated_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wfc_bundle_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"price_paid_idr" bigint NOT NULL,
	"refunded_idr" bigint DEFAULT 0 NOT NULL,
	"status" varchar(10) DEFAULT 'paid' NOT NULL,
	"payment_ref" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_bundle_purchases_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_bundle_purchases_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_bundle_purchases_payment_ref_key" UNIQUE("tenant_id","payment_ref"),
	CONSTRAINT "wfc_bundle_purchases_status_check" CHECK ("wfc_bundle_purchases"."status" IN ('paid', 'refunded')),
	CONSTRAINT "wfc_bundle_purchases_amount_check" CHECK ("wfc_bundle_purchases"."price_paid_idr" > 0 AND "wfc_bundle_purchases"."refunded_idr" >= 0 AND "wfc_bundle_purchases"."refunded_idr" <= "wfc_bundle_purchases"."price_paid_idr")
);
--> statement-breakpoint
CREATE TABLE "wfc_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"price_idr" bigint NOT NULL,
	"validity_days" integer DEFAULT 1 NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_bundles_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_bundles_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wfc_bundles_status_check" CHECK ("wfc_bundles"."status" IN ('active', 'inactive')),
	CONSTRAINT "wfc_bundles_amount_check" CHECK ("wfc_bundles"."price_idr" > 0 AND "wfc_bundles"."validity_days" BETWEEN 1 AND 366)
);
--> statement-breakpoint
CREATE TABLE "wfc_spend_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"customer_profile_id" uuid,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"min_spend_idr" bigint NOT NULL,
	"spent_idr" bigint DEFAULT 0 NOT NULL,
	"status" varchar(10) DEFAULT 'ok' NOT NULL,
	"nudge_count" integer DEFAULT 0 NOT NULL,
	"last_nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_spend_windows_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wfc_spend_windows_session_window_key" UNIQUE("tenant_id","table_session_id","window_start"),
	CONSTRAINT "wfc_spend_windows_status_check" CHECK ("wfc_spend_windows"."status" IN ('ok', 'below', 'nudged')),
	CONSTRAINT "wfc_spend_windows_amount_check" CHECK ("wfc_spend_windows"."min_spend_idr" > 0 AND "wfc_spend_windows"."spent_idr" >= 0),
	CONSTRAINT "wfc_spend_windows_range_check" CHECK ("wfc_spend_windows"."window_end" > "wfc_spend_windows"."window_start"),
	CONSTRAINT "wfc_spend_windows_nudge_check" CHECK ("nudge_count" BETWEEN 0 AND 2 AND (("nudge_count" = 0) = ("last_nudged_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "wfc_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "wfc_day_pass_purchases" ADD CONSTRAINT "wfc_day_pass_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_day_pass_purchases" ADD CONSTRAINT "wfc_day_pass_purchases_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_day_pass_purchases" ADD CONSTRAINT "wfc_day_pass_purchases_product_fk" FOREIGN KEY ("tenant_id","outlet_id","product_id") REFERENCES "public"."facility_products"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_day_pass_purchases" ADD CONSTRAINT "wfc_day_pass_purchases_customer_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD CONSTRAINT "wfc_seat_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD CONSTRAINT "wfc_seat_reservations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD CONSTRAINT "wfc_seat_reservations_seat_fk" FOREIGN KEY ("tenant_id","outlet_id","seat_id") REFERENCES "public"."wfc_seats"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD CONSTRAINT "wfc_seat_reservations_product_fk" FOREIGN KEY ("tenant_id","outlet_id","product_id") REFERENCES "public"."facility_products"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD CONSTRAINT "wfc_seat_reservations_customer_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seats" ADD CONSTRAINT "wfc_seats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seats" ADD CONSTRAINT "wfc_seats_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_seats" ADD CONSTRAINT "wfc_seats_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_zones" ADD CONSTRAINT "floor_zones_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id");--> statement-breakpoint
ALTER TABLE "wfc_seats" ADD CONSTRAINT "wfc_seats_zone_fk" FOREIGN KEY ("tenant_id","outlet_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_bundle_fk" FOREIGN KEY ("tenant_id","outlet_id","bundle_id") REFERENCES "public"."wfc_bundles"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_product_fk" FOREIGN KEY ("tenant_id","outlet_id","product_id") REFERENCES "public"."facility_products"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_items" ADD CONSTRAINT "wfc_bundle_items_plan_fk" FOREIGN KEY ("tenant_id","outlet_id","plan_id") REFERENCES "public"."facility_subscription_plans"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchase_allocations" ADD CONSTRAINT "wfc_bundle_purchase_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchase_allocations" ADD CONSTRAINT "wfc_bundle_purchase_allocations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchase_allocations" ADD CONSTRAINT "wfc_bundle_purchase_allocations_purchase_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_id") REFERENCES "public"."wfc_bundle_purchases"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchase_allocations" ADD CONSTRAINT "wfc_bundle_purchase_allocations_item_fk" FOREIGN KEY ("tenant_id","outlet_id","item_id") REFERENCES "public"."wfc_bundle_items"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchases" ADD CONSTRAINT "wfc_bundle_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchases" ADD CONSTRAINT "wfc_bundle_purchases_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchases" ADD CONSTRAINT "wfc_bundle_purchases_bundle_fk" FOREIGN KEY ("tenant_id","outlet_id","bundle_id") REFERENCES "public"."wfc_bundles"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundles" ADD CONSTRAINT "wfc_bundles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundles" ADD CONSTRAINT "wfc_bundles_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_bundles" ADD CONSTRAINT "wfc_bundles_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_spend_windows" ADD CONSTRAINT "wfc_spend_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_spend_windows" ADD CONSTRAINT "wfc_spend_windows_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_spend_windows" ADD CONSTRAINT "wfc_spend_windows_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_spend_windows" ADD CONSTRAINT "wfc_spend_windows_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_spend_windows" ADD CONSTRAINT "wfc_spend_windows_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wfc_day_pass_purchases_customer_idx" ON "wfc_day_pass_purchases" USING btree ("tenant_id","customer_profile_id");--> statement-breakpoint
CREATE INDEX "wfc_seat_reservations_seat_idx" ON "wfc_seat_reservations" USING btree ("tenant_id","seat_id","starts_at");--> statement-breakpoint
CREATE INDEX "wfc_seat_reservations_customer_idx" ON "wfc_seat_reservations" USING btree ("tenant_id","customer_profile_id","starts_at");--> statement-breakpoint
CREATE INDEX "wfc_seats_zone_idx" ON "wfc_seats" USING btree ("tenant_id","zone_id");--> statement-breakpoint
CREATE INDEX "wfc_bundle_items_bundle_idx" ON "wfc_bundle_items" USING btree ("tenant_id","bundle_id");--> statement-breakpoint
CREATE INDEX "wfc_bundle_purchases_customer_idx" ON "wfc_bundle_purchases" USING btree ("tenant_id","customer_profile_id");--> statement-breakpoint
CREATE INDEX "wfc_bundles_outlet_idx" ON "wfc_bundles" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "wfc_spend_windows_zone_idx" ON "wfc_spend_windows" USING btree ("tenant_id","zone_id","window_start");--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_wfc_kind_check" CHECK ("facility_products"."wfc_kind" IS NULL OR ("facility_products"."wfc_kind" IN ('day_pass', 'seat_reservation') AND "facility_products"."type" = 'single'));
--> statement-breakpoint
-- Hand SQL for wfc_seats, wfc_seat_reservations and wfc_day_pass_purchases
-- (bead legend-bz9h; PRD v1.7 §3 F25/F39, FAC-14). To be appended to the
-- generated `wfc_products` migration by the lead.

-- M5: a seat cannot be double-booked. Only holds that still occupy the seat
-- count; cancelled / no_show / refunded / completed drop out.
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
SELECT app.enforce_tenant_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_day_pass_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_day_pass_purchases'::regclass);

--> statement-breakpoint
-- WFC bundles (bead legend-bz9h): every row is tenant and outlet owned, so
-- both guards apply (TEN-01, TEN-03). Append this block to the generated
-- wfc_products migration.
SELECT app.enforce_tenant_rls('public.wfc_bundles'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundles'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_purchase_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_purchase_allocations'::regclass);

--> statement-breakpoint
-- Hand SQL for wfc_spend_windows (bead legend-bz9h; PRD v1.7 §3 F39, FAC-14).
-- To be appended to the generated `wfc_products` migration by the lead.
SELECT app.enforce_tenant_rls('public.wfc_spend_windows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_spend_windows'::regclass);
