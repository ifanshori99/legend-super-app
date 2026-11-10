-- WS-02 edge (brief 90; bead legend-wqc6): operator resolutions of edge sync
-- conflicts. Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03); the log
-- is append-only like edge_sync_conflicts (edge-node.custom.sql).
SELECT app.enforce_tenant_rls('public.edge_sync_conflict_resolutions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_sync_conflict_resolutions'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_sync_conflict_resolutions_append_only BEFORE UPDATE OR DELETE ON public.edge_sync_conflict_resolutions
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
