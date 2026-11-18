-- Cloud "edge offline" alert kind (bead legend-5ab0l, docs/design/edge-status-cloud.md D11).
ALTER TABLE "edge_node_alerts" DROP CONSTRAINT "edge_node_alerts_kind_check";--> statement-breakpoint
ALTER TABLE "edge_node_alerts" ADD CONSTRAINT "edge_node_alerts_kind_check" CHECK ("edge_node_alerts"."kind" IN ('device_registry_hard_stale', 'receipt_run_alert', 'edge_offline'));
