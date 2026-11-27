-- Custom SQL migration file, put your code below! ---
-- O1 offline kits (0534). Tenant RLS (TEN-01/02) plus the outlet backstop
-- (TEN-03), like the other POS tables.
SELECT app.enforce_tenant_rls('public.pos_offline_kits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_kits'::regclass);
--> statement-breakpoint
-- A kit is what the cloud promised the tablet (prices, epoch): once issued it
-- never changes and is never deleted.
CREATE FUNCTION app.guard_pos_offline_kit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline kit % is append-only', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_kits_guard BEFORE UPDATE OR DELETE ON public.pos_offline_kits
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_kit();
--> statement-breakpoint
-- O1 review P3 2 (0542, legend-wasr7.15): the snapshot table is stored once per
-- (outlet, catalogue version). Tenant RLS plus the outlet backstop, and
-- append-only like the kits: what a kit was priced from never changes.
SELECT app.enforce_tenant_rls('public.pos_offline_catalog_snapshots'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_catalog_snapshots'::regclass);
--> statement-breakpoint
CREATE FUNCTION app.guard_pos_offline_catalog_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline catalogue snapshot % is append-only', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_catalog_snapshots_guard BEFORE UPDATE OR DELETE ON public.pos_offline_catalog_snapshots
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_catalog_snapshot();
