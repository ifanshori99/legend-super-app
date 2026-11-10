CREATE TABLE "wifi_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"business_date" date NOT NULL,
	"quota_minutes" integer NOT NULL,
	"used_minutes" integer DEFAULT 0 NOT NULL,
	"speed_tier" varchar(8) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"accrued_at" timestamp with time zone NOT NULL,
	"quota_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wifi_sessions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wifi_sessions_device_hash_check" CHECK ("wifi_sessions"."device_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wifi_sessions_speed_tier_check" CHECK ("wifi_sessions"."speed_tier" IN ('full','base')),
	CONSTRAINT "wifi_sessions_minutes_check" CHECK ("wifi_sessions"."quota_minutes" BETWEEN 0 AND 1440 AND "wifi_sessions"."used_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "wifi_spend_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" varchar(8) NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wifi_spend_entries_source_key" UNIQUE("tenant_id","kind","source_id"),
	CONSTRAINT "wifi_spend_entries_kind_check" CHECK ("wifi_spend_entries"."kind" IN ('paid','refund')),
	CONSTRAINT "wifi_spend_entries_amount_check" CHECK ("wifi_spend_entries"."amount_idr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wifi_policies" ADD COLUMN "spend_mode" varchar(20);--> statement-breakpoint
-- Lift FORCE RLS on the existing tables the FK validation scans (as the
-- migrator), restored after the last FK (docs/plan/contracts.md pattern 2).
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.wifi_policies NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wifi_sessions" ADD CONSTRAINT "wifi_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_sessions" ADD CONSTRAINT "wifi_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_sessions" ADD CONSTRAINT "wifi_sessions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_sessions" ADD CONSTRAINT "wifi_sessions_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."wifi_policies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_spend_entries" ADD CONSTRAINT "wifi_spend_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_spend_entries" ADD CONSTRAINT "wifi_spend_entries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_spend_entries" ADD CONSTRAINT "wifi_spend_entries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.wifi_policies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "wifi_sessions_open_device_key" ON "wifi_sessions" USING btree ("tenant_id","customer_profile_id","device_hash") WHERE "wifi_sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wifi_sessions_account_day_idx" ON "wifi_sessions" USING btree ("tenant_id","customer_profile_id","business_date");--> statement-breakpoint
CREATE INDEX "wifi_sessions_outlet_open_idx" ON "wifi_sessions" USING btree ("tenant_id","outlet_id","ended_at");--> statement-breakpoint
CREATE INDEX "wifi_spend_entries_account_day_idx" ON "wifi_spend_entries" USING btree ("tenant_id","customer_profile_id","business_date");--> statement-breakpoint
CREATE INDEX "wifi_spend_entries_order_idx" ON "wifi_spend_entries" USING btree ("tenant_id","order_id");--> statement-breakpoint
ALTER TABLE "wifi_policies" ADD CONSTRAINT "wifi_policies_spend_mode_check" CHECK ("wifi_policies"."spend_mode" IS NULL OR "wifi_policies"."spend_mode" IN ('per_day_multiple','per_order'));--> statement-breakpoint
-- Custom SQL migration file, put your code below! ---
-- legend-kmd3: hand SQL of migration 0216 (tables in wifi-quota.ts). Keep this file and the migration in step.

-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.wifi_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wifi_spend_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_spend_entries'::regclass);
