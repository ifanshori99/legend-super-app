CREATE TABLE "payment_settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"reference" varchar(100) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"fee_idr" bigint NOT NULL,
	"expected_idr" bigint,
	"matched_edc_transaction_id" uuid,
	"matched_payment_intent_id" uuid,
	"match_status" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settlement_lines_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_settlement_lines_reference_key" UNIQUE("tenant_id","settlement_id","reference"),
	CONSTRAINT "payment_settlement_lines_match_status_check" CHECK ("payment_settlement_lines"."match_status" IN ('matched','mismatch','unmatched')),
	CONSTRAINT "payment_settlement_lines_amount_check" CHECK ("payment_settlement_lines"."amount_idr" > 0 AND "payment_settlement_lines"."fee_idr" >= 0),
	CONSTRAINT "payment_settlement_lines_match_link_check" CHECK (("payment_settlement_lines"."match_status" = 'unmatched' AND num_nonnulls("payment_settlement_lines"."matched_edc_transaction_id", "payment_settlement_lines"."matched_payment_intent_id") = 0) OR ("payment_settlement_lines"."match_status" IN ('matched','mismatch') AND num_nonnulls("payment_settlement_lines"."matched_edc_transaction_id", "payment_settlement_lines"."matched_payment_intent_id") = 1)),
	CONSTRAINT "payment_settlement_lines_match_amount_check" CHECK ("payment_settlement_lines"."match_status" = 'unmatched' OR ("payment_settlement_lines"."expected_idr" IS NOT NULL AND (("payment_settlement_lines"."match_status" = 'matched' AND "payment_settlement_lines"."expected_idr" = "payment_settlement_lines"."amount_idr") OR ("payment_settlement_lines"."match_status" = 'mismatch' AND "payment_settlement_lines"."expected_idr" <> "payment_settlement_lines"."amount_idr"))))
);
--> statement-breakpoint
CREATE TABLE "payment_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source" varchar(20) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"terminal_id" uuid,
	"batch_no" varchar(20),
	"reference" varchar(100) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"gross_idr" bigint NOT NULL,
	"fee_idr" bigint NOT NULL,
	"net_idr" bigint NOT NULL,
	"line_count" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settlements_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_settlements_tenant_id_outlet_key" UNIQUE("tenant_id","id","outlet_id"),
	CONSTRAINT "payment_settlements_report_key" UNIQUE("tenant_id","source","provider","outlet_id","reference"),
	CONSTRAINT "payment_settlements_source_check" CHECK ("payment_settlements"."source" IN ('gateway','edc')),
	CONSTRAINT "payment_settlements_period_check" CHECK ("payment_settlements"."period_start" <= "payment_settlements"."period_end"),
	CONSTRAINT "payment_settlements_amount_check" CHECK ("payment_settlements"."gross_idr" >= 0 AND "payment_settlements"."fee_idr" >= 0 AND "payment_settlements"."net_idr" >= 0 AND "payment_settlements"."net_idr" = "payment_settlements"."gross_idr" - "payment_settlements"."fee_idr"),
	CONSTRAINT "payment_settlements_line_count_check" CHECK ("payment_settlements"."line_count" >= 0),
	CONSTRAINT "payment_settlements_edc_batch_check" CHECK (("payment_settlements"."source" = 'edc') = ("payment_settlements"."terminal_id" IS NOT NULL AND "payment_settlements"."batch_no" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_settlement_fk" FOREIGN KEY ("tenant_id","settlement_id","outlet_id") REFERENCES "public"."payment_settlements"("tenant_id","id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlements" ADD CONSTRAINT "payment_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlements" ADD CONSTRAINT "payment_settlements_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlements" ADD CONSTRAINT "payment_settlements_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlement_lines_edc_txn_key" ON "payment_settlement_lines" USING btree ("tenant_id","matched_edc_transaction_id") WHERE "payment_settlement_lines"."matched_edc_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlement_lines_intent_key" ON "payment_settlement_lines" USING btree ("tenant_id","matched_payment_intent_id") WHERE "payment_settlement_lines"."matched_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_settlement_lines_status_idx" ON "payment_settlement_lines" USING btree ("tenant_id","outlet_id","match_status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlements_edc_batch_key" ON "payment_settlements" USING btree ("tenant_id","terminal_id","batch_no") WHERE "payment_settlements"."source" = 'edc';
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_settlements'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_settlements'::regclass);

--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_settlement_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_settlement_lines'::regclass);

--> statement-breakpoint
-- Settlement reports and lines are append-only for the application role:
-- reconciliation records differences, it never edits or removes a report.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payment_settlements FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payment_settlement_lines FROM legend_app;
