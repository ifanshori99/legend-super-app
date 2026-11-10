CREATE TABLE "hris_checklist_task_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"action" varchar(10) NOT NULL,
	"from_status" varchar(10) NOT NULL,
	"to_status" varchar(10) NOT NULL,
	"reason" varchar(500),
	"document_id" uuid,
	"actor_user_id" text NOT NULL,
	"idempotency_key" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_checklist_task_actions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_checklist_task_actions_idempotency_key" UNIQUE("tenant_id","task_id","idempotency_key"),
	CONSTRAINT "hris_checklist_task_actions_action_check" CHECK ("hris_checklist_task_actions"."action" IN ('complete', 'block', 'unblock', 'waive')),
	CONSTRAINT "hris_checklist_task_actions_reason_check" CHECK ("hris_checklist_task_actions"."action" NOT IN ('block', 'waive') OR "hris_checklist_task_actions"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "hris_checklist_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"offboarding_id" uuid,
	"template_id" uuid,
	"kind" varchar(12) NOT NULL,
	"code" varchar(40) NOT NULL,
	"title" varchar(200) NOT NULL,
	"category" varchar(20) NOT NULL,
	"requires_document" boolean DEFAULT false NOT NULL,
	"document_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"system_managed" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"done_by" text,
	"done_at" timestamp with time zone,
	"block_reason" varchar(500),
	"waive_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_checklist_tasks_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_checklist_tasks_kind_check" CHECK ("hris_checklist_tasks"."kind" IN ('onboarding', 'offboarding')),
	CONSTRAINT "hris_checklist_tasks_category_check" CHECK ("hris_checklist_tasks"."category" IN ('documents', 'uniform', 'account', 'training', 'asset', 'access_revocation', 'final_settlement', 'work_certificate', 'other')),
	CONSTRAINT "hris_checklist_tasks_status_check" CHECK ("hris_checklist_tasks"."status" IN ('open', 'done', 'blocked', 'waived')),
	CONSTRAINT "hris_checklist_tasks_done_pair_check" CHECK (("hris_checklist_tasks"."done_by" IS NULL) = ("hris_checklist_tasks"."done_at" IS NULL)),
	CONSTRAINT "hris_checklist_tasks_done_check" CHECK (("hris_checklist_tasks"."status" = 'done') = ("hris_checklist_tasks"."done_at" IS NOT NULL)),
	CONSTRAINT "hris_checklist_tasks_blocked_check" CHECK ("hris_checklist_tasks"."status" <> 'blocked' OR "hris_checklist_tasks"."block_reason" IS NOT NULL),
	CONSTRAINT "hris_checklist_tasks_waived_check" CHECK ("hris_checklist_tasks"."status" <> 'waived' OR "hris_checklist_tasks"."waive_reason" IS NOT NULL),
	CONSTRAINT "hris_checklist_tasks_offboarding_link_check" CHECK (("hris_checklist_tasks"."kind" = 'offboarding') = ("hris_checklist_tasks"."offboarding_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hris_checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"position_id" uuid,
	"title" varchar(150) NOT NULL,
	"items" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_checklist_templates_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_checklist_templates_kind_check" CHECK ("hris_checklist_templates"."kind" IN ('onboarding', 'offboarding')),
	CONSTRAINT "hris_checklist_templates_items_array_check" CHECK (jsonb_typeof("hris_checklist_templates"."items") = 'array' AND jsonb_array_length("hris_checklist_templates"."items") > 0)
);
--> statement-breakpoint
CREATE TABLE "hris_kpi_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position_id" uuid,
	"name" varchar(150) NOT NULL,
	"source" varchar(10) NOT NULL,
	"metric_code" varchar(60),
	"target" numeric(18, 4),
	"unit" varchar(20) NOT NULL,
	"direction" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_kpi_definitions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_kpi_definitions_source_check" CHECK ("hris_kpi_definitions"."source" IN ('system', 'manager')),
	CONSTRAINT "hris_kpi_definitions_metric_code_check" CHECK (("hris_kpi_definitions"."source" = 'system') = ("hris_kpi_definitions"."metric_code" IS NOT NULL)),
	CONSTRAINT "hris_kpi_definitions_target_check" CHECK ("hris_kpi_definitions"."target" IS NULL OR "hris_kpi_definitions"."target" >= 0),
	CONSTRAINT "hris_kpi_definitions_direction_check" CHECK ("hris_kpi_definitions"."direction" IN ('higher_is_better', 'lower_is_better'))
);
--> statement-breakpoint
CREATE TABLE "hris_kpi_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"cycle" varchar(10) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"reviewer_user_id" text,
	"submitted_at" timestamp with time zone,
	"overall_score" numeric(5, 2),
	"note" varchar(2000),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_kpi_reviews_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_kpi_reviews_employee_period_key" UNIQUE("tenant_id","employee_id","cycle","period_start"),
	CONSTRAINT "hris_kpi_reviews_cycle_check" CHECK ("hris_kpi_reviews"."cycle" IN ('monthly', 'quarterly')),
	CONSTRAINT "hris_kpi_reviews_status_check" CHECK ("hris_kpi_reviews"."status" IN ('draft', 'submitted')),
	CONSTRAINT "hris_kpi_reviews_period_check" CHECK ("hris_kpi_reviews"."period_end" >= "hris_kpi_reviews"."period_start"),
	CONSTRAINT "hris_kpi_reviews_submitted_check" CHECK (("hris_kpi_reviews"."status" = 'submitted') = ("hris_kpi_reviews"."submitted_at" IS NOT NULL AND "hris_kpi_reviews"."reviewer_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hris_kpi_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"kpi_definition_id" uuid NOT NULL,
	"definition_snapshot" jsonb NOT NULL,
	"system_actual" numeric(18, 4),
	"system_availability" varchar(30),
	"system_computed_at" timestamp with time zone,
	"actual" numeric(18, 4),
	"actual_source" varchar(10),
	"score" smallint,
	"comment" varchar(1000),
	CONSTRAINT "hris_kpi_scores_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_kpi_scores_review_definition_key" UNIQUE("tenant_id","review_id","kpi_definition_id"),
	CONSTRAINT "hris_kpi_scores_score_check" CHECK ("hris_kpi_scores"."score" IS NULL OR "hris_kpi_scores"."score" BETWEEN 0 AND 100),
	CONSTRAINT "hris_kpi_scores_actual_source_check" CHECK ("hris_kpi_scores"."actual_source" IS NULL OR "hris_kpi_scores"."actual_source" IN ('system', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "hris_offboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"exit_type" varchar(20) NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"notice_date" date,
	"last_working_date" date NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"access_revoked_at" timestamp with time zone,
	"access_revoked_by" text,
	"revocation_result" jsonb,
	"settlement_snapshot" jsonb,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" varchar(500),
	"certificate_no" varchar(40),
	"certificate_issued_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_offboardings_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hris_offboardings_exit_type_check" CHECK ("hris_offboardings"."exit_type" IN ('resignation', 'termination', 'contract_end')),
	CONSTRAINT "hris_offboardings_status_check" CHECK ("hris_offboardings"."status" IN ('open', 'revoked', 'completed', 'cancelled')),
	CONSTRAINT "hris_offboardings_revoked_check" CHECK ("hris_offboardings"."status" NOT IN ('revoked', 'completed') OR ("hris_offboardings"."access_revoked_at" IS NOT NULL AND "hris_offboardings"."access_revoked_by" IS NOT NULL AND "hris_offboardings"."revocation_result" IS NOT NULL)),
	CONSTRAINT "hris_offboardings_completed_check" CHECK ("hris_offboardings"."status" <> 'completed' OR ("hris_offboardings"."completed_at" IS NOT NULL AND "hris_offboardings"."completed_by" IS NOT NULL AND "hris_offboardings"."settlement_snapshot" IS NOT NULL)),
	CONSTRAINT "hris_offboardings_cancelled_check" CHECK ("hris_offboardings"."status" <> 'cancelled' OR ("hris_offboardings"."access_revoked_at" IS NULL AND "hris_offboardings"."cancelled_at" IS NOT NULL AND "hris_offboardings"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "hris_offboardings_notice_check" CHECK ("hris_offboardings"."notice_date" IS NULL OR "hris_offboardings"."notice_date" <= "hris_offboardings"."last_working_date")
);
--> statement-breakpoint
ALTER TABLE "hris_checklist_task_actions" ADD CONSTRAINT "hris_checklist_task_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_task_actions" ADD CONSTRAINT "hris_checklist_task_actions_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."hris_checklist_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_task_actions" ADD CONSTRAINT "hris_checklist_task_actions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."employee_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_tasks" ADD CONSTRAINT "hris_checklist_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_tasks" ADD CONSTRAINT "hris_checklist_tasks_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_tasks" ADD CONSTRAINT "hris_checklist_tasks_offboarding_fk" FOREIGN KEY ("tenant_id","offboarding_id") REFERENCES "public"."hris_offboardings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_tasks" ADD CONSTRAINT "hris_checklist_tasks_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."hris_checklist_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_tasks" ADD CONSTRAINT "hris_checklist_tasks_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."employee_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_templates" ADD CONSTRAINT "hris_checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_checklist_templates" ADD CONSTRAINT "hris_checklist_templates_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_definitions" ADD CONSTRAINT "hris_kpi_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_definitions" ADD CONSTRAINT "hris_kpi_definitions_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_reviews" ADD CONSTRAINT "hris_kpi_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_reviews" ADD CONSTRAINT "hris_kpi_reviews_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_scores" ADD CONSTRAINT "hris_kpi_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_scores" ADD CONSTRAINT "hris_kpi_scores_review_fk" FOREIGN KEY ("tenant_id","review_id") REFERENCES "public"."hris_kpi_reviews"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_kpi_scores" ADD CONSTRAINT "hris_kpi_scores_definition_fk" FOREIGN KEY ("tenant_id","kpi_definition_id") REFERENCES "public"."hris_kpi_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_offboardings" ADD CONSTRAINT "hris_offboardings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_offboardings" ADD CONSTRAINT "hris_offboardings_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hris_checklist_task_actions_task_idx" ON "hris_checklist_task_actions" USING btree ("tenant_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hris_checklist_tasks_onboarding_code_key" ON "hris_checklist_tasks" USING btree ("tenant_id","employee_id","code") WHERE "hris_checklist_tasks"."kind" = 'onboarding';--> statement-breakpoint
CREATE UNIQUE INDEX "hris_checklist_tasks_offboarding_code_key" ON "hris_checklist_tasks" USING btree ("tenant_id","offboarding_id","code") WHERE "hris_checklist_tasks"."offboarding_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hris_checklist_tasks_tenant_employee_idx" ON "hris_checklist_tasks" USING btree ("tenant_id","employee_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "hris_checklist_templates_active_position_key" ON "hris_checklist_templates" USING btree ("tenant_id","kind","position_id") WHERE "hris_checklist_templates"."is_active" AND "hris_checklist_templates"."position_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hris_checklist_templates_active_default_key" ON "hris_checklist_templates" USING btree ("tenant_id","kind") WHERE "hris_checklist_templates"."is_active" AND "hris_checklist_templates"."position_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hris_kpi_definitions_active_position_name_key" ON "hris_kpi_definitions" USING btree ("tenant_id","position_id","name") WHERE "hris_kpi_definitions"."is_active" AND "hris_kpi_definitions"."position_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hris_kpi_definitions_active_default_name_key" ON "hris_kpi_definitions" USING btree ("tenant_id","name") WHERE "hris_kpi_definitions"."is_active" AND "hris_kpi_definitions"."position_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hris_offboardings_live_employee_key" ON "hris_offboardings" USING btree ("tenant_id","employee_id") WHERE "hris_offboardings"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "hris_offboardings_certificate_no_key" ON "hris_offboardings" USING btree ("tenant_id","certificate_no") WHERE "hris_offboardings"."certificate_no" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_window_check";--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_window_check" CHECK ("role_assignments"."valid_until" IS NULL OR "role_assignments"."valid_until" >= "role_assignments"."valid_from");
--> statement-breakpoint
-- HRIS lifecycle and KPI (bead legend-ovxw; PRD v1.7 F24, F29): tenant RLS on
-- every table (TEN-01/02). None carries a NOT NULL `outlet_id`, so outlet
-- reach is enforced in services/hris-*.ts through the employee's home outlet
-- (like `employees`). The task action trail is append-only.
SELECT app.enforce_tenant_rls('public.hris_checklist_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_offboardings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_checklist_tasks'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_checklist_task_actions'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.hris_checklist_task_actions FROM legend_app;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_definitions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_reviews'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_kpi_scores'::regclass);
