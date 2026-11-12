-- Custom SQL migration file, put your code below! ---
-- Edge catalog sales gate state (legend-10nex): tenant + outlet owned.
SELECT app.enforce_tenant_rls('public.edge_catalog_gate_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_gate_state'::regclass);
