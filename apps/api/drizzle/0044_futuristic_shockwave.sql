CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"storage_object_id" uuid NOT NULL,
	"expires_on" date,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	CONSTRAINT "employee_documents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_documents_type_check" CHECK ("employee_documents"."type" IN ('ktp', 'npwp', 'bpjs', 'contract', 'certificate', 'education', 'other')),
	CONSTRAINT "employee_documents_verified_check" CHECK (("employee_documents"."verified_by" IS NULL) = ("employee_documents"."verified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text,
	"legal_entity_id" uuid,
	"employee_no" varchar(30) NOT NULL,
	"full_name" varchar(150) NOT NULL,
	"position_id" uuid,
	"org_unit_id" uuid,
	"manager_id" uuid,
	"home_outlet_id" uuid NOT NULL,
	"employment_type" varchar(20) NOT NULL,
	"join_date" date NOT NULL,
	"end_date" date,
	"ptkp_status" varchar(10),
	"status" varchar(20) DEFAULT 'onboarding' NOT NULL,
	"nik_encrypted" "bytea",
	"nik_hmac" varchar(64),
	"npwp_encrypted" "bytea",
	"npwp_hmac" varchar(64),
	"bpjs_kes_no_encrypted" "bytea",
	"bpjs_kes_no_hmac" varchar(64),
	"bpjs_tk_no_encrypted" "bytea",
	"bpjs_tk_no_hmac" varchar(64),
	"bank_account_encrypted" "bytea",
	"bank_account_hmac" varchar(64),
	"emergency_contact_name_encrypted" "bytea",
	"emergency_contact_phone_encrypted" "bytea",
	"pii_key_version" smallint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employees_tenant_employee_no_key" UNIQUE("tenant_id","employee_no"),
	CONSTRAINT "employees_employment_type_check" CHECK ("employees"."employment_type" IN ('pkwtt', 'pkwt', 'daily', 'intern')),
	CONSTRAINT "employees_status_check" CHECK ("employees"."status" IN ('onboarding', 'active', 'suspended', 'resigned', 'terminated')),
	CONSTRAINT "employees_ptkp_status_check" CHECK ("employees"."ptkp_status" IS NULL OR "employees"."ptkp_status" IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3', 'K/I/0', 'K/I/1', 'K/I/2', 'K/I/3')),
	CONSTRAINT "employees_employee_no_check" CHECK ("employees"."employee_no" ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'),
	CONSTRAINT "employees_full_name_check" CHECK (length("employees"."full_name") > 0),
	CONSTRAINT "employees_dates_check" CHECK ("employees"."end_date" IS NULL OR "employees"."end_date" >= "employees"."join_date"),
	CONSTRAINT "employees_manager_check" CHECK ("employees"."manager_id" IS NULL OR "employees"."manager_id" <> "employees"."id"),
	CONSTRAINT "employees_pii_key_version_check" CHECK ("employees"."pii_key_version" > 0),
	CONSTRAINT "employees_nik_pair_check" CHECK (("employees"."nik_encrypted" IS NULL) = ("employees"."nik_hmac" IS NULL) AND ("employees"."nik_hmac" IS NULL OR "employees"."nik_hmac" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "employees_npwp_pair_check" CHECK (("employees"."npwp_encrypted" IS NULL) = ("employees"."npwp_hmac" IS NULL) AND ("employees"."npwp_hmac" IS NULL OR "employees"."npwp_hmac" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "employees_bpjs_kes_no_pair_check" CHECK (("employees"."bpjs_kes_no_encrypted" IS NULL) = ("employees"."bpjs_kes_no_hmac" IS NULL) AND ("employees"."bpjs_kes_no_hmac" IS NULL OR "employees"."bpjs_kes_no_hmac" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "employees_bpjs_tk_no_pair_check" CHECK (("employees"."bpjs_tk_no_encrypted" IS NULL) = ("employees"."bpjs_tk_no_hmac" IS NULL) AND ("employees"."bpjs_tk_no_hmac" IS NULL OR "employees"."bpjs_tk_no_hmac" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "employees_bank_account_pair_check" CHECK (("employees"."bank_account_encrypted" IS NULL) = ("employees"."bank_account_hmac" IS NULL) AND ("employees"."bank_account_hmac" IS NULL OR "employees"."bank_account_hmac" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "employment_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"renewed_from_id" uuid,
	"salary_snapshot_encrypted" "bytea",
	"pii_key_version" smallint DEFAULT 1 NOT NULL,
	"file_object_id" uuid,
	"reminder_days_before" integer NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_contracts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_contracts_type_check" CHECK ("employment_contracts"."type" IN ('pkwtt', 'pkwt', 'daily', 'intern')),
	CONSTRAINT "employment_contracts_status_check" CHECK ("employment_contracts"."status" IN ('draft', 'active', 'expired', 'renewed', 'terminated')),
	CONSTRAINT "employment_contracts_dates_check" CHECK ("employment_contracts"."end_date" IS NULL OR "employment_contracts"."end_date" >= "employment_contracts"."start_date"),
	CONSTRAINT "employment_contracts_term_check" CHECK (("employment_contracts"."type" <> 'pkwt' OR "employment_contracts"."end_date" IS NOT NULL) AND ("employment_contracts"."type" <> 'pkwtt' OR "employment_contracts"."end_date" IS NULL)),
	CONSTRAINT "employment_contracts_renewal_check" CHECK ("employment_contracts"."renewed_from_id" IS NULL OR "employment_contracts"."renewed_from_id" <> "employment_contracts"."id"),
	CONSTRAINT "employment_contracts_reminder_check" CHECK ("employment_contracts"."reminder_days_before" BETWEEN 1 AND 180),
	CONSTRAINT "employment_contracts_pii_key_version_check" CHECK ("employment_contracts"."pii_key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "hris_idempotency" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(60) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_idempotency_tenant_key_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "hris_idempotency_fingerprint_check" CHECK ("hris_idempotency"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(30) NOT NULL,
	"name" varchar(150) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_units_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "org_units_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "org_units_parent_check" CHECK ("org_units"."parent_id" IS NULL OR "org_units"."parent_id" <> "org_units"."id"),
	CONSTRAINT "org_units_text_check" CHECK (length("org_units"."code") > 0 AND length("org_units"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "position_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(150) NOT NULL,
	"level" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_grades_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "position_grades_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "position_grades_level_check" CHECK ("position_grades"."level" BETWEEN 1 AND 99),
	CONSTRAINT "position_grades_text_check" CHECK (length("position_grades"."code") > 0 AND length("position_grades"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"grade_id" uuid,
	"org_unit_id" uuid,
	"service_charge_points" numeric(14,4) DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "positions_points_check" CHECK ("positions"."service_charge_points" >= 0),
	CONSTRAINT "positions_name_check" CHECK (length("positions"."name") > 0)
);
--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_storage_fk" FOREIGN KEY ("tenant_id","storage_object_id") REFERENCES "public"."core_storage_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_home_outlet_fk" FOREIGN KEY ("tenant_id","home_outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_renewed_from_fk" FOREIGN KEY ("tenant_id","renewed_from_id") REFERENCES "public"."employment_contracts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_file_fk" FOREIGN KEY ("tenant_id","file_object_id") REFERENCES "public"."core_storage_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_idempotency" ADD CONSTRAINT "hris_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_grades" ADD CONSTRAINT "position_grades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."position_grades"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_documents_tenant_employee_idx" ON "employee_documents" USING btree ("tenant_id","employee_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_user_key" ON "employees" USING btree ("tenant_id","user_id") WHERE "employees"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_nik_hmac_key" ON "employees" USING btree ("tenant_id","nik_hmac") WHERE "employees"."nik_hmac" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_npwp_hmac_key" ON "employees" USING btree ("tenant_id","npwp_hmac") WHERE "employees"."npwp_hmac" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_bpjs_kes_no_hmac_key" ON "employees" USING btree ("tenant_id","bpjs_kes_no_hmac") WHERE "employees"."bpjs_kes_no_hmac" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_bpjs_tk_no_hmac_key" ON "employees" USING btree ("tenant_id","bpjs_tk_no_hmac") WHERE "employees"."bpjs_tk_no_hmac" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "employees_tenant_bank_account_hmac_idx" ON "employees" USING btree ("tenant_id","bank_account_hmac") WHERE "employees"."bank_account_hmac" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "employees_tenant_status_idx" ON "employees" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "employees_tenant_home_outlet_idx" ON "employees" USING btree ("tenant_id","home_outlet_id","employee_no");--> statement-breakpoint
CREATE INDEX "employment_contracts_tenant_employee_idx" ON "employment_contracts" USING btree ("tenant_id","employee_id","start_date");--> statement-breakpoint
CREATE INDEX "employment_contracts_tenant_expiry_idx" ON "employment_contracts" USING btree ("tenant_id","status","end_date") WHERE "employment_contracts"."end_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "org_units_tenant_parent_idx" ON "org_units" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "positions_tenant_org_unit_idx" ON "positions" USING btree ("tenant_id","org_unit_id");