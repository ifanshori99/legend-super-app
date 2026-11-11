-- WFC bundles (bead legend-bz9h): every row is tenant and outlet owned, so
-- both guards apply (TEN-01, TEN-03). Append this block to the generated
-- wfc_products migration.
SELECT app.enforce_tenant_rls('public.wfc_bundles'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundles'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_bundle_purchase_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_bundle_purchase_allocations'::regclass);
