-- Custom SQL migration file, put your code below! ---
-- Edge order ingest ledger (design docs/design/edge-order-ingest.md). Tenant RLS
-- (TEN-01/02) plus the outlet backstop (TEN-03), like edge_deferred_events.
SELECT app.enforce_tenant_rls('public.edge_order_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_order_ingests'::regclass);
