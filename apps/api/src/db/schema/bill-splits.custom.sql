-- Custom SQL migration file, put your code below! ---
-- legend-ms3 bill_splits: tenant-owned AND outlet-owned (outlet_id NOT NULL), so
-- it gets the RESTRICTIVE tenant policy and, right after it, the outlet policy
-- (TEN-03, guard test src/db/outlet-rls.test.ts), same as orders.
SELECT app.enforce_tenant_rls('public.bill_splits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.bill_splits'::regclass);
