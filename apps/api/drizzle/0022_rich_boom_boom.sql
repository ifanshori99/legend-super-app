CREATE TABLE "combo_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"combo_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"options" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"revenue_allocation_bp" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "combo_components_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "combo_components_allocation_check" CHECK ("combo_components"."revenue_allocation_bp" >= 0 AND "combo_components"."revenue_allocation_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "combos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"combo_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "combos_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "item_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_limit" integer,
	"sold_out_until" timestamp with time zone,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "item_availability_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "item_availability_status_check" CHECK ("item_availability"."status" IN ('available', 'sold_out')),
	CONSTRAINT "item_availability_limit_check" CHECK ("item_availability"."daily_limit" IS NULL OR "item_availability"."daily_limit" >= 0),
	CONSTRAINT "item_availability_schedule_check" CHECK (jsonb_typeof("item_availability"."schedule") = 'array')
);
--> statement-breakpoint
CREATE TABLE "item_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"recipe_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "item_variants_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "menu_categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_categories_not_own_parent_check" CHECK ("menu_categories"."parent_id" IS NULL OR "menu_categories"."parent_id" <> "menu_categories"."id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"tenant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "menu_item_modifier_groups_tenant_item_group_key" UNIQUE("tenant_id","menu_item_id","group_id"),
	CONSTRAINT "menu_item_modifier_groups_sort_check" CHECK ("menu_item_modifier_groups"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" varchar(20) DEFAULT 'single' NOT NULL,
	"station_id" uuid,
	"course" varchar(20),
	"recipe_id" uuid,
	"tax_rule_id" uuid,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergens" text[] DEFAULT '{}'::text[] NOT NULL,
	"media_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "menu_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_items_type_check" CHECK ("menu_items"."type" IN ('single', 'combo')),
	CONSTRAINT "menu_items_sort_order_check" CHECK ("menu_items"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "modifier_groups_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "modifier_groups_min_max_check" CHECK ("modifier_groups"."min_select" >= 0 AND "modifier_groups"."max_select" >= "modifier_groups"."min_select" AND "modifier_groups"."max_select" <= 50)
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"price_idr" bigint DEFAULT 0 NOT NULL,
	"recipe_id" uuid,
	"station_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "modifiers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "modifiers_price_check" CHECK ("modifiers"."price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"variant_id" uuid,
	"price_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "price_list_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_list_items_price_check" CHECK ("price_list_items"."price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "price_lists_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_lists_channel_check" CHECK ("price_lists"."channel" IN ('dine_in', 'takeaway', 'gofood', 'grabfood', 'shopeefood', 'reservation'))
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"printer_device_id" uuid,
	"target_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stations_type_check" CHECK ("stations"."type" IN ('coffee_bar', 'beverage_bar', 'hot_kitchen', 'cold_kitchen', 'pastry')),
	CONSTRAINT "stations_target_seconds_check" CHECK ("stations"."target_seconds" IS NULL OR "stations"."target_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_combo_fk" FOREIGN KEY ("tenant_id","combo_id") REFERENCES "public"."combos"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combos" ADD CONSTRAINT "combos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combos" ADD CONSTRAINT "combos_item_fk" FOREIGN KEY ("tenant_id","combo_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_availability" ADD CONSTRAINT "item_availability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_availability" ADD CONSTRAINT "item_availability_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_availability" ADD CONSTRAINT "item_availability_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."menu_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."modifier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."menu_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."modifier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."item_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "combo_components_combo_idx" ON "combo_components" USING btree ("tenant_id","combo_id");--> statement-breakpoint
CREATE INDEX "combo_components_replication_idx" ON "combo_components" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "combos_item_key" ON "combos" USING btree ("tenant_id","combo_item_id") WHERE "combos"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "combos_replication_idx" ON "combos" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_availability_outlet_item_key" ON "item_availability" USING btree ("tenant_id","outlet_id","menu_item_id") WHERE "item_availability"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "item_availability_outlet_status_idx" ON "item_availability" USING btree ("tenant_id","outlet_id","status","id");--> statement-breakpoint
CREATE INDEX "item_availability_replication_idx" ON "item_availability" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_variants_item_name_key" ON "item_variants" USING btree ("tenant_id","menu_item_id","name") WHERE "item_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "item_variants_item_idx" ON "item_variants" USING btree ("tenant_id","menu_item_id");--> statement-breakpoint
CREATE INDEX "item_variants_replication_idx" ON "item_variants" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "menu_categories_brand_order_idx" ON "menu_categories" USING btree ("tenant_id","brand_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "menu_categories_replication_idx" ON "menu_categories" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_item_idx" ON "menu_item_modifier_groups" USING btree ("tenant_id","menu_item_id","sort_order");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_replication_idx" ON "menu_item_modifier_groups" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "menu_items_category_order_idx" ON "menu_items" USING btree ("tenant_id","category_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "menu_items_brand_order_idx" ON "menu_items" USING btree ("tenant_id","brand_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "menu_items_station_idx" ON "menu_items" USING btree ("tenant_id","station_id");--> statement-breakpoint
CREATE INDEX "menu_items_replication_idx" ON "menu_items" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "modifier_groups_name_idx" ON "modifier_groups" USING btree ("tenant_id","name","id");--> statement-breakpoint
CREATE INDEX "modifier_groups_replication_idx" ON "modifier_groups" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifiers_group_name_key" ON "modifiers" USING btree ("tenant_id","group_id","name") WHERE "modifiers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "modifiers_group_idx" ON "modifiers" USING btree ("tenant_id","group_id","id");--> statement-breakpoint
CREATE INDEX "modifiers_replication_idx" ON "modifiers" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_plain_key" ON "price_list_items" USING btree ("tenant_id","price_list_id","item_id") WHERE "price_list_items"."variant_id" IS NULL AND "price_list_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_variant_key" ON "price_list_items" USING btree ("tenant_id","price_list_id","item_id","variant_id") WHERE "price_list_items"."variant_id" IS NOT NULL AND "price_list_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "price_list_items_list_idx" ON "price_list_items" USING btree ("tenant_id","price_list_id","id");--> statement-breakpoint
CREATE INDEX "price_list_items_replication_idx" ON "price_list_items" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_outlet_channel_date_key" ON "price_lists" USING btree ("tenant_id","outlet_id","channel","effective_from") WHERE "price_lists"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "price_lists_outlet_idx" ON "price_lists" USING btree ("tenant_id","outlet_id","channel","effective_from");--> statement-breakpoint
CREATE INDEX "price_lists_replication_idx" ON "price_lists" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stations_outlet_name_key" ON "stations" USING btree ("tenant_id","outlet_id","name") WHERE "stations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stations_outlet_idx" ON "stations" USING btree ("tenant_id","outlet_id","id");--> statement-breakpoint
CREATE INDEX "stations_replication_idx" ON "stations" USING btree ("tenant_id","updated_at","id");