-- legend-30hfs (967): payment_provider_refunds, one row per refund the payment
-- provider made on its own for money we recorded as paid (not the echo of a
-- refund we sent). Foreign keys into FORCE RLS tables are inline in the CREATE
-- TABLE (docs/plan/contracts.md, pattern 1); the table is tenant- and
-- outlet-isolated like payment_evidence (migrations 0021, 0032). The migration
-- creates the table only and writes no row, so nobody is paid more.
CREATE TABLE "payment_provider_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"evidence_id" uuid,
	"provider" varchar(20) NOT NULL,
	"provider_refund_id" varchar(100) NOT NULL,
	"provider_payment_ref" varchar(100) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"source" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_refunds_provider_refund_key" UNIQUE("tenant_id","provider","provider_refund_id"),
	CONSTRAINT "payment_provider_refunds_amount_check" CHECK ("payment_provider_refunds"."amount_idr" > 0),
	CONSTRAINT "payment_provider_refunds_source_check" CHECK ("payment_provider_refunds"."source" IN ('refund_webhook', 'payment_webhook', 'poller')),
	CONSTRAINT "payment_provider_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_provider_refunds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_provider_refunds_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_provider_refunds_evidence_fk" FOREIGN KEY ("tenant_id","evidence_id") REFERENCES "public"."payment_evidence"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_provider_refunds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payment_provider_refunds_intent_idx" ON "payment_provider_refunds" USING btree ("tenant_id","payment_intent_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_provider_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_provider_refunds'::regclass);
