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
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_tenant_id_notification_id_notifications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_due_idx" ON "delivery_attempts" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("tenant_id","status","available_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at","id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notifications'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.notification_outbox'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.delivery_attempts'::regclass);
