-- Negative stock revaluation RLS (bead 1214, same shape as 0087). The table is
-- tenant-owned AND outlet-owned (outlet_id NOT NULL): the RESTRICTIVE tenant
-- policy and, right after it, the outlet policy (TEN-03, guard test
-- src/db/outlet-rls.test.ts). No foreign key besides tenants, so no FORCE lift
-- is needed (see 0074).
SELECT app.enforce_tenant_rls('public.stock_negative_revaluations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_negative_revaluations'::regclass);
