-- Custom SQL migration file, put your code below! ---
-- Tax reports (bead legend-gmww, WS-07). Tenant RLS on every table (TEN-01/02).
-- tax_reports belongs to a legal entity, not an outlet: outlet reach is
-- enforced in the service, like the other accounting tables.
SELECT app.enforce_tenant_rls('public.tax_reports'::regclass);
--> statement-breakpoint
-- Filed reports are locked (tier K review, bead legend-gmww; revision chain,
-- bead legend-r3i8w). Once a report leaves draft its numbers, lines, subject,
-- filing stamps and revision identity never change and it is never deleted.
-- The status only moves forward (final -> exported). An export happens once:
-- file_key never changes after it is set, so a re-export cannot swap the file.
-- A correction is a new draft after a period reopen; finalizing it supersedes
-- the previous current report (superseded_at + superseded_by_id are set
-- together, once). A superseded report accepts no change at all.
-- (This replaces the 0235 comment, which said an export may repeat with a new
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
    OR NEW.fiscal_period_version IS DISTINCT FROM OLD.fiscal_period_version THEN
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
