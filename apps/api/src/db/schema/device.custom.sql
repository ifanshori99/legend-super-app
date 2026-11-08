-- Device registry (bead legend-165; PRD v1.7 §3 F5 Registri Perangkat, Mode
-- Latihan, EDG-03). Fold into the generated migration after the CREATE TABLE
-- statements. CHECK constraints live in the drizzle schema (device.ts); this
-- file holds RLS and the invariants drizzle cannot express. Same migration on
-- the cloud and on every edge node.

-- TEN-01/TEN-03: both tables are tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.device_training_periods'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.device_training_periods'::regclass);
--> statement-breakpoint

-- Revocation is terminal (EDG-03): a revoked device never becomes active again,
-- its revocation record and token floor are frozen, and its identity (tenant,
-- outlet, id, type) never changes. A replacement device is a new enrollment.
CREATE FUNCTION app.guard_device_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'device identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked'
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
     OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at) THEN
    RAISE EXCEPTION 'a revoked device cannot be reactivated (EDG-03)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER devices_guard BEFORE UPDATE ON public.devices
FOR EACH ROW EXECUTE FUNCTION app.guard_device_update();
