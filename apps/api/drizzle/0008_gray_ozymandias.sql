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
ALTER TABLE "whatsapp_reservations" ADD CONSTRAINT "whatsapp_reservations_tenant_id_delivery_attempt_id_delivery_attempts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","delivery_attempt_id") REFERENCES "public"."delivery_attempts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_reservations_month_idx" ON "whatsapp_reservations" USING btree ("tenant_id","month");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.whatsapp_reservations'::regclass);
