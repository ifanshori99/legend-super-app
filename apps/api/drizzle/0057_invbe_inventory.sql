CREATE TABLE "accounting_command_idempotency" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(60) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_command_idempotency_tenant_id_key_pk" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "accounting_command_idempotency_fingerprint_check" CHECK ("accounting_command_idempotency"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_open_item_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"open_item_id" uuid NOT NULL,
	"method" varchar(12) NOT NULL,
	"source_id" uuid,
	"settled_on" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"journal_entry_id" uuid,
	"reason" varchar(200),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_open_item_settlements_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "accounting_open_item_settlements_amount_check" CHECK ("accounting_open_item_settlements"."amount_idr" > 0),
	CONSTRAINT "accounting_open_item_settlements_method_check" CHECK ("accounting_open_item_settlements"."method" IN ('payment', 'write_off')),
	CONSTRAINT "accounting_open_item_settlements_reason_check" CHECK ("accounting_open_item_settlements"."method" <> 'write_off' OR length(btrim(coalesce("accounting_open_item_settlements"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "accounting_open_items" (
	"tenant_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"counterparty_type" varchar(20) NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"counterparty_name" varchar(150) NOT NULL,
	"document_number" varchar(60) NOT NULL,
	"document_date" date NOT NULL,
	"due_on" date NOT NULL,
	"original_idr" bigint NOT NULL,
	"settled_idr" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_open_items_tenant_id_kind_id_pk" PRIMARY KEY("tenant_id","kind","id"),
	CONSTRAINT "accounting_open_items_kind_check" CHECK ("accounting_open_items"."kind" IN ('payable', 'receivable')),
	CONSTRAINT "accounting_open_items_counterparty_check" CHECK (("accounting_open_items"."kind" = 'payable' AND "accounting_open_items"."counterparty_type" = 'supplier') OR ("accounting_open_items"."kind" = 'receivable' AND "accounting_open_items"."counterparty_type" IN ('corporate_account', 'event_customer'))),
	CONSTRAINT "accounting_open_items_amounts_check" CHECK ("accounting_open_items"."original_idr" > 0 AND "accounting_open_items"."settled_idr" >= 0 AND "accounting_open_items"."settled_idr" <= "accounting_open_items"."original_idr"),
	CONSTRAINT "accounting_open_items_due_check" CHECK ("accounting_open_items"."due_on" >= "accounting_open_items"."document_date"),
	CONSTRAINT "accounting_open_items_text_check" CHECK (length(btrim("accounting_open_items"."counterparty_name")) > 0 AND length(btrim("accounting_open_items"."document_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"account_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_tenant_entity_outlet_account_period_key" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","outlet_id","account_id","period"),
	CONSTRAINT "budgets_amount_check" CHECK ("budgets"."amount_idr" >= 0),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "depreciation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"journal_entry_id" uuid,
	"posted_by" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depreciation_runs_tenant_entity_period_key" UNIQUE("tenant_id","legal_entity_id","period"),
	CONSTRAINT "depreciation_runs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "depreciation_runs_period_check" CHECK ("depreciation_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "depreciation_runs_journal_check" CHECK ("depreciation_runs"."amount_idr" >= 0 AND ("depreciation_runs"."amount_idr" > 0) = ("depreciation_runs"."journal_entry_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"run_id" uuid,
	"journal_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_depreciations_asset_period_key" UNIQUE("tenant_id","fixed_asset_id","period"),
	CONSTRAINT "fixed_asset_depreciations_amount_check" CHECK ("fixed_asset_depreciations"."amount_idr" > 0),
	CONSTRAINT "fixed_asset_depreciations_period_check" CHECK ("fixed_asset_depreciations"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"revalued_on" date NOT NULL,
	"previous_cost_idr" bigint NOT NULL,
	"previous_accumulated_idr" bigint NOT NULL,
	"previous_useful_life_months" integer NOT NULL,
	"previous_start_period" varchar(7) NOT NULL,
	"new_carrying_amount_idr" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reason" varchar(200) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_revaluations_amount_check" CHECK ("fixed_asset_revaluations"."new_carrying_amount_idr" > 0 AND "fixed_asset_revaluations"."previous_cost_idr" > 0 AND "fixed_asset_revaluations"."previous_accumulated_idr" >= 0),
	CONSTRAINT "fixed_asset_revaluations_reason_check" CHECK (length(btrim("fixed_asset_revaluations"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"name" varchar(150) NOT NULL,
	"acquired_on" date NOT NULL,
	"cost_idr" bigint NOT NULL,
	"residual_value_idr" bigint DEFAULT 0 NOT NULL,
	"useful_life_months" integer NOT NULL,
	"method" varchar(20) DEFAULT 'straight_line' NOT NULL,
	"depreciation_start_period" varchar(7) NOT NULL,
	"source_document_id" uuid,
	"accumulated_depreciation_idr" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"disposed_on" date,
	"disposal_proceeds_idr" bigint,
	"acquisition_journal_entry_id" uuid,
	"disposal_journal_entry_id" uuid,
	"disposal_reason" varchar(200),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fixed_assets_tenant_entity_id_key" UNIQUE("tenant_id","legal_entity_id","id"),
	CONSTRAINT "fixed_assets_amounts_check" CHECK ("fixed_assets"."cost_idr" > 0 AND "fixed_assets"."residual_value_idr" >= 0 AND "fixed_assets"."residual_value_idr" < "fixed_assets"."cost_idr" AND "fixed_assets"."accumulated_depreciation_idr" >= 0 AND "fixed_assets"."accumulated_depreciation_idr" <= "fixed_assets"."cost_idr" - "fixed_assets"."residual_value_idr"),
	CONSTRAINT "fixed_assets_life_check" CHECK ("fixed_assets"."useful_life_months" BETWEEN 1 AND 600),
	CONSTRAINT "fixed_assets_method_check" CHECK ("fixed_assets"."method" = 'straight_line'),
	CONSTRAINT "fixed_assets_status_check" CHECK ("fixed_assets"."status" IN ('active', 'fully_depreciated', 'disposed')),
	CONSTRAINT "fixed_assets_period_check" CHECK ("fixed_assets"."depreciation_start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fixed_assets_disposal_check" CHECK (("fixed_assets"."status" = 'disposed') = ("fixed_assets"."disposed_on" IS NOT NULL AND "fixed_assets"."disposal_proceeds_idr" IS NOT NULL) AND ("fixed_assets"."disposal_proceeds_idr" IS NULL OR "fixed_assets"."disposal_proceeds_idr" >= 0) AND ("fixed_assets"."disposed_on" IS NULL OR "fixed_assets"."disposed_on" >= "fixed_assets"."acquired_on")),
	CONSTRAINT "fixed_assets_name_check" CHECK (length(btrim("fixed_assets"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_item_alternates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"alternate_item_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_item_alternates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_item_alternates_tenant_pair_key" UNIQUE("tenant_id","inventory_item_id","alternate_item_id"),
	CONSTRAINT "inventory_item_alternates_check" CHECK ("inventory_item_alternates"."inventory_item_id" <> "inventory_item_alternates"."alternate_item_id" AND "inventory_item_alternates"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"recipe_deduction_mode" varchar(20) DEFAULT 'real_time' NOT NULL,
	"expiry_warning_days" integer DEFAULT 7 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_settings_mode_check" CHECK ("inventory_settings"."recipe_deduction_mode" IN ('real_time', 'close_of_day')),
	CONSTRAINT "inventory_settings_expiry_days_check" CHECK ("inventory_settings"."expiry_warning_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
CREATE TABLE "inventory_setup_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_setup_idempotency_tenant_key" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "par_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"par_min" numeric(14,4) NOT NULL,
	"par_max" numeric(14,4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "par_levels_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "par_levels_tenant_location_item_key" UNIQUE("tenant_id","location_id","inventory_item_id"),
	CONSTRAINT "par_levels_range_check" CHECK ("par_levels"."par_min" >= 0 AND "par_levels"."par_max" >= "par_levels"."par_min")
);
--> statement-breakpoint
CREATE TABLE "menu_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"actor_user_id" varchar(64) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'committed' NOT NULL,
	"row_count" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_import_jobs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_import_jobs_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "menu_import_jobs_status_check" CHECK ("menu_import_jobs"."status" IN ('committed')),
	CONSTRAINT "menu_import_jobs_row_count_check" CHECK ("menu_import_jobs"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "printable_menu_renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"object_id" uuid,
	"content_hash" varchar(64),
	"item_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone,
	"dirty_since" timestamp with time zone,
	"refresh_after" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printable_menu_renders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "printable_menu_renders_tenant_outlet_key" UNIQUE("tenant_id","outlet_id"),
	CONSTRAINT "printable_menu_renders_item_count_check" CHECK ("printable_menu_renders"."item_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_ops_idempotency" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"operation" varchar(60) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_ops_idempotency_pkey" PRIMARY KEY("tenant_id","operation","idempotency_key"),
	CONSTRAINT "inventory_ops_idempotency_fingerprint_check" CHECK ("inventory_ops_idempotency"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"batch_id" uuid,
	"kind" varchar(20) NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"par_min" numeric(14,4),
	"expires_on" date,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inventory_stock_alerts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_stock_alerts_kind_check" CHECK ("inventory_stock_alerts"."kind" IN ('par_critical', 'expiring_soon', 'expired')),
	CONSTRAINT "inventory_stock_alerts_shape_check" CHECK (("inventory_stock_alerts"."kind" = 'par_critical' AND "inventory_stock_alerts"."batch_id" IS NULL AND "inventory_stock_alerts"."par_min" IS NOT NULL)
        OR ("inventory_stock_alerts"."kind" <> 'par_critical' AND "inventory_stock_alerts"."batch_id" IS NOT NULL AND "inventory_stock_alerts"."expires_on" IS NOT NULL)),
	CONSTRAINT "inventory_stock_alerts_resolved_check" CHECK ("inventory_stock_alerts"."resolved_at" IS NULL OR "inventory_stock_alerts"."resolved_at" >= "inventory_stock_alerts"."raised_at")
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"output_item_id" uuid NOT NULL,
	"planned_qty" numeric(14,4) NOT NULL,
	"actual_qty" numeric(14,4),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"cost_idr" bigint,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "production_orders_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "production_orders_status_check" CHECK ("production_orders"."status" IN ('draft', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "production_orders_planned_check" CHECK ("production_orders"."planned_qty" > 0),
	CONSTRAINT "production_orders_cost_check" CHECK ("production_orders"."cost_idr" IS NULL OR "production_orders"."cost_idr" >= 0),
	CONSTRAINT "production_orders_completed_check" CHECK (("production_orders"."status" = 'completed') = ("production_orders"."completed_at" IS NOT NULL)
        AND ("production_orders"."status" <> 'completed' OR ("production_orders"."actual_qty" > 0 AND "production_orders"."cost_idr" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "waste_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"reason" varchar(30) NOT NULL,
	"media_id" uuid,
	"value_idr" bigint NOT NULL,
	"logged_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waste_logs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "waste_logs_quantity_check" CHECK ("waste_logs"."quantity" > 0),
	CONSTRAINT "waste_logs_value_check" CHECK ("waste_logs"."value_idr" >= 0),
	CONSTRAINT "waste_logs_target_type_check" CHECK ("waste_logs"."target_type" IN ('inventory_item', 'menu_item')),
	CONSTRAINT "waste_logs_reason_check" CHECK ("waste_logs"."reason" IN ('expired', 'spoiled', 'dropped', 'prep_error', 'overproduction', 'quality_reject', 'other'))
);
--> statement-breakpoint
ALTER TABLE "accounting_command_idempotency" ADD CONSTRAINT "accounting_command_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_item_fk" FOREIGN KEY ("tenant_id","kind","open_item_id") REFERENCES "public"."accounting_open_items"("tenant_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_items" ADD CONSTRAINT "accounting_open_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_items" ADD CONSTRAINT "accounting_open_items_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_items" ADD CONSTRAINT "accounting_open_items_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_open_items" ADD CONSTRAINT "accounting_open_items_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_asset_fk" FOREIGN KEY ("tenant_id","fixed_asset_id") REFERENCES "public"."fixed_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."depreciation_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_revaluations" ADD CONSTRAINT "fixed_asset_revaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_revaluations" ADD CONSTRAINT "fixed_asset_revaluations_asset_fk" FOREIGN KEY ("tenant_id","fixed_asset_id") REFERENCES "public"."fixed_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_revaluations" ADD CONSTRAINT "fixed_asset_revaluations_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_acquisition_journal_fk" FOREIGN KEY ("tenant_id","acquisition_journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_fk" FOREIGN KEY ("tenant_id","disposal_journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_alternates" ADD CONSTRAINT "inventory_item_alternates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_alternates" ADD CONSTRAINT "inventory_item_alternates_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_alternates" ADD CONSTRAINT "inventory_item_alternates_alternate_fk" FOREIGN KEY ("tenant_id","alternate_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_setup_idempotency" ADD CONSTRAINT "inventory_setup_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "par_levels" ADD CONSTRAINT "par_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "par_levels" ADD CONSTRAINT "par_levels_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "par_levels" ADD CONSTRAINT "par_levels_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_import_jobs" ADD CONSTRAINT "menu_import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_import_jobs" ADD CONSTRAINT "menu_import_jobs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printable_menu_renders" ADD CONSTRAINT "printable_menu_renders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printable_menu_renders" ADD CONSTRAINT "printable_menu_renders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ops_idempotency" ADD CONSTRAINT "inventory_ops_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ops_idempotency" ADD CONSTRAINT "inventory_ops_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_batch_fk" FOREIGN KEY ("tenant_id","outlet_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_output_item_fk" FOREIGN KEY ("tenant_id","output_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_logged_by_user_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_open_item_settlements_item_idx" ON "accounting_open_item_settlements" USING btree ("tenant_id","kind","open_item_id","settled_on");--> statement-breakpoint
CREATE INDEX "accounting_open_items_aging_idx" ON "accounting_open_items" USING btree ("tenant_id","legal_entity_id","kind","due_on");--> statement-breakpoint
CREATE INDEX "accounting_open_items_outlet_idx" ON "accounting_open_items" USING btree ("tenant_id","outlet_id");--> statement-breakpoint
CREATE INDEX "budgets_entity_period_idx" ON "budgets" USING btree ("tenant_id","legal_entity_id","period");--> statement-breakpoint
CREATE INDEX "fixed_asset_depreciations_run_idx" ON "fixed_asset_depreciations" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "fixed_asset_revaluations_asset_idx" ON "fixed_asset_revaluations" USING btree ("tenant_id","fixed_asset_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_entity_idx" ON "fixed_assets" USING btree ("tenant_id","legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "par_levels_tenant_outlet_idx" ON "par_levels" USING btree ("tenant_id","outlet_id","id");--> statement-breakpoint
CREATE INDEX "menu_import_jobs_outlet_idx" ON "menu_import_jobs" USING btree ("tenant_id","outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "printable_menu_renders_due_idx" ON "printable_menu_renders" USING btree ("tenant_id","refresh_after");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_alerts_open_par_idx" ON "inventory_stock_alerts" USING btree ("tenant_id","location_id","inventory_item_id") WHERE "inventory_stock_alerts"."kind" = 'par_critical' AND "inventory_stock_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_alerts_open_batch_idx" ON "inventory_stock_alerts" USING btree ("tenant_id","batch_id","kind") WHERE "inventory_stock_alerts"."kind" <> 'par_critical' AND "inventory_stock_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inventory_stock_alerts_tenant_outlet_open_idx" ON "inventory_stock_alerts" USING btree ("tenant_id","outlet_id","resolved_at","raised_at");--> statement-breakpoint
CREATE INDEX "production_orders_tenant_outlet_created_idx" ON "production_orders" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "waste_logs_tenant_outlet_occurred_idx" ON "waste_logs" USING btree ("tenant_id","outlet_id","occurred_at","id");