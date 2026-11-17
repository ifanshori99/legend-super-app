-- legend-ypwsp: the shared-mode device a session was last seen on. Stamped by
-- the server only. Nullable, no FK: a revoked or deleted device lets the mark
-- lapse in the acting-staff guard.
ALTER TABLE "session" ADD COLUMN "shared_device_id" uuid;
