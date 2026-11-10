CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_type" varchar(20) DEFAULT 'api_key' NOT NULL,
	"base_url" varchar(500) NOT NULL,
	"default_model" varchar(200) NOT NULL,
	"api_key_encrypted" text,
	"api_key_key_version" smallint,
	"api_key_last4" varchar(4),
	"api_key_set_at" timestamp with time zone,
	"api_key_set_by" text,
	"last_test_status" varchar(10),
	"last_tested_at" timestamp with time zone,
	"last_test_error_code" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_configs_connection_type_check" CHECK ("ai_provider_configs"."connection_type" IN ('api_key', 'chatgpt_oauth')),
	CONSTRAINT "ai_provider_configs_test_status_check" CHECK ("ai_provider_configs"."last_test_status" IS NULL OR "ai_provider_configs"."last_test_status" IN ('ok', 'failed')),
	CONSTRAINT "ai_provider_configs_key_check" CHECK ("ai_provider_configs"."connection_type" <> 'api_key' OR ("ai_provider_configs"."api_key_encrypted" IS NOT NULL AND "ai_provider_configs"."api_key_key_version" IS NOT NULL AND "ai_provider_configs"."api_key_last4" IS NOT NULL)),
	CONSTRAINT "ai_provider_configs_test_check" CHECK ("ai_provider_configs"."last_test_status" IS NULL OR "ai_provider_configs"."last_tested_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_configs_tenant_key" ON "ai_provider_configs" USING btree ("tenant_id");
--> statement-breakpoint
-- Custom SQL migration fragment for legend-dwrr (ai_provider_configs).
-- Append AFTER the drizzle-generated CREATE TABLE statement.
--
-- Tenant RLS (TEN-01). ai_provider_configs is tenant-level (no outlet_id), so
-- there is no outlet RLS. No SECURITY DEFINER: every reader has a tenant from
-- withTenant.
SELECT app.enforce_tenant_rls('public.ai_provider_configs'::regclass);
