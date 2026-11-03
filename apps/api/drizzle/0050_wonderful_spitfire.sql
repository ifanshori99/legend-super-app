CREATE TABLE "usage_costs_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cost_date" date NOT NULL,
	"component" varchar(20) NOT NULL,
	"units" bigint DEFAULT 0 NOT NULL,
	"cost_idr" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_costs_daily_tenant_date_component_key" UNIQUE("tenant_id","cost_date","component"),
	CONSTRAINT "usage_costs_daily_component_check" CHECK ("usage_costs_daily"."component" IN ('ai', 'whatsapp', 'email', 'gateway', 'server')),
	CONSTRAINT "usage_costs_daily_units_check" CHECK ("usage_costs_daily"."units" >= 0),
	CONSTRAINT "usage_costs_daily_cost_check" CHECK ("usage_costs_daily"."cost_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "text_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"locale" varchar(5) NOT NULL,
	"key" varchar(120) NOT NULL,
	"value" varchar(500) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "text_overrides_tenant_locale_key_key" UNIQUE("tenant_id","locale","key"),
	CONSTRAINT "text_overrides_locale_check" CHECK ("text_overrides"."locale" IN ('id', 'en')),
	CONSTRAINT "text_overrides_version_check" CHECK ("text_overrides"."version" > 0),
	CONSTRAINT "text_overrides_value_check" CHECK (length(btrim("text_overrides"."value")) > 0)
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"policy_version" varchar(20) NOT NULL,
	"decision" varchar(20) NOT NULL,
	"source" varchar(20) NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "consents_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	CONSTRAINT "consents_purpose_check" CHECK ("consents"."purpose" IN ('loyalty', 'marketing', 'ai')),
	CONSTRAINT "consents_decision_check" CHECK ("consents"."decision" IN ('granted', 'withdrawn')),
	CONSTRAINT "consents_source_check" CHECK ("consents"."source" IN ('member_pwa', 'website', 'cashier', 'import'))
);
--> statement-breakpoint
ALTER TABLE "tenant_integrations" ADD COLUMN "credentials_key_version" smallint;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "expiry_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_costs_daily" ADD CONSTRAINT "usage_costs_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_overrides" ADD CONSTRAINT "text_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_subject_purpose_idx" ON "consents" USING btree ("tenant_id","subject_id","purpose","seq");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_reservations" ADD CONSTRAINT "whatsapp_reservations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_one_open_key" ON "support_access_grants" USING btree ("tenant_id","super_admin_user_id") WHERE "support_access_grants"."ended_at" IS NULL AND "support_access_grants"."expiry_recorded_at" IS NULL;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_write_duration_check" CHECK ("support_access_grants"."access_mode" = 'read_only' OR "support_access_grants"."duration_minutes" <= 30);--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_expiry_recorded_check" CHECK ("support_access_grants"."expiry_recorded_at" IS NULL OR ("support_access_grants"."ended_at" IS NULL AND "support_access_grants"."expiry_recorded_at" >= "support_access_grants"."expires_at"));