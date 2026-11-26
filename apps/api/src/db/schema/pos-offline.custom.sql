-- Custom SQL migration file, put your code below! ---
-- O1 offline kits (0533). Tenant RLS (TEN-01/02) plus the outlet backstop
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
