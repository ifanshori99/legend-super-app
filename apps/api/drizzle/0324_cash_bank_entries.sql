-- Define FKs while these new tables are empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "cash_bank_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"kind" varchar(20) NOT NULL,
	"entry_date" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"to_bank_account_id" uuid,
	"counter_account_id" uuid,
	"description" varchar(255) NOT NULL,
	"reference" varchar(60),
	"idempotency_key" varchar(100) NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_bank_entries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_bank_entries_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "cash_bank_entries_journal_key" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "cash_bank_entries_amount_check" CHECK ("cash_bank_entries"."amount_idr" > 0),
	CONSTRAINT "cash_bank_entries_kind_check" CHECK ("cash_bank_entries"."kind" IN ('cash_in','cash_out','transfer')),
	CONSTRAINT "cash_bank_entries_transfer_check" CHECK (("cash_bank_entries"."kind" = 'transfer') = ("cash_bank_entries"."to_bank_account_id" IS NOT NULL AND "cash_bank_entries"."counter_account_id" IS NULL AND "cash_bank_entries"."to_bank_account_id" <> "cash_bank_entries"."bank_account_id")),
	CONSTRAINT "cash_bank_entries_cash_check" CHECK (("cash_bank_entries"."kind" IN ('cash_in','cash_out')) = ("cash_bank_entries"."counter_account_id" IS NOT NULL AND "cash_bank_entries"."to_bank_account_id" IS NULL)),
	CONSTRAINT "cash_bank_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_bank_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_to_bank_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","to_bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_counter_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counter_account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_bank_entries_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "petty_cash_funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"balance_idr" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_funds_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "petty_cash_funds_outlet_key" UNIQUE("tenant_id","outlet_id"),
	CONSTRAINT "petty_cash_funds_tenant_id_outlet_key" UNIQUE("tenant_id","id","outlet_id"),
	CONSTRAINT "petty_cash_funds_balance_check" CHECK ("petty_cash_funds"."balance_idr" >= 0),
	CONSTRAINT "petty_cash_funds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_funds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_funds_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_funds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "petty_cash_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"balance_after_idr" bigint NOT NULL,
	"bank_account_id" uuid,
	"petty_purchase_id" uuid,
	"entry_date" date NOT NULL,
	"description" varchar(255) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"journal_status" varchar(20) NOT NULL,
	"journal_entry_id" uuid,
	"park_code" varchar(60),
	"park_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_entries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "petty_cash_entries_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "petty_cash_entries_amount_check" CHECK ("petty_cash_entries"."amount_idr" > 0),
	CONSTRAINT "petty_cash_entries_balance_check" CHECK ("petty_cash_entries"."balance_after_idr" >= 0),
	CONSTRAINT "petty_cash_entries_kind_check" CHECK ("petty_cash_entries"."kind" IN ('topup','return','purchase')),
	CONSTRAINT "petty_cash_entries_status_check" CHECK ("petty_cash_entries"."journal_status" IN ('posted','parked','external')),
	CONSTRAINT "petty_cash_entries_purchase_check" CHECK (("petty_cash_entries"."kind" = 'purchase') = ("petty_cash_entries"."petty_purchase_id" IS NOT NULL AND "petty_cash_entries"."bank_account_id" IS NULL AND "petty_cash_entries"."journal_status" = 'external')),
	CONSTRAINT "petty_cash_entries_movement_check" CHECK (("petty_cash_entries"."kind" IN ('topup','return')) = ("petty_cash_entries"."bank_account_id" IS NOT NULL AND "petty_cash_entries"."journal_status" IN ('posted','parked'))),
	CONSTRAINT "petty_cash_entries_posted_check" CHECK (("petty_cash_entries"."journal_status" = 'posted') = ("petty_cash_entries"."journal_entry_id" IS NOT NULL)),
	CONSTRAINT "petty_cash_entries_parked_check" CHECK (("petty_cash_entries"."journal_status" = 'parked') = ("petty_cash_entries"."park_code" IS NOT NULL)),
	CONSTRAINT "petty_cash_entries_attempts_check" CHECK ("petty_cash_entries"."park_attempts" >= 0),
	CONSTRAINT "petty_cash_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_fund_fk" FOREIGN KEY ("tenant_id","fund_id","outlet_id") REFERENCES "public"."petty_cash_funds"("tenant_id","id","outlet_id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_bank_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_purchase_fk" FOREIGN KEY ("tenant_id","petty_purchase_id") REFERENCES "public"."petty_purchases"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "petty_cash_entries_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_check";--> statement-breakpoint
CREATE INDEX "cash_bank_entries_list_idx" ON "cash_bank_entries" USING btree ("tenant_id","legal_entity_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cash_bank_entries_account_idx" ON "cash_bank_entries" USING btree ("tenant_id","bank_account_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_entries_purchase_key" ON "petty_cash_entries" USING btree ("tenant_id","petty_purchase_id") WHERE "petty_cash_entries"."petty_purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_entries_journal_key" ON "petty_cash_entries" USING btree ("tenant_id","journal_entry_id") WHERE "petty_cash_entries"."journal_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "petty_cash_entries_list_idx" ON "petty_cash_entries" USING btree ("tenant_id","outlet_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "petty_cash_entries_fund_idx" ON "petty_cash_entries" USING btree ("tenant_id","fund_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_check" CHECK ("journal_entries"."source_type" IN ('sale', 'refund', 'gateway_settlement', 'edc_settlement', 'cogs', 'stock_adjustment', 'purchase', 'supplier_invoice', 'supplier_payment', 'production', 'payroll', 'loyalty', 'depreciation', 'asset_acquisition', 'asset_disposal', 'asset_revaluation', 'dividend', 'cash_deposit', 'cash_receipt', 'cash_payment', 'bank_transfer', 'petty_cash_topup', 'petty_cash_return', 'cashier_shift', 'opening_balance', 'manual', 'recurring', 'reversal', 'customer_deposit', 'purchase_return', 'petty_purchase'));