-- legend-9fhs: cloud inbox of edge events accepted but not yet applied (POS
-- order.* until legend-078n). Tenant RLS (TEN-01/02) plus the outlet backstop
-- (TEN-03).
SELECT app.enforce_tenant_rls('public.edge_deferred_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_deferred_events'::regclass);
