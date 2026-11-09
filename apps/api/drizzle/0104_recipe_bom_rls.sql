-- Recipe / BOM RLS (bead legend-db6). Apply after the tables of recipe.ts are
-- created (generate with `drizzle-kit generate --custom`). Recipes, recipe
-- lines and modifier rules are tenant-wide master data (tenant policy only);
-- outlet settings, deductions and deduction lines are outlet-owned
-- (outlet_id NOT NULL), so each gets the outlet policy right after the tenant
-- one (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.recipes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.recipe_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.modifier_recipe_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.outlet_inventory_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_inventory_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.recipe_deductions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.recipe_deductions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.recipe_deduction_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.recipe_deduction_lines'::regclass);
