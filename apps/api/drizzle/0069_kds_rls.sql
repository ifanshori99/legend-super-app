-- Custom SQL migration fragment for legend-4d5 (KDS routing + ticket
-- lifecycle). Append AFTER the drizzle-generated CREATE TABLE statements for
-- kitchen_tickets, kitchen_ticket_items, kitchen_ticket_status_changes,
-- kitchen_station_feed and kitchen_station_cursors.
--
-- KDS-04: every status change is recorded with time and user, and the record
-- is never rewritten. KDS-02: the per-station feed is gapless and append-only.

-- 1. Append-only history: status changes and the station feed are never
--    updated or deleted (trigger + revoked privileges as backstop).
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
CREATE TRIGGER "kitchen_station_feed_append_only_trg"
  BEFORE UPDATE OR DELETE ON "kitchen_station_feed"
  FOR EACH ROW EXECUTE FUNCTION app.kds_append_only();
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
--    append-only tables.
REVOKE UPDATE, DELETE ON public.kitchen_ticket_status_changes FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.kitchen_station_feed FROM legend_app;
