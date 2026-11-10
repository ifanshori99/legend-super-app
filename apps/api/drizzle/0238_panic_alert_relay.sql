CREATE TABLE "panic_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" varchar(100) NOT NULL,
	"unit_id" uuid,
	"facility_incident_id" uuid,
	"triggered_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp with time zone,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"offline" boolean DEFAULT false NOT NULL,
	CONSTRAINT "panic_alerts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "panic_alerts_device_event_key" UNIQUE("tenant_id","device_id","event_id"),
	CONSTRAINT "panic_alerts_recipient_count_check" CHECK ("panic_alerts"."recipient_count" >= 0),
	CONSTRAINT "panic_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alerts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alerts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "panic_alerts_outlet_received_idx" ON "panic_alerts" USING btree ("tenant_id","outlet_id","received_at" DESC NULLS LAST);--> statement-breakpoint
-- legend-bod: FKs are inline above (new table, so no ALTER ... ADD CONSTRAINT
-- and no NO FORCE lift on outlets/tenants). Runs as the non-superuser migrator.
-- TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.panic_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.panic_alerts'::regclass);
