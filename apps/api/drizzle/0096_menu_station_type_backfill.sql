-- Backfill: carry the type of each item's current station into station_type.
-- menu_items and stations are FORCE RLS and the migration role is a non-super
-- table owner with no tenant context, so a plain UPDATE would be refused. Lift
-- FORCE on menu_items only for this statement (the owner then bypasses RLS);
-- stations is read via a subquery, so FORCE is lifted there too. Policies are
-- not touched and FORCE is restored in the same migration transaction.
ALTER TABLE "menu_items" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stations" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "menu_items" SET "station_type" = (
  SELECT s."type" FROM "stations" s
  WHERE s."tenant_id" = "menu_items"."tenant_id" AND s."id" = "menu_items"."station_id"
) WHERE "station_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "stations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;
