-- Tax report revision chain (beads legend-r3i8w, legend-5nhkp). Renumbered
-- from 0242 to 0231 by the batch48a merge train. 0228 is unchanged.
-- tax_reports is FORCE RLS and the new self foreign keys validate under its own
-- policy, so FORCE is lifted for this file and restored at the end
-- (docs/plan/contracts.md, pattern 2; NOT VALID is not allowed from 0065).
ALTER TABLE public.tax_reports NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Existing rows have no fiscal period version, no revision number and no
-- decided chain position: refuse instead of inventing them. (Drafts too: they
-- would need a fiscal_period_version.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tax_reports) THEN
    RAISE EXCEPTION 'migration 0231 needs an empty tax_reports table; existing rows must be reviewed and migrated by hand'
      USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "revision_no" smallint;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "fiscal_period_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD COLUMN "finalize_idempotency_key" varchar(100);--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_fiscal_period_version_check" CHECK ("tax_reports"."fiscal_period_version" >= 1);--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_revision_draft_check" CHECK (("tax_reports"."status" = 'draft') = ("tax_reports"."revision_no" IS NULL));--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_revision_range_check" CHECK ("tax_reports"."revision_no" IS NULL OR "tax_reports"."revision_no" >= 0);--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_revision_supersedes_check" CHECK ("tax_reports"."revision_no" IS NULL OR ("tax_reports"."revision_no" = 0) = ("tax_reports"."supersedes_id" IS NULL));--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_revision_reason_check" CHECK ("tax_reports"."revision_no" IS NULL OR ("tax_reports"."revision_no" >= 1) = ("tax_reports"."correction_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_reason_text_check" CHECK ("tax_reports"."correction_reason" IS NULL OR length(btrim("tax_reports"."correction_reason")) > 0);--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_superseded_pair_check" CHECK (("tax_reports"."superseded_at" IS NULL) = ("tax_reports"."superseded_by_id" IS NULL));--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_superseded_self_check" CHECK ("tax_reports"."superseded_by_id" IS NULL OR "tax_reports"."superseded_by_id" <> "tax_reports"."id");--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."tax_reports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_superseded_by_fk" FOREIGN KEY ("tenant_id","superseded_by_id") REFERENCES "public"."tax_reports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_reports_revision_key" ON "tax_reports" USING btree ("tenant_id","legal_entity_id","type","period","revision_no") WHERE "tax_reports"."status" <> 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_reports_current_key" ON "tax_reports" USING btree ("tenant_id","legal_entity_id","type","period") WHERE "tax_reports"."status" <> 'draft' AND "tax_reports"."superseded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_reports_finalize_idempotency_key" ON "tax_reports" USING btree ("tenant_id","finalize_idempotency_key") WHERE "tax_reports"."finalize_idempotency_key" IS NOT NULL;--> statement-breakpoint
-- Filed reports are locked (tier K review, bead legend-gmww; revision chain,
-- bead legend-r3i8w). Once a report leaves draft its numbers, lines, subject,
-- filing stamps and revision identity never change and it is never deleted.
-- The status only moves forward (final -> exported). An export happens once:
-- file_key never changes after it is set, so a re-export cannot swap the file.
-- A correction is a new draft after a period reopen; finalizing it supersedes
-- the previous current report (superseded_at + superseded_by_id are set
-- together, once). A superseded report accepts no change at all.
-- The finalize idempotency key is filled by the UPDATE that turns the draft
-- final and is locked from then on.
-- (This replaces the 0228 comment, which said an export may repeat with a new
-- file: it does not.)
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
  IF OLD.superseded_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a superseded tax report cannot be changed'
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
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
    OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
    OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
    OR NEW.fiscal_period_version IS DISTINCT FROM OLD.fiscal_period_version
    OR NEW.finalize_idempotency_key IS DISTINCT FROM OLD.finalize_idempotency_key THEN
    RAISE EXCEPTION 'a final or exported tax report is locked; reopen the period and generate a new draft'
      USING ERRCODE = '42501';
  END IF;
  -- superseded_at and superseded_by_id are set together once (the pair CHECK
  -- keeps them together); a superseded row was rejected above.
  IF OLD.file_key IS NOT NULL AND NEW.file_key IS DISTINCT FROM OLD.file_key THEN
    RAISE EXCEPTION 'the export file of a tax report cannot be replaced'
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
--> statement-breakpoint
-- Revision chain consistency, checked at COMMIT (deferred) so the replacement
-- and the superseded row can be written in either order in one transaction.
-- Runs as the invoking role: tenant RLS applies to the lookups.
CREATE OR REPLACE FUNCTION app.assert_tax_report_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  other public.tax_reports%ROWTYPE;
BEGIN
  IF NEW.superseded_by_id IS NOT NULL THEN
    SELECT * INTO other FROM public.tax_reports r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.superseded_by_id;
    IF NOT FOUND
      OR other.legal_entity_id IS DISTINCT FROM NEW.legal_entity_id
      OR other.type IS DISTINCT FROM NEW.type
      OR other.period IS DISTINCT FROM NEW.period
      OR other.status = 'draft'
      OR other.supersedes_id IS DISTINCT FROM NEW.id
      OR other.revision_no IS DISTINCT FROM NEW.revision_no + 1 THEN
      RAISE EXCEPTION 'tax report % is superseded by % which is not its next revision (same entity, type, period, supersedes_id = this report, revision_no + 1)',
        NEW.id, NEW.superseded_by_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO other FROM public.tax_reports r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.supersedes_id;
    IF NOT FOUND
      OR other.legal_entity_id IS DISTINCT FROM NEW.legal_entity_id
      OR other.type IS DISTINCT FROM NEW.type
      OR other.period IS DISTINCT FROM NEW.period
      OR other.superseded_by_id IS DISTINCT FROM NEW.id
      OR other.revision_no IS DISTINCT FROM NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'tax report % supersedes % which is not its previous revision (same entity, type, period, superseded_by_id = this report, revision_no - 1)',
        NEW.id, NEW.supersedes_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_reports_chain_check ON public.tax_reports;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tax_reports_chain_check
  AFTER INSERT OR UPDATE ON public.tax_reports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_tax_report_chain();
--> statement-breakpoint
ALTER TABLE public.tax_reports FORCE ROW LEVEL SECURITY;
