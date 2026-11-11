CREATE TABLE "wfc_payment_captures" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"capture_key" varchar(64) NOT NULL,
	"sale_kind" varchar(20) NOT NULL,
	"sale_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_payment_captures_pkey" PRIMARY KEY("tenant_id","capture_key"),
	CONSTRAINT "wfc_payment_captures_kind_check" CHECK ("wfc_payment_captures"."sale_kind" IN ('seat_reservation', 'day_pass', 'bundle'))
);
--> statement-breakpoint
ALTER TABLE "facility_products" ADD COLUMN "duration_minutes" smallint;--> statement-breakpoint
ALTER TABLE "wfc_seat_reservations" ADD COLUMN "payment_ref" varchar(100);--> statement-breakpoint
ALTER TABLE "wfc_bundles" ADD COLUMN "menu_item_id" uuid;--> statement-breakpoint
ALTER TABLE "wfc_payment_captures" ADD CONSTRAINT "wfc_payment_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfc_payment_captures" ADD CONSTRAINT "wfc_payment_captures_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wfc_payment_captures_line_idx" ON "wfc_payment_captures" USING btree ("tenant_id","order_id","menu_item_id");--> statement-breakpoint
CREATE INDEX "wfc_payment_captures_sale_idx" ON "wfc_payment_captures" USING btree ("tenant_id","sale_id");--> statement-breakpoint
ALTER TABLE "wfc_bundle_purchases" ADD CONSTRAINT "wfc_bundle_purchases_customer_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wfc_seat_reservations_payment_ref_key" ON "wfc_seat_reservations" USING btree ("tenant_id","payment_ref") WHERE "wfc_seat_reservations"."payment_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_duration_check" CHECK ("facility_products"."duration_minutes" IS NULL OR "facility_products"."duration_minutes" BETWEEN 1 AND 1440);--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_seat_duration_check" CHECK ("facility_products"."wfc_kind" IS DISTINCT FROM 'seat_reservation' OR "facility_products"."duration_minutes" IS NOT NULL);
--> statement-breakpoint
-- WFC payment capture ledger (bead legend-bz9h round 3): every row is tenant
-- and outlet owned, so both guards apply (TEN-01, TEN-03). Append this block to
-- the generated wfc_payment_captures migration.
SELECT app.enforce_tenant_rls('public.wfc_payment_captures'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_payment_captures'::regclass);
