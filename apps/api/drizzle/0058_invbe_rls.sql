-- Custom SQL migration file, put your code below! --
-- AP/AR open items, fixed assets + depreciation, budgets (bead legend-hpgo;
-- PRD v1.7 §3.19 Utang & Piutang, Aset Tetap, Anggaran; §6 F). Tenant RLS on
-- every table (TEN-01/02). None of these tables is outlet-owned: outlet_id is
-- nullable everywhere (null = whole legal entity, contract payables/assets/
-- budgets), so outlet reach is enforced in services/accounting-*.ts
-- (contracts.md "TEN-03 outlet isolation layers"), like the accounting core
-- tables. Every CHECK / unique key is expressed in schema/accounting-ap-fa.ts.
SELECT app.enforce_tenant_rls('public.accounting_open_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.accounting_open_item_settlements'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_assets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.depreciation_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_depreciations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_revaluations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.budgets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.accounting_command_idempotency'::regclass);
--> statement-breakpoint
-- Ledgers are append-only for the application role: depreciation postings and
-- revaluation history are corrected by new rows + reversing journals, never
-- edited (ACC-01 spirit for the sub-ledgers).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_depreciations FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_revaluations FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.accounting_open_item_settlements FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.accounting_command_idempotency FROM legend_app;
--> statement-breakpoint

-- Inventory setup RLS (bead legend-gjmk). Apply after the tables of
-- inventory-setup.ts are created (generate with `drizzle-kit generate --custom`).
SELECT app.enforce_tenant_rls('public.inventory_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.par_levels'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.par_levels'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_item_alternates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_setup_idempotency'::regclass);
--> statement-breakpoint

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
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.menu_import_jobs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_import_jobs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.printable_menu_renders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.printable_menu_renders'::regclass);
