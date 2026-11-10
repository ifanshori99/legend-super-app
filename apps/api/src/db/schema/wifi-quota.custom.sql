-- Wi-Fi quota engine (bead legend-kmd3; PRD v1.7 §3 F25, FAC-12/FAC-13).
-- RLS for wifi_sessions and wifi_spend_entries (wifi-quota.ts). CHECK, unique
-- and FK constraints live in the drizzle schema. Fold into the migration after
-- the generated CREATE TABLE statements.

-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.wifi_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wifi_spend_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_spend_entries'::regclass);
