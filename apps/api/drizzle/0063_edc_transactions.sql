CREATE TABLE "edc_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"bank" varchar(20) NOT NULL,
	"reference" varchar(100) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(128) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"method" varchar(10) NOT NULL,
	"status" varchar(20) NOT NULL,
	"trace" varchar(32) NOT NULL,
	"approval_code" varchar(12),
	"rrn" varchar(24),
	"card_type" varchar(32),
	"masked_pan" varchar(23),
	"response_code" varchar(8),
	"message" varchar(200),
	"invoice_no" varchar(20),
	"batch_no" varchar(20),
	"dispatched_at" timestamp with time zone,
	"needs_reconciliation" boolean DEFAULT false NOT NULL,
	"inquiry_count" integer DEFAULT 0 NOT NULL,
	"last_inquiry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "edc_transactions_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "edc_transactions_tenant_terminal_trace_key" UNIQUE("tenant_id","terminal_id","trace"),
	CONSTRAINT "edc_transactions_bank_check" CHECK ("edc_transactions"."bank" IN ('bca','mandiri','bni','bjb')),
	CONSTRAINT "edc_transactions_amount_check" CHECK ("edc_transactions"."amount_idr" > 0),
	CONSTRAINT "edc_transactions_method_check" CHECK ("edc_transactions"."method" IN ('card','qris')),
	CONSTRAINT "edc_transactions_status_check" CHECK ("edc_transactions"."status" IN ('pending','unknown','approved','declined','cancelled','failed')),
	CONSTRAINT "edc_transactions_inquiry_count_check" CHECK ("edc_transactions"."inquiry_count" >= 0),
	CONSTRAINT "edc_transactions_completed_check" CHECK (("edc_transactions"."completed_at" IS NOT NULL) = ("edc_transactions"."status" IN ('approved','declined','cancelled','failed')))
);
--> statement-breakpoint
ALTER TABLE "edc_transactions" ADD CONSTRAINT "edc_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_transactions" ADD CONSTRAINT "edc_transactions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_transactions" ADD CONSTRAINT "edc_transactions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_transactions" ADD CONSTRAINT "edc_transactions_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_id") REFERENCES "public"."payment_edc_terminals"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edc_transactions_approved_reference_key" ON "edc_transactions" USING btree ("tenant_id","outlet_id","reference") WHERE "edc_transactions"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "edc_transactions_reference_idx" ON "edc_transactions" USING btree ("tenant_id","outlet_id","reference");--> statement-breakpoint
CREATE INDEX "edc_transactions_terminal_status_idx" ON "edc_transactions" USING btree ("tenant_id","terminal_id","status");