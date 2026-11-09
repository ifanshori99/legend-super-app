-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets and approval_requests. Lift FORCE on those two
-- for this transaction only; it is restored right after the last foreign key,
-- before commit (drizzle applies pending migrations in one transaction, so no
-- other session ever sees the lifted state), as in 0068.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_requests NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "action_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"tool_code" varchar(5) NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"source" varchar(3) NOT NULL,
	"mcp_client_id" uuid,
	"payload" jsonb NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"approval_action_type" varchar(20) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"result_ref" varchar(200),
	"failure_reason" varchar(500),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "action_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "action_requests_tenant_approval_key" UNIQUE("tenant_id","approval_request_id"),
	CONSTRAINT "action_requests_tool_check" CHECK ("action_requests"."tool_code" IN ('TL-13', 'TL-14', 'TL-15', 'TL-16', 'TL-17', 'TL-18')),
	CONSTRAINT "action_requests_status_check" CHECK ("action_requests"."status" IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
	CONSTRAINT "action_requests_source_check" CHECK (("action_requests"."source" = 'ai' AND "action_requests"."mcp_client_id" IS NULL AND "action_requests"."approval_action_type" IN ('ai_action', 'stock_adjustment', 'discount', 'price_change'))
        OR ("action_requests"."source" = 'mcp' AND "action_requests"."mcp_client_id" IS NOT NULL AND "action_requests"."approval_action_type" IN ('mcp_action', 'stock_adjustment', 'discount', 'price_change'))),
	CONSTRAINT "action_requests_payload_check" CHECK (jsonb_typeof("action_requests"."payload") = 'object'),
	CONSTRAINT "action_requests_outcome_check" CHECK ((("action_requests"."status" = 'executed') = ("action_requests"."executed_at" IS NOT NULL))
        AND ("action_requests"."result_ref" IS NULL OR "action_requests"."status" = 'executed')
        AND (("action_requests"."status" = 'failed') = ("action_requests"."failure_reason" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"feature" varchar(10) NOT NULL,
	"title" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "ai_conversations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_conversations_feature_check" CHECK ("ai_conversations"."feature" ~ '^AI-(0[1-9]|1[0-4])$'),
	CONSTRAINT "ai_conversations_title_check" CHECK (char_length("ai_conversations"."title") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(10) NOT NULL,
	"content" text NOT NULL,
	"tool_code" varchar(5),
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "ai_messages_role_check" CHECK ("ai_messages"."role" IN ('user', 'assistant', 'tool')),
	CONSTRAINT "ai_messages_content_check" CHECK (char_length("ai_messages"."content") BETWEEN 1 AND 8000),
	CONSTRAINT "ai_messages_tool_code_check" CHECK ("ai_messages"."tool_code" IS NULL OR ("ai_messages"."role" = 'tool' AND "ai_messages"."tool_code" ~ '^TL-(0[1-9]|1[0-9]|20)$')),
	CONSTRAINT "ai_messages_assistant_labelled_check" CHECK ("ai_messages"."role" <> 'assistant' OR "ai_messages"."ai_assisted"),
	CONSTRAINT "ai_messages_sources_check" CHECK (jsonb_typeof("ai_messages"."sources") = 'array' AND jsonb_array_length("ai_messages"."sources") <= 20),
	CONSTRAINT "ai_messages_retention_check" CHECK ("ai_messages"."expires_at" IS NULL OR ("ai_messages"."expires_at" > "ai_messages"."created_at" AND "ai_messages"."expires_at" <= "ai_messages"."created_at" + interval '7 days'))
);
--> statement-breakpoint
CREATE TABLE "ai_response_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cache_key" varchar(128) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_response_cache_tenant_key" UNIQUE("tenant_id","cache_key"),
	CONSTRAINT "ai_response_cache_ttl_check" CHECK ("ai_response_cache"."expires_at" > "ai_response_cache"."created_at" AND "ai_response_cache"."expires_at" <= "ai_response_cache"."created_at" + interval '7 days')
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"mcp_enabled" boolean DEFAULT false NOT NULL,
	"dynamic_client_registration_enabled" boolean DEFAULT false NOT NULL,
	"monthly_budget_idr" bigint DEFAULT 0 NOT NULL,
	"budget_warn_pct" integer DEFAULT 80 NOT NULL,
	"budget_stop_pct" integer DEFAULT 100 NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_tool_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"mcp_rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"max_rows_per_response" integer DEFAULT 200 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "ai_settings_budget_check" CHECK ("ai_settings"."monthly_budget_idr" >= 0),
	CONSTRAINT "ai_settings_pct_check" CHECK ("ai_settings"."budget_warn_pct" BETWEEN 1 AND 100 AND "ai_settings"."budget_stop_pct" BETWEEN 1 AND 100 AND "ai_settings"."budget_warn_pct" < "ai_settings"."budget_stop_pct"),
	CONSTRAINT "ai_settings_features_check" CHECK (jsonb_typeof("ai_settings"."features") = 'array'),
	CONSTRAINT "ai_settings_mcp_rate_check" CHECK ("ai_settings"."mcp_rate_limit_per_minute" BETWEEN 1 AND 600),
	CONSTRAINT "ai_settings_max_rows_check" CHECK ("ai_settings"."max_rows_per_response" BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"tool_code" varchar(5) NOT NULL,
	"channel" varchar(3) NOT NULL,
	"user_id" text NOT NULL,
	"mcp_client_id" uuid,
	"conversation_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(10) NOT NULL,
	"row_count" integer,
	"duration_ms" integer,
	"error_code" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_calls_tool_check" CHECK ("ai_tool_calls"."tool_code" ~ '^TL-(0[1-9]|1[0-9]|20)$'),
	CONSTRAINT "ai_tool_calls_channel_check" CHECK ("ai_tool_calls"."channel" IN ('app', 'mcp')),
	CONSTRAINT "ai_tool_calls_status_check" CHECK ("ai_tool_calls"."status" IN ('ok', 'denied', 'error')),
	CONSTRAINT "ai_tool_calls_amounts_check" CHECK (("ai_tool_calls"."row_count" IS NULL OR "ai_tool_calls"."row_count" >= 0) AND ("ai_tool_calls"."duration_ms" IS NULL OR "ai_tool_calls"."duration_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_daily_tenant_user_date_key" UNIQUE("tenant_id","user_id","usage_date"),
	CONSTRAINT "ai_usage_daily_count_check" CHECK ("ai_usage_daily"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"outlet_id" uuid,
	"feature" varchar(10),
	"channel" varchar(10) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"model" varchar(100) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"cost_idr" bigint DEFAULT 0 NOT NULL,
	"status" varchar(10) NOT NULL,
	"error_code" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_events_channel_check" CHECK ("ai_usage_events"."channel" IN ('tanya_ai', 'mcp', 'job')),
	CONSTRAINT "ai_usage_events_status_check" CHECK ("ai_usage_events"."status" IN ('ok', 'blocked', 'error')),
	CONSTRAINT "ai_usage_events_amounts_check" CHECK ("ai_usage_events"."input_tokens" >= 0 AND "ai_usage_events"."output_tokens" >= 0 AND "ai_usage_events"."cost_micro_usd" >= 0 AND "ai_usage_events"."cost_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usage_month" varchar(7) NOT NULL,
	"cost_idr" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"warned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_monthly_tenant_month_key" UNIQUE("tenant_id","usage_month"),
	CONSTRAINT "ai_usage_monthly_month_check" CHECK ("ai_usage_monthly"."usage_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ai_usage_monthly_amounts_check" CHECK ("ai_usage_monthly"."cost_idr" >= 0 AND "ai_usage_monthly"."cost_micro_usd" >= 0 AND "ai_usage_monthly"."input_tokens" >= 0 AND "ai_usage_monthly"."output_tokens" >= 0 AND "ai_usage_monthly"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"code_challenge_method" varchar(10) DEFAULT 'S256' NOT NULL,
	"redirect_uri" varchar(2000) NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "mcp_auth_codes_hash_check" CHECK ("mcp_auth_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mcp_auth_codes_method_check" CHECK ("mcp_auth_codes"."code_challenge_method" = 'S256'),
	CONSTRAINT "mcp_auth_codes_scopes_check" CHECK (cardinality("mcp_auth_codes"."scopes") BETWEEN 1 AND 30),
	CONSTRAINT "mcp_auth_codes_ttl_check" CHECK ("mcp_auth_codes"."expires_at" > "mcp_auth_codes"."created_at" AND "mcp_auth_codes"."expires_at" <= "mcp_auth_codes"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "mcp_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"client_id" varchar(100) NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"registered_via" varchar(10) NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_clients_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mcp_clients_tenant_client_id_key" UNIQUE("tenant_id","client_id"),
	CONSTRAINT "mcp_clients_status_check" CHECK ("mcp_clients"."status" IN ('pending', 'approved', 'revoked')),
	CONSTRAINT "mcp_clients_registered_via_check" CHECK ("mcp_clients"."registered_via" IN ('admin', 'dynamic')),
	CONSTRAINT "mcp_clients_arrays_check" CHECK (cardinality("mcp_clients"."redirect_uris") BETWEEN 1 AND 10 AND cardinality("mcp_clients"."allowed_scopes") BETWEEN 1 AND 30),
	CONSTRAINT "mcp_clients_approval_check" CHECK ((("mcp_clients"."approved_by" IS NULL) = ("mcp_clients"."approved_at" IS NULL))
        AND ("mcp_clients"."status" <> 'approved' OR "mcp_clients"."approved_by" IS NOT NULL)
        AND ("mcp_clients"."status" <> 'pending' OR "mcp_clients"."approved_by" IS NULL)
        AND (("mcp_clients"."status" = 'revoked') = ("mcp_clients"."revoked_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(500),
	"last_used_at" timestamp with time zone,
	CONSTRAINT "mcp_tokens_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mcp_tokens_hash_check" CHECK ("mcp_tokens"."token_hash" ~ '^[0-9a-f]{64}$' AND "mcp_tokens"."token_prefix" ~ '^mcp_[A-Za-z0-9]{8}$'),
	CONSTRAINT "mcp_tokens_scopes_check" CHECK (cardinality("mcp_tokens"."scopes") BETWEEN 1 AND 30),
	CONSTRAINT "mcp_tokens_ttl_check" CHECK ("mcp_tokens"."expires_at" > "mcp_tokens"."created_at" AND "mcp_tokens"."expires_at" <= "mcp_tokens"."created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_mcp_client_fk" FOREIGN KEY ("tenant_id","mcp_client_id") REFERENCES "public"."mcp_clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_approval_fk" FOREIGN KEY ("tenant_id","approval_request_id") REFERENCES "public"."approval_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."ai_conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_cache" ADD CONSTRAINT "ai_response_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_mcp_client_fk" FOREIGN KEY ("tenant_id","mcp_client_id") REFERENCES "public"."mcp_clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_client_fk" FOREIGN KEY ("tenant_id","mcp_client_id") REFERENCES "public"."mcp_clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_client_fk" FOREIGN KEY ("tenant_id","mcp_client_id") REFERENCES "public"."mcp_clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.approval_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "action_requests_tenant_status_idx" ON "action_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "action_requests_tenant_requester_idx" ON "action_requests" USING btree ("tenant_id","requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_conversations_owner_idx" ON "ai_conversations" USING btree ("tenant_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_conversations_expires_idx" ON "ai_conversations" USING btree ("expires_at") WHERE "ai_conversations"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_response_cache_expires_idx" ON "ai_response_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_tenant_created_idx" ON "ai_tool_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_tenant_user_idx" ON "ai_tool_calls" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_tenant_created_idx" ON "ai_usage_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_tenant_user_idx" ON "ai_usage_events" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_auth_codes_code_hash_key" ON "mcp_auth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_expires_idx" ON "mcp_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_clients_tenant_status_idx" ON "mcp_clients" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_token_hash_key" ON "mcp_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_tenant_client_idx" ON "mcp_tokens" USING btree ("tenant_id","mcp_client_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_tenant_user_idx" ON "mcp_tokens" USING btree ("tenant_id","user_id");