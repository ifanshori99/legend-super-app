-- legend-ideif: the edge keeps the per-tenant DERIVED staff pin peppers the cloud
-- sends it, sealed (AES-256-GCM, key from the node credential) at rest. Never the
-- root pepper. The migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS): FORCE ROW LEVEL SECURITY would apply the tenant policies to it
-- while the foreign keys below are validated, so lift FORCE on outlets and
-- edge_nodes for this transaction only (same as migration 0069).
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.edge_nodes NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "edge_staff_pin_peppers" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_staff_pin_peppers_tenant_id_edge_node_id_version_pk" PRIMARY KEY("tenant_id","edge_node_id","version"),
	CONSTRAINT "edge_staff_pin_peppers_version_check" CHECK ("edge_staff_pin_peppers"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "edge_staff_pin_peppers" ADD CONSTRAINT "edge_staff_pin_peppers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_staff_pin_peppers" ADD CONSTRAINT "edge_staff_pin_peppers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_staff_pin_peppers" ADD CONSTRAINT "edge_staff_pin_peppers_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.edge_nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_staff_pin_peppers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_staff_pin_peppers'::regclass);
