-- WS-06 supplier invoices and the tenant purchasing policy (legal-entity AP,
-- bead legend-lspfy / legend-nz13; migration 0491, after the tables of 0490).
-- Foreign keys into FORCE RLS tables are inline in the 0490 CREATE TABLEs
-- (docs/plan/contracts.md, pattern 1).
SELECT app.enforce_tenant_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_policies'::regclass);
--> statement-breakpoint
-- Invoice lines are the evidence of what was billed: append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoice_lines FROM legend_app;
--> statement-breakpoint
-- An invoice is never deleted. Only the match result and the hold decision
-- (matched/held -> released/rejected, with who, when and why) may change.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoices FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, journal_entry_id, match_result, match_snapshot, match_note, tolerance_bp, updated_at) ON TABLE public.purchase_invoices TO legend_app;
--> statement-breakpoint
-- The GRANT above limits which columns may change; this trigger limits how
-- (a direct UPDATE as legend_app is held to the same rules as the service).
-- Only a held invoice may change, and it may stay held (re-match) or move to
-- matched / released / rejected. A matched, released or rejected invoice is
-- frozen except updated_at. journal_entry_id never changes once it is set.
CREATE OR REPLACE FUNCTION app.guard_purchase_invoice_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL
    AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'the journal entry of a supplier invoice cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'held' THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'a % supplier invoice is final and cannot be changed', OLD.status
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('held', 'matched', 'released', 'rejected') THEN
    RAISE EXCEPTION 'a held supplier invoice can only stay held or become matched, released or rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS purchase_invoices_update_guard ON public.purchase_invoices;
--> statement-breakpoint
CREATE TRIGGER purchase_invoices_update_guard
  BEFORE UPDATE ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION app.guard_purchase_invoice_update();
