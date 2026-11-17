-- Supplier invoice payments (bead legend-xxqz3; migration 0465, with the table).
-- Tenant and outlet RLS (TEN-01/02/03). A request is never deleted; only its
-- decision may change, and a paid, rejected or cancelled row is final.
SELECT app.enforce_tenant_rls('public.supplier_payments'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.supplier_payments'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_payments FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, decided_at, decision_note, settlement_id, journal_entry_id, updated_at) ON TABLE public.supplier_payments TO legend_app;
--> statement-breakpoint
-- The GRANT limits which columns may change; this trigger limits how. Only an
-- open request (pending_approval, approved) may move forward; a final row is
-- frozen except updated_at. A direct UPDATE is held to the service's rules.
CREATE OR REPLACE FUNCTION app.guard_supplier_payment_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status IN ('paid', 'rejected', 'cancelled') THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'a % supplier payment is final and cannot be changed', OLD.status
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'pending_approval' THEN
    RAISE EXCEPTION 'an approved supplier payment cannot return to pending approval'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS supplier_payments_update_guard ON public.supplier_payments;
--> statement-breakpoint
CREATE TRIGGER supplier_payments_update_guard
  BEFORE UPDATE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_payment_update();
