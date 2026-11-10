CREATE TABLE "wifi_quota_apply_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"wifi_session_id" uuid NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"event" jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" varchar(100),
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wifi_quota_apply_queue_event_key" UNIQUE("tenant_id","event_id"),
	CONSTRAINT "wifi_quota_apply_queue_status_check" CHECK ("wifi_quota_apply_queue"."status" IN ('pending','applied','skipped','superseded','refused','failed')),
	CONSTRAINT "wifi_quota_apply_queue_attempts_check" CHECK ("wifi_quota_apply_queue"."attempts" >= 0),
	CONSTRAINT "wifi_quota_apply_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wifi_quota_apply_queue_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wifi_quota_apply_queue_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "wifi_quota_apply_queue_due_idx" ON "wifi_quota_apply_queue" USING btree ("tenant_id","outlet_id","next_attempt_at") WHERE "wifi_quota_apply_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "wifi_quota_apply_queue_session_idx" ON "wifi_quota_apply_queue" USING btree ("tenant_id","outlet_id","wifi_session_id","aggregate_sequence");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wifi_quota_apply_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wifi_quota_apply_queue'::regclass);
