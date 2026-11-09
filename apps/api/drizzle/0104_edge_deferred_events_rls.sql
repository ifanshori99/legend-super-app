-- legend-9fhs: edge_deferred_events is tenant + outlet owned.
SELECT app.enforce_tenant_rls('public.edge_deferred_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_deferred_events'::regclass);
