CREATE TABLE "ai_chatgpt_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'disconnected' NOT NULL,
	"model" varchar(200),
	"generation" integer DEFAULT 0 NOT NULL,
	"attempt_id" uuid,
	"pending_encrypted" text,
	"tokens_encrypted" text,
	"expires_at" timestamp with time zone,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"next_start_at" timestamp with time zone,
	"operation_id" uuid,
	"operation_lease_until" timestamp with time zone,
	"risk_accepted_by" text,
	"risk_accepted_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chatgpt_connections_status_check" CHECK ("ai_chatgpt_connections"."status" IN ('disconnected','pending','connected','unavailable')),
	CONSTRAINT "ai_chatgpt_connections_consent_check" CHECK (NOT "ai_chatgpt_connections"."enabled" OR ("ai_chatgpt_connections"."risk_accepted_by" IS NOT NULL AND "ai_chatgpt_connections"."risk_accepted_at" IS NOT NULL AND "ai_chatgpt_connections"."model" IS NOT NULL)),
	CONSTRAINT "ai_chatgpt_connections_tokens_check" CHECK ("ai_chatgpt_connections"."status" <> 'connected' OR ("ai_chatgpt_connections"."enabled" AND "ai_chatgpt_connections"."tokens_encrypted" IS NOT NULL)),
	CONSTRAINT "ai_chatgpt_connections_generation_check" CHECK ("ai_chatgpt_connections"."generation" >= 0),
	CONSTRAINT "ai_chatgpt_connections_interval_check" CHECK ("ai_chatgpt_connections"."interval_seconds" BETWEEN 5 AND 60),
	CONSTRAINT "ai_chatgpt_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "billing_mode" varchar(20) DEFAULT 'api_metered' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_chatgpt_connections_tenant_key" ON "ai_chatgpt_connections" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_billing_mode_check" CHECK ("ai_usage_events"."billing_mode" IN ('api_metered', 'chatgpt_plan'));
--> statement-breakpoint
-- New empty tenant-level table: no anonymous lookups or outlet exceptions.
SELECT app.enforce_tenant_rls('public.ai_chatgpt_connections'::regclass);
