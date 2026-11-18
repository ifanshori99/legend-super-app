CREATE TABLE "edge_reconciliation_runs" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"from_link_seq" bigint DEFAULT 0 NOT NULL,
	"through_link_seq" bigint NOT NULL,
	"edge_instance_id" uuid,
	"status" varchar(10) NOT NULL,
	"edge_totals" jsonb NOT NULL,
	"cloud_totals" jsonb NOT NULL,
	"diffs" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_by" varchar(36),
	CONSTRAINT "edge_reconciliation_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_reconciliation_runs_status_check" CHECK ("edge_reconciliation_runs"."status" IN ('ok', 'mismatch', 'behind', 'stale')),
	CONSTRAINT "edge_reconciliation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_reconciliation_runs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_reconciliation_runs_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_txn_ledger" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"event_name" varchar(255) NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"amount_idr" bigint DEFAULT 0 NOT NULL,
	"id_hash_sum" numeric(20, 0) DEFAULT 0 NOT NULL,
	"last_link_seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_txn_ledger_tenant_id_edge_node_id_event_name_pk" PRIMARY KEY("tenant_id","edge_node_id","event_name"),
	CONSTRAINT "edge_txn_ledger_event_count_check" CHECK ("edge_txn_ledger"."event_count" >= 0),
	CONSTRAINT "edge_txn_ledger_amount_idr_check" CHECK ("edge_txn_ledger"."amount_idr" >= 0),
	CONSTRAINT "edge_txn_ledger_id_hash_sum_check" CHECK ("edge_txn_ledger"."id_hash_sum" >= 0 AND "edge_txn_ledger"."id_hash_sum" < 18446744073709551616),
	CONSTRAINT "edge_txn_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_txn_ledger_baselines" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"from_link_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "edge_txn_ledger_baselines_tenant_id_edge_node_id_pk" PRIMARY KEY("tenant_id","edge_node_id"),
	CONSTRAINT "edge_txn_ledger_baselines_from_link_seq_check" CHECK ("edge_txn_ledger_baselines"."from_link_seq" >= 0),
	CONSTRAINT "edge_txn_ledger_baselines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_baselines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_baselines_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_txn_ledger_events" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_txn_ledger_events_tenant_id_edge_node_id_event_id_pk" PRIMARY KEY("tenant_id","edge_node_id","event_id"),
	CONSTRAINT "edge_txn_ledger_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_txn_ledger_events_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "edge_reconciliation_runs_node_idx" ON "edge_reconciliation_runs" USING btree ("tenant_id","edge_node_id","checked_at");--> statement-breakpoint
-- legend-kai: a node that already queued events before this migration has
-- counted none of them in edge_txn_ledger. Its baseline is the link sequence it
-- had reached, so the cloud reconciles only events after it. A cloud database
-- has next_out_seq = 0 for edge_to_cloud (only the edge enqueues that
-- direction), so nothing is inserted there.
--
-- sync_cursors and edge_txn_ledger_baselines are FORCE RLS (tenant policy plus
-- the restrictive outlet policy), so a migration role without BYPASSRLS must
-- name each tenant and the tenant-wide outlet scope, like
-- 0090_pos_day_close_permission.sql. Both GUCs are restored afterwards.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
  previous_outlets text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  previous_outlets := current_setting('app.outlet_ids', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    PERFORM set_config('app.outlet_ids', '*', true);
    INSERT INTO public.edge_txn_ledger_baselines (tenant_id, outlet_id, edge_node_id, from_link_seq)
    SELECT tenant_id, outlet_id, edge_node_id, next_out_seq FROM public.sync_cursors
    WHERE tenant_id = target AND direction = 'edge_to_cloud' AND next_out_seq > 0
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  PERFORM set_config('app.outlet_ids', coalesce(previous_outlets, ''), true);
END $$;
--> statement-breakpoint
-- legend-kai: edge-side sent-transaction ledger. Tenant RLS (TEN-01/02) plus
-- the outlet backstop (TEN-03).
SELECT app.enforce_tenant_rls('public.edge_txn_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_txn_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_txn_ledger_baselines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_txn_ledger_baselines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_txn_ledger_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_txn_ledger_events'::regclass);
--> statement-breakpoint
-- legend-kai: cloud-side edge reconciliation runs (append-only evidence). Tenant
-- RLS (TEN-01/02) plus the outlet backstop (TEN-03).
SELECT app.enforce_tenant_rls('public.edge_reconciliation_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_reconciliation_runs'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON public.edge_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
