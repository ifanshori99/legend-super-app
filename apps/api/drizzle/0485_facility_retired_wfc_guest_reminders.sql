CREATE TABLE "wfc_guest_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"hours" integer NOT NULL,
	"channel" varchar(10) NOT NULL,
	"destination" text NOT NULL,
	"dedupe_key" varchar(400) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfc_guest_reminders_tenant_dedupe_key" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "wfc_guest_reminders_channel_check" CHECK ("wfc_guest_reminders"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "wfc_guest_reminders_hours_check" CHECK ("wfc_guest_reminders"."hours" >= 1),
	CONSTRAINT "wfc_guest_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_guest_reminders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_guest_reminders_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "wfc_guest_reminders_participant_fk" FOREIGN KEY ("tenant_id","participant_id") REFERENCES "public"."session_participants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "contact_whatsapp" text;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "facility_units" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "wfc_guest_reminders_session_idx" ON "wfc_guest_reminders" USING btree ("tenant_id","table_session_id","hours");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_guest_reminders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_guest_reminders'::regclass);
