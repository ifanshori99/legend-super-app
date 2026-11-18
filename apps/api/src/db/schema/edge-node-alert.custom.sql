-- Edge node alerts (beads legend-uux9k, legend-uvnll, legend-ph62j): tenant RLS
-- (TEN-01/02) plus the outlet backstop (TEN-03). Rows are updated (last seen,
-- resolved) and never deleted by the app.
SELECT app.enforce_tenant_rls('public.edge_node_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_node_alerts'::regclass);
