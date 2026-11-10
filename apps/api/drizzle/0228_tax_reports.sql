-- WS-07 tax reports (bead legend-gmww). Temporary number 0235; the merge train renumbers.
CREATE TABLE "tax_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"type" varchar(10) NOT NULL,
	"period" varchar(7) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"export_format" varchar(20),
	"file_key" varchar(500),
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_by" text,
	"finalized_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_reports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_reports_type_check" CHECK ("tax_reports"."type" IN ('pbjt','pph21','pph23','ppn')),
	CONSTRAINT "tax_reports_period_check" CHECK ("tax_reports"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "tax_reports_amount_check" CHECK ("tax_reports"."amount_idr" >= 0),
	CONSTRAINT "tax_reports_lines_check" CHECK (jsonb_typeof("tax_reports"."lines") = 'array'),
	CONSTRAINT "tax_reports_status_check" CHECK ("tax_reports"."status" IN ('draft','final','exported')),
	CONSTRAINT "tax_reports_export_format_check" CHECK ("tax_reports"."export_format" IS NULL OR "tax_reports"."export_format" = 'coretax_xml'),
	CONSTRAINT "tax_reports_file_key_check" CHECK (char_length("tax_reports"."file_key") >= 1),
	CONSTRAINT "tax_reports_finalized_check" CHECK (("tax_reports"."finalized_by" IS NULL) = ("tax_reports"."finalized_at" IS NULL) AND ("tax_reports"."status" <> 'draft') = ("tax_reports"."finalized_by" IS NOT NULL)),
	CONSTRAINT "tax_reports_exported_check" CHECK (("tax_reports"."status" = 'exported') = ("tax_reports"."export_format" IS NOT NULL AND "tax_reports"."file_key" IS NOT NULL AND "tax_reports"."exported_at" IS NOT NULL) AND ("tax_reports"."export_format" IS NULL) = ("tax_reports"."file_key" IS NULL) AND ("tax_reports"."file_key" IS NULL) = ("tax_reports"."exported_at" IS NULL)),
	CONSTRAINT "tax_reports_version_check" CHECK ("tax_reports"."version" >= 1),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "tax_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tax_reports_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_reports_draft_key" ON "tax_reports" USING btree ("tenant_id","legal_entity_id","type","period") WHERE "tax_reports"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "tax_reports_period_idx" ON "tax_reports" USING btree ("tenant_id","legal_entity_id","period","type");--> statement-breakpoint
-- Tenant RLS (TEN-01/02). tax_reports belongs to a legal entity, not an outlet:
-- outlet reach is enforced in the service, like the other accounting tables.
SELECT app.enforce_tenant_rls('public.tax_reports'::regclass);
--> statement-breakpoint
-- Filed reports are locked (tier K review, bead legend-gmww): once a report
-- leaves draft, its numbers, lines, subject and filing stamps never change and
-- it is never deleted; the status only moves forward (final -> exported, an
-- export may repeat with a new file). A correction is a new draft after a
-- period reopen (transitionTaxReport), never an edit of a filed report.
CREATE OR REPLACE FUNCTION app.guard_tax_report_filed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a final or exported tax report cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.period IS DISTINCT FROM OLD.period
    OR NEW.amount_idr IS DISTINCT FROM OLD.amount_idr
    OR NEW.lines IS DISTINCT FROM OLD.lines
    OR NEW.generated_by IS DISTINCT FROM OLD.generated_by
    OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
    OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'a final or exported tax report is locked; reopen the period and generate a new draft'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'exported' AND NEW.status <> 'exported'
    OR OLD.status = 'final' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a tax report status cannot move backwards'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_reports_filed_guard ON public.tax_reports;
--> statement-breakpoint
CREATE TRIGGER tax_reports_filed_guard
  BEFORE UPDATE OR DELETE ON public.tax_reports
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_report_filed();
