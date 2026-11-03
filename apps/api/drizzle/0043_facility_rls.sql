-- Facility access (bead legend-nm4f; FAC-02, FAC-06). Requires the btree_gist
-- extension, created by 0041_reservation_rls.sql (earlier in the journal). CHECK constraints
-- live in the drizzle schema (facility.ts); this file holds what drizzle
-- cannot express.

-- FAC-02: one unit cannot hold two overlapping slots, cleaning buffer
-- included. Half-open range [starts_at, cleaning_ends_at) so back-to-back
-- sessions are legal. The WHERE clause is SLOT_HOLD_PREDICATE_SQL from
-- @starter/shared/facility (machines.ts): cancelled / refunded / no_show
-- tickets release the unit.
ALTER TABLE "access_tickets"
  ADD CONSTRAINT "access_tickets_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "unit_id" WITH =,
    tstzrange("starts_at", "cleaning_ends_at", '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled','refunded','no_show'));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facilities'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facilities'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_areas'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_areas'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_units'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_units'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.access_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.access_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_queue_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_queue_entries'::regclass);
