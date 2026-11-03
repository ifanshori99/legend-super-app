-- Custom SQL migration fragment for legend-kk7 (WS-04 POS order service).
-- Append AFTER the drizzle-generated CREATE TABLE statements for pos_orders,
-- pos_order_items, order_events, pos_order_tenders, pos_order_discounts,
-- pos_order_voids, pos_order_refunds, pos_order_approval_uses,
-- pos_order_idempotency and pos_approval_policies.
--
-- PRD v1.7 §6 C: `orders` is channel-general; POS-04 "Transaksi final tidak
-- dapat dihapus; koreksi dilakukan melalui void atau refund yang tertaut".
-- The service checks the same rules first (assertPosOrderMutable); these
-- triggers are the database backstop.

-- 1. Widen the §6 `orders.channel` check from the QR-only value to every
--    channel of the contract (ORDER_CHANNELS). LEAD: if you instead change the
--    check in schema/qr-order.ts (`orders_channel_check`) and db:generate emits
--    this DROP/ADD itself, delete these two statements.
ALTER TABLE "orders" DROP CONSTRAINT "orders_channel_check";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_check"
  CHECK ("channel" IN ('qr', 'pos', 'captain', 'gofood', 'grabfood', 'shopeefood', 'reservation', 'kiosk'));
--> statement-breakpoint

-- 2. POS-04: a completed or voided order is history. No UPDATE, no DELETE of
--    the order row, whatever the channel (QR never rewrites a final order).
CREATE OR REPLACE FUNCTION app.orders_final_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status IN ('completed', 'voided') THEN
    RAISE EXCEPTION 'POS-04: order % is final and cannot be changed or deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "orders_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION app.orders_final_immutable();
--> statement-breakpoint

-- 3. The lines of a final order are frozen too. The only change still allowed
--    is the kitchen progressing a live line (queued -> in_progress -> ready ->
--    served) with every other column unchanged, so KDS can bump a ticket that
--    belongs to an already settled sale. A void or delete is refused.
CREATE OR REPLACE FUNCTION app.order_items_final_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE parent_status text;
BEGIN
  SELECT o.status INTO parent_status FROM public.orders o
  WHERE o.tenant_id = OLD.tenant_id AND o.id = OLD.order_id;
  IF parent_status IN ('completed', 'voided') THEN
    IF TG_OP = 'UPDATE'
      AND OLD.status <> 'voided' AND NEW.status IN ('queued', 'in_progress', 'ready', 'served')
      AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'POS-04: order item % belongs to a final order', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "order_items_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION app.order_items_final_immutable();
--> statement-breakpoint

-- 4. POS extension rows (attribution, holds, tenders, discounts) of a final
--    order are frozen. Every table here carries (tenant_id, order_id).
CREATE OR REPLACE FUNCTION app.pos_order_rows_final_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.tenant_id = OLD.tenant_id AND o.id = OLD.order_id
      AND o.status IN ('completed', 'voided')
  ) THEN
    RAISE EXCEPTION 'POS-04: % row of final order % cannot be changed or deleted', TG_TABLE_NAME, OLD.order_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_orders_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pos_orders"
  FOR EACH ROW EXECUTE FUNCTION app.pos_order_rows_final_immutable();
--> statement-breakpoint
CREATE TRIGGER "pos_order_items_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_items"
  FOR EACH ROW EXECUTE FUNCTION app.pos_order_rows_final_immutable();
--> statement-breakpoint
CREATE TRIGGER "pos_order_tenders_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_tenders"
  FOR EACH ROW EXECUTE FUNCTION app.pos_order_rows_final_immutable();
--> statement-breakpoint
CREATE TRIGGER "pos_order_discounts_final_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_discounts"
  FOR EACH ROW EXECUTE FUNCTION app.pos_order_rows_final_immutable();
--> statement-breakpoint

-- 5. Append-only history: the §6 order log, the linked corrections and the
--    single-use approval ledger are never updated or deleted.
CREATE OR REPLACE FUNCTION app.pos_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "order_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
CREATE TRIGGER "pos_order_voids_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_voids"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
CREATE TRIGGER "pos_order_refunds_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_refunds"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
CREATE TRIGGER "pos_order_approval_uses_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pos_order_approval_uses"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.order_events FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.pos_order_voids FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.pos_order_refunds FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.pos_order_approval_uses FROM legend_app;
--> statement-breakpoint

-- 6. POS-04: a linked void or refund only ever targets a completed sale; the
--    order itself stays `completed` with its lines.
CREATE OR REPLACE FUNCTION app.pos_correction_targets_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id
      AND o.outlet_id = NEW.outlet_id AND o.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'POS-04: % must target a completed order of the same outlet', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_order_voids_target_final_trg"
  BEFORE INSERT ON "pos_order_voids"
  FOR EACH ROW EXECUTE FUNCTION app.pos_correction_targets_final();
--> statement-breakpoint
CREATE TRIGGER "pos_order_refunds_target_final_trg"
  BEFORE INSERT ON "pos_order_refunds"
  FOR EACH ROW EXECUTE FUNCTION app.pos_correction_targets_final();
--> statement-breakpoint

-- 7. A POS extension row sits in the outlet of its order (the composite FKs
--    only tie tenant + id).
CREATE OR REPLACE FUNCTION app.pos_orders_same_outlet() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id
      AND o.outlet_id = NEW.outlet_id AND o.channel = NEW.channel
  ) THEN
    RAISE EXCEPTION 'pos_orders outlet and channel must match the order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_orders_same_outlet_trg"
  BEFORE INSERT ON "pos_orders"
  FOR EACH ROW EXECUTE FUNCTION app.pos_orders_same_outlet();
--> statement-breakpoint

-- 8. Tenant + outlet RLS (TEN-01/TEN-03). pos_approval_policies has a
--    nullable outlet_id (tenant default row): tenant RLS only.
SELECT app.enforce_tenant_rls('public.pos_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.order_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_tenders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_tenders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_discounts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_discounts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_voids'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_voids'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_approval_uses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_approval_uses'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_order_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_order_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_approval_policies'::regclass);
