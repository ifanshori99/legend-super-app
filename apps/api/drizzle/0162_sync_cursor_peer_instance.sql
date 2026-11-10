-- legend-nd3cu: link cursors per edge instance (offset rebase). Trigger body
-- is the same as schema/edge-node.custom.sql. sync_cursors is FORCE RLS: lift it
-- while the CHECK validates existing rows (docs/plan/contracts.md).
ALTER TABLE public.sync_cursors NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD COLUMN "peer_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD COLUMN "peer_seq_offset" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_peer_offset_check" CHECK ("sync_cursors"."peer_seq_offset" >= 0 AND "sync_cursors"."peer_seq_offset" <= GREATEST("sync_cursors"."acked_out_seq", "sync_cursors"."received_in_seq") AND ("sync_cursors"."peer_instance_id" IS NOT NULL OR "sync_cursors"."peer_seq_offset" = 0));--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_sync_cursor_update() RETURNS trigger
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
ALTER TABLE public.sync_cursors FORCE ROW LEVEL SECURITY;
