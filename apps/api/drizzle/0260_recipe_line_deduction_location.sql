ALTER TABLE "recipe_deduction_lines" DROP CONSTRAINT "recipe_deduction_lines_tenant_deduction_item_key";--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD COLUMN "deduction_location_id" uuid;--> statement-breakpoint
-- FORCE RLS tables: a later ADD CONSTRAINT FOREIGN KEY by a non-superuser owner fails with
-- "tenant context is required" while the RLS policies are forced (merge train batch48h, same
-- pattern as 0202). RLS is re-forced right after.
ALTER TABLE public.recipe_lines NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stock_locations NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_deduction_location_fk" FOREIGN KEY ("tenant_id","deduction_location_id") REFERENCES "public"."stock_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.stock_locations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.recipe_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe_deduction_lines" ADD CONSTRAINT "recipe_deduction_lines_tenant_deduction_item_location_key" UNIQUE("tenant_id","deduction_id","inventory_item_id","location_id");