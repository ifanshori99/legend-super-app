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
--> statement-breakpoint

-- 4. Breakfast pay-before-kitchen (bead oa0qk, owner Q43; migration 0279).
--    Backstop for every path (retry, edge sync, captain, resend, worker): a
--    kitchen ticket or item for a breakfast order is refused unless its
--    `facility_linked_orders` row is paid (paid_at set, status fired).
--    The service checks first (HttpError 409 BREAKFAST_NOT_PAID); the triggers
--    raise 23514 with constraint `kitchen_tickets_breakfast_paid`. The lookups
--    run in SECURITY DEFINER helpers owned by the migrator (BYPASSRLS,
--    docs/deployment.md; same as ai.custom.sql) so RLS scope cannot hide the
--    order and make the check pass. Breakfast = orders.channel = 'facility' OR
--    a facility_linked_orders row exists.
--    Migration 0280 narrows the pass condition: the fired order must also have
--    fired_at < access_tickets.ends_at (missing ticket = not paid), so a send
--    to the kitchen at or after the ticket end is refused even if the worker
--    was down. fired_at, not now(), keeps the answer deterministic.
CREATE FUNCTION app.breakfast_order_unpaid(p_tenant uuid, p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT (
           EXISTS (
             SELECT 1 FROM public.orders o
             WHERE o.tenant_id = p_tenant AND o.id = p_order AND o.channel = 'facility'
           )
           OR EXISTS (
             SELECT 1 FROM public.facility_linked_orders f
             WHERE f.tenant_id = p_tenant AND f.order_id = p_order
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.facility_linked_orders f
           JOIN public.access_tickets a
             ON a.tenant_id = f.tenant_id AND a.id = f.access_ticket_id
           WHERE f.tenant_id = p_tenant AND f.order_id = p_order
             AND f.paid_at IS NOT NULL AND f.status = 'fired'
             AND f.fired_at IS NOT NULL AND f.fired_at < a.ends_at
         );
$$;
--> statement-breakpoint
-- The same answer for a kitchen item: the order it names, the order of the
-- order line it points at, and the order of its ticket. Also SECURITY DEFINER
-- so the order_items / kitchen_tickets lookups are not hidden by RLS either.
CREATE FUNCTION app.breakfast_order_item_unpaid(
  p_tenant uuid, p_order uuid, p_order_item uuid, p_ticket uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT app.breakfast_order_unpaid(p_tenant, p_order)
      OR EXISTS (
           SELECT 1 FROM public.order_items i
           WHERE i.tenant_id = p_tenant AND i.id = p_order_item
             AND app.breakfast_order_unpaid(p_tenant, i.order_id)
         )
      OR EXISTS (
           SELECT 1 FROM public.kitchen_tickets t
           WHERE t.tenant_id = p_tenant AND t.id = p_ticket
             AND app.breakfast_order_unpaid(p_tenant, t.order_id)
         );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.breakfast_order_item_unpaid(uuid, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) TO legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.breakfast_order_item_unpaid(uuid, uuid, uuid, uuid) TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.kitchen_tickets_breakfast_paid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF app.breakfast_order_unpaid(NEW.tenant_id, NEW.order_id) THEN
    RAISE EXCEPTION 'breakfast order % is not paid and cannot reach the kitchen', NEW.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'kitchen_tickets_breakfast_paid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.kitchen_tickets_breakfast_paid() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "kitchen_tickets_breakfast_paid_trg"
  BEFORE INSERT OR UPDATE OF order_id ON "kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION app.kitchen_tickets_breakfast_paid();
--> statement-breakpoint
CREATE FUNCTION app.kitchen_ticket_items_breakfast_paid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF app.breakfast_order_item_unpaid(NEW.tenant_id, NEW.order_id, NEW.order_item_id, NEW.ticket_id) THEN
    RAISE EXCEPTION 'breakfast order % is not paid and cannot reach the kitchen', NEW.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'kitchen_tickets_breakfast_paid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.kitchen_ticket_items_breakfast_paid() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "kitchen_ticket_items_breakfast_paid_trg"
  BEFORE INSERT OR UPDATE OF order_id, order_item_id, ticket_id ON "kitchen_ticket_items"
  FOR EACH ROW EXECUTE FUNCTION app.kitchen_ticket_items_breakfast_paid();
