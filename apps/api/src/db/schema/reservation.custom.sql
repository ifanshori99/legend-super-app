-- Custom SQL migration for legend-t8bz (WS-08 reservations). Append AFTER the
-- drizzle-generated CREATE TABLE statements for reservation_policies,
-- reservations, reservation_tables, reservation_deposit_allocations and
-- reservation_idempotency.
--
-- DEPENDS ON the `btree_gist` extension (the lead's migration runs
-- `CREATE EXTENSION IF NOT EXISTS btree_gist;` BEFORE this file): the exclusion
-- constraint mixes uuid equality (tenant_id, table_id) with tstzrange overlap.
--
-- RSV-01: two live holds on one table at overlapping times are impossible, even
-- when two requests race. `hold_range` is the generated half-open
-- `[starts_at, ends_at)` range, so a slot ending exactly when the next starts
-- is free. A hold stops blocking once `released_at` is set (cancelled, no-show,
-- completed). Violation = SQLSTATE 23P01, mapped to RESERVATION_SLOT_TAKEN.
ALTER TABLE "reservation_tables"
  ADD CONSTRAINT "reservation_tables_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "table_id" WITH =,
    "hold_range" WITH &&
  ) WHERE ("released_at" IS NULL);
--> statement-breakpoint
-- A hold's outlet must be the reservation's outlet (the composite FK only ties
-- tenant + id). Enforced for inserts and outlet changes.
CREATE OR REPLACE FUNCTION app.reservation_tables_same_outlet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reservation_id AND r.outlet_id = NEW.outlet_id
  ) OR NOT EXISTS (
    SELECT 1 FROM tables t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.table_id AND t.outlet_id = NEW.outlet_id
  ) THEN
    RAISE EXCEPTION 'reservation_tables outlet must match the reservation and the table'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "reservation_tables_same_outlet_trg"
  BEFORE INSERT OR UPDATE OF "outlet_id", "reservation_id", "table_id" ON "reservation_tables"
  FOR EACH ROW EXECUTE FUNCTION app.reservation_tables_same_outlet();
--> statement-breakpoint
-- RSV-03: the policy snapshot is frozen at booking time. Any update that
-- changes it is refused at the database, not only in the service.
CREATE OR REPLACE FUNCTION app.reservations_snapshot_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'reservations.policy_snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "reservations_snapshot_frozen_trg"
  BEFORE UPDATE ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION app.reservations_snapshot_frozen();
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_tables'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_tables'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_deposit_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_deposit_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_idempotency'::regclass);
