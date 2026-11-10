ALTER TABLE "edge_pull_checkpoints" DROP CONSTRAINT "edge_pull_checkpoints_stream_check";--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "cloud_failed_attempts" integer;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "cloud_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "generation_edge_node_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "generation_edge_sequence" bigint;--> statement-breakpoint
ALTER TABLE "edge_pull_checkpoints" ADD CONSTRAINT "edge_pull_checkpoints_stream_check" CHECK ("edge_pull_checkpoints"."stream" IN ('device_registry', 'staff_pins'));