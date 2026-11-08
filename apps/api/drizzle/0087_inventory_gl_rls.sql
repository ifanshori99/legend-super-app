-- Inventory -> GL bridge RLS (bead legend-w1vo; PRD v1.7 §3.19, J.4).
-- Apply after the tables of inventory-gl.ts are created (generate with
-- `drizzle-kit generate --custom`). Both tables are tenant-owned AND
-- outlet-owned (outlet_id NOT NULL), so each gets the RESTRICTIVE tenant policy
-- and, right after it, the outlet policy (TEN-03, guard test
-- src/db/outlet-rls.test.ts). No foreign key besides tenants, so no FORCE lift
-- is needed (see 0074).
SELECT app.enforce_tenant_rls('public.inventory_gl_postings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.inventory_gl_postings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_gl_blocked'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.inventory_gl_blocked'::regclass);
