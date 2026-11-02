-- Inventory isolation and append-only stock card (PRD v1.7 §6 E, §16
-- "Kartu Stok Append-only", INV-01; bead legend-98t).
--
-- Run order: after the generated tables migration (0016). Every table is
-- tenant-owned: RESTRICTIVE tenant_isolation policy via app.enforce_tenant_rls,
-- which also grants DML to the non-bypass legend_app login. The composite
-- (tenant_id, id) / (tenant_id, outlet_id, id) foreign keys in 0016 already
-- stop a privileged writer from pointing a row at another tenant's or outlet's
-- parent.
SELECT app.enforce_tenant_rls('public.uoms'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.uom_conversions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_locations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_batches'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_balances'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_transfers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_transfer_lines'::regclass);
--> statement-breakpoint
-- INV-01: the stock card is append-only. A trigger (not only a privilege)
-- also blocks the table owner and the migration role, so a correction can
-- never rewrite history; it is a new `adjustment` row from an approved count.
CREATE FUNCTION app.reject_stock_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only (INV-01)' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only
BEFORE UPDATE OR DELETE ON public.stock_ledger
FOR EACH ROW EXECUTE FUNCTION app.reject_stock_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_ledger_no_truncate
BEFORE TRUNCATE ON public.stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION app.reject_stock_ledger_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_stock_ledger_mutation() FROM PUBLIC;
--> statement-breakpoint
-- Least privilege for the application login: append and read only. The
-- ledger rows are written inside the tenant transaction and never updated.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.stock_ledger FROM legend_app;
