ALTER TABLE "ai_usage_monthly" ADD COLUMN "reserved_cost_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD COLUMN "detected_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD COLUMN "capability_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_reserved_cost_check" CHECK ("ai_usage_monthly"."reserved_cost_idr" >= 0);