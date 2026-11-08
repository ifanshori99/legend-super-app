-- Tenant RLS (FORCE) for the manual / recurring journal request tables
-- (accounting-journal-requests.ts, bead legend-vmyg). outlet_id is nullable
-- (entity-level journals), so only the tenant policy applies, like
-- journal_entries; the service layer filters outlets.
SELECT app.enforce_tenant_rls('public.manual_journals'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.recurring_journals'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.recurring_journal_runs'::regclass);
