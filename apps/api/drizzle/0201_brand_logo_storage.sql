-- legend-a30j: tenant-level brand_logo upload.
--
-- A brand logo belongs to the tenant, not to an outlet, so outlet_id becomes
-- nullable. outlet_id is NULL exactly when purpose is brand_logo: a brand_logo
-- row never carries an outlet and every other purpose keeps requiring one.
-- Existing rows all carry an outlet and none is a brand_logo, so they satisfy
-- the new CHECK and nothing is rewritten. The composite outlet FK stays: a
-- null outlet_id skips it (MATCH SIMPLE).
ALTER TABLE "core_storage_objects" ALTER COLUMN "outlet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_outlet_purpose_check" CHECK (("core_storage_objects"."outlet_id" IS NULL) = ("core_storage_objects"."purpose" = 'brand_logo'));--> statement-breakpoint
-- Replace the restrictive outlet_isolation policy (0032). tenant_isolation is
-- untouched, so another tenant never sees or overwrites a tenant-level row.
-- outlet_isolation is FOR ALL: its USING also governs UPDATE and DELETE, so it
-- lets outlet-scoped staff READ tenant-level rows (outlet_id IS NULL) and
-- WITH CHECK lets only a tenant-scope context write outlet_id NULL. Two more
-- RESTRICTIVE policies re-tighten UPDATE and DELETE to the strict outlet
-- predicate, so an outlet-scoped context cannot delete a tenant-level row or
-- claim one by setting its own outlet_id. Restrictive policies are ANDed.
DROP POLICY outlet_isolation ON public.core_storage_objects;--> statement-breakpoint
CREATE POLICY outlet_isolation ON public.core_storage_objects AS RESTRICTIVE FOR ALL
  USING (outlet_id IS NULL OR (SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]))
  WITH CHECK ((SELECT app.outlet_scope_is_tenant()) OR (outlet_id IS NOT NULL AND outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[])));--> statement-breakpoint
CREATE POLICY outlet_isolation_update ON public.core_storage_objects AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]));--> statement-breakpoint
CREATE POLICY outlet_isolation_delete ON public.core_storage_objects AS RESTRICTIVE FOR DELETE
  USING ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]));
