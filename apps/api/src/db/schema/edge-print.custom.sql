-- Edge Print Agent tables (bead legend-46p; PRD v1.7 §3 F5 "Print Agent",
-- §3 F12 "Fallback Cetak", EDG-05). Fold into the generated migration after
-- the CREATE TABLE statements (generated as 0244_edge_print, this file as
-- 0245_edge_print_rls). CHECK constraints live in the drizzle schema
-- (edge-print.ts); this file holds RLS and the invariants drizzle cannot
-- express. Same migration on the cloud and on every edge node.

-- TEN-01/TEN-03: every table is tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.edge_printers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_printers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_print_jobs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_print_jobs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_print_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_print_alerts'::regclass);
--> statement-breakpoint

-- A queued job is evidence of what was sent to a printer: the bytes, kind,
-- idempotency key, reprint link and creation time never change. Status,
-- attempts, error, fallback fields and the printer (reroute) may.
CREATE FUNCTION app.guard_edge_print_job_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.kind <> OLD.kind
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.reprint_of IS DISTINCT FROM OLD.reprint_of
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'print job content is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_print_jobs_guard BEFORE UPDATE ON public.edge_print_jobs
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_print_job_update();
--> statement-breakpoint

-- Alert evidence is immutable; the one-way acknowledgement and notification
-- delivery marker may change. The marker is added by migration 0408.
CREATE FUNCTION app.guard_edge_print_alert_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.kind <> OLD.kind
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.station_id IS DISTINCT FROM OLD.station_id
     OR NEW.detail <> OLD.detail
     OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.created_at <> OLD.created_at
     OR (OLD.acknowledged_at IS NOT NULL AND (
          NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
          OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by)) THEN
    RAISE EXCEPTION 'print alerts are append-only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_print_alerts_guard BEFORE UPDATE ON public.edge_print_alerts
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_print_alert_update();
