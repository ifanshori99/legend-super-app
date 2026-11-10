-- Edge Wi-Fi agent grant ledger (bead legend-hsk; PRD v1.7 §3 F5 + F25,
-- FAC-11, FAC-13). RLS and the update guard for wifi_device_grants
-- (edge-wifi.ts). CHECK, unique and partial unique constraints live in the
-- drizzle schema; this file holds what drizzle cannot express. Runs after the
-- generated CREATE TABLE (0103_broad_revanche). Same migration on the cloud and
-- on every edge node.

-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.wifi_device_grants'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_device_grants'::regclass);
--> statement-breakpoint

-- A grant's id is the provider reference, and a reference's request is fixed
-- at the controller: the request columns never change. A terminal status
-- (superseded, revoked, failed) is final; a new speed or a new session is a
-- new grant.
CREATE FUNCTION app.guard_wifi_device_grant_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.outlet_id IS DISTINCT FROM OLD.outlet_id
     OR NEW.wifi_session_id IS DISTINCT FROM OLD.wifi_session_id
     OR NEW.device_hash IS DISTINCT FROM OLD.device_hash
     OR NEW.speed_tier IS DISTINCT FROM OLD.speed_tier
     OR NEW.bandwidth_kbps IS DISTINCT FROM OLD.bandwidth_kbps
     OR NEW.base_bandwidth_kbps IS DISTINCT FROM OLD.base_bandwidth_kbps
     OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
     OR NEW.renew_until IS DISTINCT FROM OLD.renew_until
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'wifi grant request is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('superseded', 'revoked', 'failed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a terminal wifi grant status is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wifi_device_grants_guard BEFORE UPDATE ON public.wifi_device_grants
FOR EACH ROW EXECUTE FUNCTION app.guard_wifi_device_grant_update();
