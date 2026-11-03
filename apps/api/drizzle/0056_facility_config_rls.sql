-- WS-09 facility configuration tables (bead legend-8dpm; PRD v1.7 §3 F22/F25):
-- every row is tenant and outlet owned, so both guards apply (TEN-01, TEN-03).
SELECT app.enforce_tenant_rls('public.facility_products'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_products'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_addons'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_addons'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.entitlement_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.entitlement_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_subscription_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_subscription_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wifi_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_incidents'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_incidents'::regclass);
