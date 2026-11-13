-- FKs are declared inline on these empty new tables so a plain migration owner
-- does not validate them with ALTER TABLE against already FORCE-RLS parents.
CREATE TABLE "panic_alert_deliveries" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"first_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_count" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone,
	CONSTRAINT "panic_alert_deliveries_pkey" PRIMARY KEY("tenant_id","alert_id","session_id"),
	CONSTRAINT "panic_alert_deliveries_sent_count_check" CHECK ("panic_alert_deliveries"."sent_count" >= 1),
	CONSTRAINT "panic_alert_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alert_deliveries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alert_deliveries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alert_deliveries_alert_fk" FOREIGN KEY ("tenant_id","alert_id") REFERENCES "public"."panic_alerts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alert_deliveries_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."panic_receiver_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.panic_alert_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.panic_alert_deliveries'::regclass);
