DROP INDEX "order_issues_resolved_item_once_idx";--> statement-breakpoint
ALTER TABLE "order_issues" ADD COLUMN "refund_rejected_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "order_issues_resolved_item_once_idx" ON "order_issues" USING btree ("tenant_id","order_item_id") WHERE "order_issues"."type" = 'unfulfillable' AND "order_issues"."resolution" IS NOT NULL AND "order_issues"."status" <> 'cancelled' AND "order_issues"."refund_rejected_at" IS NULL;--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_refund_rejected_check" CHECK ("order_issues"."refund_rejected_at" IS NULL OR "order_issues"."resolution" = 'manual_refund');
--> statement-breakpoint
CREATE TABLE "order_issue_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_issue_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"table_session_id" uuid,
	"route" varchar(10) NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"difference_idr" bigint NOT NULL,
	"gross_sales_idr" bigint NOT NULL,
	"service_charge_idr" bigint NOT NULL,
	"pbjt_idr" bigint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"payment_link_id" uuid,
	"payment_link_token_sealed" text,
	"payment_intent_id" uuid,
	"paid_at" timestamp with time zone,
	"cash_movement_id" uuid,
	"paid_by" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_issue_charges_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_issue_charges_cash_paid_check" CHECK ("order_issue_charges"."cash_movement_id" IS NULL OR ("order_issue_charges"."status" = 'paid' AND "order_issue_charges"."payment_intent_id" IS NULL)),
	CONSTRAINT "order_issue_charges_link_token_check" CHECK (("order_issue_charges"."payment_link_id" IS NULL) = ("order_issue_charges"."payment_link_token_sealed" IS NULL)),
	CONSTRAINT "order_issue_charges_route_check" CHECK ("order_issue_charges"."route" IN ('qr_link', 'pos')),
	CONSTRAINT "order_issue_charges_status_check" CHECK ("order_issue_charges"."status" IN ('open', 'paid', 'routed_pos', 'waived', 'expired')),
	CONSTRAINT "order_issue_charges_amount_check" CHECK ("order_issue_charges"."difference_idr" > 0 AND "order_issue_charges"."gross_sales_idr" >= 0 AND "order_issue_charges"."service_charge_idr" >= 0 AND "order_issue_charges"."pbjt_idr" >= 0 AND "order_issue_charges"."amount_idr" > 0 AND "order_issue_charges"."amount_idr" = "order_issue_charges"."gross_sales_idr" + "order_issue_charges"."service_charge_idr" + "order_issue_charges"."pbjt_idr"),
	CONSTRAINT "order_issue_charges_state_check" CHECK (("order_issue_charges"."status" = 'paid') = ("order_issue_charges"."paid_at" IS NOT NULL) AND ("order_issue_charges"."status" IN ('waived', 'expired')) = ("order_issue_charges"."closed_at" IS NOT NULL) AND ("order_issue_charges"."status" <> 'waived' OR ("order_issue_charges"."closed_by" IS NOT NULL AND "order_issue_charges"."close_reason" IS NOT NULL))),
	CONSTRAINT "order_issue_charges_route_status_check" CHECK (("order_issue_charges"."route" = 'pos') = ("order_issue_charges"."status" = 'routed_pos') OR "order_issue_charges"."status" IN ('paid', 'waived', 'expired')),
	CONSTRAINT "order_issue_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "order_issue_charges_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "order_issue_charges_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issue_charges_paid_by_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issue_charges_issue_fk" FOREIGN KEY ("tenant_id","order_issue_id") REFERENCES "public"."order_issues"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_link_fk" FOREIGN KEY ("tenant_id","payment_link_id") REFERENCES "public"."payment_links"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id"),
	CONSTRAINT "order_issue_charges_cash_movement_fk" FOREIGN KEY ("tenant_id","cash_movement_id") REFERENCES "public"."cash_movements"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charges_issue_once_idx" ON "order_issue_charges" USING btree ("tenant_id","order_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charges_link_once_idx" ON "order_issue_charges" USING btree ("tenant_id","payment_link_id") WHERE "order_issue_charges"."payment_link_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charges_cash_movement_once_idx" ON "order_issue_charges" USING btree ("tenant_id","cash_movement_id") WHERE "order_issue_charges"."cash_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "order_issue_charges_session_open_idx" ON "order_issue_charges" USING btree ("tenant_id","table_session_id") WHERE "order_issue_charges"."status" = 'open';
--> statement-breakpoint
-- legend-i83ls: order_issue_charges, tenant + outlet RLS. Append AFTER its
-- generated CREATE TABLE. Rows are updated (paid, waived, expired); never deleted.
SELECT app.enforce_tenant_rls('public.order_issue_charges'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issue_charges'::regclass);
