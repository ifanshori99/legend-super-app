CREATE TABLE "edge_print_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"subject_id" uuid NOT NULL,
	"station_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_print_alerts_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "edge_print_alerts_kind_check" CHECK ("edge_print_alerts"."kind" IN ('printer_offline', 'printer_online', 'kds_down', 'kds_up', 'fallback_printed', 'job_failed')),
	CONSTRAINT "edge_print_alerts_ack_check" CHECK (("edge_print_alerts"."acknowledged_at" IS NULL) = ("edge_print_alerts"."acknowledged_by" IS NULL)),
	CONSTRAINT "edge_print_alerts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_print_alerts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_print_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"printer_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"content" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(500),
	"failure_phase" varchar(20),
	"reprint_of" uuid,
	"printed_fallback" boolean DEFAULT false NOT NULL,
	"fallback_reason" varchar(20),
	"original_printer_id" uuid,
	"source_ref" varchar(255),
	"idempotency_key" varchar(255) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_print_jobs_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "edge_print_jobs_tenant_outlet_idempotency_key" UNIQUE("tenant_id","outlet_id","idempotency_key"),
	CONSTRAINT "edge_print_jobs_kind_check" CHECK ("edge_print_jobs"."kind" IN ('receipt', 'station_ticket', 'shift_report')),
	CONSTRAINT "edge_print_jobs_status_check" CHECK ("edge_print_jobs"."status" IN ('queued', 'printing', 'printed', 'failed')),
	CONSTRAINT "edge_print_jobs_fallback_check" CHECK (("edge_print_jobs"."printed_fallback" AND "edge_print_jobs"."fallback_reason" IS NOT NULL AND "edge_print_jobs"."fallback_reason" IN ('kds_down', 'printer_offline'))
        OR (NOT "edge_print_jobs"."printed_fallback" AND "edge_print_jobs"."fallback_reason" IS NULL)),
	CONSTRAINT "edge_print_jobs_failure_phase_check" CHECK ("edge_print_jobs"."failure_phase" IN ('write', 'stale', 'other')),
	CONSTRAINT "edge_print_jobs_failure_phase_status_check" CHECK (("edge_print_jobs"."status" = 'failed') = ("edge_print_jobs"."failure_phase" IS NOT NULL)),
	CONSTRAINT "edge_print_jobs_attempts_check" CHECK ("edge_print_jobs"."attempts" >= 0),
	CONSTRAINT "edge_print_jobs_printed_at_check" CHECK (("edge_print_jobs"."status" = 'printed') = ("edge_print_jobs"."printed_at" IS NOT NULL)),
	CONSTRAINT "edge_print_jobs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"label" varchar(255) NOT NULL,
	"role" varchar(20) NOT NULL,
	"station_id" uuid,
	"transport" varchar(20) NOT NULL,
	"host" varchar(255),
	"port" integer,
	"device_path" varchar(255),
	"paper_width" integer DEFAULT 48 NOT NULL,
	"fallback_printer_id" uuid,
	"status" varchar(20) DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"offline_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_printers_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "edge_printers_role_check" CHECK ("edge_printers"."role" IN ('receipt', 'station')),
	CONSTRAINT "edge_printers_status_check" CHECK ("edge_printers"."status" IN ('unknown', 'online', 'offline')),
	CONSTRAINT "edge_printers_paper_width_check" CHECK ("edge_printers"."paper_width" IN (32, 48)),
	CONSTRAINT "edge_printers_transport_check" CHECK (("edge_printers"."transport" = 'network' AND "edge_printers"."host" IS NOT NULL AND "edge_printers"."port" BETWEEN 1 AND 65535 AND "edge_printers"."device_path" IS NULL)
        OR ("edge_printers"."transport" = 'usb' AND "edge_printers"."device_path" IS NOT NULL AND "edge_printers"."host" IS NULL AND "edge_printers"."port" IS NULL)),
	CONSTRAINT "edge_printers_device_path_check" CHECK ("edge_printers"."device_path" IS NULL OR "edge_printers"."device_path" ~ '^/dev/(usb/lp|lp)[0-9]+$'),
	CONSTRAINT "edge_printers_port_check" CHECK ("edge_printers"."port" IS NULL OR "edge_printers"."port" BETWEEN 9100 AND 9102),
	CONSTRAINT "edge_printers_host_check" CHECK ("edge_printers"."host" IS NULL OR (CASE WHEN "edge_printers"."host" ~ '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$' THEN "edge_printers"."host"::inet << '10.0.0.0/8'::inet OR "edge_printers"."host"::inet << '172.16.0.0/12'::inet OR "edge_printers"."host"::inet << '192.168.0.0/16'::inet ELSE false END)),
	CONSTRAINT "edge_printers_station_role_check" CHECK ("edge_printers"."role" = 'station' OR "edge_printers"."station_id" IS NULL),
	CONSTRAINT "edge_printers_not_own_fallback_check" CHECK ("edge_printers"."fallback_printer_id" IS NULL OR "edge_printers"."fallback_printer_id" <> "edge_printers"."id"),
	CONSTRAINT "edge_printers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_printers_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "edge_print_alerts" ADD CONSTRAINT "edge_print_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_print_jobs" ADD CONSTRAINT "edge_print_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_print_jobs" ADD CONSTRAINT "edge_print_jobs_printer_fk" FOREIGN KEY ("tenant_id","outlet_id","printer_id") REFERENCES "public"."edge_printers"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_print_jobs" ADD CONSTRAINT "edge_print_jobs_original_printer_fk" FOREIGN KEY ("tenant_id","outlet_id","original_printer_id") REFERENCES "public"."edge_printers"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_print_jobs" ADD CONSTRAINT "edge_print_jobs_reprint_of_fk" FOREIGN KEY ("tenant_id","outlet_id","reprint_of") REFERENCES "public"."edge_print_jobs"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_printers" ADD CONSTRAINT "edge_printers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_printers" ADD CONSTRAINT "edge_printers_fallback_fk" FOREIGN KEY ("tenant_id","outlet_id","fallback_printer_id") REFERENCES "public"."edge_printers"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_print_alerts_recent_idx" ON "edge_print_alerts" USING btree ("tenant_id","outlet_id","occurred_at");--> statement-breakpoint
CREATE INDEX "edge_print_jobs_queue_idx" ON "edge_print_jobs" USING btree ("tenant_id","outlet_id","printer_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "edge_print_jobs_list_idx" ON "edge_print_jobs" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "edge_printers_station_idx" ON "edge_printers" USING btree ("tenant_id","outlet_id","station_id");