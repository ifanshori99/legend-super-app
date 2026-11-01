CREATE TABLE "delivery_attempts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"notification_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"idempotency_key" varchar(255) NOT NULL,
	"cost_idr" bigint DEFAULT 0 NOT NULL,
	"provider_ref" varchar(255),
	"error_code" varchar(64),
	"skip_reason" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "delivery_attempts_channel_key" UNIQUE("tenant_id","notification_id","channel"),
	CONSTRAINT "delivery_attempts_idempotency_key" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"source_event_id" uuid NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notification_outbox_event_key" UNIQUE("tenant_id","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "notification_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"web_push_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"whatsapp" jsonb NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"retry_backoff_seconds" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"categories" jsonb NOT NULL,
	"quiet_hours" jsonb,
	"time_zone" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"category" varchar(80) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"locale" varchar(2) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" varchar(1000) NOT NULL,
	"link" varchar(500),
	"whatsapp_template_name" varchar(512),
	"variables" jsonb NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_templates_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notification_templates_version_key" UNIQUE("tenant_id","category","channel","locale","version")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"user_id" uuid NOT NULL,
	"category" varchar(80) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" varchar(1000) NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_event_id" uuid,
	"dedupe_key" varchar(200) NOT NULL,
	CONSTRAINT "notifications_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notifications_dedupe_key" UNIQUE("tenant_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint_hash" varchar(128) NOT NULL,
	"subscription_ciphertext" text NOT NULL,
	"key_version" varchar(64) NOT NULL,
	"device_label" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE("tenant_id","user_id","endpoint_hash")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_reservations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"delivery_attempt_id" uuid NOT NULL,
	"month" varchar(7) NOT NULL,
	"status" varchar(20) DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_reservations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "whatsapp_reservations_attempt_key" UNIQUE("tenant_id","delivery_attempt_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_tenant_id_notification_id_notifications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_reservations" ADD CONSTRAINT "whatsapp_reservations_tenant_id_delivery_attempt_id_delivery_attempts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","delivery_attempt_id") REFERENCES "public"."delivery_attempts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_due_idx" ON "delivery_attempts" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("tenant_id","status","available_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "whatsapp_reservations_month_idx" ON "whatsapp_reservations" USING btree ("tenant_id","month");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notifications'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_outbox'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.delivery_attempts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_preferences'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.push_subscriptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.whatsapp_reservations'::regclass);
