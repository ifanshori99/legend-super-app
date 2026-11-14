-- legend-40nvj: barcode scanner status reported by KDS devices in their
-- heartbeat. Two nullable columns on devices; NULL = the device never
-- reported a scanner. Heartbeats without a scanner field leave both alone.
-- No backfill, so no NO FORCE ROW LEVEL SECURITY dance.
ALTER TABLE "devices" ADD COLUMN "scanner_status" varchar(20);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "scanner_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_scanner_status_check" CHECK ("devices"."scanner_status" IS NULL OR "devices"."scanner_status" IN ('connected', 'disconnected'));
