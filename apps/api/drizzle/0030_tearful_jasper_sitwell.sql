CREATE TABLE "payment_admin_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_admin_idempotency_key" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "payment_cashier_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"terminal_id" uuid,
	"default_method" varchar(20) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_cashier_defaults_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_cashier_defaults_cashier_key" UNIQUE("tenant_id","outlet_id","cashier_id"),
	CONSTRAINT "payment_cashier_defaults_method_check" CHECK ("payment_cashier_defaults"."default_method" IN ('edc_card','edc_qris','qris_doit'))
);
--> statement-breakpoint
CREATE TABLE "payment_edc_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bank_code" varchar(20) NOT NULL,
	"terminal_id" varchar(100) NOT NULL,
	"merchant_id" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"connection" varchar(20) NOT NULL,
	"ip_address" varchar(45),
	"supported_methods" text[] NOT NULL,
	"assigned_device_id" uuid,
	"status" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_edc_terminals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_edc_terminals_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "payment_edc_terminals_external_key" UNIQUE("tenant_id","bank_code","terminal_id"),
	CONSTRAINT "payment_edc_terminals_bank_check" CHECK ("payment_edc_terminals"."bank_code" IN ('bca','mandiri','bni','bjb')),
	CONSTRAINT "payment_edc_terminals_connection_check" CHECK ("payment_edc_terminals"."connection" IN ('lan','usb','bluetooth')),
	CONSTRAINT "payment_edc_terminals_status_check" CHECK ("payment_edc_terminals"."status" IN ('active','inactive')),
	CONSTRAINT "payment_edc_terminals_methods_check" CHECK (cardinality("payment_edc_terminals"."supported_methods") > 0 AND "payment_edc_terminals"."supported_methods" <@ ARRAY['card','qris']::text[])
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"settlement_line_id" uuid,
	"source" varchar(20) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"reference" varchar(100) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"expected_idr" bigint NOT NULL,
	"received_idr" bigint NOT NULL,
	"variance_idr" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_cases_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_reconciliation_cases_source_check" CHECK ("payment_reconciliation_cases"."source" IN ('gateway','edc')),
	CONSTRAINT "payment_reconciliation_cases_status_check" CHECK ("payment_reconciliation_cases"."status" IN ('open','resolved')),
	CONSTRAINT "payment_reconciliation_cases_amount_check" CHECK ("payment_reconciliation_cases"."expected_idr" >= 0 AND "payment_reconciliation_cases"."received_idr" >= 0 AND "payment_reconciliation_cases"."variance_idr" = "payment_reconciliation_cases"."received_idr" - "payment_reconciliation_cases"."expected_idr"),
	CONSTRAINT "payment_reconciliation_cases_period_check" CHECK ("payment_reconciliation_cases"."period_start" <= "payment_reconciliation_cases"."period_end")
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"unallocated_fund_id" uuid,
	"amount_idr" bigint NOT NULL,
	"reason" text NOT NULL,
	"provider_ref" varchar(100),
	"note" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_refunds_amount_check" CHECK ("payment_refunds"."amount_idr" > 0),
	CONSTRAINT "payment_refunds_status_check" CHECK ("payment_refunds"."status" IN ('pending','approved','completed','failed')),
	CONSTRAINT "payment_refunds_distinct_approver_check" CHECK ("payment_refunds"."approved_by" IS NULL OR "payment_refunds"."approved_by" <> "payment_refunds"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "payment_routing_rules" ALTER COLUMN "provider" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "payment_routing_rules" ALTER COLUMN "fallback_provider" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "payment_unallocated_funds" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "payment_admin_idempotency" ADD CONSTRAINT "payment_admin_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cashier_defaults" ADD CONSTRAINT "payment_cashier_defaults_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cashier_defaults" ADD CONSTRAINT "payment_cashier_defaults_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cashier_defaults" ADD CONSTRAINT "payment_cashier_defaults_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cashier_defaults" ADD CONSTRAINT "payment_cashier_defaults_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_id") REFERENCES "public"."payment_edc_terminals"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_unallocated_fk" FOREIGN KEY ("tenant_id","unallocated_fund_id") REFERENCES "public"."payment_unallocated_funds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_reconciliation_cases_status_idx" ON "payment_reconciliation_cases" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "payment_refunds_intent_idx" ON "payment_refunds" USING btree ("tenant_id","payment_intent_id","status");