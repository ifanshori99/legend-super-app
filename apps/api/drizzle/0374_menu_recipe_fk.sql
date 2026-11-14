-- legend-3kdd: menu_items, item_variants and modifiers carried a plain
-- recipe_id (menu.ts predated the recipes table). Add the composite foreign key
-- (tenant_id, recipe_id) -> recipes (tenant_id, id) so a menu row can only point
-- at a recipe of its own tenant, and a referenced recipe cannot be deleted
-- (ON DELETE NO ACTION).
--
-- Orphan check first: a recipe_id with no recipe of the same tenant (missing or
-- another tenant's) would fail the key, so it is set to NULL. NULL means "no
-- recipe", the same state as a menu row never linked to one; no price, tax or
-- amount column is touched. Idempotent: rows already NULL or valid are skipped.
--
-- The four tables are FORCE RLS and the migrator is a table owner with no tenant
-- context, so the orphan scan and the FK check on existing rows would raise
-- "tenant context is required". Lift FORCE for this transaction only and restore it before
-- commit (drizzle applies pending migrations in one transaction, so no other
-- session sees the lifted state), as in 0127 and 0364. Without FORCE the owner
-- skips RLS, so the scan spans every tenant. ADD CONSTRAINT validates existing
-- rows itself (no NOT VALID: migration-force-rls-guard forbids it).
ALTER TABLE public.menu_items NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.item_variants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.modifiers NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.recipes NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.menu_items m
SET recipe_id = NULL
WHERE m.recipe_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.recipes r
    WHERE r.tenant_id = m.tenant_id AND r.id = m.recipe_id
  );--> statement-breakpoint
UPDATE public.item_variants v
SET recipe_id = NULL
WHERE v.recipe_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.recipes r
    WHERE r.tenant_id = v.tenant_id AND r.id = v.recipe_id
  );--> statement-breakpoint
UPDATE public.modifiers d
SET recipe_id = NULL
WHERE d.recipe_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.recipes r
    WHERE r.tenant_id = d.tenant_id AND r.id = d.recipe_id
  );--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.recipes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.modifiers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.item_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.menu_items FORCE ROW LEVEL SECURITY;
