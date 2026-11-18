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
