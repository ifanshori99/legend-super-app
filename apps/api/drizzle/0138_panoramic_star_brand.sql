CREATE TABLE "auto_journal_parked" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"event_id" text NOT NULL,
	"event_name" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"error_code" varchar(60) NOT NULL,
	"retryable" boolean NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone,
	CONSTRAINT "auto_journal_parked_tenant_key" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_check";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "late_adjustment_from" date;--> statement-breakpoint
-- auto_journal_parked.(tenant_id, outlet_id) references outlets, which has FORCE
-- ROW LEVEL SECURITY: the FK validation scan runs under RLS and fails without a
-- tenant context. Lift FORCE on outlets for this transaction only and restore it
-- right after the foreign key (pattern 0065/0068/0129). tenants never had FORCE.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auto_journal_parked" ADD CONSTRAINT "auto_journal_parked_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_journal_parked" ADD CONSTRAINT "auto_journal_parked_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "auto_journal_parked_retry_idx" ON "auto_journal_parked" USING btree ("tenant_id","next_retry_at");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_late_adjustment_check" CHECK ("journal_entries"."late_adjustment_from" IS NULL OR "journal_entries"."late_adjustment_from" < "journal_entries"."entry_date");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_check" CHECK ("journal_entries"."source_type" IN ('sale', 'refund', 'gateway_settlement', 'edc_settlement', 'cogs', 'stock_adjustment', 'purchase', 'supplier_invoice', 'supplier_payment', 'production', 'payroll', 'loyalty', 'depreciation', 'asset_acquisition', 'asset_disposal', 'asset_revaluation', 'dividend', 'cash_deposit', 'cashier_shift', 'opening_balance', 'manual', 'recurring', 'reversal', 'customer_deposit'));