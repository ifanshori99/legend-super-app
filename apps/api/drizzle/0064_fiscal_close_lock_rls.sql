-- Tenant RLS + invariants for the fiscal close tables (legend-72we).
-- Snapshots are the frozen trial balance of a closed period: append-only for
-- every role (a re-close after a reopen adds a new version, it never rewrites
-- one). period_reopen_requests is mutable: a request moves from pending to
-- approved, rejected or cancelled.
SELECT app.enforce_tenant_rls('public.fiscal_period_snapshots'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fiscal_period_snapshot_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.period_reopen_requests'::regclass);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reject_period_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'period snapshots are append-only; close the period again after a reopen'
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fiscal_period_snapshots_append_only ON public.fiscal_period_snapshots;
--> statement-breakpoint
CREATE TRIGGER fiscal_period_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.fiscal_period_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.reject_period_snapshot_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS fiscal_period_snapshot_lines_append_only ON public.fiscal_period_snapshot_lines;
--> statement-breakpoint
CREATE TRIGGER fiscal_period_snapshot_lines_append_only
  BEFORE UPDATE OR DELETE ON public.fiscal_period_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION app.reject_period_snapshot_mutation();
