-- X2 (legend-wasr7.11): EDC settlement CSV per bank. New tables only, after
-- 0537. Lines are matched to EDC sales by terminal + RRN + amount; the import
-- never edits an amount or a payment status.
CREATE TABLE "edc_settlement_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bank" varchar(20) NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"row_count" integer NOT NULL,
	"matched_count" integer NOT NULL,
	"cleared_count" integer NOT NULL,
	"mismatch_count" integer NOT NULL,
	"unmatched_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edc_settlement_files_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "edc_settlement_files_tenant_id_outlet_key" UNIQUE("tenant_id","id","outlet_id"),
	CONSTRAINT "edc_settlement_files_hash_key" UNIQUE("tenant_id","outlet_id","file_hash"),
	CONSTRAINT "edc_settlement_files_bank_check" CHECK ("edc_settlement_files"."bank" IN ('bca','mandiri','bni','bjb')),
	CONSTRAINT "edc_settlement_files_count_check" CHECK ("edc_settlement_files"."row_count" >= 0 AND "edc_settlement_files"."matched_count" >= 0 AND "edc_settlement_files"."cleared_count" >= 0 AND "edc_settlement_files"."cleared_count" <= "edc_settlement_files"."matched_count" AND "edc_settlement_files"."mismatch_count" >= 0 AND "edc_settlement_files"."unmatched_count" >= 0 AND "edc_settlement_files"."duplicate_count" >= 0 AND "edc_settlement_files"."matched_count" + "edc_settlement_files"."mismatch_count" + "edc_settlement_files"."unmatched_count" + "edc_settlement_files"."duplicate_count" = "edc_settlement_files"."row_count")
);
--> statement-breakpoint
CREATE TABLE "edc_settlement_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"row_key" varchar(64) NOT NULL,
	"bank" varchar(20) NOT NULL,
	"terminal_code" varchar(32) NOT NULL,
	"terminal_id" uuid,
	"rrn" varchar(24) NOT NULL,
	"approval_code" varchar(12),
	"batch_no" varchar(20),
	"amount_idr" bigint NOT NULL,
	"match_status" varchar(20) NOT NULL,
	"matched_edc_transaction_id" uuid,
	"cleared_flag" boolean DEFAULT false NOT NULL,
	"reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edc_settlement_rows_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "edc_settlement_rows_status_check" CHECK ("edc_settlement_rows"."match_status" IN ('matched','mismatch','unmatched')),
	CONSTRAINT "edc_settlement_rows_amount_check" CHECK ("edc_settlement_rows"."amount_idr" > 0),
	CONSTRAINT "edc_settlement_rows_link_check" CHECK (("edc_settlement_rows"."match_status" = 'matched') <= ("edc_settlement_rows"."matched_edc_transaction_id" IS NOT NULL) AND ("edc_settlement_rows"."match_status" = 'unmatched') <= ("edc_settlement_rows"."matched_edc_transaction_id" IS NULL)),
	CONSTRAINT "edc_settlement_rows_cleared_check" CHECK (NOT "edc_settlement_rows"."cleared_flag" OR "edc_settlement_rows"."match_status" = 'matched')
);
--> statement-breakpoint
ALTER TABLE "edc_settlement_files" ADD CONSTRAINT "edc_settlement_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_files" ADD CONSTRAINT "edc_settlement_files_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_files" ADD CONSTRAINT "edc_settlement_files_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_rows" ADD CONSTRAINT "edc_settlement_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_rows" ADD CONSTRAINT "edc_settlement_rows_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_rows" ADD CONSTRAINT "edc_settlement_rows_file_fk" FOREIGN KEY ("tenant_id","file_id","outlet_id") REFERENCES "public"."edc_settlement_files"("tenant_id","id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_settlement_rows" ADD CONSTRAINT "edc_settlement_rows_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edc_settlement_rows_row_key" ON "edc_settlement_rows" USING btree ("tenant_id","outlet_id","row_key") WHERE "edc_settlement_rows"."match_status" <> 'unmatched';--> statement-breakpoint
CREATE UNIQUE INDEX "edc_settlement_rows_matched_txn_key" ON "edc_settlement_rows" USING btree ("tenant_id","matched_edc_transaction_id") WHERE "edc_settlement_rows"."match_status" = 'matched';--> statement-breakpoint
CREATE INDEX "edc_settlement_rows_txn_idx" ON "edc_settlement_rows" USING btree ("tenant_id","matched_edc_transaction_id");
--> statement-breakpoint
-- Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03).
SELECT app.enforce_tenant_rls('public.edc_settlement_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_settlement_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_settlement_rows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_settlement_rows'::regclass);
--> statement-breakpoint
-- Append-only for the application role, as payment_settlements (0319).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.edc_settlement_files FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.edc_settlement_rows FROM legend_app;
