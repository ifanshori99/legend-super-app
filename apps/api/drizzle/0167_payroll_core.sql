-- legend-m007 pattern 2: the composite foreign keys below are added by
-- ALTER TABLE and validate against FORCE RLS parents (employees,
-- legal_entities, outlets). Lift FORCE for this transaction; it is restored
-- at the start of the custom section (payroll.custom.sql).
ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legal_entities NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "bank_transfer_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"format" varchar(15) NOT NULL,
	"row_count" integer NOT NULL,
	"total_idr" bigint NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"object_key" varchar(500) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_files_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_transfer_files_format_check" CHECK ("bank_transfer_files"."format" IN ('generic_csv', 'bca', 'mandiri', 'bni', 'bjb')),
	CONSTRAINT "bank_transfer_files_row_count_check" CHECK ("bank_transfer_files"."row_count" BETWEEN 0 AND 100000),
	CONSTRAINT "bank_transfer_files_total_check" CHECK ("bank_transfer_files"."total_idr" >= 0),
	CONSTRAINT "bank_transfer_files_checksum_check" CHECK ("bank_transfer_files"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "employee_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"principal_idr" bigint NOT NULL,
	"installment_idr" bigint NOT NULL,
	"installment_count" integer NOT NULL,
	"outstanding_idr" bigint NOT NULL,
	"first_deduction_period" date NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"disbursed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_loans_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_loans_status_check" CHECK ("employee_loans"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled')),
	CONSTRAINT "employee_loans_amounts_check" CHECK ("employee_loans"."principal_idr" > 0 AND "employee_loans"."installment_idr" > 0
        AND "employee_loans"."installment_idr" <= "employee_loans"."principal_idr"
        AND "employee_loans"."outstanding_idr" >= 0
        AND "employee_loans"."outstanding_idr" <= "employee_loans"."principal_idr"
        AND "employee_loans"."installment_idr" * "employee_loans"."installment_count" >= "employee_loans"."principal_idr"),
	CONSTRAINT "employee_loans_installment_count_check" CHECK ("employee_loans"."installment_count" BETWEEN 1 AND 36),
	CONSTRAINT "employee_loans_decided_pair_check" CHECK (("employee_loans"."status" <> 'pending') = ("employee_loans"."decided_by" IS NOT NULL)
        AND ("employee_loans"."status" <> 'pending') = ("employee_loans"."decided_at" IS NOT NULL)),
	CONSTRAINT "employee_loans_disbursed_check" CHECK (("employee_loans"."status" IN ('disbursed', 'settled')) = ("employee_loans"."disbursed_at" IS NOT NULL)
        AND ("employee_loans"."status" IN ('disbursed', 'settled') OR "employee_loans"."outstanding_idr" = "employee_loans"."principal_idr")),
	CONSTRAINT "employee_loans_settled_check" CHECK (("employee_loans"."status" = 'settled') = ("employee_loans"."settled_at" IS NOT NULL)
        AND ("employee_loans"."status" <> 'settled' OR "employee_loans"."outstanding_idr" = 0))
);
--> statement-breakpoint
CREATE TABLE "employee_pay_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"amount_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_pay_components_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_pay_components_tenant_employee_component_from_key" UNIQUE("tenant_id","employee_id","component_id","effective_from"),
	CONSTRAINT "employee_pay_components_dates_check" CHECK ("employee_pay_components"."effective_to" IS NULL OR "employee_pay_components"."effective_to" >= "employee_pay_components"."effective_from"),
	CONSTRAINT "employee_pay_components_key_version_check" CHECK ("employee_pay_components"."pii_key_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "pay_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"category" varchar(30) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"recurrence" varchar(10) NOT NULL,
	"taxable" boolean NOT NULL,
	"tax_scheme" varchar(10) NOT NULL,
	"bpjs_base" boolean NOT NULL,
	"overtime_base" boolean NOT NULL,
	"thr_base" boolean NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_components_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_components_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "pay_components_code_check" CHECK ("pay_components"."code" ~ '^[A-Z][A-Z0-9_]{1,29}$'),
	CONSTRAINT "pay_components_category_check" CHECK ("pay_components"."category" IN ('base_salary', 'fixed_allowance', 'variable_allowance', 'meal_allowance', 'transport_allowance', 'incentive', 'overtime', 'service_charge', 'thr', 'bonus', 'reimbursement', 'tax_allowance', 'late_deduction', 'loan_installment', 'bpjs_employee', 'pph21', 'pph21_receivable', 'custom_earning', 'custom_deduction')),
	CONSTRAINT "pay_components_kind_check" CHECK ("pay_components"."kind" = CASE WHEN "pay_components"."category" IN ('late_deduction', 'loan_installment', 'bpjs_employee', 'pph21', 'pph21_receivable', 'custom_deduction') THEN 'deduction' ELSE 'earning' END),
	CONSTRAINT "pay_components_recurrence_check" CHECK ("pay_components"."recurrence" IN ('fixed', 'variable')),
	CONSTRAINT "pay_components_tax_scheme_check" CHECK ("pay_components"."tax_scheme" IN ('gross', 'gross_up', 'net')),
	CONSTRAINT "pay_components_deduction_flags_check" CHECK ("pay_components"."kind" = 'earning' OR NOT ("pay_components"."taxable" OR "pay_components"."bpjs_base" OR "pay_components"."overtime_base" OR "pay_components"."thr_base")),
	CONSTRAINT "pay_components_reimbursement_taxable_check" CHECK ("pay_components"."category" <> 'reimbursement' OR NOT "pay_components"."taxable"),
	CONSTRAINT "pay_components_display_order_check" CHECK ("pay_components"."display_order" BETWEEN 0 AND 999)
);
--> statement-breakpoint
CREATE TABLE "payroll_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"employee_group_code" varchar(30) NOT NULL,
	"employee_group" jsonb NOT NULL,
	"cycle" jsonb NOT NULL,
	"pay_date_adjustment" varchar(25) NOT NULL,
	"jkk_risk_class" varchar(10) NOT NULL,
	"bpjs_programmes" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_policies_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_policies_tenant_entity_group_key" UNIQUE("tenant_id","legal_entity_id","employee_group_code"),
	CONSTRAINT "payroll_policies_pay_date_adjustment_check" CHECK ("payroll_policies"."pay_date_adjustment" IN ('previous_working_day', 'next_working_day', 'none')),
	CONSTRAINT "payroll_policies_jkk_risk_class_check" CHECK ("payroll_policies"."jkk_risk_class" IN ('very_low', 'low', 'medium', 'high', 'very_high')),
	CONSTRAINT "payroll_policies_group_code_check" CHECK ("payroll_policies"."employee_group_code" = "payroll_policies"."employee_group" ->> 'code'),
	CONSTRAINT "payroll_policies_bpjs_programmes_check" CHECK (jsonb_typeof("payroll_policies"."bpjs_programmes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payroll_policy_id" uuid NOT NULL,
	"run_type" varchar(10) NOT NULL,
	"thr_schedule_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"simulation_count" integer DEFAULT 0 NOT NULL,
	"last_simulated_at" timestamp with time zone,
	"totals" jsonb,
	"config_snapshot" jsonb,
	"approved_by_hr" text,
	"approved_by_hr_at" timestamp with time zone,
	"approved_by_finance" text,
	"approved_by_finance_at" timestamp with time zone,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"reversal" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_runs_run_type_check" CHECK ("payroll_runs"."run_type" IN ('regular', 'thr', 'off_cycle')),
	CONSTRAINT "payroll_runs_status_check" CHECK ("payroll_runs"."status" IN ('draft', 'simulated', 'hr_approved', 'approved', 'locked', 'paid', 'reversed')),
	CONSTRAINT "payroll_runs_period_check" CHECK ("payroll_runs"."period_end" >= "payroll_runs"."period_start"),
	CONSTRAINT "payroll_runs_thr_schedule_check" CHECK (("payroll_runs"."run_type" = 'thr') = ("payroll_runs"."thr_schedule_id" IS NOT NULL)),
	CONSTRAINT "payroll_runs_simulation_count_check" CHECK ("payroll_runs"."simulation_count" >= 0),
	CONSTRAINT "payroll_runs_distinct_approvers_check" CHECK ("payroll_runs"."approved_by_finance" IS NULL OR "payroll_runs"."approved_by_hr" IS NULL OR "payroll_runs"."approved_by_finance" <> "payroll_runs"."approved_by_hr"),
	CONSTRAINT "payroll_runs_locked_snapshot_check" CHECK ("payroll_runs"."status" NOT IN ('locked', 'paid', 'reversed') OR ("payroll_runs"."config_snapshot" IS NOT NULL AND "payroll_runs"."totals" IS NOT NULL AND "payroll_runs"."locked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payroll_tax_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"tax_period" varchar(7) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"object_key" varchar(500),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_tax_exports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_tax_exports_kind_check" CHECK ("payroll_tax_exports"."kind" IN ('monthly_withholding', 'annual_statement')),
	CONSTRAINT "payroll_tax_exports_period_check" CHECK (("payroll_tax_exports"."kind" = 'monthly_withholding' AND "payroll_tax_exports"."tax_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
        OR ("payroll_tax_exports"."kind" = 'annual_statement' AND "payroll_tax_exports"."tax_period" ~ '^[0-9]{4}$')),
	CONSTRAINT "payroll_tax_exports_status_check" CHECK ("payroll_tax_exports"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "payroll_tax_exports_ready_check" CHECK (("payroll_tax_exports"."status" = 'ready') = ("payroll_tax_exports"."object_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payment_method" varchar(15) NOT NULL,
	"calculation_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"pdf_object_key" varchar(500),
	"viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslips_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payslips_tenant_run_employee_key" UNIQUE("tenant_id","payroll_run_id","employee_id"),
	CONSTRAINT "payslips_payment_method_check" CHECK ("payslips"."payment_method" IN ('bank_transfer', 'cash')),
	CONSTRAINT "payslips_key_version_check" CHECK ("payslips"."pii_key_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "reimbursement_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"receipt_required" boolean NOT NULL,
	"limits" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reimbursement_categories_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reimbursement_categories_tenant_name_key" UNIQUE("tenant_id","name"),
	CONSTRAINT "reimbursement_categories_limits_check" CHECK (jsonb_typeof("reimbursement_categories"."limits") = 'array' AND jsonb_array_length("reimbursement_categories"."limits") >= 1)
);
--> statement-breakpoint
CREATE TABLE "reimbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"expense_date" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"approved_amount_idr" bigint,
	"description" varchar(500) NOT NULL,
	"receipt_upload_ref" varchar(200),
	"payout" varchar(10) NOT NULL,
	"status" varchar(10) DEFAULT 'submitted' NOT NULL,
	"payroll_run_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reimbursements_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reimbursements_status_check" CHECK ("reimbursements"."status" IN ('submitted', 'approved', 'rejected', 'cancelled', 'paid')),
	CONSTRAINT "reimbursements_payout_check" CHECK ("reimbursements"."payout" IN ('payroll', 'cash')),
	CONSTRAINT "reimbursements_amount_check" CHECK ("reimbursements"."amount_idr" > 0 AND ("reimbursements"."approved_amount_idr" IS NULL OR ("reimbursements"."approved_amount_idr" > 0 AND "reimbursements"."approved_amount_idr" <= "reimbursements"."amount_idr"))),
	CONSTRAINT "reimbursements_decided_pair_check" CHECK (("reimbursements"."status" <> 'submitted') = ("reimbursements"."decided_by" IS NOT NULL)
        AND ("reimbursements"."status" <> 'submitted') = ("reimbursements"."decided_at" IS NOT NULL)),
	CONSTRAINT "reimbursements_approved_amount_check" CHECK (("reimbursements"."status" IN ('approved', 'paid')) = ("reimbursements"."approved_amount_idr" IS NOT NULL)),
	CONSTRAINT "reimbursements_paid_check" CHECK (("reimbursements"."status" = 'paid') = ("reimbursements"."paid_at" IS NOT NULL)),
	CONSTRAINT "reimbursements_run_check" CHECK (("reimbursements"."payout" = 'payroll' OR "reimbursements"."payroll_run_id" IS NULL)
        AND ("reimbursements"."status" <> 'paid' OR "reimbursements"."payout" = 'cash' OR "reimbursements"."payroll_run_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "service_charge_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"points" numeric(14,4) NOT NULL,
	"attendance_days" integer NOT NULL,
	"weight" bigint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_charge_allocations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_charge_allocations_tenant_pool_employee_key" UNIQUE("tenant_id","pool_id","employee_id"),
	CONSTRAINT "service_charge_allocations_points_check" CHECK ("service_charge_allocations"."points" >= 0),
	CONSTRAINT "service_charge_allocations_attendance_check" CHECK ("service_charge_allocations"."attendance_days" BETWEEN 0 AND 31),
	CONSTRAINT "service_charge_allocations_weight_check" CHECK ("service_charge_allocations"."weight" >= 0),
	CONSTRAINT "service_charge_allocations_amount_check" CHECK ("service_charge_allocations"."amount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_charge_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"rule" jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"payroll_run_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_charge_pools_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_charge_pools_status_check" CHECK ("service_charge_pools"."status" IN ('draft', 'calculated', 'approved', 'distributed', 'cancelled')),
	CONSTRAINT "service_charge_pools_period_check" CHECK ("service_charge_pools"."period_end" >= "service_charge_pools"."period_start"),
	CONSTRAINT "service_charge_pools_amount_check" CHECK ("service_charge_pools"."amount_idr" >= 0),
	CONSTRAINT "service_charge_pools_approved_pair_check" CHECK (("service_charge_pools"."status" IN ('approved', 'distributed')) = ("service_charge_pools"."approved_by" IS NOT NULL)
        AND ("service_charge_pools"."status" IN ('approved', 'distributed')) = ("service_charge_pools"."approved_at" IS NOT NULL)),
	CONSTRAINT "service_charge_pools_distributed_run_check" CHECK (("service_charge_pools"."status" = 'distributed') = ("service_charge_pools"."payroll_run_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "statutory_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"legal_basis" varchar(200) NOT NULL,
	"parameters" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_rates_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "statutory_rates_tenant_type_version_key" UNIQUE("tenant_id","type","version"),
	CONSTRAINT "statutory_rates_type_check" CHECK ("statutory_rates"."type" IN ('bpjs_kes', 'jht', 'jkk', 'jkm', 'jp', 'ptkp', 'pph21_ter', 'pph21_annual', 'overtime', 'thr')),
	CONSTRAINT "statutory_rates_status_check" CHECK ("statutory_rates"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "statutory_rates_version_check" CHECK ("statutory_rates"."version" >= 1),
	CONSTRAINT "statutory_rates_published_pair_check" CHECK (("statutory_rates"."status" = 'published') = ("statutory_rates"."published_at" IS NOT NULL)
        AND ("statutory_rates"."status" = 'published') = ("statutory_rates"."published_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "thr_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"holiday_name" varchar(100) NOT NULL,
	"holiday_date" date NOT NULL,
	"tenure_as_of_date" date NOT NULL,
	"pay_date" date NOT NULL,
	"employee_ids" jsonb,
	"status" varchar(10) DEFAULT 'scheduled' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thr_schedules_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "thr_schedules_status_check" CHECK ("thr_schedules"."status" IN ('scheduled', 'paid', 'cancelled')),
	CONSTRAINT "thr_schedules_dates_check" CHECK ("thr_schedules"."pay_date" <= "thr_schedules"."holiday_date" AND "thr_schedules"."tenure_as_of_date" <= "thr_schedules"."holiday_date"),
	CONSTRAINT "thr_schedules_employee_ids_check" CHECK ("thr_schedules"."employee_ids" IS NULL OR jsonb_typeof("thr_schedules"."employee_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "bank_transfer_files" ADD CONSTRAINT "bank_transfer_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_files" ADD CONSTRAINT "bank_transfer_files_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_components" ADD CONSTRAINT "employee_pay_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_components" ADD CONSTRAINT "employee_pay_components_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_components" ADD CONSTRAINT "employee_pay_components_component_fk" FOREIGN KEY ("tenant_id","component_id") REFERENCES "public"."pay_components"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_policy_fk" FOREIGN KEY ("tenant_id","payroll_policy_id") REFERENCES "public"."payroll_policies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_thr_schedule_fk" FOREIGN KEY ("tenant_id","thr_schedule_id") REFERENCES "public"."thr_schedules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_tax_exports" ADD CONSTRAINT "payroll_tax_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_tax_exports" ADD CONSTRAINT "payroll_tax_exports_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_categories" ADD CONSTRAINT "reimbursement_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."reimbursement_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_allocations" ADD CONSTRAINT "service_charge_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_allocations" ADD CONSTRAINT "service_charge_allocations_pool_fk" FOREIGN KEY ("tenant_id","pool_id") REFERENCES "public"."service_charge_pools"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_allocations" ADD CONSTRAINT "service_charge_allocations_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_pools" ADD CONSTRAINT "service_charge_pools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_pools" ADD CONSTRAINT "service_charge_pools_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_charge_pools" ADD CONSTRAINT "service_charge_pools_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thr_schedules" ADD CONSTRAINT "thr_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thr_schedules" ADD CONSTRAINT "thr_schedules_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_loans_tenant_employee_idx" ON "employee_loans" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_pay_components_open_key" ON "employee_pay_components" USING btree ("tenant_id","employee_id","component_id") WHERE "employee_pay_components"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "payroll_runs_tenant_period_idx" ON "payroll_runs" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE INDEX "payslips_tenant_employee_idx" ON "payslips" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "reimbursements_tenant_employee_idx" ON "reimbursements" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "reimbursements_tenant_status_idx" ON "reimbursements" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "service_charge_pools_live_period_key" ON "service_charge_pools" USING btree ("tenant_id","outlet_id","period_start","period_end") WHERE "service_charge_pools"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_rates_tenant_type_published_from_key" ON "statutory_rates" USING btree ("tenant_id","type","effective_from") WHERE "statutory_rates"."status" = 'published';--> statement-breakpoint
CREATE INDEX "thr_schedules_tenant_holiday_idx" ON "thr_schedules" USING btree ("tenant_id","holiday_date");
--> statement-breakpoint
-- Payroll core tables (bead legend-gfcr; PRD v1.7 §3 D.30-31, §6 H, R20,
-- PAYR-02, HR-03). Appended to the generated migration 0167_payroll_core.
-- Every table is tenant-owned: forced, restrictive tenant RLS (TEN-01/02).
-- service_charge_pools carries outlet_id NOT NULL, so it also gets the TEN-03
-- outlet backstop. Every CHECK / unique constraint lives in schema/payroll.ts.
-- Restore FORCE on the parents lifted at the top of 0167 (legend-m007).
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.statutory_rates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.thr_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pay_components'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employee_pay_components'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payslips'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_transfer_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_tax_exports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.service_charge_pools'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.service_charge_pools'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.service_charge_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employee_loans'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reimbursement_categories'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reimbursements'::regclass);
--> statement-breakpoint
-- Payroll history is never deleted by the app role (audit, PAYR-04/05).
-- Allocations are the exception: a pool recalculated before approval
-- replaces its allocations (calculated -> calculated, service-charge.ts).
REVOKE DELETE, TRUNCATE ON TABLE
  public.statutory_rates, public.payroll_policies, public.thr_schedules,
  public.pay_components, public.employee_pay_components, public.payroll_runs,
  public.payslips, public.bank_transfer_files, public.payroll_tax_exports,
  public.service_charge_pools, public.employee_loans,
  public.reimbursement_categories, public.reimbursements
  FROM legend_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE public.service_charge_allocations FROM legend_app;
--> statement-breakpoint
-- HR-03 + PAYR-02: a sealed pay amount is never rewritten; a new amount is a
-- new row from its effective date. Only the end date of the previous row may
-- be set when the next one starts.
REVOKE UPDATE ON TABLE public.employee_pay_components FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (effective_to) ON TABLE public.employee_pay_components TO legend_app;
--> statement-breakpoint
-- A payslip is written once when the run locks (PAYR-04). Afterwards only the
-- rendered PDF key and the first PIN view may be recorded.
REVOKE UPDATE ON TABLE public.payslips FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (pdf_object_key, viewed_at) ON TABLE public.payslips TO legend_app;
--> statement-breakpoint
-- A bank file is derived from the locked payslips and never edited (PAYR-04).
REVOKE UPDATE ON TABLE public.bank_transfer_files FROM legend_app;
--> statement-breakpoint
-- PAYR-02 / R20: a published or archived statutory version never changes. A
-- draft may be edited and then published or archived exactly once. Enforced
-- here so a direct write cannot slip past the service.
CREATE OR REPLACE FUNCTION app.statutory_rates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'PAYR-02: statutory version % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'PAYR-02: statutory version % is % and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.type <> OLD.type OR NEW.version <> OLD.version
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYR-02: statutory version % identity cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "statutory_rates_guard_trg"
  BEFORE UPDATE OR DELETE ON "statutory_rates"
  FOR EACH ROW EXECUTE FUNCTION app.statutory_rates_guard();
--> statement-breakpoint
-- PAYR-02 / PAYR-04 / PAYR-05: once a run is locked, its pinned configuration,
-- totals, period, policy and approvals are fixed. The only moves left are
-- locked -> paid, and locked/paid -> reversed through the reversal record.
CREATE OR REPLACE FUNCTION app.payroll_runs_lock_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status NOT IN ('locked', 'paid', 'reversed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'reversed'
    OR (NEW.status <> OLD.status AND NOT (
      (OLD.status = 'locked' AND NEW.status IN ('paid', 'reversed'))
      OR (OLD.status = 'paid' AND NEW.status = 'reversed')))
  THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % is % and cannot move to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.legal_entity_id <> OLD.legal_entity_id
    OR NEW.payroll_policy_id <> OLD.payroll_policy_id
    OR NEW.run_type <> OLD.run_type
    OR NEW.thr_schedule_id IS DISTINCT FROM OLD.thr_schedule_id
    OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
    OR NEW.pay_date <> OLD.pay_date
    OR NEW.simulation_count <> OLD.simulation_count
    OR NEW.last_simulated_at IS DISTINCT FROM OLD.last_simulated_at
    OR NEW.totals IS DISTINCT FROM OLD.totals
    OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
    OR NEW.approved_by_hr IS DISTINCT FROM OLD.approved_by_hr
    OR NEW.approved_by_hr_at IS DISTINCT FROM OLD.approved_by_hr_at
    OR NEW.approved_by_finance IS DISTINCT FROM OLD.approved_by_finance
    OR NEW.approved_by_finance_at IS DISTINCT FROM OLD.approved_by_finance_at
    OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
    OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR (OLD.paid_at IS NOT NULL AND (
      NEW.paid_at IS DISTINCT FROM OLD.paid_at
      OR NEW.paid_by IS DISTINCT FROM OLD.paid_by))
  THEN
    RAISE EXCEPTION 'PAYR-02: locked payroll run % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payroll_runs_lock_guard_trg"
  BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_lock_guard();
