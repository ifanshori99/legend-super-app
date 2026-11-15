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
-- re-apply (receiver) events that were already settled. Columns added by
-- 0162 (peer instance and offset, legend-nd3cu) follow the same rule.
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
  -- legend-nd3cu: a known peer instance is never forgotten, and the offset
  -- (where the instance's link numbering starts) moves only forward and only
  -- when the peer changes from one known instance to another. Within one
  -- instance the cursors stay strictly forward-only.
  IF OLD.peer_instance_id IS NOT NULL AND NEW.peer_instance_id IS NULL THEN
    RAISE EXCEPTION 'sync cursor peer instance cannot be cleared' USING ERRCODE = '42501';
  END IF;
  IF NEW.peer_seq_offset < OLD.peer_seq_offset THEN
    RAISE EXCEPTION 'sync cursors never move backwards (EDG-02)' USING ERRCODE = '42501';
  END IF;
  IF NEW.peer_seq_offset <> OLD.peer_seq_offset AND (OLD.peer_instance_id IS NULL
     OR NEW.peer_instance_id IS NOT DISTINCT FROM OLD.peer_instance_id) THEN
    RAISE EXCEPTION 'sync cursor offset changes only with a new peer instance' USING ERRCODE = '42501';
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

-- legend-wg5t (migration 0065): tenant-wide registry of edge_to_cloud event
-- ids. Tenant + outlet owned, append-only like the receipts it summarises.
SELECT app.enforce_tenant_rls('public.edge_received_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_received_events'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_received_events_append_only BEFORE UPDATE OR DELETE ON public.edge_received_events
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
--> statement-breakpoint

-- legend-2lp.7: edge-side pull checkpoint, tenant + outlet owned like the
-- other edge tables (fold after the CREATE TABLE in migration 0065).
SELECT app.enforce_tenant_rls('public.edge_pull_checkpoints'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_pull_checkpoints'::regclass);
--> statement-breakpoint

-- legend-ideif: edge-side sealed staff pin peppers, tenant + outlet owned
-- like the other edge tables (see schema/edge-node.ts edgeStaffPinPeppers).
SELECT app.enforce_tenant_rls('public.edge_staff_pin_peppers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_staff_pin_peppers'::regclass);

-- legend-pz641 (migration 0376): one row per link slot held by a counted
-- receipt. Tenant + outlet owned, append-only like the receipts. Backfilled
-- from edge_inbound_events: only slots with exactly ONE counted receipt
-- (cloud_to_edge always; edge_to_cloud only when the event is registered in
-- edge_received_events). A slot with several counted receipts is left empty
-- (the proof stops there, as before) and heals through replay. Idempotent.
SELECT app.enforce_tenant_rls('public.edge_link_slots'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_link_slots'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_link_slots_append_only BEFORE UPDATE OR DELETE ON public.edge_link_slots
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
--> statement-breakpoint
-- FORCE RLS is lifted on the three tables the backfill reads or writes (the
-- migrator may be a plain table owner) and restored before commit, as in 0065.
-- outlets and edge_nodes keep FORCE: the foreign keys are created on an empty
-- table, so no row is checked against them before the backfill.
ALTER TABLE public.edge_inbound_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_received_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_link_slots NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id)
SELECT r.tenant_id, min(r.outlet_id::text)::uuid, r.edge_node_id, r.direction, r.link_seq, min(r.event_id::text)::uuid
FROM public.edge_inbound_events r
WHERE r.direction = 'cloud_to_edge'
   OR EXISTS (SELECT 1 FROM public.edge_received_events rv WHERE rv.tenant_id = r.tenant_id AND rv.event_id = r.event_id)
GROUP BY r.tenant_id, r.edge_node_id, r.direction, r.link_seq
HAVING count(*) = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.edge_link_slots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_received_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_inbound_events FORCE ROW LEVEL SECURITY;
