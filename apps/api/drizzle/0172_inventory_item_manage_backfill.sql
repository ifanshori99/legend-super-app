-- Migration number 0172 and its `when` were assigned by the coordinator; merge
-- it after 0163 in the journal (drizzle skips an older `when` applied after a
-- newer one).
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill and the foreign key validation below raise
-- 42501. Lift FORCE for this transaction only and restore it right after
-- (drizzle applies pending migrations in one transaction; same pattern as
-- 0065, 0068, 0120, 0148 and 0159).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-1ozj: inventory.item.manage (item master data writes). Role rows are
-- seeded once per tenant and the resolver reads the stored rows, so existing
-- tenants need the new permission appended: the owner and warehouse templates,
-- and every role (custom included) that holds inventory.stock.receive, the
-- code that gated item writes before. New tenants get it from the template
-- catalog. Idempotent: skips rows that already hold it.
UPDATE "roles"
SET "permissions" = "permissions" || '["inventory.item.manage"]'::jsonb,
    "updated_at" = now()
WHERE NOT ("permissions" @> '["inventory.item.manage"]'::jsonb)
  AND (
    "permissions" @> '["inventory.stock.receive"]'::jsonb
    OR ("is_template" AND "template_key" IN ('owner', 'warehouse'))
  );
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-tk7i: production_orders.recipe_id references recipes per tenant. The
-- validation scan reads both FORCE tables as the migrator, so lift both.
ALTER TABLE public.recipes NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.production_orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.production_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recipes FORCE ROW LEVEL SECURITY;
