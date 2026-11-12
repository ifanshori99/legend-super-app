CREATE TABLE "edge_catalog_gate_state" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"tracking_started_at" timestamp with time zone NOT NULL,
	"clock_high_water_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_catalog_gate_state_tenant_id_edge_node_id_pk" PRIMARY KEY("tenant_id","edge_node_id"),
	CONSTRAINT "edge_catalog_gate_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_catalog_gate_state_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_catalog_gate_state_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_catalog_sale_overrides" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"until_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	CONSTRAINT "edge_catalog_sale_overrides_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_catalog_sale_overrides_window_check" CHECK ("edge_catalog_sale_overrides"."until_at" > "edge_catalog_sale_overrides"."granted_at" AND "edge_catalog_sale_overrides"."until_at" <= "edge_catalog_sale_overrides"."granted_at" + interval '24 hours'),
	CONSTRAINT "edge_catalog_sale_overrides_reason_check" CHECK (char_length(btrim("edge_catalog_sale_overrides"."reason")) BETWEEN 3 AND 500),
	CONSTRAINT "edge_catalog_sale_overrides_closed_check" CHECK (("edge_catalog_sale_overrides"."closed_at" IS NULL) = ("edge_catalog_sale_overrides"."closed_reason" IS NULL)),
	CONSTRAINT "edge_catalog_sale_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_catalog_sale_overrides_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_catalog_sale_overrides_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "edge_catalog_sale_overrides_edge_until_idx" ON "edge_catalog_sale_overrides" USING btree ("edge_node_id","until_at");--> statement-breakpoint
CREATE UNIQUE INDEX "edge_catalog_sale_overrides_active_uniq" ON "edge_catalog_sale_overrides" USING btree ("edge_node_id") WHERE "edge_catalog_sale_overrides"."superseded_at" IS NULL AND "edge_catalog_sale_overrides"."closed_at" IS NULL;
--> statement-breakpoint
-- Edge catalog sales gate state (legend-10nex): tenant + outlet owned.
SELECT app.enforce_tenant_rls('public.edge_catalog_gate_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_gate_state'::regclass);

--> statement-breakpoint
-- WS-02 edge (bead legend-10nex): owner override of the 24 h stale-catalog
-- sales block. Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03). Not
-- append-only: superseded_at / closed_at / closed_reason are set after the grant.
SELECT app.enforce_tenant_rls('public.edge_catalog_sale_overrides'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_sale_overrides'::regclass);
