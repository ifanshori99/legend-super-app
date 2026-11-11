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
