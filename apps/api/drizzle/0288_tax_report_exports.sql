-- PBJT recap CSV export history (brief in4m-pbjt-export). Provisional number
-- 0288; the merge train renumbers. Append-only: each export is a new row, the
-- same idempotency key replays the same row. tax_reports is only referenced
-- (nullable link), never changed. The foreign keys are inline in CREATE TABLE,
-- so they need no validation scan and no NO FORCE on the parents.
CREATE TABLE "tax_report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"tax_report_id" uuid,
	"type" varchar(10) NOT NULL,
	"period" varchar(7) NOT NULL,
	"format" varchar(10) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"row_count" integer NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"file_name" varchar(150) NOT NULL,
	"idempotency_key" text NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_report_exports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_report_exports_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_report_exports_type_check" CHECK ("tax_report_exports"."type" = 'pbjt'),
	CONSTRAINT "tax_report_exports_period_check" CHECK ("tax_report_exports"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "tax_report_exports_format_check" CHECK ("tax_report_exports"."format" = 'csv'),
	CONSTRAINT "tax_report_exports_amount_check" CHECK ("tax_report_exports"."amount_idr" >= 0),
	CONSTRAINT "tax_report_exports_row_count_check" CHECK ("tax_report_exports"."row_count" >= 0),
	CONSTRAINT "tax_report_exports_file_key_check" CHECK (char_length("tax_report_exports"."file_key") >= 1),
	CONSTRAINT "tax_report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tax_report_exports_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tax_report_exports_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tax_report_exports_tax_report_fk" FOREIGN KEY ("tenant_id","tax_report_id") REFERENCES "public"."tax_reports"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "tax_report_exports_outlet_period_idx" ON "tax_report_exports" USING btree ("tenant_id","outlet_id","period");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tax_report_exports'::regclass);
--> statement-breakpoint
-- Append-only history: no UPDATE, DELETE or TRUNCATE for the app role.
REVOKE UPDATE, DELETE, TRUNCATE ON public.tax_report_exports FROM legend_app;
