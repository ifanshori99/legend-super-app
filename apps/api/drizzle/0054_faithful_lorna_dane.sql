CREATE TABLE "entitlement_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"condition" jsonb NOT NULL,
	"sessions" integer NOT NULL,
	"validity" jsonb NOT NULL,
	"is_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "entitlement_rules_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "entitlement_rules_type_check" CHECK ("entitlement_rules"."type" IN ('min_spend', 'tier_benefit', 'package')),
	CONSTRAINT "entitlement_rules_sessions_check" CHECK ("entitlement_rules"."sessions" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "facility_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"price_idr" bigint NOT NULL,
	"inventory_item_id" uuid,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_addons_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_addons_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "facility_addons_amount_check" CHECK ("facility_addons"."price_idr" >= 0 AND "facility_addons"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "facility_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid,
	"access_ticket_id" uuid,
	"type" varchar(20) NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"responded_by" text,
	"responded_at" timestamp with time zone,
	"resolution" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_incidents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_incidents_type_check" CHECK ("facility_incidents"."type" IN ('panic', 'assist', 'damage'))
);
--> statement-breakpoint
CREATE TABLE "facility_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"price_idr" bigint NOT NULL,
	"tax_rule_id" uuid,
	"sessions" integer NOT NULL,
	"max_per_day" integer,
	"menu_item_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_products_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_products_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "facility_products_type_check" CHECK ("facility_products"."type" IN ('single', 'package_component', 'subscription_plan')),
	CONSTRAINT "facility_products_amount_check" CHECK ("facility_products"."price_idr" >= 0 AND "facility_products"."sessions" BETWEEN 1 AND 100 AND ("facility_products"."max_per_day" IS NULL OR "facility_products"."max_per_day" BETWEEN 1 AND 10))
);
--> statement-breakpoint
CREATE TABLE "facility_subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"price_idr" bigint NOT NULL,
	"quota_per_period" integer NOT NULL,
	"interval" varchar(10) NOT NULL,
	"max_per_day" integer,
	"provider_plan_id" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_subscription_plans_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_subscription_plans_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "facility_subscription_plans_interval_check" CHECK ("facility_subscription_plans"."interval" IN ('month', 'year')),
	CONSTRAINT "facility_subscription_plans_amount_check" CHECK ("facility_subscription_plans"."price_idr" >= 0 AND "facility_subscription_plans"."quota_per_period" BETWEEN 1 AND 100 AND ("facility_subscription_plans"."max_per_day" IS NULL OR "facility_subscription_plans"."max_per_day" BETWEEN 1 AND 10))
);
--> statement-breakpoint
CREATE TABLE "wifi_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"facility_id" uuid,
	"free_minutes" integer NOT NULL,
	"peak_free_minutes" integer NOT NULL,
	"spend_per_extra_hour_idr" bigint NOT NULL,
	"extra_minutes" integer NOT NULL,
	"max_devices" integer NOT NULL,
	"peak_schedule" jsonb NOT NULL,
	"base_speed_kbps" integer NOT NULL,
	"full_speed_kbps" integer NOT NULL,
	"min_spend_per_hour_idr" bigint,
	"tier_bonus_minutes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wifi_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wifi_policies_tenant_outlet_zone_key" UNIQUE("tenant_id","outlet_id","zone_id"),
	CONSTRAINT "wifi_policies_amount_check" CHECK ("wifi_policies"."free_minutes" >= 0 AND "wifi_policies"."peak_free_minutes" >= 0 AND "wifi_policies"."spend_per_extra_hour_idr" >= 0 AND "wifi_policies"."extra_minutes" BETWEEN 1 AND 1440 AND "wifi_policies"."max_devices" BETWEEN 1 AND 20 AND "wifi_policies"."base_speed_kbps" >= 1 AND "wifi_policies"."full_speed_kbps" >= 1 AND ("wifi_policies"."min_spend_per_hour_idr" IS NULL OR "wifi_policies"."min_spend_per_hour_idr" >= 0))
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"category" varchar(30) NOT NULL,
	"asset_id" uuid,
	"linked_menu_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" varchar(20) DEFAULT 'operational' NOT NULL,
	"temperature_threshold" jsonb,
	"disabled_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "equipment_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "equipment_category_check" CHECK ("equipment"."category" IN ('espresso_machine', 'grinder', 'blender', 'oven', 'water_filter', 'air_conditioner', 'water_heater', 'chiller', 'freezer', 'other')),
	CONSTRAINT "equipment_status_check" CHECK ("equipment"."status" IN ('operational', 'under_maintenance', 'broken', 'retired')),
	CONSTRAINT "equipment_linked_items_check" CHECK (array_length("equipment"."linked_menu_item_ids", 1) IS NULL OR array_length("equipment"."linked_menu_item_ids", 1) <= 100)
);
--> statement-breakpoint
CREATE TABLE "maintenance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"interval_days" integer NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"vendor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_schedules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "maintenance_schedules_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "maintenance_schedules_interval_check" CHECK ("maintenance_schedules"."interval_days" BETWEEN 1 AND 3650)
);
--> statement-breakpoint
CREATE TABLE "maintenance_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"reported_by" text NOT NULL,
	"urgency" varchar(20) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"media_ids" uuid[] NOT NULL,
	"vendor_id" uuid,
	"cost_idr" bigint,
	"status" varchar(20) DEFAULT 'reported' NOT NULL,
	"marks_equipment_broken" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_tickets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "maintenance_tickets_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "maintenance_tickets_urgency_check" CHECK ("maintenance_tickets"."urgency" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "maintenance_tickets_status_check" CHECK ("maintenance_tickets"."status" IN ('reported', 'in_progress', 'resolved', 'cancelled')),
	CONSTRAINT "maintenance_tickets_resolved_check" CHECK (("maintenance_tickets"."status" = 'resolved') = ("maintenance_tickets"."resolved_at" IS NOT NULL)),
	CONSTRAINT "maintenance_tickets_media_check" CHECK (array_length("maintenance_tickets"."media_ids", 1) BETWEEN 1 AND 10),
	CONSTRAINT "maintenance_tickets_cost_check" CHECK ("maintenance_tickets"."cost_idr" IS NULL OR "maintenance_tickets"."cost_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "operations_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"result_table" varchar(40) NOT NULL,
	"result_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_tenant_key_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "operations_idempotency_key_check" CHECK (length("operations_idempotency"."key") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ops_checklist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"shift_date" date NOT NULL,
	"shift_template_id" uuid,
	"assigned_to" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missed_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_checklist_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ops_checklist_runs_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "ops_checklist_runs_status_check" CHECK ("ops_checklist_runs"."status" IN ('pending', 'in_progress', 'completed', 'missed', 'failed')),
	CONSTRAINT "ops_checklist_runs_completed_check" CHECK (("ops_checklist_runs"."status" IN ('completed', 'failed')) = ("ops_checklist_runs"."completed_at" IS NOT NULL)),
	CONSTRAINT "ops_checklist_runs_missed_check" CHECK (("ops_checklist_runs"."status" = 'missed') = ("ops_checklist_runs"."missed_at" IS NOT NULL)),
	CONSTRAINT "ops_checklist_runs_items_check" CHECK (jsonb_typeof("ops_checklist_runs"."items") = 'array' AND jsonb_array_length("ops_checklist_runs"."items") BETWEEN 1 AND 100),
	CONSTRAINT "ops_checklist_runs_results_check" CHECK (jsonb_typeof("ops_checklist_runs"."results") = 'array')
);
--> statement-breakpoint
CREATE TABLE "ops_checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"items" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"role_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_checklist_templates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ops_checklist_templates_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "ops_checklist_templates_type_check" CHECK ("ops_checklist_templates"."type" IN ('opening', 'closing', 'cleaning', 'shift')),
	CONSTRAINT "ops_checklist_templates_version_check" CHECK ("ops_checklist_templates"."version" > 0),
	CONSTRAINT "ops_checklist_templates_items_check" CHECK (jsonb_typeof("ops_checklist_templates"."items") = 'array' AND jsonb_array_length("ops_checklist_templates"."items") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "prep_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"produced_at" timestamp with time zone NOT NULL,
	"use_by" timestamp with time zone NOT NULL,
	"produced_by" text NOT NULL,
	"printed_at" timestamp with time zone,
	"expiry_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_labels_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prep_labels_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "prep_labels_use_by_check" CHECK ("prep_labels"."use_by" > "prep_labels"."produced_at")
);
--> statement-breakpoint
CREATE TABLE "prep_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"prep_list_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"planned_quantity" numeric(14,4) NOT NULL,
	"production_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_list_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prep_list_items_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "prep_list_items_tenant_list_item_key" UNIQUE("tenant_id","prep_list_id","inventory_item_id"),
	CONSTRAINT "prep_list_items_quantity_check" CHECK ("prep_list_items"."planned_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "prep_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"prep_date" date NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"generated_from_forecast_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_lists_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prep_lists_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "prep_lists_tenant_outlet_date_key" UNIQUE("tenant_id","outlet_id","prep_date"),
	CONSTRAINT "prep_lists_status_check" CHECK ("prep_lists"."status" IN ('pending', 'in_progress', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "shift_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"from_shift_template_id" uuid NOT NULL,
	"to_shift_template_id" uuid NOT NULL,
	"notes" jsonb NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_handovers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_handovers_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "shift_handovers_status_check" CHECK ("shift_handovers"."status" IN ('submitted', 'acknowledged')),
	CONSTRAINT "shift_handovers_acknowledged_check" CHECK (("shift_handovers"."status" = 'acknowledged') = ("shift_handovers"."acknowledged_by" IS NOT NULL AND "shift_handovers"."acknowledged_at" IS NOT NULL)),
	CONSTRAINT "shift_handovers_self_acknowledgement_check" CHECK ("shift_handovers"."acknowledged_by" IS NULL OR "shift_handovers"."acknowledged_by" <> "shift_handovers"."submitted_by")
);
--> statement-breakpoint
CREATE TABLE "temperature_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"reading_celsius" numeric(14,4) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text NOT NULL,
	"in_range" boolean NOT NULL,
	"corrective_action" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temperature_logs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "temperature_logs_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "temperature_logs_corrective_action_check" CHECK (("temperature_logs"."in_range" AND "temperature_logs"."corrective_action" IS NULL) OR (NOT "temperature_logs"."in_range" AND "temperature_logs"."corrective_action" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "entitlement_rules" ADD CONSTRAINT "entitlement_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_rules" ADD CONSTRAINT "entitlement_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_rules" ADD CONSTRAINT "entitlement_rules_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_addons" ADD CONSTRAINT "facility_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_addons" ADD CONSTRAINT "facility_addons_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_addons" ADD CONSTRAINT "facility_addons_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_addons" ADD CONSTRAINT "facility_addons_inventory_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_incidents" ADD CONSTRAINT "facility_incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_incidents" ADD CONSTRAINT "facility_incidents_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_incidents" ADD CONSTRAINT "facility_incidents_responded_by_user_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_incidents" ADD CONSTRAINT "facility_incidents_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_products" ADD CONSTRAINT "facility_products_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_subscription_plans" ADD CONSTRAINT "facility_subscription_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_subscription_plans" ADD CONSTRAINT "facility_subscription_plans_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_subscription_plans" ADD CONSTRAINT "facility_subscription_plans_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_policies" ADD CONSTRAINT "wifi_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_policies" ADD CONSTRAINT "wifi_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_policies" ADD CONSTRAINT "wifi_policies_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_equipment_fk" FOREIGN KEY ("tenant_id","outlet_id","equipment_id") REFERENCES "public"."equipment"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_reported_by_user_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_equipment_fk" FOREIGN KEY ("tenant_id","outlet_id","equipment_id") REFERENCES "public"."equipment"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_idempotency" ADD CONSTRAINT "operations_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_idempotency" ADD CONSTRAINT "operations_idempotency_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_idempotency" ADD CONSTRAINT "operations_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_runs" ADD CONSTRAINT "ops_checklist_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_runs" ADD CONSTRAINT "ops_checklist_runs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_runs" ADD CONSTRAINT "ops_checklist_runs_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_runs" ADD CONSTRAINT "ops_checklist_runs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_runs" ADD CONSTRAINT "ops_checklist_runs_template_fk" FOREIGN KEY ("tenant_id","outlet_id","template_id") REFERENCES "public"."ops_checklist_templates"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_templates" ADD CONSTRAINT "ops_checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_templates" ADD CONSTRAINT "ops_checklist_templates_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_templates" ADD CONSTRAINT "ops_checklist_templates_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_produced_by_user_id_fk" FOREIGN KEY ("produced_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_labels" ADD CONSTRAINT "prep_labels_batch_fk" FOREIGN KEY ("tenant_id","outlet_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_list_items" ADD CONSTRAINT "prep_list_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_list_items" ADD CONSTRAINT "prep_list_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_list_items" ADD CONSTRAINT "prep_list_items_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_list_items" ADD CONSTRAINT "prep_list_items_list_fk" FOREIGN KEY ("tenant_id","outlet_id","prep_list_id") REFERENCES "public"."prep_lists"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_list_items" ADD CONSTRAINT "prep_list_items_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_lists" ADD CONSTRAINT "prep_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_lists" ADD CONSTRAINT "prep_lists_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_lists" ADD CONSTRAINT "prep_lists_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_acknowledged_by_user_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_equipment_fk" FOREIGN KEY ("tenant_id","outlet_id","equipment_id") REFERENCES "public"."equipment"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_rules_facility_idx" ON "entitlement_rules" USING btree ("tenant_id","facility_id","type");--> statement-breakpoint
CREATE INDEX "facility_addons_facility_idx" ON "facility_addons" USING btree ("tenant_id","facility_id","sort_order");--> statement-breakpoint
CREATE INDEX "facility_incidents_log_idx" ON "facility_incidents" USING btree ("tenant_id","outlet_id","facility_id","triggered_at","id");--> statement-breakpoint
CREATE INDEX "facility_products_facility_idx" ON "facility_products" USING btree ("tenant_id","facility_id","type");--> statement-breakpoint
CREATE INDEX "facility_subscription_plans_facility_idx" ON "facility_subscription_plans" USING btree ("tenant_id","facility_id","is_active");--> statement-breakpoint
CREATE INDEX "wifi_policies_zone_idx" ON "wifi_policies" USING btree ("tenant_id","zone_id","id");--> statement-breakpoint
CREATE INDEX "equipment_tenant_outlet_status_idx" ON "equipment" USING btree ("tenant_id","outlet_id","status","id");--> statement-breakpoint
CREATE INDEX "equipment_tenant_outlet_category_idx" ON "equipment" USING btree ("tenant_id","outlet_id","category","id");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_tenant_outlet_due_idx" ON "maintenance_schedules" USING btree ("tenant_id","outlet_id","next_due_at","id");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_tenant_outlet_status_idx" ON "maintenance_tickets" USING btree ("tenant_id","outlet_id","status","reported_at","id");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_tenant_equipment_idx" ON "maintenance_tickets" USING btree ("tenant_id","equipment_id","status");--> statement-breakpoint
CREATE INDEX "ops_checklist_runs_tenant_outlet_status_idx" ON "ops_checklist_runs" USING btree ("tenant_id","outlet_id","status","due_at","id");--> statement-breakpoint
CREATE INDEX "ops_checklist_runs_tenant_outlet_date_idx" ON "ops_checklist_runs" USING btree ("tenant_id","outlet_id","shift_date","id");--> statement-breakpoint
CREATE INDEX "ops_checklist_runs_tenant_assignee_idx" ON "ops_checklist_runs" USING btree ("tenant_id","assigned_to","status");--> statement-breakpoint
CREATE INDEX "ops_checklist_templates_tenant_outlet_type_idx" ON "ops_checklist_templates" USING btree ("tenant_id","outlet_id","type","id");--> statement-breakpoint
CREATE INDEX "prep_labels_tenant_outlet_use_by_idx" ON "prep_labels" USING btree ("tenant_id","outlet_id","use_by","id");--> statement-breakpoint
CREATE INDEX "prep_labels_tenant_item_idx" ON "prep_labels" USING btree ("tenant_id","inventory_item_id","use_by");--> statement-breakpoint
CREATE INDEX "prep_list_items_tenant_list_idx" ON "prep_list_items" USING btree ("tenant_id","prep_list_id","id");--> statement-breakpoint
CREATE INDEX "prep_lists_tenant_outlet_status_idx" ON "prep_lists" USING btree ("tenant_id","outlet_id","status","id");--> statement-breakpoint
CREATE INDEX "shift_handovers_tenant_outlet_status_idx" ON "shift_handovers" USING btree ("tenant_id","outlet_id","status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "temperature_logs_tenant_outlet_recorded_idx" ON "temperature_logs" USING btree ("tenant_id","outlet_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "temperature_logs_tenant_equipment_idx" ON "temperature_logs" USING btree ("tenant_id","equipment_id","recorded_at");