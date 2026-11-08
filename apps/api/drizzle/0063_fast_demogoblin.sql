CREATE TABLE "purchase_order_email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"recipient_email" varchar(254) NOT NULL,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" varchar(200),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "purchase_order_email_deliveries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_order_email_deliveries_status_check" CHECK ("purchase_order_email_deliveries"."status" IN ('queued', 'sent', 'failed')),
	CONSTRAINT "purchase_order_email_deliveries_attempts_check" CHECK ("purchase_order_email_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"uom_id" uuid NOT NULL,
	"unit_price_idr" numeric(14,4) NOT NULL,
	"line_total_idr" bigint NOT NULL,
	"line_no" smallint NOT NULL,
	CONSTRAINT "purchase_order_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_order_lines_order_line_no_key" UNIQUE("tenant_id","purchase_order_id","line_no"),
	CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("purchase_order_lines"."quantity" > 0),
	CONSTRAINT "purchase_order_lines_price_check" CHECK ("purchase_order_lines"."unit_price_idr" >= 0 AND "purchase_order_lines"."line_total_idr" >= 0),
	CONSTRAINT "purchase_order_lines_line_no_check" CHECK ("purchase_order_lines"."line_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_share_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_order_share_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "purchase_order_share_links_hash_check" CHECK ("purchase_order_share_links"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"number" varchar(40) NOT NULL,
	"purchase_request_id" uuid,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"expected_date" date NOT NULL,
	"subtotal_idr" bigint NOT NULL,
	"tax_idr" bigint NOT NULL,
	"total_idr" bigint NOT NULL,
	"source" varchar(10) DEFAULT 'user' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_to" varchar(254),
	"closed_at" timestamp with time zone,
	"note" varchar(300),
	"approval_chain_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_orders_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "purchase_orders_tenant_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" IN ('draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
	CONSTRAINT "purchase_orders_source_check" CHECK ("purchase_orders"."source" IN ('user', 'ai', 'mcp')),
	CONSTRAINT "purchase_orders_totals_check" CHECK ("purchase_orders"."subtotal_idr" >= 0 AND "purchase_orders"."tax_idr" >= 0
        AND "purchase_orders"."total_idr" >= 0
        AND "purchase_orders"."total_idr" = "purchase_orders"."subtotal_idr" + "purchase_orders"."tax_idr")
);
--> statement-breakpoint
CREATE TABLE "purchase_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"uom_id" uuid NOT NULL,
	CONSTRAINT "purchase_request_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_request_lines_quantity_check" CHECK ("purchase_request_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"needed_by" date NOT NULL,
	"note" varchar(300),
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" varchar(300),
	"approval_chain_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_requests_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "purchase_requests_status_check" CHECK ("purchase_requests"."status" IN ('draft', 'pending_approval', 'approved', 'rejected', 'converted', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "purchasing_document_sequences" (
	"tenant_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"period" varchar(6) NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "purchasing_document_sequences_pkey" PRIMARY KEY("tenant_id","kind","period"),
	CONSTRAINT "purchasing_document_sequences_kind_check" CHECK ("purchasing_document_sequences"."kind" IN ('PO')),
	CONSTRAINT "purchasing_document_sequences_period_check" CHECK ("purchasing_document_sequences"."period" ~ '^[0-9]{6}$'),
	CONSTRAINT "purchasing_document_sequences_value_check" CHECK ("purchasing_document_sequences"."last_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchasing_idempotency" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"operation" varchar(60) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchasing_idempotency_pkey" PRIMARY KEY("tenant_id","operation","idempotency_key"),
	CONSTRAINT "purchasing_idempotency_fingerprint_check" CHECK ("purchasing_idempotency"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"role" varchar(60),
	"phone" varchar(16) NOT NULL,
	"email" varchar(254),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_contacts_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "supplier_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"purchase_uom_id" uuid NOT NULL,
	"price_idr" numeric(14,4) NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_prices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_prices_price_check" CHECK ("supplier_prices"."price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"legal_name" varchar(200),
	"contact_name" varchar(150),
	"phone" varchar(16),
	"email" varchar(254),
	"address" varchar(300),
	"payment_terms_days" integer NOT NULL,
	"rating" smallint,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "suppliers_payment_terms_check" CHECK ("suppliers"."payment_terms_days" >= 0),
	CONSTRAINT "suppliers_rating_check" CHECK ("suppliers"."rating" IS NULL OR "suppliers"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_email_deliveries" ADD CONSTRAINT "purchase_order_email_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_email_deliveries" ADD CONSTRAINT "purchase_order_email_deliveries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_email_deliveries" ADD CONSTRAINT "purchase_order_email_deliveries_order_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_uom_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_share_links" ADD CONSTRAINT "purchase_order_share_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_share_links" ADD CONSTRAINT "purchase_order_share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_share_links" ADD CONSTRAINT "purchase_order_share_links_order_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_request_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_request_id") REFERENCES "public"."purchase_requests"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_request_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_request_id") REFERENCES "public"."purchase_requests"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_uom_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_document_sequences" ADD CONSTRAINT "purchasing_document_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_idempotency" ADD CONSTRAINT "purchasing_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_idempotency" ADD CONSTRAINT "purchasing_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_uom_fk" FOREIGN KEY ("tenant_id","purchase_uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_email_deliveries_order_idx" ON "purchase_order_email_deliveries" USING btree ("tenant_id","outlet_id","purchase_order_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_order_idx" ON "purchase_order_lines" USING btree ("tenant_id","outlet_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_share_links_order_idx" ON "purchase_order_share_links" USING btree ("tenant_id","outlet_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_outlet_created_idx" ON "purchase_orders" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_outlet_status_idx" ON "purchase_orders" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_supplier_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_request_lines_request_idx" ON "purchase_request_lines" USING btree ("tenant_id","outlet_id","purchase_request_id");--> statement-breakpoint
CREATE INDEX "purchase_requests_tenant_outlet_created_idx" ON "purchase_requests" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_requests_tenant_outlet_status_idx" ON "purchase_requests" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_contacts_primary_idx" ON "supplier_contacts" USING btree ("tenant_id","supplier_id") WHERE "supplier_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "supplier_contacts_tenant_supplier_idx" ON "supplier_contacts" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE INDEX "supplier_prices_lookup_idx" ON "supplier_prices" USING btree ("tenant_id","supplier_id","inventory_item_id","effective_from","created_at");--> statement-breakpoint
CREATE INDEX "supplier_prices_item_idx" ON "supplier_prices" USING btree ("tenant_id","inventory_item_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_lower_name_idx" ON "suppliers" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "suppliers_tenant_active_name_idx" ON "suppliers" USING btree ("tenant_id","is_active","name","id");