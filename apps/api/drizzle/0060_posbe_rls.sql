-- WS-02 edge node + WS-04 POS order (squad-posbe: legend-2pi, legend-kk7):
-- RLS and the invariants drizzle cannot express for the tables created in
-- 0059. Sources: schema/edge-node.custom.sql, schema/pos-order.custom.sql.
-- Edge node registry + cloud <-> edge link (bead legend-2pi; PRD v1.7 §3 F5,
-- §6 A edge_nodes, §6 J sync_cursors). Fold into the generated migration
-- after the CREATE TABLE statements. CHECK constraints live in the drizzle
-- schema (edge-node.ts); this file holds RLS and the invariants drizzle
-- cannot express. Same migration on the cloud and on every edge node.

-- TEN-01/TEN-03: every table is tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.edge_nodes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_nodes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.sync_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.sync_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_outbound_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_outbound_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_inbound_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_inbound_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_sync_conflicts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_sync_conflicts'::regclass);
--> statement-breakpoint

-- Revocation is terminal (EDG-03): a revoked node never becomes active again
-- and its identity (tenant, outlet, role, credential) is frozen. A new mini
-- PC is a new registration.
CREATE FUNCTION app.guard_edge_node_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.role <> OLD.role THEN
    RAISE EXCEPTION 'edge node identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked'
     OR NEW.credential_hash <> OLD.credential_hash
     OR NEW.revoked_at <> OLD.revoked_at) THEN
    RAISE EXCEPTION 'a revoked edge node cannot be reactivated (EDG-03)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_nodes_guard BEFORE UPDATE ON public.edge_nodes
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_node_update();
--> statement-breakpoint
CREATE FUNCTION app.reject_edge_node_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'edge nodes are revoked, never deleted' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_nodes_no_delete BEFORE DELETE ON public.edge_nodes
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_node_delete();
--> statement-breakpoint

-- Link cursors only move forward: a lower sequence would resend (sender) or
-- re-apply (receiver) events that were already settled.
CREATE FUNCTION app.guard_sync_cursor_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.edge_node_id <> OLD.edge_node_id OR NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'sync cursor identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.next_out_seq < OLD.next_out_seq OR NEW.acked_out_seq < OLD.acked_out_seq
     OR NEW.received_in_seq < OLD.received_in_seq THEN
    RAISE EXCEPTION 'sync cursors never move backwards (EDG-02)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sync_cursors_forward_only BEFORE UPDATE ON public.sync_cursors
FOR EACH ROW EXECUTE FUNCTION app.guard_sync_cursor_update();
--> statement-breakpoint

-- Offline queue: the queued event is immutable; the only change is the
-- one-way pending -> acked acknowledgement. Pending rows are never deleted
-- (no loss); acked rows may be pruned by a retention job.
CREATE FUNCTION app.guard_edge_outbound_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'acked' THEN
      RAISE EXCEPTION 'unacknowledged edge events cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.edge_node_id <> OLD.edge_node_id OR NEW.direction <> OLD.direction
     OR NEW.link_seq <> OLD.link_seq OR NEW.event_id <> OLD.event_id
     OR NEW.aggregate_type <> OLD.aggregate_type OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.aggregate_sequence <> OLD.aggregate_sequence OR NEW.kind <> OLD.kind
     OR NEW.event <> OLD.event OR NEW.enqueued_at <> OLD.enqueued_at
     OR (OLD.status = 'acked' AND (NEW.status <> 'acked' OR NEW.acked_at <> OLD.acked_at)) THEN
    RAISE EXCEPTION 'queued edge events are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_outbound_queue_guard BEFORE UPDATE OR DELETE ON public.edge_outbound_queue
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_outbound_update();
--> statement-breakpoint

-- Receipts and conflicts are evidence for EDG-02 reconciliation: append-only.
CREATE FUNCTION app.reject_edge_sync_log_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (EDG-02)', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_inbound_events_append_only BEFORE UPDATE OR DELETE ON public.edge_inbound_events
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
--> statement-breakpoint
CREATE TRIGGER edge_sync_conflicts_append_only BEFORE UPDATE OR DELETE ON public.edge_sync_conflicts
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
--> statement-breakpoint
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
--    channel of the contract (ORDER_CHANNELS). Kept here (migration 0060), not
--    in schema/qr-order.ts: the drizzle snapshot still records ('qr'), so a
--    future edit of that check must carry this full list.
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
