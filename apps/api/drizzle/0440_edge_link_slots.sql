CREATE TABLE "edge_link_slots" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"link_seq" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_link_slots_tenant_id_edge_node_id_direction_link_seq_pk" PRIMARY KEY("tenant_id","edge_node_id","direction","link_seq"),
	CONSTRAINT "edge_link_slots_direction_check" CHECK ("edge_link_slots"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "edge_link_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_link_slots_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_link_slots_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- legend-pz641 (migration 0440): one row per link slot held by a counted
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
