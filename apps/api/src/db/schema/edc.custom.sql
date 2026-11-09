-- EDC agent framework (bead legend-apt; PRD v1.7 §3 F13, EDC-01..EDC-04).
-- RLS for edc_transactions (edc.ts). CHECK and unique constraints live in the
-- drizzle schema; this file holds what drizzle cannot express. Fold into the
-- migration after the generated CREATE TABLE.

-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.edc_transactions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_transactions'::regclass);
