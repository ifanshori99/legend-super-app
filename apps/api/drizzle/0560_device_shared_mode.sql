-- legend-f586w: per-device shared-device mode. A flagged device needs an
-- acting-staff token on POS, floor and KDS requests; unflagged devices keep the
-- old behaviour. Constant default, so existing rows read false without a
-- backfill (no NO FORCE ROW LEVEL SECURITY dance).
ALTER TABLE "devices" ADD COLUMN "shared_mode" boolean DEFAULT false NOT NULL;
