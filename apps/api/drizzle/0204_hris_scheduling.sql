CREATE TABLE "roster_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"from_week_start" date NOT NULL,
	"to_week_start" date NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"assignment_ids" uuid[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_copies_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "roster_copies_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "roster_copies_count_check" CHECK (cardinality("roster_copies"."assignment_ids") > 0 AND "roster_copies"."to_week_start" <> "roster_copies"."from_week_start")
);
--> statement-breakpoint
CREATE TABLE "roster_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"compliance_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignment_count" integer NOT NULL,
	"assignment_ids" uuid[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_publications_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "roster_publications_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "roster_publications_count_check" CHECK ("roster_publications"."assignment_count" > 0 AND cardinality("roster_publications"."assignment_ids") = "roster_publications"."assignment_count")
);
--> statement-breakpoint
CREATE TABLE "shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_template_id" uuid,
	"station_id" uuid,
	"business_date" date NOT NULL,
	"segments" jsonb NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"source" varchar(10) DEFAULT 'user' NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"create_idempotency_key" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_assignments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_assignments_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "shift_assignments_tenant_idempotency_key" UNIQUE("tenant_id","create_idempotency_key"),
	CONSTRAINT "shift_assignments_status_check" CHECK ("shift_assignments"."status" IN ('draft', 'published', 'swapped', 'cancelled')),
	CONSTRAINT "shift_assignments_source_check" CHECK ("shift_assignments"."source" IN ('user', 'ai', 'mcp')),
	CONSTRAINT "shift_assignments_break_check" CHECK ("shift_assignments"."break_minutes" >= 0 AND "shift_assignments"."break_minutes" <= 240),
	CONSTRAINT "shift_assignments_segments_check" CHECK (jsonb_typeof("shift_assignments"."segments") = 'array' AND jsonb_array_length("shift_assignments"."segments") BETWEEN 1 AND 2),
	CONSTRAINT "shift_assignments_published_check" CHECK (("shift_assignments"."published_by" IS NULL) = ("shift_assignments"."published_at" IS NULL)
        AND ("shift_assignments"."status" = 'draft') = ("shift_assignments"."published_at" IS NULL)
        OR "shift_assignments"."status" = 'cancelled')
);
--> statement-breakpoint
CREATE TABLE "shift_compliance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"max_shift_minutes" integer DEFAULT 600 NOT NULL,
	"max_daily_minutes" integer DEFAULT 720 NOT NULL,
	"max_weekly_minutes" integer DEFAULT 2700 NOT NULL,
	"min_rest_minutes_between_shifts" integer DEFAULT 660 NOT NULL,
	"max_consecutive_work_days" integer DEFAULT 6 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_compliance_policies_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_compliance_policies_limits_check" CHECK ("shift_compliance_policies"."max_shift_minutes" BETWEEN 60 AND 1440
        AND "shift_compliance_policies"."max_daily_minutes" BETWEEN "shift_compliance_policies"."max_shift_minutes" AND 2880
        AND "shift_compliance_policies"."max_weekly_minutes" BETWEEN "shift_compliance_policies"."max_daily_minutes" AND 10080
        AND "shift_compliance_policies"."min_rest_minutes_between_shifts" BETWEEN 0 AND 1440
        AND "shift_compliance_policies"."max_consecutive_work_days" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"from_assignment_id" uuid NOT NULL,
	"to_assignment_id" uuid,
	"requested_by" uuid NOT NULL,
	"to_employee_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"compliance_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"override_reason" varchar(500),
	"approved_by" text,
	"requested_by_user_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"create_idempotency_key" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_swap_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_swap_requests_tenant_idempotency_key" UNIQUE("tenant_id","create_idempotency_key"),
	CONSTRAINT "shift_swap_requests_status_check" CHECK ("shift_swap_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
	CONSTRAINT "shift_swap_requests_distinct_employee_check" CHECK ("shift_swap_requests"."requested_by" <> "shift_swap_requests"."to_employee_id"),
	CONSTRAINT "shift_swap_requests_decision_check" CHECK (("shift_swap_requests"."approved_by" IS NULL) = ("shift_swap_requests"."decided_at" IS NULL)
        OR "shift_swap_requests"."status" IN ('cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "shift_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"segments" jsonb NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"station_id" uuid,
	"position_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_templates_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_templates_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "shift_templates_tenant_outlet_name_key" UNIQUE("tenant_id","outlet_id","name"),
	CONSTRAINT "shift_templates_break_check" CHECK ("shift_templates"."break_minutes" >= 0 AND "shift_templates"."break_minutes" <= 240),
	CONSTRAINT "shift_templates_segments_check" CHECK (jsonb_typeof("shift_templates"."segments") = 'array' AND jsonb_array_length("shift_templates"."segments") BETWEEN 1 AND 2)
);
--> statement-breakpoint
ALTER TABLE "roster_copies" ADD CONSTRAINT "roster_copies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_copies" ADD CONSTRAINT "roster_copies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_publications" ADD CONSTRAINT "roster_publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_publications" ADD CONSTRAINT "roster_publications_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_template_fk" FOREIGN KEY ("tenant_id","outlet_id","shift_template_id") REFERENCES "public"."shift_templates"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_compliance_policies" ADD CONSTRAINT "shift_compliance_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_compliance_policies" ADD CONSTRAINT "shift_compliance_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_from_fk" FOREIGN KEY ("tenant_id","outlet_id","from_assignment_id") REFERENCES "public"."shift_assignments"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_to_fk" FOREIGN KEY ("tenant_id","outlet_id","to_assignment_id") REFERENCES "public"."shift_assignments"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requester_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_target_fk" FOREIGN KEY ("tenant_id","to_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_copies_tenant_outlet_week_idx" ON "roster_copies" USING btree ("tenant_id","outlet_id","to_week_start");--> statement-breakpoint
CREATE INDEX "roster_publications_tenant_outlet_week_idx" ON "roster_publications" USING btree ("tenant_id","outlet_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_assignments_active_employee_day_template_key" ON "shift_assignments" USING btree ("tenant_id","employee_id","business_date","shift_template_id") WHERE "shift_assignments"."status" <> 'cancelled' AND "shift_assignments"."shift_template_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shift_assignments_tenant_outlet_date_idx" ON "shift_assignments" USING btree ("tenant_id","outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "shift_assignments_tenant_employee_date_idx" ON "shift_assignments" USING btree ("tenant_id","employee_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_compliance_policies_tenant_outlet_key" ON "shift_compliance_policies" USING btree ("tenant_id","outlet_id") WHERE "shift_compliance_policies"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_compliance_policies_tenant_default_key" ON "shift_compliance_policies" USING btree ("tenant_id") WHERE "shift_compliance_policies"."outlet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "shift_swap_requests_tenant_outlet_status_idx" ON "shift_swap_requests" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_swap_requests_open_from_key" ON "shift_swap_requests" USING btree ("tenant_id","from_assignment_id") WHERE "shift_swap_requests"."status" = 'pending';
--> statement-breakpoint
-- HRIS shift scheduling (bead legend-jstx; PRD v1.7 §3 F26, HR-05): tenant RLS
-- on every table (TEN-01/02). Tables with outlet_id NOT NULL also get the
-- TEN-03 outlet backstop; shift_compliance_policies.outlet_id is nullable
-- (null = tenant default) and keeps the service-layer outlet filter only.
-- Every CHECK / unique constraint is expressed in schema/hris-scheduling.ts.
SELECT app.enforce_tenant_rls('public.shift_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_assignments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.roster_publications'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.roster_publications'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.roster_copies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.roster_copies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_swap_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_swap_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_compliance_policies'::regclass);
