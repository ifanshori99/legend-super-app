CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"brand_id" uuid,
	"channel" varchar(20) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"browser_binding_hash" varchar(64) NOT NULL,
	"receiving_number" varchar(32),
	"matched_user_id" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"session_id" text,
	"session_issued_at" timestamp with time zone,
	"ip_hash" varchar(64),
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_challenges_channel_check" CHECK ("login_challenges"."channel" IN ('whatsapp_inbound', 'email_magic_link', 'google')),
	CONSTRAINT "login_challenges_status_check" CHECK ("login_challenges"."status" IN ('pending', 'completed', 'expired', 'cancelled')),
	CONSTRAINT "login_challenges_brand_needs_tenant_check" CHECK ("login_challenges"."brand_id" IS NULL OR "login_challenges"."tenant_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(20) NOT NULL,
	"value_hash" varchar(64) NOT NULL,
	"value_encrypted" text,
	"provider_subject" varchar(255),
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_type_value_key" UNIQUE("type","value_hash"),
	CONSTRAINT "user_identities_type_check" CHECK ("user_identities"."type" IN ('whatsapp', 'email', 'google')),
	CONSTRAINT "user_identities_value_hash_check" CHECK ("user_identities"."value_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "wa_inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" varchar(255) NOT NULL,
	"tenant_id" uuid,
	"receiving_number" varchar(32) NOT NULL,
	"from_hash" varchar(64) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"challenge_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_inbound_messages_provider_id_key" UNIQUE("provider_message_id"),
	CONSTRAINT "wa_inbound_messages_kind_check" CHECK ("wa_inbound_messages"."kind" IN ('login', 'unknown', 'rejected', 'rate_limited')),
	CONSTRAINT "wa_inbound_messages_from_hash_check" CHECK ("wa_inbound_messages"."from_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_challenge_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."login_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_challenges_code_idx" ON "login_challenges" USING btree ("channel","code_hash");--> statement-breakpoint
CREATE INDEX "login_challenges_binding_idx" ON "login_challenges" USING btree ("browser_binding_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_ip_idx" ON "login_challenges" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_tenant_status_idx" ON "login_challenges" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_from_idx" ON "wa_inbound_messages" USING btree ("from_hash","processed_at");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_tenant_idx" ON "wa_inbound_messages" USING btree ("tenant_id","processed_at");--> statement-breakpoint
-- Identity login tables are GLOBAL in PRD v1.7 §6 B, so they get explicit
-- least-privilege grants instead of app.enforce_tenant_rls (the tenant arrives
-- from the receiving WhatsApp number, inside the services; docs/plan/contracts.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_identities TO legend_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.login_challenges TO legend_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wa_inbound_messages TO legend_app;