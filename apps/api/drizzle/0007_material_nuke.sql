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
SELECT app.enforce_tenant_rls('public.notification_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_preferences'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.push_subscriptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_templates'::regclass);
