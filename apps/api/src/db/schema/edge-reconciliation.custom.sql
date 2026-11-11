-- legend-kai: cloud-side edge reconciliation runs (append-only evidence). Tenant
-- RLS (TEN-01/02) plus the outlet backstop (TEN-03).
SELECT app.enforce_tenant_rls('public.edge_reconciliation_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_reconciliation_runs'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON public.edge_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
