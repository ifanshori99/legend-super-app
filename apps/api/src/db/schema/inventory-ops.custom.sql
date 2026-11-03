-- Inventory operations RLS (bead legend-ugo; PRD v1.7 §3 F16, F17, §6 E).
-- Apply after the tables of inventory-ops.ts are created (generate with
-- `drizzle-kit generate --custom`). Every table is tenant-owned AND
-- outlet-owned (outlet_id NOT NULL), so each gets the RESTRICTIVE tenant policy
-- and, right after it, the outlet policy (TEN-03, legend-tjey guard test
-- src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.production_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.production_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.waste_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.waste_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_stock_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.inventory_stock_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_ops_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.inventory_ops_idempotency'::regclass);
--> statement-breakpoint
-- Waste is a loss record: once written it is history like the stock card it
-- posted. The application login may append and read only (corrections are a
-- new adjustment through an approved stock count, INV-01).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.waste_logs FROM legend_app;
