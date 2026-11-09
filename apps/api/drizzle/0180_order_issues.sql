CREATE TABLE "order_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"reason" varchar(20) NOT NULL,
	"reason_note" varchar(500) NOT NULL,
	"station_id" uuid,
	"employee_id" text,
	"reported_by" text NOT NULL,
	"resolution" varchar(20),
	"replacement_item_id" uuid,
	"voucher_id" uuid,
	"price_difference_idr" bigint,
	"approved_by" text,
	"cost_idr" bigint NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "order_issues_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_issues_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "order_issues_type_check" CHECK ("order_issues"."type" IN ('unfulfillable', 'remake', 'comp', 'complaint')),
	CONSTRAINT "order_issues_reason_check" CHECK ("order_issues"."reason" IN ('wrong_order', 'quality', 'late', 'complaint', 'out_of_stock', 'other')),
	CONSTRAINT "order_issues_resolution_check" CHECK ("order_issues"."resolution" IS NULL OR "order_issues"."resolution" IN ('swap', 'voucher', 'manual_refund')),
	CONSTRAINT "order_issues_status_check" CHECK ("order_issues"."status" IN ('open', 'resolved', 'cancelled')),
	CONSTRAINT "order_issues_cost_check" CHECK ("order_issues"."cost_idr" >= 0),
	CONSTRAINT "order_issues_staff_check" CHECK ("order_issues"."type" NOT IN ('remake', 'comp') OR "order_issues"."employee_id" IS NOT NULL),
	CONSTRAINT "order_issues_refund_approval_check" CHECK ("order_issues"."resolution" IS DISTINCT FROM 'manual_refund' OR ("order_issues"."approved_by" IS NOT NULL AND length(btrim("order_issues"."reason_note")) >= 10)),
	CONSTRAINT "order_issues_voucher_check" CHECK ("order_issues"."resolution" IS DISTINCT FROM 'voucher' OR "order_issues"."voucher_id" IS NOT NULL),
	CONSTRAINT "order_issues_swap_check" CHECK ("order_issues"."resolution" IS DISTINCT FROM 'swap' OR "order_issues"."replacement_item_id" IS NOT NULL),
	CONSTRAINT "order_issues_resolved_check" CHECK (("order_issues"."status" = 'resolved') = ("order_issues"."resolved_at" IS NOT NULL)),
	CONSTRAINT "order_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "order_issues_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "order_issues_employee_id_user_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issues_reported_by_user_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issues_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issues_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id"),
	CONSTRAINT "order_issues_order_item_fk" FOREIGN KEY ("tenant_id","order_item_id") REFERENCES "public"."order_items"("tenant_id","id"),
	CONSTRAINT "order_issues_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id"),
	CONSTRAINT "order_issues_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "order_issues_outlet_created_idx" ON "order_issues" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "order_issues_order_item_idx" ON "order_issues" USING btree ("tenant_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_issues_comp_once_idx" ON "order_issues" USING btree ("tenant_id","order_item_id") WHERE "order_issues"."type" = 'comp' AND "order_issues"."status" <> 'cancelled';
--> statement-breakpoint
-- Tenant + outlet RLS (TEN-01/TEN-03). order_issues has outlet_id NOT NULL.
-- Rows are updated when an open issue is resolved; the API never deletes one.
SELECT app.enforce_tenant_rls('public.order_issues'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issues'::regclass);
