CREATE TABLE "service_charge_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"code" varchar(40) NOT NULL,
	"name" varchar(150) NOT NULL,
	"rate_bp" integer NOT NULL,
	"zone_id" uuid,
	"order_types" jsonb NOT NULL,
	"item_classes" jsonb NOT NULL,
	"is_active" boolean NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_charge_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_charge_rules_rate_bp_check" CHECK ("service_charge_rules"."rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "service_charge_rules_version_check" CHECK ("service_charge_rules"."version" > 0),
	CONSTRAINT "service_charge_rules_status_check" CHECK ("service_charge_rules"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "service_charge_rules_published_meta_check" CHECK (("service_charge_rules"."status" = 'published') = ("service_charge_rules"."published_at" IS NOT NULL)
        AND ("service_charge_rules"."status" = 'published') = ("service_charge_rules"."published_by" IS NOT NULL)),
	CONSTRAINT "service_charge_rules_order_types_array_check" CHECK (jsonb_typeof("service_charge_rules"."order_types") = 'array'),
	CONSTRAINT "service_charge_rules_item_classes_array_check" CHECK (jsonb_typeof("service_charge_rules"."item_classes") = 'array'
        AND jsonb_array_length("service_charge_rules"."item_classes") > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"code" varchar(40) NOT NULL,
	"name" varchar(150) NOT NULL,
	"tax_type" varchar(20) NOT NULL,
	"rate_bp" integer NOT NULL,
	"region_code" varchar(20),
	"channels" jsonb NOT NULL,
	"applies_to" jsonb NOT NULL,
	"price_includes_tax" boolean NOT NULL,
	"include_service_in_base" boolean NOT NULL,
	"is_active" boolean NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_rules_tax_type_check" CHECK ("tax_rules"."tax_type" IN ('pbjt', 'ppn', 'other')),
	CONSTRAINT "tax_rules_rate_bp_check" CHECK ("tax_rules"."rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "tax_rules_version_check" CHECK ("tax_rules"."version" > 0),
	CONSTRAINT "tax_rules_status_check" CHECK ("tax_rules"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "tax_rules_published_meta_check" CHECK (("tax_rules"."status" = 'published') = ("tax_rules"."published_at" IS NOT NULL)
        AND ("tax_rules"."status" = 'published') = ("tax_rules"."published_by" IS NOT NULL)),
	CONSTRAINT "tax_rules_channels_array_check" CHECK (jsonb_typeof("tax_rules"."channels") = 'array'),
	CONSTRAINT "tax_rules_applies_to_object_check" CHECK (jsonb_typeof("tax_rules"."applies_to") = 'object')
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"calculation_order" varchar(30) NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"service_rounding_mode" varchar(20) NOT NULL,
	"tax_rounding_mode" varchar(20) NOT NULL,
	"inclusive_base_rounding_mode" varchar(20) NOT NULL,
	"bill_rounding" jsonb,
	"package_allocation" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_settings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_settings_calculation_order_check" CHECK ("tax_settings"."calculation_order" IN ('discount_service_tax')),
	CONSTRAINT "tax_settings_service_rounding_check" CHECK ("tax_settings"."service_rounding_mode" IN ('half_up', 'half_even', 'down', 'floor', 'ceil')),
	CONSTRAINT "tax_settings_tax_rounding_check" CHECK ("tax_settings"."tax_rounding_mode" IN ('half_up', 'half_even', 'down', 'floor', 'ceil')),
	CONSTRAINT "tax_settings_inclusive_rounding_check" CHECK ("tax_settings"."inclusive_base_rounding_mode" IN ('half_up', 'half_even', 'down', 'floor', 'ceil')),
	CONSTRAINT "tax_settings_package_allocation_check" CHECK ("tax_settings"."package_allocation" IN ('fixed_bp', 'standalone_price_ratio')),
	CONSTRAINT "tax_settings_bill_rounding_check" CHECK ("tax_settings"."bill_rounding" IS NULL OR jsonb_typeof("tax_settings"."bill_rounding") = 'object'),
	CONSTRAINT "tax_settings_version_check" CHECK ("tax_settings"."version" > 0),
	CONSTRAINT "tax_settings_status_check" CHECK ("tax_settings"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "tax_settings_published_meta_check" CHECK (("tax_settings"."status" = 'published') = ("tax_settings"."published_at" IS NOT NULL)
        AND ("tax_settings"."status" = 'published') = ("tax_settings"."published_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tax_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"tax_rule_id" uuid NOT NULL,
	"tax_rule_code" varchar(40) NOT NULL,
	"tax_rule_version" integer NOT NULL,
	"tax_type" varchar(20) NOT NULL,
	"rate_bp" integer NOT NULL,
	"price_includes_tax" boolean NOT NULL,
	"gross_idr" bigint NOT NULL,
	"tax_base_idr" bigint NOT NULL,
	"service_charge_idr" bigint NOT NULL,
	"tax_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_snapshots_source_rule_key" UNIQUE("tenant_id","source_type","source_id","tax_rule_id"),
	CONSTRAINT "tax_snapshots_source_type_check" CHECK ("tax_snapshots"."source_type" IN ('order', 'pos_sale', 'facility_ticket', 'preorder')),
	CONSTRAINT "tax_snapshots_amounts_check" CHECK ("tax_snapshots"."gross_idr" >= 0 AND "tax_snapshots"."tax_base_idr" >= 0
        AND "tax_snapshots"."service_charge_idr" >= 0 AND "tax_snapshots"."tax_idr" >= 0),
	CONSTRAINT "tax_snapshots_rate_bp_check" CHECK ("tax_snapshots"."rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "tax_snapshots_version_check" CHECK ("tax_snapshots"."tax_rule_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "service_charge_rules" ADD CONSTRAINT "service_charge_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_rules" ADD CONSTRAINT "service_charge_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_rules" ADD CONSTRAINT "service_charge_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_rule_fk" FOREIGN KEY ("tenant_id","tax_rule_id") REFERENCES "public"."tax_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_charge_rules_tenant_outlet_code_version_key" ON "service_charge_rules" USING btree ("tenant_id","outlet_id","code","version") WHERE "service_charge_rules"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_charge_rules_tenant_code_version_key" ON "service_charge_rules" USING btree ("tenant_id","code","version") WHERE "service_charge_rules"."outlet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "service_charge_rules_lookup_idx" ON "service_charge_rules" USING btree ("tenant_id","outlet_id","status","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_tenant_outlet_code_version_key" ON "tax_rules" USING btree ("tenant_id","outlet_id","code","version") WHERE "tax_rules"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_tenant_code_version_key" ON "tax_rules" USING btree ("tenant_id","code","version") WHERE "tax_rules"."outlet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tax_rules_lookup_idx" ON "tax_rules" USING btree ("tenant_id","outlet_id","status","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_settings_tenant_outlet_version_key" ON "tax_settings" USING btree ("tenant_id","outlet_id","version") WHERE "tax_settings"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_settings_tenant_version_key" ON "tax_settings" USING btree ("tenant_id","version") WHERE "tax_settings"."outlet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tax_settings_lookup_idx" ON "tax_settings" USING btree ("tenant_id","outlet_id","status","effective_from");--> statement-breakpoint
CREATE INDEX "tax_snapshots_recap_idx" ON "tax_snapshots" USING btree ("tenant_id","outlet_id","business_date");