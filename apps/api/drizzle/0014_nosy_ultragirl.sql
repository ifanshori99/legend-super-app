CREATE TABLE "account_mappings" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"role" varchar(40) NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "account_mappings_tenant_entity_role_key" UNIQUE("tenant_id","legal_entity_id","role")
);
--> statement-breakpoint
CREATE TABLE "chart_of_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"report_group" varchar(40) NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_of_accounts_tenant_entity_code_key" UNIQUE("tenant_id","legal_entity_id","code"),
	CONSTRAINT "chart_of_accounts_tenant_entity_id_key" UNIQUE("tenant_id","legal_entity_id","id"),
	CONSTRAINT "chart_of_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "chart_of_accounts_type_check" CHECK ("chart_of_accounts"."type" IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
	CONSTRAINT "chart_of_accounts_report_group_check" CHECK ("chart_of_accounts"."report_group" IN ('cash_and_equivalents', 'current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity', 'revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense')),
	CONSTRAINT "chart_of_accounts_report_group_type_check" CHECK (("chart_of_accounts"."report_group" IN ('cash_and_equivalents', 'current_asset', 'non_current_asset') AND "chart_of_accounts"."type" = 'asset') OR ("chart_of_accounts"."report_group" IN ('current_liability', 'non_current_liability') AND "chart_of_accounts"."type" = 'liability') OR ("chart_of_accounts"."report_group" = 'equity' AND "chart_of_accounts"."type" = 'equity') OR ("chart_of_accounts"."report_group" IN ('revenue', 'other_income') AND "chart_of_accounts"."type" = 'revenue') OR ("chart_of_accounts"."report_group" IN ('cogs', 'operating_expense', 'other_expense') AND "chart_of_accounts"."type" = 'expense')),
	CONSTRAINT "chart_of_accounts_code_check" CHECK ("chart_of_accounts"."code" ~ '^[0-9]{1,10}([.-][0-9]{1,10}){0,4}$'),
	CONSTRAINT "chart_of_accounts_parent_check" CHECK ("chart_of_accounts"."parent_id" IS NULL OR "chart_of_accounts"."parent_id" <> "chart_of_accounts"."id")
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reopened_reason" varchar(500),
	"reopened_by" text,
	"reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_periods_tenant_entity_period_key" UNIQUE("tenant_id","legal_entity_id","period"),
	CONSTRAINT "fiscal_periods_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fiscal_periods_period_check" CHECK ("fiscal_periods"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fiscal_periods_status_check" CHECK ("fiscal_periods"."status" IN ('open', 'closed')),
	CONSTRAINT "fiscal_periods_version_check" CHECK ("fiscal_periods"."version" >= 1),
	CONSTRAINT "fiscal_periods_closed_check" CHECK (("fiscal_periods"."status" = 'closed') = ("fiscal_periods"."closed_by" IS NOT NULL AND "fiscal_periods"."closed_at" IS NOT NULL)),
	CONSTRAINT "fiscal_periods_reopened_check" CHECK (("fiscal_periods"."reopened_reason" IS NULL) = ("fiscal_periods"."reopened_by" IS NULL) AND ("fiscal_periods"."reopened_by" IS NULL) = ("fiscal_periods"."reopened_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"entry_date" date NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" varchar(64),
	"description" varchar(255) NOT NULL,
	"reversal_of" uuid,
	"posted_by" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "journal_entries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "journal_entries_source_type_check" CHECK ("journal_entries"."source_type" IN ('sale', 'refund', 'gateway_settlement', 'edc_settlement', 'cogs', 'stock_adjustment', 'purchase', 'supplier_invoice', 'supplier_payment', 'production', 'payroll', 'loyalty', 'depreciation', 'asset_acquisition', 'asset_disposal', 'asset_revaluation', 'dividend', 'cash_deposit', 'cashier_shift', 'opening_balance', 'manual', 'recurring', 'reversal')),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("journal_entries"."source_type" = 'reversal') = ("journal_entries"."reversal_of" IS NOT NULL)),
	CONSTRAINT "journal_entries_description_check" CHECK (length(btrim("journal_entries"."description")) > 0),
	CONSTRAINT "journal_entries_source_id_check" CHECK ("journal_entries"."source_id" IS NULL OR "journal_entries"."source_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR "journal_entries"."source_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"debit_idr" bigint DEFAULT 0 NOT NULL,
	"credit_idr" bigint DEFAULT 0 NOT NULL,
	"outlet_id" uuid,
	"cost_center" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_tenant_entry_line_key" UNIQUE("tenant_id","entry_id","line_no"),
	CONSTRAINT "journal_lines_amounts_check" CHECK ("journal_lines"."debit_idr" >= 0 AND "journal_lines"."credit_idr" >= 0),
	CONSTRAINT "journal_lines_side_check" CHECK (("journal_lines"."debit_idr" > 0 AND "journal_lines"."credit_idr" = 0) OR ("journal_lines"."credit_idr" > 0 AND "journal_lines"."debit_idr" = 0)),
	CONSTRAINT "journal_lines_line_no_check" CHECK ("journal_lines"."line_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_fk" FOREIGN KEY ("tenant_id","legal_entity_id","parent_id") REFERENCES "public"."chart_of_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_fk" FOREIGN KEY ("tenant_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_fk" FOREIGN KEY ("tenant_id","reversal_of") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_mappings_account_idx" ON "account_mappings" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "chart_of_accounts_entity_idx" ON "chart_of_accounts" USING btree ("tenant_id","legal_entity_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reversal_once_key" ON "journal_entries" USING btree ("tenant_id","reversal_of") WHERE "journal_entries"."reversal_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_entity_date_idx" ON "journal_entries" USING btree ("tenant_id","legal_entity_id","entry_date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_outlet_date_idx" ON "journal_entries" USING btree ("tenant_id","outlet_id","entry_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("tenant_id","entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_outlet_idx" ON "journal_lines" USING btree ("tenant_id","outlet_id");