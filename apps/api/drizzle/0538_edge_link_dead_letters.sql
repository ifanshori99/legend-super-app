CREATE TABLE "edge_link_dead_letters" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"event_id" uuid NOT NULL,
	"link_seq" bigint NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"bytes" bigint NOT NULL,
	"reason" varchar(40) NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_link_dead_letters_tenant_id_edge_node_id_direction_event_id_pk" PRIMARY KEY("tenant_id","edge_node_id","direction","event_id"),
	CONSTRAINT "edge_link_dead_letters_direction_check" CHECK ("edge_link_dead_letters"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "edge_link_dead_letters_reason_check" CHECK ("edge_link_dead_letters"."reason" IN ('frame_too_large')),
	CONSTRAINT "edge_link_dead_letters_size_check" CHECK ("edge_link_dead_letters"."link_seq" >= 1 AND "edge_link_dead_letters"."bytes" >= 0 AND "edge_link_dead_letters"."aggregate_sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "edge_link_dead_letters" ADD CONSTRAINT "edge_link_dead_letters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_link_dead_letters" ADD CONSTRAINT "edge_link_dead_letters_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_link_dead_letters" ADD CONSTRAINT "edge_link_dead_letters_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_link_dead_letters'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_link_dead_letters'::regclass);
--> statement-breakpoint
-- legend-btx4d: dead letters are evidence, append-only like the receipts.
CREATE TRIGGER edge_link_dead_letters_append_only BEFORE UPDATE OR DELETE ON public.edge_link_dead_letters
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
--> statement-breakpoint
-- legend-btx4d: moving an oversized head event to the dead-letter store removes
-- a pending queue row and renumbers the rows behind it (none of them was ever
-- sent), so the receiver's contiguous cursor never sees a gap. Both guards
-- stay strict except inside that one transaction, marked with the local
-- setting app.edge_dead_letter = 'on'. The delete additionally needs the
-- dead-letter copy of the same event, so a pending event can never vanish.
-- A pending link_seq moves only one step down, to the parking zone (+10^12,
-- the RENUMBER_PARK of db-link-store.ts) or from the parking zone back down
-- by one step (OLD - 10^12 - 1): it can never jump anywhere else.
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
             OR (OLD.link_seq > 1000000000000 AND NEW.link_seq = OLD.link_seq - 1000000000001))))
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
  -- legend-btx4d: the sender's head may step back by exactly one when an
  -- unsent head event moved to the dead-letter store, never below the ack.
  IF dead_letter AND NEW.next_out_seq = OLD.next_out_seq - 1
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
