-- Purchasing RLS (bead legend-9yz; PRD v1.7 §3 "Supplier", "Purchase Request &
-- Purchase Order", §6 E).
-- Apply after the tables of purchasing.ts are created (generate with
-- `drizzle-kit generate --custom`). Tenant-owned tables get the RESTRICTIVE
-- tenant policy; outlet-owned tables (outlet_id NOT NULL) also get the outlet
-- policy right after it (TEN-03, guard test src/db/outlet-rls.test.ts).
-- `purchasing_idempotency.outlet_id` is nullable (suppliers are tenant-level),
-- so that table has the tenant policy only.
SELECT app.enforce_tenant_rls('public.suppliers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_contacts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_prices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_request_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_request_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_document_sequences'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_share_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_share_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_email_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_email_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_idempotency'::regclass);
--> statement-breakpoint
-- Price history is append-only: a new price is a new row. The application
-- login may append and read, and may only flip `is_active` (deactivate a
-- price); no other column changes and no row is deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_prices FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (is_active) ON TABLE public.supplier_prices TO legend_app;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_invoices'::regclass);
--> statement-breakpoint
-- Tax records are append-only: the tax reports reconcile against them, so the
-- application login may insert and read, never change or remove a row.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_invoices FROM legend_app;
--> statement-breakpoint
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
