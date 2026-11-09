-- Custom SQL migration fragment for legend-4d5 (KDS routing + ticket
-- lifecycle). Append AFTER the drizzle-generated CREATE TABLE statements for
-- kitchen_tickets, kitchen_ticket_items, kitchen_ticket_status_changes,
-- kitchen_station_feed and kitchen_station_cursors.
--
-- KDS-04: every status change is recorded with time and user, and the record
-- is never rewritten. KDS-02: the per-station feed is gapless and append-only,
-- except that rows older than 24 hours may be deleted (pruning, see 1b).

-- 1. Append-only history: status changes are never updated or deleted
--    (trigger + revoked privileges as backstop).
CREATE OR REPLACE FUNCTION app.kds_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "kitchen_ticket_status_changes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "kitchen_ticket_status_changes"
  FOR EACH ROW EXECUTE FUNCTION app.kds_append_only();
--> statement-breakpoint

-- 1b. The station feed is never updated. The only delete allowed is pruning
--     from the bottom: a row older than 24 hours (by occurred_at against the
--     database clock) AND more than KITCHEN_FEED_MAX_LAG (2000) sequences
--     behind the station cursor, so a cursor that may still resume never sees
--     a hole (KDS-02). Keep 24 hours / 2000 in step with
--     KITCHEN_FEED_RETENTION_HOURS / KITCHEN_FEED_MAX_LAG (kitchen/realtime.ts).
CREATE OR REPLACE FUNCTION app.kds_feed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.occurred_at < now() - interval '24 hours'
     AND OLD.sequence < (
       SELECT c.last_sequence - 2000 FROM public.kitchen_station_cursors c
       WHERE c.tenant_id = OLD.tenant_id AND c.station_id = OLD.station_id
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "kitchen_station_feed_append_only_trg"
  BEFORE UPDATE OR DELETE ON "kitchen_station_feed"
  FOR EACH ROW EXECUTE FUNCTION app.kds_feed_guard();
--> statement-breakpoint

-- 2. Tenant + outlet RLS (TEN-01/TEN-03). Every table has outlet_id NOT NULL.
SELECT app.enforce_tenant_rls('public.kitchen_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_ticket_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_ticket_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_ticket_status_changes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_ticket_status_changes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_station_feed'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_station_feed'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_station_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_station_cursors'::regclass);
--> statement-breakpoint

-- 3. enforce_tenant_rls grants full DML; take UPDATE/DELETE back on the
--    status change log. On the station feed only UPDATE is revoked: DELETE
--    stays granted to legend_app for pruning, and the trigger above limits it
--    to rows older than 24 hours.
REVOKE UPDATE, DELETE ON public.kitchen_ticket_status_changes FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE ON public.kitchen_station_feed FROM legend_app;
