ALTER TABLE "wifi_device_grants" ADD COLUMN "revoke_retry_at" timestamp with time zone;--> statement-breakpoint
-- legend-1mbi: a terminal row (superseded, revoked, failed) is frozen except
-- revoke_retry_at, the pending controller revoke of its reference. ended_at,
-- end_reason, superseded_by, controller_device_id (stays NULL), authorized_at,
-- expires_at and every other column keep their terminal values. Request
-- columns stay immutable on every row. RLS and the DELETE grant are unchanged:
-- enforce_tenant_rls (0100) granted SELECT, INSERT, UPDATE, DELETE to
-- legend_app, and the tenant + outlet policies are FOR ALL, so retention
-- (legend-y2dg) deletes only inside the caller's tenant and outlet scope.
CREATE OR REPLACE FUNCTION app.guard_wifi_device_grant_update() RETURNS trigger
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
  IF OLD.status IN ('superseded', 'revoked', 'failed') THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'a terminal wifi grant status is final' USING ERRCODE = '42501';
    END IF;
    -- Whole-row compare: a column added later is frozen by default.
    IF to_jsonb(NEW) - 'revoke_retry_at' IS DISTINCT FROM to_jsonb(OLD) - 'revoke_retry_at' THEN
      RAISE EXCEPTION 'a terminal wifi grant is frozen except revoke_retry_at' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
