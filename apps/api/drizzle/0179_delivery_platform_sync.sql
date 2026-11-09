ALTER TABLE "delivery_channel_orders" ADD COLUMN "platform_sync_state" varchar(12) DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD COLUMN "platform_sync_action" varchar(16);--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD COLUMN "platform_sync_status" varchar(12);--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD COLUMN "platform_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD COLUMN "platform_sync_next_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "delivery_channel_orders_platform_retry_idx" ON "delivery_channel_orders" USING btree ("tenant_id","platform_sync_next_at") WHERE "delivery_channel_orders"."platform_sync_state" = 'retrying';--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD CONSTRAINT "delivery_channel_orders_platform_sync_check" CHECK ("delivery_channel_orders"."platform_sync_state" IN ('ok', 'retrying', 'needs_action')
        AND "delivery_channel_orders"."platform_sync_attempts" >= 0
        AND ("delivery_channel_orders"."platform_sync_action" IS NULL OR "delivery_channel_orders"."platform_sync_action" IN ('accept_order', 'update_order', 'cancel_order'))
        AND ("delivery_channel_orders"."platform_sync_state" <> 'retrying' OR ("delivery_channel_orders"."platform_sync_action" IS NOT NULL AND "delivery_channel_orders"."platform_sync_status" IS NOT NULL AND "delivery_channel_orders"."platform_sync_next_at" IS NOT NULL)));