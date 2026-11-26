-- WS-11 F12 (bead legend-ay6e6, docs/briefs/259-ws11-card-split.md): saved
-- report builder queries, their delivery schedules and export jobs. New
-- tables only, no existing row changes. Foreign keys are inline in CREATE
-- TABLE (contracts.md legend-m007 pattern 1: no validation scan under FORCE
-- RLS). The RLS block at the end is copied from
-- src/db/schema/report-delivery.custom.sql (drizzle-kit does not emit it).
--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"query" jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_reports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "saved_reports_status_check" CHECK ("saved_reports"."status" IN ('active', 'archived')),
	CONSTRAINT "saved_reports_query_check" CHECK (jsonb_typeof("saved_reports"."query") = 'object'),
	CONSTRAINT "saved_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "saved_reports_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"saved_report_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"frequency" varchar(10) NOT NULL,
	"time_of_day" varchar(5) NOT NULL,
	"day_of_week" smallint,
	"day_of_month" smallint,
	"format" varchar(4) NOT NULL,
	"recipient_user_ids" jsonb NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_schedules_frequency_check" CHECK ("report_schedules"."frequency" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "report_schedules_time_check" CHECK ("report_schedules"."time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "report_schedules_days_check" CHECK (("report_schedules"."frequency" = 'daily' AND "report_schedules"."day_of_week" IS NULL AND "report_schedules"."day_of_month" IS NULL) OR ("report_schedules"."frequency" = 'weekly' AND "report_schedules"."day_of_week" BETWEEN 1 AND 7 AND "report_schedules"."day_of_month" IS NULL) OR ("report_schedules"."frequency" = 'monthly' AND "report_schedules"."day_of_month" BETWEEN 1 AND 28 AND "report_schedules"."day_of_week" IS NULL)),
	CONSTRAINT "report_schedules_format_check" CHECK ("report_schedules"."format" IN ('csv', 'xlsx', 'pdf')),
	CONSTRAINT "report_schedules_recipients_check" CHECK (jsonb_typeof("report_schedules"."recipient_user_ids") = 'array' AND jsonb_array_length("report_schedules"."recipient_user_ids") BETWEEN 1 AND 20),
	CONSTRAINT "report_schedules_next_run_check" CHECK ("report_schedules"."is_enabled" OR "report_schedules"."next_run_at" IS NULL),
	CONSTRAINT "report_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "report_schedules_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "report_schedules_saved_report_fk" FOREIGN KEY ("tenant_id","saved_report_id") REFERENCES "public"."saved_reports"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"report_code" varchar(80),
	"saved_report_id" uuid,
	"schedule_id" uuid,
	"scheduled_for" timestamp with time zone,
	"format" varchar(4) NOT NULL,
	"query" jsonb NOT NULL,
	"contains_personal_data" boolean NOT NULL,
	"approval_request_id" uuid,
	"status" varchar(20) NOT NULL,
	"idempotency_key" varchar(128),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"outlet_ids" jsonb,
	"viewer" varchar(10),
	"file_content" "bytea",
	"file_size_bytes" integer,
	"row_count" integer,
	"expires_at" timestamp with time zone,
	"error_code" varchar(40),
	CONSTRAINT "report_exports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_exports_idempotency_key" UNIQUE("tenant_id","requested_by","idempotency_key"),
	CONSTRAINT "report_exports_schedule_slot_key" UNIQUE("tenant_id","schedule_id","scheduled_for","requested_by"),
	CONSTRAINT "report_exports_source_check" CHECK (("report_exports"."report_code" IS NULL) <> ("report_exports"."saved_report_id" IS NULL)),
	CONSTRAINT "report_exports_schedule_check" CHECK (("report_exports"."schedule_id" IS NULL) = ("report_exports"."scheduled_for" IS NULL) AND ("report_exports"."schedule_id" IS NULL OR ("report_exports"."saved_report_id" IS NOT NULL AND NOT "report_exports"."contains_personal_data"))),
	CONSTRAINT "report_exports_format_check" CHECK ("report_exports"."format" IN ('csv', 'xlsx', 'pdf')),
	CONSTRAINT "report_exports_status_check" CHECK ("report_exports"."status" IN ('pending_approval', 'queued', 'generating', 'ready', 'failed', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "report_exports_approval_check" CHECK (("report_exports"."contains_personal_data" OR "report_exports"."approval_request_id" IS NULL) AND (NOT "report_exports"."contains_personal_data" OR "report_exports"."approval_request_id" IS NOT NULL OR "report_exports"."status" IN ('cancelled', 'expired'))),
	CONSTRAINT "report_exports_file_check" CHECK (("report_exports"."status" = 'ready') = ("report_exports"."file_content" IS NOT NULL) AND ("report_exports"."file_content" IS NULL OR ("report_exports"."file_size_bytes" IS NOT NULL AND "report_exports"."row_count" IS NOT NULL AND "report_exports"."expires_at" IS NOT NULL))),
	CONSTRAINT "report_exports_viewer_check" CHECK ("report_exports"."viewer" IS NULL OR "report_exports"."viewer" IN ('full', 'aggregate')),
	CONSTRAINT "report_exports_error_check" CHECK (("report_exports"."status" = 'failed') = ("report_exports"."error_code" IS NOT NULL)),
	CONSTRAINT "report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "report_exports_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "report_exports_saved_report_fk" FOREIGN KEY ("tenant_id","saved_report_id") REFERENCES "public"."saved_reports"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "report_exports_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."report_schedules"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "report_exports_requester_idx" ON "report_exports" USING btree ("tenant_id","requested_by","requested_at","id");
--> statement-breakpoint
CREATE INDEX "report_exports_status_idx" ON "report_exports" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("tenant_id","next_run_at");
--> statement-breakpoint
CREATE INDEX "report_schedules_owner_idx" ON "report_schedules" USING btree ("tenant_id","owner_user_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "saved_reports_owner_idx" ON "saved_reports" USING btree ("tenant_id","owner_user_id","created_at","id");
--> statement-breakpoint
-- WS-11 F12 (legend-ay6e6): saved reports, schedules and export jobs are
-- tenant-owned rows without an outlet column (one report spans outlets; the
-- outlet scope is checked by the service against the caller's reach).
SELECT app.enforce_tenant_rls('public.saved_reports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.report_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.report_exports'::regclass);
