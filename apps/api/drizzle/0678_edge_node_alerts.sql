-- Edge node alerts for the back-office "Status edge" screen (beads legend-uux9k,
-- legend-uvnll, legend-ph62j). Foreign keys are inline in the CREATE TABLE
-- (docs/plan/contracts.md, pattern 1).
CREATE TABLE "edge_node_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_node_alerts_kind_check" CHECK ("edge_node_alerts"."kind" IN ('device_registry_hard_stale', 'receipt_run_alert')),
	CONSTRAINT "edge_node_alerts_resolved_check" CHECK ("edge_node_alerts"."resolved_at" IS NULL OR "edge_node_alerts"."resolved_at" >= "edge_node_alerts"."raised_at"),
	CONSTRAINT "edge_node_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_node_alerts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_node_alerts_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "edge_node_alerts_open_key" ON "edge_node_alerts" USING btree ("tenant_id","edge_node_id","kind") WHERE "edge_node_alerts"."resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "edge_node_alerts_open_outlet_idx" ON "edge_node_alerts" USING btree ("tenant_id","outlet_id") WHERE "edge_node_alerts"."resolved_at" IS NULL;
--> statement-breakpoint
-- Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03). Rows are updated
-- (last seen, resolved) and never deleted by the app.
SELECT app.enforce_tenant_rls('public.edge_node_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_node_alerts'::regclass);
