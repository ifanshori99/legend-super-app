CREATE TABLE "facility_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"facility_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"source_order_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"entitlement_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "facility_rewards_quantity_check" CHECK ("facility_rewards"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "promo_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"stacking_policy" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotion_customer_usage" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_customer_usage_pkey" PRIMARY KEY("tenant_id","promotion_id","customer_profile_id"),
	CONSTRAINT "promotion_customer_usage_uses_check" CHECK ("promotion_customer_usage"."uses" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_order_applications" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"customer_profile_id" uuid,
	"voucher_id" uuid,
	"subtotal_idr" bigint NOT NULL,
	"total_discount_idr" bigint NOT NULL,
	"result" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'applied' NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_by" text,
	"released_at" timestamp with time zone,
	"release_reason" varchar(300),
	CONSTRAINT "promotion_order_applications_pkey" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "promotion_order_applications_status_check" CHECK ("promotion_order_applications"."status" IN ('applied', 'released')),
	CONSTRAINT "promotion_order_applications_release_check" CHECK (("promotion_order_applications"."status" = 'released') = ("promotion_order_applications"."released_at" IS NOT NULL AND "promotion_order_applications"."release_reason" IS NOT NULL)),
	CONSTRAINT "promotion_order_applications_amount_check" CHECK ("promotion_order_applications"."subtotal_idr" >= 0 AND "promotion_order_applications"."total_discount_idr" >= 0 AND "promotion_order_applications"."total_discount_idr" <= "promotion_order_applications"."subtotal_idr")
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"promotion_id" uuid,
	"voucher_id" uuid,
	"customer_profile_id" uuid,
	"discount_idr" bigint NOT NULL,
	"free_items" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'applied' NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "promotion_redemptions_target_check" CHECK ("promotion_redemptions"."promotion_id" IS NOT NULL OR "promotion_redemptions"."voucher_id" IS NOT NULL),
	CONSTRAINT "promotion_redemptions_status_check" CHECK ("promotion_redemptions"."status" IN ('applied', 'released')),
	CONSTRAINT "promotion_redemptions_released_check" CHECK (("promotion_redemptions"."status" = 'released') = ("promotion_redemptions"."released_at" IS NOT NULL)),
	CONSTRAINT "promotion_redemptions_discount_check" CHECK ("promotion_redemptions"."discount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"status" varchar(20) NOT NULL,
	"code_hash" varchar(64),
	"voucher_required" boolean NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"conditions" jsonb NOT NULL,
	"benefit" jsonb NOT NULL,
	"stack_group" varchar(30) NOT NULL,
	"stackable" boolean NOT NULL,
	"priority" integer NOT NULL,
	"quota_total" integer,
	"quota_per_customer" integer,
	"budget_idr" bigint,
	"spent_idr" bigint DEFAULT 0 NOT NULL,
	"uses_total" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "promotions_status_check" CHECK ("promotions"."status" IN ('draft', 'active', 'paused', 'ended')),
	CONSTRAINT "promotions_validity_check" CHECK ("promotions"."ends_at" IS NULL OR "promotions"."ends_at" > "promotions"."starts_at"),
	CONSTRAINT "promotions_code_hash_check" CHECK ("promotions"."code_hash" IS NULL OR "promotions"."code_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "promotions_voucher_code_check" CHECK (NOT "promotions"."voucher_required" OR "promotions"."code_hash" IS NOT NULL),
	CONSTRAINT "promotions_quota_check" CHECK (("promotions"."quota_total" IS NULL OR "promotions"."quota_total" > 0) AND ("promotions"."quota_per_customer" IS NULL OR "promotions"."quota_per_customer" > 0)),
	CONSTRAINT "promotions_uses_check" CHECK ("promotions"."uses_total" >= 0 AND ("promotions"."quota_total" IS NULL OR "promotions"."uses_total" <= "promotions"."quota_total")),
	CONSTRAINT "promotions_budget_check" CHECK ("promotions"."spent_idr" >= 0 AND ("promotions"."budget_idr" IS NULL OR ("promotions"."budget_idr" >= 0 AND "promotions"."spent_idr" <= "promotions"."budget_idr")))
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid,
	"customer_profile_id" uuid,
	"code_hash" varchar(64) NOT NULL,
	"source" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'issued' NOT NULL,
	"value_idr" bigint,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text,
	"redeemed_at" timestamp with time zone,
	"redeemed_order_id" uuid,
	"cancelled_reason" varchar(300),
	CONSTRAINT "vouchers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vouchers_tenant_code_hash_key" UNIQUE("tenant_id","code_hash"),
	CONSTRAINT "vouchers_status_check" CHECK ("vouchers"."status" IN ('issued', 'redeemed', 'expired', 'cancelled')),
	CONSTRAINT "vouchers_source_check" CHECK ("vouchers"."source" IN ('promo_code', 'apology', 'birthday', 'referral', 'campaign', 'manual')),
	CONSTRAINT "vouchers_code_hash_check" CHECK ("vouchers"."code_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "vouchers_value_check" CHECK (("vouchers"."promotion_id" IS NOT NULL) OR ("vouchers"."value_idr" IS NOT NULL AND "vouchers"."value_idr" > 0)),
	CONSTRAINT "vouchers_validity_check" CHECK ("vouchers"."valid_until" IS NULL OR "vouchers"."valid_until" > "vouchers"."valid_from"),
	CONSTRAINT "vouchers_redeemed_check" CHECK (("vouchers"."status" = 'redeemed') = ("vouchers"."redeemed_at" IS NOT NULL AND "vouchers"."redeemed_order_id" IS NOT NULL)),
	CONSTRAINT "vouchers_cancelled_check" CHECK (("vouchers"."status" = 'cancelled') = ("vouchers"."cancelled_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "facility_rewards" ADD CONSTRAINT "facility_rewards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_rewards" ADD CONSTRAINT "facility_rewards_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_rewards" ADD CONSTRAINT "facility_rewards_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_rewards" ADD CONSTRAINT "facility_rewards_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_settings" ADD CONSTRAINT "promo_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_customer_usage" ADD CONSTRAINT "promotion_customer_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_customer_usage" ADD CONSTRAINT "promotion_customer_usage_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."vouchers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_application_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."promotion_order_applications"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."vouchers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facility_rewards_order_promotion_key" ON "facility_rewards" USING btree ("tenant_id","source_order_id","promotion_id");--> statement-breakpoint
CREATE INDEX "facility_rewards_customer_idx" ON "facility_rewards" USING btree ("tenant_id","customer_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_order_promotion_key" ON "promotion_redemptions" USING btree ("tenant_id","order_id","promotion_id") WHERE "promotion_redemptions"."promotion_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_order_voucher_key" ON "promotion_redemptions" USING btree ("tenant_id","order_id","voucher_id") WHERE "promotion_redemptions"."promotion_id" IS NULL;--> statement-breakpoint
CREATE INDEX "promotion_redemptions_roi_idx" ON "promotion_redemptions" USING btree ("tenant_id","promotion_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_tenant_code_hash_key" ON "promotions" USING btree ("tenant_id","code_hash") WHERE "promotions"."code_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "promotions_tenant_status_idx" ON "promotions" USING btree ("tenant_id","status","starts_at");--> statement-breakpoint
CREATE INDEX "vouchers_tenant_status_idx" ON "vouchers" USING btree ("tenant_id","status","issued_at");--> statement-breakpoint
CREATE INDEX "vouchers_tenant_customer_idx" ON "vouchers" USING btree ("tenant_id","customer_profile_id");