CREATE TABLE "modifier_recipe_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"action" varchar(10) NOT NULL,
	"target_component_type" varchar(10),
	"target_component_id" uuid,
	"component_type" varchar(10),
	"component_id" uuid,
	"quantity" numeric(14,4),
	"uom_id" uuid,
	"waste_pct_bp" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "modifier_recipe_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "modifier_recipe_rules_action_check" CHECK ("modifier_recipe_rules"."action" IN ('add', 'replace', 'remove')),
	CONSTRAINT "modifier_recipe_rules_types_check" CHECK (("modifier_recipe_rules"."target_component_type" IS NULL OR "modifier_recipe_rules"."target_component_type" IN ('item', 'recipe'))
        AND ("modifier_recipe_rules"."component_type" IS NULL OR "modifier_recipe_rules"."component_type" IN ('item', 'recipe'))),
	CONSTRAINT "modifier_recipe_rules_quantity_check" CHECK ("modifier_recipe_rules"."quantity" IS NULL OR "modifier_recipe_rules"."quantity" > 0),
	CONSTRAINT "modifier_recipe_rules_waste_check" CHECK ("modifier_recipe_rules"."waste_pct_bp" BETWEEN 0 AND 9999),
	CONSTRAINT "modifier_recipe_rules_shape_check" CHECK ((
        "modifier_recipe_rules"."action" = 'add'
        AND "modifier_recipe_rules"."target_component_type" IS NULL AND "modifier_recipe_rules"."target_component_id" IS NULL
        AND "modifier_recipe_rules"."component_type" IS NOT NULL AND "modifier_recipe_rules"."component_id" IS NOT NULL
        AND "modifier_recipe_rules"."quantity" IS NOT NULL AND "modifier_recipe_rules"."uom_id" IS NOT NULL
      ) OR (
        "modifier_recipe_rules"."action" = 'replace'
        AND "modifier_recipe_rules"."target_component_type" IS NOT NULL AND "modifier_recipe_rules"."target_component_id" IS NOT NULL
        AND "modifier_recipe_rules"."component_type" IS NOT NULL AND "modifier_recipe_rules"."component_id" IS NOT NULL
        AND "modifier_recipe_rules"."quantity" IS NOT NULL AND "modifier_recipe_rules"."uom_id" IS NOT NULL
      ) OR (
        "modifier_recipe_rules"."action" = 'remove'
        AND "modifier_recipe_rules"."target_component_type" IS NOT NULL AND "modifier_recipe_rules"."target_component_id" IS NOT NULL
        AND "modifier_recipe_rules"."component_type" IS NULL AND "modifier_recipe_rules"."component_id" IS NULL
        AND "modifier_recipe_rules"."quantity" IS NULL AND "modifier_recipe_rules"."uom_id" IS NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "outlet_inventory_settings" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"recipe_deduction_mode" varchar(20),
	"sale_location_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlet_inventory_settings_pkey" PRIMARY KEY("tenant_id","outlet_id"),
	CONSTRAINT "outlet_inventory_settings_mode_check" CHECK ("outlet_inventory_settings"."recipe_deduction_mode" IS NULL OR "outlet_inventory_settings"."recipe_deduction_mode" IN ('real_time', 'close_of_day'))
);
--> statement-breakpoint
CREATE TABLE "recipe_deduction_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"deduction_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4),
	"ledger_entry_id" uuid,
	CONSTRAINT "recipe_deduction_lines_tenant_deduction_item_key" UNIQUE("tenant_id","deduction_id","inventory_item_id"),
	CONSTRAINT "recipe_deduction_lines_quantity_check" CHECK ("recipe_deduction_lines"."quantity" > 0),
	CONSTRAINT "recipe_deduction_lines_unit_cost_check" CHECK ("recipe_deduction_lines"."unit_cost_idr" IS NULL OR "recipe_deduction_lines"."unit_cost_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" text NOT NULL,
	"business_date" date NOT NULL,
	"idempotency_key" varchar(120) NOT NULL,
	"cost_idr" bigint,
	"skip_reason" varchar(30),
	"reason" varchar(200),
	"recorded_by" text,
	"beneficiary_user_id" text,
	"shift_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversal_reason" varchar(20),
	"reversal_source_id" text,
	"reversal_failed_at" timestamp with time zone,
	CONSTRAINT "recipe_deductions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "recipe_deductions_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "recipe_deductions_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "recipe_deductions_kind_check" CHECK ("recipe_deductions"."kind" IN ('sale', 'remake', 'comp', 'duty_meal')),
	CONSTRAINT "recipe_deductions_status_check" CHECK ("recipe_deductions"."status" IN ('pending', 'posted', 'skipped', 'reversed')),
	CONSTRAINT "recipe_deductions_mode_check" CHECK ("recipe_deductions"."mode" IN ('real_time', 'close_of_day')),
	CONSTRAINT "recipe_deductions_source_type_check" CHECK ("recipe_deductions"."source_type" IN ('order', 'order_issue', 'duty_meal')),
	CONSTRAINT "recipe_deductions_skip_reason_check" CHECK ("recipe_deductions"."skip_reason" IS NULL OR "recipe_deductions"."skip_reason" IN ('no_recipe', 'no_sale_location', 'recipe_inactive', 'recipe_error')),
	CONSTRAINT "recipe_deductions_cost_check" CHECK ("recipe_deductions"."cost_idr" IS NULL OR "recipe_deductions"."cost_idr" >= 0),
	CONSTRAINT "recipe_deductions_posted_check" CHECK (("recipe_deductions"."status" = 'posted' AND "recipe_deductions"."posted_at" IS NOT NULL) OR ("recipe_deductions"."status" IN ('pending', 'skipped') AND "recipe_deductions"."posted_at" IS NULL) OR "recipe_deductions"."status" = 'reversed'),
	CONSTRAINT "recipe_deductions_reversed_check" CHECK (("recipe_deductions"."status" = 'reversed') = ("recipe_deductions"."reversed_at" IS NOT NULL)),
	CONSTRAINT "recipe_deductions_reversal_source_check" CHECK (("recipe_deductions"."reversed_at" IS NOT NULL OR "recipe_deductions"."reversal_failed_at" IS NOT NULL) = ("recipe_deductions"."reversal_reason" IS NOT NULL AND "recipe_deductions"."reversal_source_id" IS NOT NULL)),
	CONSTRAINT "recipe_deductions_reversal_failed_check" CHECK ("recipe_deductions"."reversal_failed_at" IS NULL OR "recipe_deductions"."status" = 'posted'),
	CONSTRAINT "recipe_deductions_reversal_reason_check" CHECK ("recipe_deductions"."reversal_reason" IS NULL OR "recipe_deductions"."reversal_reason" IN ('void')),
	CONSTRAINT "recipe_deductions_skipped_check" CHECK ("recipe_deductions"."status" <> 'skipped' OR "recipe_deductions"."skip_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"component_type" varchar(10) NOT NULL,
	"component_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"uom_id" uuid NOT NULL,
	"waste_pct_bp" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "recipe_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "recipe_lines_component_type_check" CHECK ("recipe_lines"."component_type" IN ('item', 'recipe')),
	CONSTRAINT "recipe_lines_quantity_check" CHECK ("recipe_lines"."quantity" > 0),
	CONSTRAINT "recipe_lines_waste_check" CHECK ("recipe_lines"."waste_pct_bp" BETWEEN 0 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"output_item_id" uuid,
	"yield_quantity" numeric(14,4) NOT NULL,
	"yield_uom_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"theoretical_cost_idr" numeric(14,4) DEFAULT '0' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "recipes_yield_check" CHECK ("recipes"."yield_quantity" > 0),
	CONSTRAINT "recipes_version_check" CHECK ("recipes"."version" >= 1),
	CONSTRAINT "recipes_cost_check" CHECK ("recipes"."theoretical_cost_idr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "modifier_recipe_rules" ADD CONSTRAINT "modifier_recipe_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_recipe_rules" ADD CONSTRAINT "modifier_recipe_rules_modifier_fk" FOREIGN KEY ("tenant_id","modifier_id") REFERENCES "public"."modifiers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_recipe_rules" ADD CONSTRAINT "modifier_recipe_rules_uom_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_inventory_settings" ADD CONSTRAINT "outlet_inventory_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_inventory_settings" ADD CONSTRAINT "outlet_inventory_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_inventory_settings" ADD CONSTRAINT "outlet_inventory_settings_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_inventory_settings" ADD CONSTRAINT "outlet_inventory_settings_location_fk" FOREIGN KEY ("tenant_id","outlet_id","sale_location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deduction_lines" ADD CONSTRAINT "recipe_deduction_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deduction_lines" ADD CONSTRAINT "recipe_deduction_lines_deduction_fk" FOREIGN KEY ("tenant_id","outlet_id","deduction_id") REFERENCES "public"."recipe_deductions"("tenant_id","outlet_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deduction_lines" ADD CONSTRAINT "recipe_deduction_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deduction_lines" ADD CONSTRAINT "recipe_deduction_lines_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deductions" ADD CONSTRAINT "recipe_deductions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deductions" ADD CONSTRAINT "recipe_deductions_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deductions" ADD CONSTRAINT "recipe_deductions_beneficiary_user_id_user_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_deductions" ADD CONSTRAINT "recipe_deductions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_uom_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_output_item_fk" FOREIGN KEY ("tenant_id","output_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_yield_uom_fk" FOREIGN KEY ("tenant_id","yield_uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "modifier_recipe_rules_tenant_modifier_idx" ON "modifier_recipe_rules" USING btree ("tenant_id","modifier_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_deductions_tenant_outlet_status_date_idx" ON "recipe_deductions" USING btree ("tenant_id","outlet_id","status","business_date");--> statement-breakpoint
CREATE INDEX "recipe_deductions_tenant_outlet_occurred_idx" ON "recipe_deductions" USING btree ("tenant_id","outlet_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "recipe_lines_tenant_recipe_idx" ON "recipe_lines" USING btree ("tenant_id","recipe_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipes_tenant_brand_name_idx" ON "recipes" USING btree ("tenant_id","brand_id","name","id");