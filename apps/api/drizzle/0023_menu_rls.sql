-- Menu master-data isolation (PRD v1.7 §6 C "Menu, Meja & Order", TEN-01/02/03).
-- Runs after the generated table migration. Every statement is idempotent so a
-- re-run on an existing database cannot diverge.
--
-- Menu tables are (T, E): tenant owned, edge replicated. `app.enforce_tenant_rls`
-- enables + forces RLS and installs the restrictive tenant_isolation policy
-- plus the legend_app DML grants (least privilege). Outlet-owned tables
-- (stations, price_lists, availability) additionally rely on the composite
-- (tenant_id, outlet_id) foreign keys so a row can never point at another
-- tenant's outlet.

SELECT app.enforce_tenant_rls('public.menu_categories'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.stations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.menu_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.item_variants'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.modifier_groups'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.modifiers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.menu_item_modifier_groups'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.combos'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.combo_components'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.price_lists'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.price_list_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.item_availability'::regclass);
