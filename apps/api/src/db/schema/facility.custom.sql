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
--> statement-breakpoint
-- WS-09 config tables (bead legend-8dpm; PRD v1.7 §3 F22/F25): every row is
-- tenant and outlet owned, so both guards apply (TEN-01, TEN-03).
SELECT app.enforce_tenant_rls('public.facility_products'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_products'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_addons'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_addons'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.entitlement_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.entitlement_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_subscription_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_subscription_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wifi_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_incidents'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_incidents'::regclass);
--> statement-breakpoint
-- Breakfast pay-before-kitchen (bead oa0qk, migration 0279): the linked order
-- row is tenant and outlet owned.
SELECT app.enforce_tenant_rls('public.facility_linked_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_linked_orders'::regclass);
--> statement-breakpoint
-- POS facility tickets (936, legend-hpgyw part D, migration 0671): the line
-- that ties a ticket to its bill line and the credential digests are tenant and
-- outlet owned.
SELECT app.enforce_tenant_rls('public.facility_ticket_pos_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_ticket_pos_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.access_ticket_credentials'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.access_ticket_credentials'::regclass);
