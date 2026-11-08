CREATE TABLE "manual_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"entry_date" date NOT NULL,
	"kind" varchar(12) NOT NULL,
	"description" varchar(255) NOT NULL,
	"lines" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"requested_by" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"rejection_reason" varchar(500),
	"posted_entry_id" uuid,
	"approval_chain_id" uuid,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_journals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "manual_journals_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "manual_journals_tenant_posted_entry_key" UNIQUE("tenant_id","posted_entry_id"),
	CONSTRAINT "manual_journals_status_check" CHECK ("manual_journals"."status" IN ('draft', 'pending_approval', 'rejected', 'cancelled', 'posted')),
	CONSTRAINT "manual_journals_kind_check" CHECK ("manual_journals"."kind" IN ('general', 'adjustment')),
	CONSTRAINT "manual_journals_posted_check" CHECK (("manual_journals"."status" = 'posted') = ("manual_journals"."posted_entry_id" IS NOT NULL)),
	CONSTRAINT "manual_journals_rejected_check" CHECK (("manual_journals"."status" = 'rejected') = ("manual_journals"."rejection_reason" IS NOT NULL)),
	CONSTRAINT "manual_journals_distinct_decider_check" CHECK ("manual_journals"."decided_by" IS NULL OR "manual_journals"."decided_by" <> "manual_journals"."requested_by"),
	CONSTRAINT "manual_journals_description_check" CHECK (length(btrim("manual_journals"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "recurring_journal_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recurring_journal_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"journal_entry_id" uuid,
	"skipped_by" text,
	"skip_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_journal_runs_tenant_template_period_key" UNIQUE("tenant_id","recurring_journal_id","period"),
	CONSTRAINT "recurring_journal_runs_tenant_entry_key" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "recurring_journal_runs_period_check" CHECK ("recurring_journal_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "recurring_journal_runs_posted_or_skipped_check" CHECK (("recurring_journal_runs"."journal_entry_id" IS NOT NULL) <> ("recurring_journal_runs"."skipped_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "recurring_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"description" varchar(255) NOT NULL,
	"lines" jsonb NOT NULL,
	"frequency" varchar(10) DEFAULT 'monthly' NOT NULL,
	"day_of_month" integer NOT NULL,
	"start_period" varchar(7) NOT NULL,
	"end_period" varchar(7),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejection_reason" varchar(500),
	"last_generated_period" varchar(7),
	"paused_at" timestamp with time zone,
	"last_error" varchar(500),
	"failed_at" timestamp with time zone,
	"approval_chain_id" uuid,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_journals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "recurring_journals_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "recurring_journals_status_check" CHECK ("recurring_journals"."status" IN ('draft', 'pending_approval', 'rejected', 'active', 'paused', 'ended')),
	CONSTRAINT "recurring_journals_frequency_check" CHECK ("recurring_journals"."frequency" = 'monthly'),
	CONSTRAINT "recurring_journals_day_check" CHECK ("recurring_journals"."day_of_month" BETWEEN 1 AND 31),
	CONSTRAINT "recurring_journals_period_check" CHECK ("recurring_journals"."start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ("recurring_journals"."end_period" IS NULL OR ("recurring_journals"."end_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "recurring_journals"."end_period" >= "recurring_journals"."start_period"))),
	CONSTRAINT "recurring_journals_approved_check" CHECK ("recurring_journals"."status" NOT IN ('active', 'paused', 'ended') OR ("recurring_journals"."approved_by" IS NOT NULL AND "recurring_journals"."approved_at" IS NOT NULL)),
	CONSTRAINT "recurring_journals_distinct_approver_check" CHECK ("recurring_journals"."approved_by" IS NULL OR "recurring_journals"."approved_by" <> "recurring_journals"."requested_by"),
	CONSTRAINT "recurring_journals_description_check" CHECK (length(btrim("recurring_journals"."description")) > 0)
);
--> statement-breakpoint
ALTER TABLE "manual_journals" ADD CONSTRAINT "manual_journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journals" ADD CONSTRAINT "manual_journals_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journals" ADD CONSTRAINT "manual_journals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journals" ADD CONSTRAINT "manual_journals_posted_entry_fk" FOREIGN KEY ("tenant_id","posted_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_template_fk" FOREIGN KEY ("tenant_id","recurring_journal_id") REFERENCES "public"."recurring_journals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_journals_entity_status_idx" ON "manual_journals" USING btree ("tenant_id","legal_entity_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "manual_journals_chain_idx" ON "manual_journals" USING btree ("tenant_id","approval_chain_id");--> statement-breakpoint
CREATE INDEX "recurring_journals_entity_status_idx" ON "recurring_journals" USING btree ("tenant_id","legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "recurring_journals_chain_idx" ON "recurring_journals" USING btree ("tenant_id","approval_chain_id");