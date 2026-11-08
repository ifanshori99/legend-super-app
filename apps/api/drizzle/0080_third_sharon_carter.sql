CREATE TABLE "sop_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sop_document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_acknowledgements_tenant_doc_employee_key" UNIQUE("tenant_id","sop_document_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "sop_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"supersedes_id" uuid,
	"station_id" uuid,
	"position_id" uuid,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requires_acknowledgement" boolean NOT NULL,
	"effective_from" date NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_documents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sop_documents_tenant_id_id_version_key" UNIQUE("tenant_id","id","version"),
	CONSTRAINT "sop_documents_tenant_lineage_version_key" UNIQUE("tenant_id","lineage_id","version"),
	CONSTRAINT "sop_documents_version_check" CHECK ("sop_documents"."version" > 0),
	CONSTRAINT "sop_documents_lineage_check" CHECK (("sop_documents"."version" = 1 AND "sop_documents"."supersedes_id" IS NULL AND "sop_documents"."lineage_id" = "sop_documents"."id") OR ("sop_documents"."version" > 1 AND "sop_documents"."supersedes_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "training_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"training_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"completion_id" uuid NOT NULL,
	"certificate_number" varchar(40) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_on" date,
	CONSTRAINT "training_certificates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "training_certificates_tenant_completion_key" UNIQUE("tenant_id","completion_id"),
	CONSTRAINT "training_certificates_tenant_number_key" UNIQUE("tenant_id","certificate_number")
);
--> statement-breakpoint
CREATE TABLE "training_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"training_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"score" smallint NOT NULL,
	"passed" boolean NOT NULL,
	"answers" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"expires_on" date,
	"idempotency_key" varchar(100) NOT NULL,
	CONSTRAINT "training_completions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "training_completions_tenant_attempt_key" UNIQUE("tenant_id","training_id","employee_id","attempt_number"),
	CONSTRAINT "training_completions_tenant_employee_idempotency_key" UNIQUE("tenant_id","employee_id","idempotency_key"),
	CONSTRAINT "training_completions_attempt_check" CHECK ("training_completions"."attempt_number" BETWEEN 1 AND 100),
	CONSTRAINT "training_completions_score_check" CHECK ("training_completions"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "training_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"training_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"enrolled_by" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" date,
	CONSTRAINT "training_enrollments_tenant_training_employee_key" UNIQUE("tenant_id","training_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "training_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"training_id" uuid NOT NULL,
	"sort_order" smallint NOT NULL,
	"prompt" varchar(500) NOT NULL,
	"options" jsonb NOT NULL,
	"points" smallint NOT NULL,
	"correct_option_index" smallint NOT NULL,
	CONSTRAINT "training_questions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "training_questions_tenant_training_sort_key" UNIQUE("tenant_id","training_id","sort_order"),
	CONSTRAINT "training_questions_options_check" CHECK (jsonb_typeof("training_questions"."options") = 'array' AND jsonb_array_length("training_questions"."options") BETWEEN 2 AND 6),
	CONSTRAINT "training_questions_points_check" CHECK ("training_questions"."points" BETWEEN 1 AND 100),
	CONSTRAINT "training_questions_correct_option_check" CHECK ("training_questions"."correct_option_index" >= 0 AND "training_questions"."correct_option_index" < jsonb_array_length("training_questions"."options")),
	CONSTRAINT "training_questions_sort_order_check" CHECK ("training_questions"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trainings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"station_id" uuid,
	"position_id" uuid,
	"passing_score" smallint NOT NULL,
	"validity_months" smallint NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trainings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "trainings_passing_score_check" CHECK ("trainings"."passing_score" BETWEEN 0 AND 100),
	CONSTRAINT "trainings_validity_months_check" CHECK ("trainings"."validity_months" BETWEEN 0 AND 120),
	CONSTRAINT "trainings_schedule_check" CHECK ("trainings"."scheduled_start" IS NULL OR "trainings"."scheduled_end" IS NULL OR "trainings"."scheduled_end" > "trainings"."scheduled_start")
);
--> statement-breakpoint
CREATE TABLE "hris_announcement_outlets" (
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	CONSTRAINT "hris_announcement_outlets_pkey" PRIMARY KEY("tenant_id","announcement_id","outlet_id")
);
--> statement-breakpoint
CREATE TABLE "announcement_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"idempotency_key" varchar(100) NOT NULL,
	CONSTRAINT "announcement_receipts_tenant_announcement_employee_key" UNIQUE("tenant_id","announcement_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"audience_kind" varchar(10) NOT NULL,
	"requires_receipt" boolean NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "announcements_audience_kind_check" CHECK ("announcements"."audience_kind" IN ('all', 'outlets'))
);
--> statement-breakpoint
-- legend-7df1: foreign keys into tables that already FORCE row level security
-- (employees, positions, stations, outlets). The migrator may be a plain table
-- owner (no SUPERUSER, no BYPASSRLS): FORCE would apply the tenant policies to
-- it, and with no app.tenant_id set they raise 42501 while the foreign keys
-- below are validated. Lift FORCE for this transaction only and restore it
-- before commit (drizzle applies pending migrations in one transaction; same
-- pattern as 0065 and 0075).
ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.positions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stations NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sop_acknowledgements" ADD CONSTRAINT "sop_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_acknowledgements" ADD CONSTRAINT "sop_acknowledgements_document_fk" FOREIGN KEY ("tenant_id","sop_document_id","document_version") REFERENCES "public"."sop_documents"("tenant_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_acknowledgements" ADD CONSTRAINT "sop_acknowledgements_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_documents" ADD CONSTRAINT "sop_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_documents" ADD CONSTRAINT "sop_documents_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_documents" ADD CONSTRAINT "sop_documents_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."sop_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_documents" ADD CONSTRAINT "sop_documents_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_documents" ADD CONSTRAINT "sop_documents_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_certificates" ADD CONSTRAINT "training_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_certificates" ADD CONSTRAINT "training_certificates_training_fk" FOREIGN KEY ("tenant_id","training_id") REFERENCES "public"."trainings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_certificates" ADD CONSTRAINT "training_certificates_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_certificates" ADD CONSTRAINT "training_certificates_completion_fk" FOREIGN KEY ("tenant_id","completion_id") REFERENCES "public"."training_completions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_completions" ADD CONSTRAINT "training_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_completions" ADD CONSTRAINT "training_completions_training_fk" FOREIGN KEY ("tenant_id","training_id") REFERENCES "public"."trainings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_completions" ADD CONSTRAINT "training_completions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_enrolled_by_user_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_training_fk" FOREIGN KEY ("tenant_id","training_id") REFERENCES "public"."trainings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_questions" ADD CONSTRAINT "training_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_questions" ADD CONSTRAINT "training_questions_training_fk" FOREIGN KEY ("tenant_id","training_id") REFERENCES "public"."trainings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_announcement_outlets" ADD CONSTRAINT "hris_announcement_outlets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_announcement_outlets" ADD CONSTRAINT "hris_announcement_outlets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_announcement_outlets" ADD CONSTRAINT "hris_announcement_outlets_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_announcement_outlets" ADD CONSTRAINT "hris_announcement_outlets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.positions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "sop_acknowledgements_tenant_employee_idx" ON "sop_acknowledgements" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_documents_tenant_supersedes_key" ON "sop_documents" USING btree ("tenant_id","supersedes_id") WHERE "sop_documents"."supersedes_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sop_documents_tenant_station_idx" ON "sop_documents" USING btree ("tenant_id","station_id");--> statement-breakpoint
CREATE INDEX "sop_documents_tenant_position_idx" ON "sop_documents" USING btree ("tenant_id","position_id");--> statement-breakpoint
CREATE INDEX "training_certificates_tenant_employee_idx" ON "training_certificates" USING btree ("tenant_id","employee_id","training_id");--> statement-breakpoint
CREATE INDEX "training_completions_tenant_employee_idx" ON "training_completions" USING btree ("tenant_id","employee_id","training_id");--> statement-breakpoint
CREATE INDEX "training_enrollments_tenant_employee_idx" ON "training_enrollments" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "trainings_tenant_station_idx" ON "trainings" USING btree ("tenant_id","station_id");--> statement-breakpoint
CREATE INDEX "hris_announcement_outlets_tenant_outlet_idx" ON "hris_announcement_outlets" USING btree ("tenant_id","outlet_id");--> statement-breakpoint
CREATE INDEX "announcement_receipts_tenant_employee_idx" ON "announcement_receipts" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "announcements_tenant_published_idx" ON "announcements" USING btree ("tenant_id","published_at");