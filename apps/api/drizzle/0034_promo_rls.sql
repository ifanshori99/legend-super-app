-- Promo engine tables (bead legend-7x4g): tenant RLS on every table (TEN-01/02)
-- and outlet RLS on the outlet-owned ones (TEN-03, legend-tjey).
SELECT app.enforce_tenant_rls('public.promotions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.promotion_customer_usage'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.vouchers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.promo_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.promotion_order_applications'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.promotion_order_applications'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.promotion_redemptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.promotion_redemptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_rewards'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_rewards'::regclass);
