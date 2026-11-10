CREATE TABLE "attendance_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"attendance_log_id" uuid,
	"requested_type" varchar(20) NOT NULL,
	"requested_occurred_at" timestamp with time zone NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approval_chain_id" uuid,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"resulting_log_id" uuid,
	"idempotency_key" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_corrections_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_corrections_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "attendance_corrections_type_check" CHECK ("attendance_corrections"."requested_type" IN ('in', 'out', 'break_start', 'break_end')),
	CONSTRAINT "attendance_corrections_status_check" CHECK ("attendance_corrections"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "attendance_corrections_decision_check" CHECK (("attendance_corrections"."decided_by" IS NULL) = ("attendance_corrections"."decided_at" IS NULL)
        AND ("attendance_corrections"."status" = 'pending') = ("attendance_corrections"."decided_at" IS NULL)),
	CONSTRAINT "attendance_corrections_result_check" CHECK ("attendance_corrections"."resulting_log_id" IS NULL OR "attendance_corrections"."status" = 'approved'),
	CONSTRAINT "attendance_corrections_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "attendance_corrections_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "attendance_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"device_id_hash" varchar(64) NOT NULL,
	"label" varchar(100) NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "attendance_devices_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_devices_tenant_employee_hash_key" UNIQUE("tenant_id","employee_id","device_id_hash"),
	CONSTRAINT "attendance_devices_hash_check" CHECK ("device_id_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attendance_devices_status_check" CHECK ("attendance_devices"."status" IN ('active', 'revoked')),
	CONSTRAINT "attendance_devices_revoked_check" CHECK (("attendance_devices"."status" = 'revoked') = ("attendance_devices"."revoked_at" IS NOT NULL)
        AND ("attendance_devices"."revoked_at" IS NULL) = ("attendance_devices"."revoked_by" IS NULL)),
	CONSTRAINT "attendance_devices_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "attendance_duty_meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_assignment_id" uuid,
	"business_date" date NOT NULL,
	"meal_count" integer DEFAULT 1 NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	CONSTRAINT "attendance_duty_meals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_duty_meals_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "attendance_duty_meals_employee_day_shift_key" UNIQUE NULLS NOT DISTINCT("tenant_id","employee_id","business_date","shift_assignment_id"),
	CONSTRAINT "attendance_duty_meals_count_check" CHECK ("attendance_duty_meals"."meal_count" >= 1),
	CONSTRAINT "attendance_duty_meals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "attendance_duty_meals_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "attendance_duty_meals_shift_assignment_fk" FOREIGN KEY ("tenant_id","shift_assignment_id") REFERENCES "public"."shift_assignments"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "attendance_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"method" varchar(20) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"geo_distance_m" integer,
	"device_id_hash" varchar(64),
	"photo_key" text,
	"photo_purged_at" timestamp with time zone,
	"validity" varchar(10) NOT NULL,
	"flag_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shift_assignment_id" uuid,
	"business_date" date NOT NULL,
	"late_minutes" integer,
	"early_leave_minutes" integer,
	"overtime_minutes" integer,
	"offline" boolean DEFAULT false NOT NULL,
	"client_event_id" varchar(100) NOT NULL,
	"correction_id" uuid,
	"review_status" varchar(10) DEFAULT 'none' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "attendance_logs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_logs_tenant_client_event_key" UNIQUE("tenant_id","client_event_id"),
	CONSTRAINT "attendance_logs_type_check" CHECK ("attendance_logs"."type" IN ('in', 'out', 'break_start', 'break_end')),
	CONSTRAINT "attendance_logs_method_check" CHECK ("attendance_logs"."method" IN ('selfie_geo', 'rotating_qr', 'manual_correction')),
	CONSTRAINT "attendance_logs_validity_check" CHECK ("attendance_logs"."validity" IN ('valid', 'flagged', 'rejected')),
	CONSTRAINT "attendance_logs_review_status_check" CHECK ("attendance_logs"."review_status" IN ('none', 'pending', 'accepted', 'rejected')),
	CONSTRAINT "attendance_logs_review_check" CHECK (("attendance_logs"."reviewed_by" IS NULL) = ("attendance_logs"."reviewed_at" IS NULL)
        AND ("attendance_logs"."review_status" IN ('accepted', 'rejected')) = ("attendance_logs"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "attendance_logs_flag_reasons_check" CHECK (jsonb_typeof("attendance_logs"."flag_reasons") = 'array'),
	CONSTRAINT "attendance_logs_device_hash_check" CHECK ("device_id_hash" IS NULL OR "device_id_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attendance_logs_measure_check" CHECK (("attendance_logs"."geo_distance_m" IS NULL OR "attendance_logs"."geo_distance_m" >= 0)
        AND ("attendance_logs"."late_minutes" IS NULL OR "attendance_logs"."late_minutes" >= 0)
        AND ("attendance_logs"."early_leave_minutes" IS NULL OR "attendance_logs"."early_leave_minutes" >= 0)
        AND ("attendance_logs"."overtime_minutes" IS NULL OR "attendance_logs"."overtime_minutes" >= 0)),
	CONSTRAINT "attendance_logs_photo_check" CHECK ("attendance_logs"."photo_purged_at" IS NULL OR "attendance_logs"."photo_key" IS NULL),
	CONSTRAINT "attendance_logs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "attendance_logs_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "attendance_logs_shift_assignment_fk" FOREIGN KEY ("tenant_id","shift_assignment_id") REFERENCES "public"."shift_assignments"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "attendance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"policy" jsonb NOT NULL,
	"sampling" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_policies_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_policies_tenant_outlet_key" UNIQUE NULLS NOT DISTINCT("tenant_id","outlet_id"),
	CONSTRAINT "attendance_policies_policy_check" CHECK (jsonb_typeof("attendance_policies"."policy") = 'object'),
	CONSTRAINT "attendance_policies_sampling_check" CHECK (jsonb_typeof("attendance_policies"."sampling") = 'object'
        AND ("attendance_policies"."sampling"->>'rate')::numeric BETWEEN 0 AND 1
        AND jsonb_typeof("attendance_policies"."sampling"->'flaggedAlways') = 'boolean'
        AND ("attendance_policies"."sampling"->>'minPerSupervisorPerWeek')::numeric >= 0),
	CONSTRAINT "attendance_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "attendance_qr_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"seed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "attendance_qr_secrets_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_qr_secrets_tenant_outlet_key" UNIQUE("tenant_id","outlet_id"),
	CONSTRAINT "attendance_qr_secrets_seed_check" CHECK (octet_length("attendance_qr_secrets"."seed") >= 32),
	CONSTRAINT "attendance_qr_secrets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_log_fk" FOREIGN KEY ("tenant_id","attendance_log_id") REFERENCES "public"."attendance_logs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_resulting_log_fk" FOREIGN KEY ("tenant_id","resulting_log_id") REFERENCES "public"."attendance_logs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_duty_meals" ADD CONSTRAINT "attendance_duty_meals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_correction_fk" FOREIGN KEY ("tenant_id","correction_id") REFERENCES "public"."attendance_corrections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_qr_secrets" ADD CONSTRAINT "attendance_qr_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_corrections_tenant_employee_idx" ON "attendance_corrections" USING btree ("tenant_id","employee_id","requested_occurred_at");--> statement-breakpoint
CREATE INDEX "attendance_corrections_tenant_outlet_status_idx" ON "attendance_corrections" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "attendance_corrections_chain_idx" ON "attendance_corrections" USING btree ("tenant_id","approval_chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_active_employee_key" ON "attendance_devices" USING btree ("tenant_id","employee_id") WHERE "attendance_devices"."status" = 'active';--> statement-breakpoint
CREATE INDEX "attendance_duty_meals_tenant_outlet_date_idx" ON "attendance_duty_meals" USING btree ("tenant_id","outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "attendance_logs_tenant_employee_date_idx" ON "attendance_logs" USING btree ("tenant_id","employee_id","business_date");--> statement-breakpoint
CREATE INDEX "attendance_logs_tenant_outlet_occurred_idx" ON "attendance_logs" USING btree ("tenant_id","outlet_id","occurred_at");--> statement-breakpoint
CREATE INDEX "attendance_logs_photo_purge_idx" ON "attendance_logs" USING btree ("tenant_id","business_date") WHERE "attendance_logs"."photo_key" IS NOT NULL;
--> statement-breakpoint
-- HRIS attendance (bead legend-wh71; PRD v1.7 §3 F25, HR-02): tenant RLS on
-- every table (TEN-01/02). Tables with outlet_id NOT NULL also get the TEN-03
-- outlet backstop; attendance_policies.outlet_id is nullable (null = tenant
-- default) and attendance_devices belongs to the employee, so both keep the
-- service-layer outlet filter only. Every CHECK / unique constraint is
-- expressed in schema/hris-attendance.ts.
SELECT app.enforce_tenant_rls('public.attendance_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_corrections'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_corrections'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_qr_secrets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_qr_secrets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.attendance_duty_meals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.attendance_duty_meals'::regclass);
