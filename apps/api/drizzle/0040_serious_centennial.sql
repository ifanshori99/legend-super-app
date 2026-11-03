CREATE TABLE "promotion_outlets" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_outlets_pkey" PRIMARY KEY("tenant_id","promotion_id","outlet_id")
);
--> statement-breakpoint
ALTER TABLE "facility_rewards" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD COLUMN "refunded_subtotal_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_outlets" ADD CONSTRAINT "promotion_outlets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_outlets" ADD CONSTRAINT "promotion_outlets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_outlets" ADD CONSTRAINT "promotion_outlets_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_outlets" ADD CONSTRAINT "promotion_outlets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotion_outlets_outlet_idx" ON "promotion_outlets" USING btree ("tenant_id","outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_rewards_daily_key" ON "facility_rewards" USING btree ("tenant_id","outlet_id","promotion_id","customer_profile_id","business_date") WHERE "facility_rewards"."business_date" IS NOT NULL AND "facility_rewards"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "promotion_order_applications_customer_day_idx" ON "promotion_order_applications" USING btree ("tenant_id","outlet_id","customer_profile_id","redeemed_at") WHERE "promotion_order_applications"."customer_profile_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_refund_check" CHECK ("promotion_order_applications"."refunded_subtotal_idr" >= 0 AND "promotion_order_applications"."refunded_subtotal_idr" <= "promotion_order_applications"."subtotal_idr");