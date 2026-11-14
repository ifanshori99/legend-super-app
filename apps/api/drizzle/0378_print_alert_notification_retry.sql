ALTER TABLE "edge_print_alerts" ADD COLUMN "notification_enqueued_at" timestamp with time zone;--> statement-breakpoint
-- Stop the old print worker before applying this migration. Historical alerts
-- used process-local event ids, so their delivery cannot be established safely.
-- Treat them as delivered to avoid duplicate supervisor notices on upgrade;
-- durable recovery applies to alerts recorded by the new worker.
ALTER TABLE public.edge_print_alerts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.edge_print_alerts SET notification_enqueued_at = now();
--> statement-breakpoint
ALTER TABLE public.edge_print_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "edge_print_alerts_pending_notification_idx" ON "edge_print_alerts" USING btree ("tenant_id","outlet_id","occurred_at","id") WHERE "edge_print_alerts"."notification_enqueued_at" IS NULL;
