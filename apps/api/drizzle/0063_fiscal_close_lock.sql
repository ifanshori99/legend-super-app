CREATE TABLE "fiscal_period_snapshot_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_idr" bigint DEFAULT 0 NOT NULL,
	"credit_idr" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "fiscal_period_snapshot_lines_snapshot_account_key" UNIQUE("snapshot_id","account_id"),
	CONSTRAINT "fiscal_period_snapshot_lines_amounts_check" CHECK ("fiscal_period_snapshot_lines"."debit_idr" >= 0 AND "fiscal_period_snapshot_lines"."credit_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fiscal_period_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"version" integer NOT NULL,
	"idempotency_key" varchar(100),
	"taken_by" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_period_snapshots_tenant_period_version_key" UNIQUE("tenant_id","fiscal_period_id","version"),
	CONSTRAINT "fiscal_period_snapshots_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fiscal_period_snapshots_period_check" CHECK ("fiscal_period_snapshots"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fiscal_period_snapshots_version_check" CHECK ("fiscal_period_snapshots"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "period_reopen_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_reopen_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "period_reopen_requests_period_check" CHECK ("period_reopen_requests"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "period_reopen_requests_status_check" CHECK ("period_reopen_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "period_reopen_requests_reason_check" CHECK (length(btrim("period_reopen_requests"."reason")) > 0),
	CONSTRAINT "period_reopen_requests_decided_check" CHECK (("period_reopen_requests"."status" IN ('approved', 'rejected')) = ("period_reopen_requests"."decided_by" IS NOT NULL AND "period_reopen_requests"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshot_lines" ADD CONSTRAINT "fiscal_period_snapshot_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshot_lines" ADD CONSTRAINT "fiscal_period_snapshot_lines_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."fiscal_period_snapshots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshot_lines" ADD CONSTRAINT "fiscal_period_snapshot_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshots" ADD CONSTRAINT "fiscal_period_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshots" ADD CONSTRAINT "fiscal_period_snapshots_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period_snapshots" ADD CONSTRAINT "fiscal_period_snapshots_fiscal_period_fk" FOREIGN KEY ("tenant_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_reopen_requests" ADD CONSTRAINT "period_reopen_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_reopen_requests" ADD CONSTRAINT "period_reopen_requests_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_reopen_requests" ADD CONSTRAINT "period_reopen_requests_fiscal_period_fk" FOREIGN KEY ("tenant_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_period_snapshots_idempotency_key" ON "fiscal_period_snapshots" USING btree ("tenant_id","idempotency_key") WHERE "fiscal_period_snapshots"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "period_reopen_requests_pending_key" ON "period_reopen_requests" USING btree ("tenant_id","fiscal_period_id") WHERE "period_reopen_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "period_reopen_requests_entity_idx" ON "period_reopen_requests" USING btree ("tenant_id","legal_entity_id","requested_at" DESC NULLS LAST);