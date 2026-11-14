CREATE TABLE edge_catalog_publisher_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  edge_node_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  stream varchar(40) NOT NULL,
  watermark text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz,
  PRIMARY KEY (tenant_id, edge_node_id, stream),
  CONSTRAINT edge_catalog_publisher_cursors_edge_node_fk FOREIGN KEY (tenant_id, outlet_id, edge_node_id) REFERENCES edge_nodes (tenant_id, outlet_id, id)
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_catalog_publisher_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_publisher_cursors'::regclass);
--> statement-breakpoint
-- legend-3k41y: the version of a printer deletion the edge applied (HTTP pull or
-- live event). A printer row is hard-deleted on the edge, so without this row a
-- later, older live event would bring it back. Only a version above it may.
CREATE TABLE edge_printer_delete_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  printer_id uuid NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, printer_id),
  CONSTRAINT edge_printer_delete_versions_outlet_fk FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_printer_delete_versions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_printer_delete_versions'::regclass);
--> statement-breakpoint
ALTER TABLE edge_inbound_events DROP CONSTRAINT edge_inbound_events_outcome_check;
--> statement-breakpoint
ALTER TABLE edge_inbound_events ADD CONSTRAINT edge_inbound_events_outcome_check CHECK (outcome IN ('applied','superseded','conflict','deferred')) NOT VALID;

--> statement-breakpoint
-- legend-3k41y: catalog rows of a node whose outlet brand moved are dead-lettered
-- (reason brand_moved) and the pending rows behind them renumbered down, so the
-- queue stays gap-free for the receiver. Same marker as legend-btx4d
-- (app.edge_dead_letter = 'on'); only the step size widens: a parked pending row
-- (+10^12) returns to any positive link_seq below its former one, and the sender
-- head steps back by any amount, never below the acknowledged cursor.
ALTER TABLE edge_link_dead_letters DROP CONSTRAINT edge_link_dead_letters_reason_check;
--> statement-breakpoint
ALTER TABLE edge_link_dead_letters ADD CONSTRAINT edge_link_dead_letters_reason_check CHECK (reason IN ('frame_too_large', 'brand_moved')) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_edge_outbound_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  dead_letter boolean := COALESCE(current_setting('app.edge_dead_letter', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'acked' THEN
      RETURN OLD;
    END IF;
    IF dead_letter AND EXISTS (
      SELECT 1 FROM public.edge_link_dead_letters d
      WHERE d.tenant_id = OLD.tenant_id AND d.edge_node_id = OLD.edge_node_id
        AND d.direction = OLD.direction AND d.event_id = OLD.event_id
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'unacknowledged edge events cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.edge_node_id <> OLD.edge_node_id OR NEW.direction <> OLD.direction
     OR (NEW.link_seq <> OLD.link_seq AND NOT (
           dead_letter AND OLD.status = 'pending' AND NEW.status = 'pending'
           AND (NEW.link_seq = OLD.link_seq - 1
             OR NEW.link_seq = OLD.link_seq + 1000000000000
             OR (OLD.link_seq > 1000000000000 AND NEW.link_seq >= 1
                 AND NEW.link_seq < OLD.link_seq - 1000000000000))))
     OR NEW.event_id <> OLD.event_id
     OR NEW.aggregate_type <> OLD.aggregate_type OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.aggregate_sequence <> OLD.aggregate_sequence OR NEW.kind <> OLD.kind
     OR NEW.event <> OLD.event OR NEW.enqueued_at <> OLD.enqueued_at
     OR (OLD.status = 'acked' AND (NEW.status <> 'acked' OR NEW.acked_at <> OLD.acked_at)) THEN
    RAISE EXCEPTION 'queued edge events are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_sync_cursor_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  dead_letter boolean := COALESCE(current_setting('app.edge_dead_letter', true), '') = 'on';
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.edge_node_id <> OLD.edge_node_id OR NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'sync cursor identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF dead_letter AND NEW.next_out_seq < OLD.next_out_seq
     AND NEW.next_out_seq >= OLD.acked_out_seq
     AND NEW.acked_out_seq = OLD.acked_out_seq
     AND NEW.received_in_seq = OLD.received_in_seq THEN
    NULL;
  ELSIF NEW.next_out_seq < OLD.next_out_seq OR NEW.acked_out_seq < OLD.acked_out_seq
     OR NEW.received_in_seq < OLD.received_in_seq THEN
    RAISE EXCEPTION 'sync cursors never move backwards (EDG-02)' USING ERRCODE = '42501';
  END IF;
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
