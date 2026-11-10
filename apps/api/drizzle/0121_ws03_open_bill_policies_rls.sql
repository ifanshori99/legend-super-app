-- Custom SQL migration file, put your code below! ---
-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL). The tenant policy
-- must exist first; enforce_outlet_rls checks for it.
SELECT app.enforce_tenant_rls('public.outlet_open_bill_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_open_bill_policies'::regclass);
