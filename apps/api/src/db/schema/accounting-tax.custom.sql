-- Custom SQL migration file, put your code below! ---
-- Tax reports (bead legend-gmww, WS-07). Tenant RLS on every table (TEN-01/02).
-- tax_reports belongs to a legal entity, not an outlet: outlet reach is
-- enforced in the service, like the other accounting tables.
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
