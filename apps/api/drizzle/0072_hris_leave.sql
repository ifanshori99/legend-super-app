CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"date" date NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "holidays_tenant_outlet_date_key" UNIQUE NULLS NOT DISTINCT("tenant_id","outlet_id","date"),
	CONSTRAINT "holidays_type_check" CHECK ("holidays"."type" IN ('national', 'collective', 'company'))
);
--> statement-breakpoint
CREATE TABLE "hris_leave_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"collective_leave_deducts_annual" boolean DEFAULT true NOT NULL,
	"annual_leave_type_id" uuid,
	"collective_leave_effective_from" date,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"period" varchar(10) NOT NULL,
	"days" numeric(9, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "leave_accruals_tenant_employee_type_kind_period_key" UNIQUE("tenant_id","employee_id","leave_type_id","kind","period"),
	CONSTRAINT "leave_accruals_kind_check" CHECK ("leave_accruals"."kind" IN ('grant', 'carry_over', 'carry_over_expiry', 'collective_leave')),
	CONSTRAINT "leave_accruals_period_check" CHECK ("leave_accruals"."period" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$')
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"period_year" smallint NOT NULL,
	"entitled_days" numeric(9, 4) DEFAULT '0' NOT NULL,
	"carried_over_days" numeric(9, 4) DEFAULT '0' NOT NULL,
	"used_days" numeric(9, 4) DEFAULT '0' NOT NULL,
	"pending_days" numeric(9, 4) DEFAULT '0' NOT NULL,
	"carry_over_expires_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_balances_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_balances_tenant_employee_type_year_key" UNIQUE("tenant_id","employee_id","leave_type_id","period_year"),
	CONSTRAINT "leave_balances_period_year_check" CHECK ("leave_balances"."period_year" BETWEEN 2000 AND 2100),
	CONSTRAINT "leave_balances_nonnegative_check" CHECK ("leave_balances"."entitled_days" >= 0 AND "leave_balances"."carried_over_days" >= 0 AND "leave_balances"."pending_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"period_year" smallint NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"days" numeric(9, 4) NOT NULL,
	"reason" text,
	"attachment_key" varchar(500),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approval_chain_id" uuid,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"create_idempotency_key" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_requests_tenant_idempotency_key" UNIQUE("tenant_id","create_idempotency_key"),
	CONSTRAINT "leave_requests_date_range_check" CHECK ("leave_requests"."end_date" >= "leave_requests"."start_date"),
	CONSTRAINT "leave_requests_days_check" CHECK ("leave_requests"."days" >= 0),
	CONSTRAINT "leave_requests_status_check" CHECK ("leave_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"paid" boolean NOT NULL,
	"requires_attachment" boolean NOT NULL,
	"policy" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_types_tenant_code_key" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "overtime_formulas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"parameters" jsonb NOT NULL,
	"rest_day_type" varchar(30) NOT NULL,
	"legal_basis" varchar(200) NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "overtime_formulas_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "overtime_formulas_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "overtime_formulas_version_check" CHECK ("overtime_formulas"."version" > 0),
	CONSTRAINT "overtime_formulas_status_check" CHECK ("overtime_formulas"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "overtime_formulas_rest_day_type_check" CHECK ("overtime_formulas"."rest_day_type" IN ('rest_day_6_day_week', 'rest_day_5_day_week'))
);
--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"minutes" smallint NOT NULL,
	"day_type" varchar(30) NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approval_chain_id" uuid,
	"formula_id" uuid,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"create_idempotency_key" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overtime_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "overtime_requests_tenant_idempotency_key" UNIQUE("tenant_id","create_idempotency_key"),
	CONSTRAINT "overtime_requests_minutes_check" CHECK ("overtime_requests"."minutes" BETWEEN 1 AND 720),
	CONSTRAINT "overtime_requests_status_check" CHECK ("overtime_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_leave_settings" ADD CONSTRAINT "hris_leave_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_leave_settings" ADD CONSTRAINT "hris_leave_settings_annual_leave_type_fk" FOREIGN KEY ("tenant_id","annual_leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_leave_type_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_formulas" ADD CONSTRAINT "overtime_formulas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_formula_fk" FOREIGN KEY ("tenant_id","formula_id") REFERENCES "public"."overtime_formulas"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holidays_tenant_date_idx" ON "holidays" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_accruals_collective_leave_key" ON "leave_accruals" USING btree ("tenant_id","employee_id","period") WHERE "leave_accruals"."kind" = 'collective_leave';--> statement-breakpoint
CREATE INDEX "leave_requests_tenant_employee_start_idx" ON "leave_requests" USING btree ("tenant_id","employee_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_requests_tenant_attachment_key" ON "leave_requests" USING btree ("tenant_id","attachment_key");--> statement-breakpoint
CREATE INDEX "overtime_requests_tenant_employee_date_idx" ON "overtime_requests" USING btree ("tenant_id","employee_id","date");