-- Custom SQL migration file, put your code below! ---
-- O2 offline sales ledger (0535). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other POS tables.
SELECT app.enforce_tenant_rls('public.pos_offline_sales'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_sales'::regclass);
--> statement-breakpoint
-- A stored offline sale is the money record of a sale already paid: it never
-- changes and is never deleted.
CREATE FUNCTION app.guard_pos_offline_sale() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline sale % is append-only', OLD.event_id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_sales_guard BEFORE UPDATE OR DELETE ON public.pos_offline_sales
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_sale();
