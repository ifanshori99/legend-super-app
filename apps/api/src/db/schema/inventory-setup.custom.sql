-- Inventory setup RLS (bead legend-gjmk). Apply after the tables of
-- inventory-setup.ts are created (generate with `drizzle-kit generate --custom`).
SELECT app.enforce_tenant_rls('public.inventory_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.par_levels'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.par_levels'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_item_alternates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.inventory_setup_idempotency'::regclass);
