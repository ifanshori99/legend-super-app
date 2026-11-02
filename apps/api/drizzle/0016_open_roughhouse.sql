CREATE TABLE "payment_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_ref" varchar(100) NOT NULL,
	"method" varchar(20) NOT NULL,
	"source" varchar(30) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_evidence_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_evidence_provider_ref_key" UNIQUE("tenant_id","provider","provider_ref"),
	CONSTRAINT "payment_evidence_amount_check" CHECK ("payment_evidence"."amount_idr" > 0),
	CONSTRAINT "payment_evidence_source_check" CHECK ("payment_evidence"."source" IN ('verified_webhook', 'gateway_status', 'edc_ecr', 'authorized_cash', 'authorized_edc_standalone')),
	CONSTRAINT "payment_evidence_method_check" CHECK ("payment_evidence"."method" IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher'))
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_link_id" uuid NOT NULL,
	"order_id" uuid,
	"bill_split_id" uuid,
	"reservation_id" uuid,
	"access_ticket_id" uuid,
	"subscription_invoice_id" uuid,
	"method" varchar(20) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"fee_idr" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"provider_ref" varchar(100),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"edc_transaction_id" uuid,
	"instructions" jsonb NOT NULL,
	"channel_code" varchar(40),
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "payment_intents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_intents_amount_check" CHECK ("payment_intents"."amount_idr" > 0),
	CONSTRAINT "payment_intents_fee_check" CHECK ("payment_intents"."fee_idr" >= 0),
	CONSTRAINT "payment_intents_status_check" CHECK ("payment_intents"."status" IN ('pending', 'paid', 'expired', 'failed', 'refunded', 'partially_refunded')),
	CONSTRAINT "payment_intents_method_check" CHECK ("payment_intents"."method" IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher')),
	CONSTRAINT "payment_intents_flags_check" CHECK ("payment_intents"."flags" <@ ARRAY['late_payment', 'double_payment']::text[]),
	CONSTRAINT "payment_intents_paid_at_check" CHECK (("payment_intents"."status" IN ('paid', 'partially_refunded', 'refunded')) = ("payment_intents"."paid_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_link_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_link_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"reference" varchar(40) NOT NULL,
	"table_label" varchar(40),
	"pax" integer,
	"subtotal_idr" bigint NOT NULL,
	"discount_idr" bigint DEFAULT 0 NOT NULL,
	"service_charge_idr" bigint DEFAULT 0 NOT NULL,
	"tax_idr" bigint DEFAULT 0 NOT NULL,
	"rounding_idr" bigint DEFAULT 0 NOT NULL,
	"total_idr" bigint NOT NULL,
	"paid_idr" bigint DEFAULT 0 NOT NULL,
	"return_path" varchar(300),
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "payment_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_links_total_check" CHECK ("payment_links"."total_idr" = "payment_links"."subtotal_idr" - "payment_links"."discount_idr" + "payment_links"."service_charge_idr" + "payment_links"."tax_idr" + "payment_links"."rounding_idr"),
	CONSTRAINT "payment_links_paid_check" CHECK ("payment_links"."paid_idr" BETWEEN 0 AND "payment_links"."total_idr"),
	CONSTRAINT "payment_links_amounts_check" CHECK ("payment_links"."subtotal_idr" >= 0 AND "payment_links"."discount_idr" >= 0 AND "payment_links"."service_charge_idr" >= 0 AND "payment_links"."tax_idr" >= 0 AND "payment_links"."total_idr" >= 0),
	CONSTRAINT "payment_links_table_pair_check" CHECK (("payment_links"."table_label" IS NULL) = ("payment_links"."pax" IS NULL)),
	CONSTRAINT "payment_links_pax_check" CHECK ("payment_links"."pax" IS NULL OR "payment_links"."pax" BETWEEN 1 AND 30),
	CONSTRAINT "payment_links_return_path_check" CHECK ("payment_links"."return_path" IS NULL OR "payment_links"."return_path" ~ '^/(?!/)')
);
--> statement-breakpoint
CREATE TABLE "payment_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"method" varchar(20) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"fallback_provider" varchar(20),
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_routing_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_routing_rules_method_check" CHECK ("payment_routing_rules"."method" IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher')),
	CONSTRAINT "payment_routing_rules_provider_check" CHECK ("payment_routing_rules"."provider" <> '' AND ("payment_routing_rules"."fallback_provider" IS NULL OR "payment_routing_rules"."fallback_provider" <> ''))
);
--> statement-breakpoint
CREATE TABLE "payment_unallocated_funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"reason" varchar(20) NOT NULL,
	"resolution" varchar(20),
	"resolved_by" text,
	"approval_ref" varchar(100),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_unallocated_funds_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_unallocated_funds_amount_check" CHECK ("payment_unallocated_funds"."amount_idr" > 0),
	CONSTRAINT "payment_unallocated_funds_reason_check" CHECK ("payment_unallocated_funds"."reason" IN ('overpayment', 'double_payment')),
	CONSTRAINT "payment_unallocated_funds_resolution_check" CHECK ("payment_unallocated_funds"."resolution" IS NULL OR "payment_unallocated_funds"."resolution" IN ('refund', 'credit')),
	CONSTRAINT "payment_unallocated_funds_resolved_check" CHECK (("payment_unallocated_funds"."resolution" IS NULL AND "payment_unallocated_funds"."resolved_by" IS NULL AND "payment_unallocated_funds"."resolved_at" IS NULL) OR ("payment_unallocated_funds"."resolution" IS NOT NULL AND "payment_unallocated_funds"."resolved_by" IS NOT NULL AND "payment_unallocated_funds"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_link_fk" FOREIGN KEY ("tenant_id","payment_link_id") REFERENCES "public"."payment_links"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_tokens" ADD CONSTRAINT "payment_link_tokens_link_fk" FOREIGN KEY ("tenant_id","payment_link_id") REFERENCES "public"."payment_links"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_routing_rules" ADD CONSTRAINT "payment_routing_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_routing_rules" ADD CONSTRAINT "payment_routing_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_unallocated_funds" ADD CONSTRAINT "payment_unallocated_funds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_unallocated_funds" ADD CONSTRAINT "payment_unallocated_funds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_unallocated_funds" ADD CONSTRAINT "payment_unallocated_funds_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_unallocated_funds" ADD CONSTRAINT "payment_unallocated_funds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_evidence_intent_idx" ON "payment_evidence" USING btree ("tenant_id","payment_intent_id","received_at");--> statement-breakpoint
CREATE INDEX "payment_intents_status_expiry_idx" ON "payment_intents" USING btree ("tenant_id","outlet_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "payment_intents_link_status_idx" ON "payment_intents" USING btree ("tenant_id","payment_link_id","status");--> statement-breakpoint
CREATE INDEX "payment_link_tokens_expiry_idx" ON "payment_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_links_outlet_created_idx" ON "payment_links" USING btree ("tenant_id","outlet_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_routing_rules_tenant_default_key" ON "payment_routing_rules" USING btree ("tenant_id","method") WHERE "payment_routing_rules"."outlet_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_routing_rules_tenant_outlet_key" ON "payment_routing_rules" USING btree ("tenant_id","outlet_id","method") WHERE "payment_routing_rules"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_unallocated_funds_open_idx" ON "payment_unallocated_funds" USING btree ("tenant_id","outlet_id","resolved_at");