CREATE TABLE "edge_deferred_events" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"event_name" varchar(255) NOT NULL,
	"envelope" jsonb NOT NULL,
	"parked_reason" varchar(20) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_deferred_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "edge_deferred_events_parked_reason_check" CHECK ("edge_deferred_events"."parked_reason" IN ('deferred', 'unclassified'))
);
--> statement-breakpoint
-- legend-wg5t pattern (see 0068, 0070): the migrator may be a plain table owner
-- (no SUPERUSER, no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant
-- policies to it, and with no app.tenant_id set they raise 42501 while the
-- foreign keys below are validated against outlets and edge_nodes. Lift FORCE
-- on those two for this transaction only; it is restored right after the last
-- foreign key, before commit (drizzle applies pending migrations in one
-- transaction, so no other session ever sees the lifted state). tenants never
-- had FORCE.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_nodes NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.edge_nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "edge_deferred_events_aggregate_idx" ON "edge_deferred_events" USING btree ("tenant_id","aggregate_type","received_at");
