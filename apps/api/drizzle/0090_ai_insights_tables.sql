CREATE TABLE "ai_anomaly_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" varchar(20) NOT NULL,
	"observed_idr" bigint NOT NULL,
	"baseline_idr" bigint NOT NULL,
	"ratio" numeric(8, 2) NOT NULL,
	"severity" varchar(10) NOT NULL,
	"status" varchar(15) DEFAULT 'open' NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_anomaly_alerts_tenant_outlet_date_kind_key" UNIQUE("tenant_id","outlet_id","business_date","kind"),
	CONSTRAINT "ai_anomaly_alerts_kind_check" CHECK ("ai_anomaly_alerts"."kind" IN ('void', 'discount', 'refund', 'waste')),
	CONSTRAINT "ai_anomaly_alerts_severity_check" CHECK ("ai_anomaly_alerts"."severity" IN ('warn', 'high')),
	CONSTRAINT "ai_anomaly_alerts_status_check" CHECK ("ai_anomaly_alerts"."status" IN ('open', 'acknowledged')),
	CONSTRAINT "ai_anomaly_alerts_amount_check" CHECK ("ai_anomaly_alerts"."observed_idr" >= 0 AND "ai_anomaly_alerts"."baseline_idr" >= 0 AND "ai_anomaly_alerts"."ratio" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"text" text NOT NULL,
	"ai_assisted" boolean NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_daily_summaries_tenant_outlet_date_key" UNIQUE("tenant_id","outlet_id","business_date"),
	CONSTRAINT "ai_daily_summaries_metrics_check" CHECK (jsonb_typeof("ai_daily_summaries"."metrics") = 'object')
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"hour" smallint NOT NULL,
	"metric_code" varchar(20) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"model_version" varchar(20) NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecasts_tenant_outlet_date_hour_metric_key" UNIQUE("tenant_id","outlet_id","target_date","hour","metric_code"),
	CONSTRAINT "forecasts_hour_check" CHECK ("forecasts"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "forecasts_metric_check" CHECK ("forecasts"."metric_code" IN ('sales_idr', 'orders', 'covers')),
	CONSTRAINT "forecasts_value_check" CHECK ("forecasts"."value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_anomaly_alerts" ADD CONSTRAINT "ai_anomaly_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_anomaly_alerts" ADD CONSTRAINT "ai_anomaly_alerts_acknowledged_by_user_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_daily_summaries" ADD CONSTRAINT "ai_daily_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_anomaly_alerts_tenant_outlet_status_idx" ON "ai_anomaly_alerts" USING btree ("tenant_id","outlet_id","status","business_date");--> statement-breakpoint
CREATE INDEX "ai_daily_summaries_tenant_outlet_date_idx" ON "ai_daily_summaries" USING btree ("tenant_id","outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "forecasts_tenant_outlet_date_idx" ON "forecasts" USING btree ("tenant_id","outlet_id","target_date");