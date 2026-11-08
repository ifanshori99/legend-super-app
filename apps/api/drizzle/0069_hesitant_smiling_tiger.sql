-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets and edge_nodes. Lift FORCE on those two for
-- this transaction only; it is restored right after the last foreign key,
-- before commit. tenants never had FORCE, so it is left alone.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_nodes NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "edge_pull_checkpoints" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"stream" varchar(40) NOT NULL,
	"watermark" text,
	"last_success_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_pull_checkpoints_tenant_id_edge_node_id_stream_pk" PRIMARY KEY("tenant_id","edge_node_id","stream"),
	CONSTRAINT "edge_pull_checkpoints_stream_check" CHECK ("edge_pull_checkpoints"."stream" IN ('device_registry'))
);
--> statement-breakpoint
ALTER TABLE "edge_pull_checkpoints" ADD CONSTRAINT "edge_pull_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_pull_checkpoints" ADD CONSTRAINT "edge_pull_checkpoints_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_pull_checkpoints" ADD CONSTRAINT "edge_pull_checkpoints_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.edge_nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-2lp.7: edge-side pull checkpoint, tenant + outlet owned like the
-- other edge tables (see schema/edge-node.ts edgePullCheckpoints and
-- edge-node.custom.sql).
SELECT app.enforce_tenant_rls('public.edge_pull_checkpoints'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_pull_checkpoints'::regclass);
