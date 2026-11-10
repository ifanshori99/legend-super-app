-- legend-r11j7: counter revision of a staff pin. The edge merges a cloud
-- counter only where it moved past its stored baseline, by value
-- (legend-7vv8h). A counter that went 3 -> 0 -> 3 between two pulls has the
-- same value, so the edge dropped it as a replay. attempt_revision counts every
-- change of the counter or the hash material; the cloud exports it
-- and the edge keeps the last one it applied (cloud_attempt_revision), so such
-- a move is seen although the value is the same. Null baseline on the edge:
-- the edge falls back to the value comparison once, then stores the revision.
-- A lock-only change (the cloud extending a lock with GREATEST while the
-- counter stays at its maximum) does not bump it: the edge merges the lock by
-- value, and a bump there would re-raise a counter the edge already cleared
-- with a correct PIN (review K). The trigger bumps it, so no application
-- code can forget it or set it.
ALTER TABLE "staff_pins" ADD COLUMN "attempt_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "cloud_attempt_revision" bigint;--> statement-breakpoint
CREATE FUNCTION app.bump_staff_pin_attempt_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.failed_attempts IS DISTINCT FROM OLD.failed_attempts
     OR NEW.pin_hash IS DISTINCT FROM OLD.pin_hash
     OR NEW.pin_salt IS DISTINCT FROM OLD.pin_salt THEN
    NEW.attempt_revision := OLD.attempt_revision + 1;
  ELSE
    NEW.attempt_revision := OLD.attempt_revision;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER staff_pins_attempt_revision BEFORE UPDATE ON public.staff_pins
  FOR EACH ROW EXECUTE FUNCTION app.bump_staff_pin_attempt_revision();
