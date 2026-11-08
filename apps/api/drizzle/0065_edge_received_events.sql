-- legend-wg5t: an earlier, never-merged draft of 0063 created this partial
-- unique index on the receipts; it fails on legitimate primary + standby
-- duplicates. Drop it where a dev database applied that draft.
DROP INDEX IF EXISTS "edge_inbound_events_edge_to_cloud_event_key";
--> statement-breakpoint
-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated (outlets, edge_nodes) and while the backfill reads the
-- receipts. Lift FORCE for this transaction only; it is restored after the
-- backfill, before commit (drizzle applies pending migrations in one
-- transaction, so no other session ever sees the lifted state).
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_nodes NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_inbound_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "edge_received_events" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"first_edge_node_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_received_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "edge_received_events" ADD CONSTRAINT "edge_received_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_received_events" ADD CONSTRAINT "edge_received_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_received_events" ADD CONSTRAINT "edge_received_events_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","first_edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- legend-wg5t: tenant-wide registry of edge_to_cloud event ids (see
-- schema/edge-node.ts edgeReceivedEvents and edge-node.custom.sql).
-- Backfill from the existing receipts. Primary and standby may already hold
-- receipts for the same (tenant, event) on different nodes; DISTINCT ON keeps
-- one registry row per event (the earliest receipt) and the receipts stay
-- untouched (append-only). FORCE RLS on the receipts was lifted above and is
-- restored right after the backfill.
INSERT INTO public.edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id, received_at)
SELECT DISTINCT ON (tenant_id, event_id) tenant_id, outlet_id, event_id, edge_node_id, received_at
FROM public.edge_inbound_events
WHERE direction = 'edge_to_cloud'
ORDER BY tenant_id, event_id, received_at, edge_node_id;
--> statement-breakpoint
ALTER TABLE public.edge_inbound_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_received_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_received_events'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_received_events_append_only BEFORE UPDATE OR DELETE ON public.edge_received_events
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
