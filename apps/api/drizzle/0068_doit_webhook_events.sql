CREATE TABLE "gateway_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"integration_id" uuid,
	"provider" varchar(20) NOT NULL,
	"event_id" varchar(200),
	"event_type" varchar(60),
	"signature_valid" boolean NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"payload" jsonb,
	"provider_ref" varchar(100),
	"payment_intent_id" uuid,
	"status" varchar(20) DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_webhook_events_provider_check" CHECK ("gateway_webhook_events"."provider" IN ('doit', 'duitku')),
	CONSTRAINT "gateway_webhook_events_status_check" CHECK ("gateway_webhook_events"."status" IN ('received', 'processed', 'ignored', 'failed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "gateway_integration_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "gateway_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_webhook_events_event_key" ON "gateway_webhook_events" USING btree ("tenant_id","provider","event_id") WHERE "gateway_webhook_events"."signature_valid" AND "gateway_webhook_events"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_webhook_events_rejected_hash_uq" ON "gateway_webhook_events" USING btree ("tenant_id","payload_hash") WHERE NOT "gateway_webhook_events"."signature_valid";--> statement-breakpoint
CREATE INDEX "gateway_webhook_events_status_idx" ON "gateway_webhook_events" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
CREATE INDEX "gateway_webhook_events_provider_ref_idx" ON "gateway_webhook_events" USING btree ("tenant_id","provider","provider_ref");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_gateway_integration_fk" FOREIGN KEY ("gateway_integration_id") REFERENCES "public"."tenant_integrations"("id") ON DELETE no action ON UPDATE no action;