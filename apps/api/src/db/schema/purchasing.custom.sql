-- Purchasing RLS (bead legend-9yz; PRD v1.7 §3 "Supplier", "Purchase Request &
-- Purchase Order", §6 E).
-- Apply after the tables of purchasing.ts are created (generate with
-- `drizzle-kit generate --custom`). Tenant-owned tables get the RESTRICTIVE
-- tenant policy; outlet-owned tables (outlet_id NOT NULL) also get the outlet
-- policy right after it (TEN-03, guard test src/db/outlet-rls.test.ts).
-- `purchasing_idempotency.outlet_id` is nullable (suppliers are tenant-level),
-- so that table has the tenant policy only.
SELECT app.enforce_tenant_rls('public.suppliers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_contacts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_prices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_request_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_request_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_document_sequences'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_share_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_share_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_order_email_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_order_email_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_idempotency'::regclass);
--> statement-breakpoint
-- Price history is append-only: a new price is a new row. The application
-- login may append and read, and may only flip `is_active` (deactivate a
-- price); no other column changes and no row is deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_prices FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (is_active) ON TABLE public.supplier_prices TO legend_app;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.supplier_invoices'::regclass);
--> statement-breakpoint
-- Tax records are append-only: the tax reports reconcile against them, so the
-- application login may insert and read, never change or remove a row.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_invoices FROM legend_app;
--> statement-breakpoint
-- WS-06 supplier invoices and the tenant purchasing policy (legal-entity AP,
-- bead legend-lspfy / legend-nz13; migration 0491, after the tables of 0490).
-- Foreign keys into FORCE RLS tables are inline in the 0490 CREATE TABLEs
-- (docs/plan/contracts.md, pattern 1).
SELECT app.enforce_tenant_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_policies'::regclass);
--> statement-breakpoint
-- Invoice lines are the evidence of what was billed: append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoice_lines FROM legend_app;
--> statement-breakpoint
-- An invoice is never deleted. Only the match result and the hold decision
-- (matched/held -> released/rejected, with who, when and why) may change.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoices FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, journal_entry_id, match_result, match_snapshot, match_note, tolerance_bp, updated_at) ON TABLE public.purchase_invoices TO legend_app;
