-- Custom SQL migration file, put your code below! ---
-- 1271 F3 switchover counts (0532). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other edge tables.
SELECT app.enforce_tenant_rls('public.outlet_failover_switchover_counts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_failover_switchover_counts'::regclass);
--> statement-breakpoint
-- The switchover count C1 closes the interrupted edge shift (D2): once
-- written it never changes and is never deleted.
CREATE FUNCTION app.guard_outlet_failover_switchover_count() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'failover switchover counts are append-only' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER outlet_failover_switchover_counts_guard BEFORE UPDATE OR DELETE ON public.outlet_failover_switchover_counts
FOR EACH ROW EXECUTE FUNCTION app.guard_outlet_failover_switchover_count();
