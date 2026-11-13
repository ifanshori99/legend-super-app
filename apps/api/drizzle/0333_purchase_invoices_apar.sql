CREATE TABLE "purchase_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"number" varchar(60) NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"goods_idr" bigint NOT NULL,
	"price_variance_idr" bigint NOT NULL,
	"services_idr" bigint NOT NULL,
	"ppn_idr" bigint NOT NULL,
	"pph23_idr" bigint NOT NULL,
	"total_idr" bigint NOT NULL,
	"payable_idr" bigint NOT NULL,
	"tolerance_bp" integer NOT NULL,
	"match_result" varchar(12) NOT NULL,
	"match_snapshot" jsonb NOT NULL,
	"match_note" varchar(500),
	"status" varchar(12) NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" varchar(500),
	"journal_entry_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_invoices_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "purchase_invoices_amounts_check" CHECK ("purchase_invoices"."goods_idr" >= 0 AND "purchase_invoices"."services_idr" >= 0
        AND "purchase_invoices"."ppn_idr" >= 0 AND "purchase_invoices"."pph23_idr" >= 0
        AND "purchase_invoices"."total_idr" >= 0 AND "purchase_invoices"."payable_idr" > 0
        AND "purchase_invoices"."total_idr" = "purchase_invoices"."goods_idr" + "purchase_invoices"."price_variance_idr"
          + "purchase_invoices"."services_idr" + "purchase_invoices"."ppn_idr"
        AND "purchase_invoices"."payable_idr" = "purchase_invoices"."total_idr" - "purchase_invoices"."pph23_idr"),
	CONSTRAINT "purchase_invoices_dates_check" CHECK ("purchase_invoices"."due_date" >= "purchase_invoices"."invoice_date"),
	CONSTRAINT "purchase_invoices_tolerance_check" CHECK ("purchase_invoices"."tolerance_bp" BETWEEN 0 AND 1000),
	CONSTRAINT "purchase_invoices_number_check" CHECK (length(btrim("purchase_invoices"."number")) > 0),
	CONSTRAINT "purchase_invoices_status_check" CHECK ("purchase_invoices"."status" IN ('matched', 'held', 'released', 'rejected')),
	CONSTRAINT "purchase_invoices_match_result_check" CHECK ("purchase_invoices"."match_result" IN ('matched', 'discrepancy')),
	CONSTRAINT "purchase_invoices_journal_state_check" CHECK (("purchase_invoices"."status" IN ('matched', 'released')) = ("purchase_invoices"."journal_entry_id" IS NOT NULL)),
	CONSTRAINT "purchase_invoices_decision_state_check" CHECK (("purchase_invoices"."status" IN ('released', 'rejected')) = ("purchase_invoices"."decided_by" IS NOT NULL)
        AND ("purchase_invoices"."decided_by" IS NULL) = ("purchase_invoices"."decided_at" IS NULL)),
	CONSTRAINT "purchase_invoices_match_state_check" CHECK (("purchase_invoices"."status" <> 'matched' OR "purchase_invoices"."match_result" = 'matched')
        AND ("purchase_invoices"."status" NOT IN ('held', 'released') OR "purchase_invoices"."match_result" = 'discrepancy')),
	CONSTRAINT "purchase_invoices_decider_check" CHECK ("purchase_invoices"."status" <> 'released' OR "purchase_invoices"."decided_by" <> "purchase_invoices"."recorded_by"),
	CONSTRAINT "purchase_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_order_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoices_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "purchase_invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"purchase_order_line_id" uuid,
	"kind" varchar(8) NOT NULL,
	"description" varchar(200) NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"unit_price_idr" numeric(14,4) NOT NULL,
	"line_total_idr" bigint NOT NULL,
	CONSTRAINT "purchase_invoice_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_invoice_lines_invoice_line_no_key" UNIQUE("tenant_id","purchase_invoice_id","line_no"),
	CONSTRAINT "purchase_invoice_lines_line_no_check" CHECK ("purchase_invoice_lines"."line_no" > 0),
	CONSTRAINT "purchase_invoice_lines_kind_check" CHECK ("purchase_invoice_lines"."kind" IN ('goods', 'service')),
	CONSTRAINT "purchase_invoice_lines_goods_line_check" CHECK ("purchase_invoice_lines"."kind" = 'service' OR "purchase_invoice_lines"."purchase_order_line_id" IS NOT NULL),
	CONSTRAINT "purchase_invoice_lines_amounts_check" CHECK ("purchase_invoice_lines"."quantity" > 0 AND "purchase_invoice_lines"."unit_price_idr" >= 0 AND "purchase_invoice_lines"."line_total_idr" >= 0),
	CONSTRAINT "purchase_invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_invoice_id") REFERENCES "public"."purchase_invoices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchase_invoice_lines_order_line_fk" FOREIGN KEY ("tenant_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "purchasing_policies" (
	"tenant_id" uuid NOT NULL,
	"three_way_match_tolerance_bp" integer NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchasing_policies_pkey" PRIMARY KEY("tenant_id"),
	CONSTRAINT "purchasing_policies_tolerance_check" CHECK ("purchasing_policies"."three_way_match_tolerance_bp" BETWEEN 0 AND 1000),
	CONSTRAINT "purchasing_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "purchasing_policies_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" DROP CONSTRAINT "accounting_open_item_settlements_method_check";
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_order_line_idx" ON "purchase_invoice_lines" USING btree ("tenant_id","purchase_order_line_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_invoices_supplier_number_key" ON "purchase_invoices" USING btree ("tenant_id","supplier_id",lower(btrim("number"))) WHERE "purchase_invoices"."status" <> 'rejected';
--> statement-breakpoint
CREATE INDEX "purchase_invoices_order_status_idx" ON "purchase_invoices" USING btree ("tenant_id","purchase_order_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_open_item_settlements_debit_note_key" ON "accounting_open_item_settlements" USING btree ("tenant_id","kind","open_item_id","source_id") WHERE "accounting_open_item_settlements"."method" = 'debit_note';
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_debit_note_source_check" CHECK ("accounting_open_item_settlements"."method" <> 'debit_note' OR "accounting_open_item_settlements"."source_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_method_check" CHECK ("accounting_open_item_settlements"."method" IN ('payment', 'write_off', 'debit_note'));
