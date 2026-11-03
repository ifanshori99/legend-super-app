-- Custom SQL migration file, put your code below! ---
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
