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
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_deferred_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_deferred_events_aggregate_idx" ON "edge_deferred_events" USING btree ("tenant_id","aggregate_type","received_at");