-- legend-yhia9 C3 (migration 0370): customer display RLS and version triggers.
-- Append after the generated customer_display_* tables, FKs and indexes.
SELECT app.enforce_tenant_rls('public.customer_display_pairing_codes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pairing_codes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_pairings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pairings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_pair_attempts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pair_attempts'::regclass);
--> statement-breakpoint

-- D-08 `version`: a per-terminal counter the display uses to drop older
-- answers. It moves when the bill a display shows changes its money or status
-- (orders) or its QRIS hold changes (pos_qris_holds). A selection change is
-- bumped by the service. A row hidden from the writer by RLS is not bumped
-- (the writer then has no business with that bill).
CREATE OR REPLACE FUNCTION app.customer_display_bump_for_order() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_order uuid;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_order := NEW.id;
  ELSE
    target_order := NEW.order_id;
  END IF;
  UPDATE public.customer_display_sessions
     SET version = version + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND selected_order_id = target_order;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "orders_customer_display_bump_trg"
  AFTER UPDATE ON "orders"
  FOR EACH ROW
  WHEN (NEW.subtotal_idr IS DISTINCT FROM OLD.subtotal_idr
    OR NEW.discount_idr IS DISTINCT FROM OLD.discount_idr
    OR NEW.service_charge_idr IS DISTINCT FROM OLD.service_charge_idr
    OR NEW.tax_idr IS DISTINCT FROM OLD.tax_idr
    OR NEW.rounding_idr IS DISTINCT FROM OLD.rounding_idr
    OR NEW.total_idr IS DISTINCT FROM OLD.total_idr
    OR NEW.deposit_applied_idr IS DISTINCT FROM OLD.deposit_applied_idr
    OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.customer_display_bump_for_order();
--> statement-breakpoint
CREATE TRIGGER "pos_qris_holds_customer_display_bump_trg"
  AFTER INSERT OR UPDATE OF state ON "pos_qris_holds"
  FOR EACH ROW EXECUTE FUNCTION app.customer_display_bump_for_order();
--> statement-breakpoint
-- Captured tenders change `remaining`: bump when a tender of the selected bill
-- is inserted or its status or amount moves.
CREATE OR REPLACE FUNCTION app.customer_display_bump_for_tender() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.customer_display_sessions
     SET version = version + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND selected_order_id = NEW.order_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_order_tenders_customer_display_bump_trg"
  AFTER INSERT OR UPDATE OF status, amount_idr ON "pos_order_tenders"
  FOR EACH ROW EXECUTE FUNCTION app.customer_display_bump_for_tender();
