-- Stock count (stok opname) RLS (bead legend-j5x; PRD v1.7 §3 F16, INV-03).
-- Apply after the tables of inventory-count.ts are created (generate with
-- `drizzle-kit generate --custom`). Both tables are tenant-owned AND
-- outlet-owned (outlet_id NOT NULL), so each gets the RESTRICTIVE tenant policy
-- and, right after it, the outlet policy (TEN-03, legend-tjey guard test
-- src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.stock_counts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_counts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stock_count_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_count_lines'::regclass);
