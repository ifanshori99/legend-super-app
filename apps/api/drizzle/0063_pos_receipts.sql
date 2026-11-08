CREATE TABLE "pos_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"billed_to_name" varchar(150) NOT NULL,
	"billed_to_address" varchar(300) NOT NULL,
	"billed_to_npwp" varchar(25),
	"due_date" date NOT NULL,
	"notes" varchar(500),
	"idempotency_key" varchar(100) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_invoices_idempotency_key" UNIQUE("tenant_id","order_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "pos_receipt_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"channel" varchar(10) NOT NULL,
	"status" varchar(10) NOT NULL,
	"destination_masked" varchar(120),
	"destination_sealed" text,
	"idempotency_key" varchar(100) NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"failure_reason" varchar(200),
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_receipt_deliveries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_receipt_deliveries_idempotency_key" UNIQUE("tenant_id","receipt_id","idempotency_key","channel"),
	CONSTRAINT "pos_receipt_deliveries_channel_check" CHECK ("pos_receipt_deliveries"."channel" IN ('print', 'link', 'email')),
	CONSTRAINT "pos_receipt_deliveries_status_check" CHECK ("pos_receipt_deliveries"."status" IN ('queued', 'sent', 'failed')),
	CONSTRAINT "pos_receipt_deliveries_sent_check" CHECK (("pos_receipt_deliveries"."status" = 'sent') = ("pos_receipt_deliveries"."sent_at" IS NOT NULL)),
	CONSTRAINT "pos_receipt_deliveries_failed_check" CHECK ("pos_receipt_deliveries"."status" <> 'failed' OR "pos_receipt_deliveries"."failure_reason" IS NOT NULL),
	CONSTRAINT "pos_receipt_deliveries_email_check" CHECK (("pos_receipt_deliveries"."channel" <> 'email' AND "pos_receipt_deliveries"."destination_sealed" IS NULL)
        OR ("pos_receipt_deliveries"."channel" = 'email' AND ("pos_receipt_deliveries"."status" <> 'queued' OR "pos_receipt_deliveries"."destination_sealed" IS NOT NULL))),
	CONSTRAINT "pos_receipt_deliveries_attempts_check" CHECK ("pos_receipt_deliveries"."attempts" BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "pos_receipt_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_receipt_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_receipt_links_token_key" UNIQUE("tenant_id","token_hash"),
	CONSTRAINT "pos_receipt_links_idempotency_key" UNIQUE("tenant_id","receipt_id","idempotency_key"),
	CONSTRAINT "pos_receipt_links_token_hash_check" CHECK ("pos_receipt_links"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "pos_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"number" varchar(22) NOT NULL,
	"sequence_number" integer NOT NULL,
	"status" varchar(10) DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(30),
	"voided_by" text,
	"reprint_count" smallint DEFAULT 0 NOT NULL,
	"outlet_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_receipts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_receipts_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "pos_receipts_sequence_ordinal_key" UNIQUE("tenant_id","sequence_id","sequence_number"),
	CONSTRAINT "pos_receipts_number_key" UNIQUE("tenant_id","outlet_id","number"),
	CONSTRAINT "pos_receipts_status_check" CHECK ("pos_receipts"."status" IN ('issued', 'voided')),
	CONSTRAINT "pos_receipts_sequence_number_check" CHECK ("pos_receipts"."sequence_number" BETWEEN 1 AND 999999999),
	CONSTRAINT "pos_receipts_reprint_count_check" CHECK ("pos_receipts"."reprint_count" BETWEEN 0 AND 99),
	CONSTRAINT "pos_receipts_void_fields_check" CHECK (("pos_receipts"."status" = 'voided') = ("pos_receipts"."voided_at" IS NOT NULL AND "pos_receipts"."void_reason" IS NOT NULL AND "pos_receipts"."voided_by" IS NOT NULL)
        AND ("pos_receipts"."status" = 'voided' OR ("pos_receipts"."voided_at" IS NULL AND "pos_receipts"."void_reason" IS NULL AND "pos_receipts"."voided_by" IS NULL))),
	CONSTRAINT "pos_receipts_outlet_snapshot_check" CHECK (jsonb_typeof("pos_receipts"."outlet_snapshot") = 'object'
        AND jsonb_typeof("pos_receipts"."outlet_snapshot" -> 'outletName') = 'string'
        AND jsonb_typeof("pos_receipts"."outlet_snapshot" -> 'outletAddress') = 'string')
);
--> statement-breakpoint
CREATE TABLE "receipt_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_sequences_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "receipt_sequences_device_key" UNIQUE("tenant_id","outlet_id","device_id"),
	CONSTRAINT "receipt_sequences_prefix_key" UNIQUE("tenant_id","outlet_id","prefix"),
	CONSTRAINT "receipt_sequences_prefix_check" CHECK ("receipt_sequences"."prefix" ~ '^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$'),
	CONSTRAINT "receipt_sequences_last_number_check" CHECK ("receipt_sequences"."last_number" BETWEEN 0 AND 999999999)
);
--> statement-breakpoint
ALTER TABLE "pos_invoices" ADD CONSTRAINT "pos_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_invoices" ADD CONSTRAINT "pos_invoices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_invoices" ADD CONSTRAINT "pos_invoices_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."pos_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_invoices" ADD CONSTRAINT "pos_invoices_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_invoices" ADD CONSTRAINT "pos_invoices_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_deliveries" ADD CONSTRAINT "pos_receipt_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_deliveries" ADD CONSTRAINT "pos_receipt_deliveries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_deliveries" ADD CONSTRAINT "pos_receipt_deliveries_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."pos_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_deliveries" ADD CONSTRAINT "pos_receipt_deliveries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_links" ADD CONSTRAINT "pos_receipt_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_links" ADD CONSTRAINT "pos_receipt_links_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_links" ADD CONSTRAINT "pos_receipt_links_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."pos_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipt_links" ADD CONSTRAINT "pos_receipt_links_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipts" ADD CONSTRAINT "pos_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipts" ADD CONSTRAINT "pos_receipts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipts" ADD CONSTRAINT "pos_receipts_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."receipt_sequences"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipts" ADD CONSTRAINT "pos_receipts_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_receipts" ADD CONSTRAINT "pos_receipts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_invoices_order_idx" ON "pos_invoices" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "pos_receipt_deliveries_queue_idx" ON "pos_receipt_deliveries" USING btree ("tenant_id","channel","status");--> statement-breakpoint
CREATE INDEX "pos_receipts_outlet_issued_idx" ON "pos_receipts" USING btree ("tenant_id","outlet_id","issued_at");