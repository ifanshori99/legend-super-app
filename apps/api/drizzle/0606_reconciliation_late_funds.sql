CREATE TABLE "payment_reconciliation_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"settlement_line_id" uuid NOT NULL,
	"mismatch_case_id" uuid,
	"source" varchar(20) NOT NULL,
	"reference" varchar(100) NOT NULL,
	"written_off_idr" bigint NOT NULL,
	"received_idr" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"decision" varchar(30),
	"approval_chain_id" uuid,
	"requested_by" text,
	"approved_by" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_corrections_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_reconciliation_corrections_case_key" UNIQUE("tenant_id","case_id"),
	CONSTRAINT "payment_reconciliation_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_reconciliation_corrections_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_reconciliation_corrections_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_reconciliation_corrections_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."payment_reconciliation_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_reconciliation_corrections_mismatch_case_fk" FOREIGN KEY ("tenant_id","mismatch_case_id") REFERENCES "public"."payment_reconciliation_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_reconciliation_corrections_source_check" CHECK ("payment_reconciliation_corrections"."source" IN ('gateway','edc')),
	CONSTRAINT "payment_reconciliation_corrections_status_check" CHECK ("payment_reconciliation_corrections"."status" IN ('open','pending_approval','resolved')),
	CONSTRAINT "payment_reconciliation_corrections_decision_check" CHECK ("payment_reconciliation_corrections"."decision" IS NULL OR "payment_reconciliation_corrections"."decision" IN ('reverse_write_off','keep_write_off')),
	CONSTRAINT "payment_reconciliation_corrections_amount_check" CHECK ("payment_reconciliation_corrections"."written_off_idr" >= 0 AND "payment_reconciliation_corrections"."received_idr" >= 0)
);
--> statement-breakpoint
CREATE INDEX "payment_reconciliation_corrections_status_idx" ON "payment_reconciliation_corrections" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
-- legend-oan3p: funds of a written-off case that arrived later; finance reviews, nothing is reversed automatically.
SELECT app.enforce_tenant_rls('public.payment_reconciliation_corrections'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_reconciliation_corrections'::regclass);
