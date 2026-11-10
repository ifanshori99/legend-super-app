-- Custom SQL migration file, put your code below! ---
-- WS-11 sales_targets: tenant-owned AND outlet-owned (outlet_id NOT NULL), so it
-- gets the RESTRICTIVE tenant policy and, right after it, the outlet policy
-- (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.sales_targets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.sales_targets'::regclass);
