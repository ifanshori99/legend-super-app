CREATE TABLE "wifi_device_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"wifi_session_id" uuid NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"controller_device_id" varchar(64),
	"speed_tier" varchar(8) NOT NULL,
	"bandwidth_kbps" integer NOT NULL,
	"base_bandwidth_kbps" integer NOT NULL,
	"duration_seconds" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"renew_until" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoke_requested_at" timestamp with time zone,
	"end_reason" varchar(32),
	"ended_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wifi_device_grants_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wifi_device_grants_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "wifi_device_grants_device_hash_check" CHECK ("wifi_device_grants"."device_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wifi_device_grants_speed_tier_check" CHECK ("wifi_device_grants"."speed_tier" IN ('full','base')),
	CONSTRAINT "wifi_device_grants_bandwidth_check" CHECK ("wifi_device_grants"."bandwidth_kbps" BETWEEN 1 AND 1000000),
	CONSTRAINT "wifi_device_grants_base_bandwidth_check" CHECK ("wifi_device_grants"."base_bandwidth_kbps" BETWEEN 1 AND 1000000 AND "wifi_device_grants"."base_bandwidth_kbps" <= "wifi_device_grants"."bandwidth_kbps"),
	CONSTRAINT "wifi_device_grants_duration_check" CHECK ("wifi_device_grants"."duration_seconds" BETWEEN 1 AND 129600),
	CONSTRAINT "wifi_device_grants_status_check" CHECK ("wifi_device_grants"."status" IN ('pending','active','unknown','superseded','revoked','failed')),
	CONSTRAINT "wifi_device_grants_attempt_count_check" CHECK ("wifi_device_grants"."attempt_count" >= 0),
	CONSTRAINT "wifi_device_grants_scrub_check" CHECK (("wifi_device_grants"."controller_device_id" IS NOT NULL) = ("wifi_device_grants"."status" IN ('pending','active','unknown'))),
	CONSTRAINT "wifi_device_grants_active_check" CHECK ("wifi_device_grants"."status" <> 'active' OR ("wifi_device_grants"."authorized_at" IS NOT NULL AND "wifi_device_grants"."expires_at" IS NOT NULL)),
	CONSTRAINT "wifi_device_grants_ended_check" CHECK (("wifi_device_grants"."ended_at" IS NOT NULL) = ("wifi_device_grants"."status" IN ('superseded','revoked','failed'))),
	CONSTRAINT "wifi_device_grants_end_reason_check" CHECK ("wifi_device_grants"."end_reason" IS NULL OR "wifi_device_grants"."end_reason" IN ('session_ended','staff_revoked','device_moved','day_closed')),
	CONSTRAINT "wifi_device_grants_revoke_request_check" CHECK (("wifi_device_grants"."revoke_requested_at" IS NULL) = ("wifi_device_grants"."end_reason" IS NULL) AND ("wifi_device_grants"."status" <> 'revoked' OR "wifi_device_grants"."revoke_requested_at" IS NOT NULL)),
	CONSTRAINT "wifi_device_grants_superseded_check" CHECK (("wifi_device_grants"."superseded_by" IS NOT NULL) = ("wifi_device_grants"."status" = 'superseded') AND "wifi_device_grants"."superseded_by" IS DISTINCT FROM "wifi_device_grants"."id")
);
--> statement-breakpoint
ALTER TABLE "wifi_device_grants" ADD CONSTRAINT "wifi_device_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_device_grants" ADD CONSTRAINT "wifi_device_grants_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_device_grants" ADD CONSTRAINT "wifi_device_grants_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wifi_device_grants" ADD CONSTRAINT "wifi_device_grants_superseded_by_fk" FOREIGN KEY ("tenant_id","outlet_id","superseded_by") REFERENCES "public"."wifi_device_grants"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wifi_device_grants_one_active" ON "wifi_device_grants" USING btree ("tenant_id","outlet_id","device_hash") WHERE "wifi_device_grants"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "wifi_device_grants_one_inflight" ON "wifi_device_grants" USING btree ("tenant_id","outlet_id","device_hash") WHERE "wifi_device_grants"."status" IN ('pending','unknown');--> statement-breakpoint
CREATE INDEX "wifi_device_grants_session_idx" ON "wifi_device_grants" USING btree ("tenant_id","outlet_id","wifi_session_id");--> statement-breakpoint
CREATE INDEX "wifi_device_grants_loop_idx" ON "wifi_device_grants" USING btree ("tenant_id","outlet_id","status","expires_at");