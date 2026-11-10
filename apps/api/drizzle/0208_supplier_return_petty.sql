-- legend-65mgw: supplier returns (purchase_returns, purchase_return_lines) and
-- simple petty purchases (petty_purchases, petty_purchase_policies). Number
-- 0208 and its `when` were assigned by the coordinator.
-- The generated part also widens purchasing_document_sequences_kind_check to
-- PO/GR/RT and core_storage_objects_source_kind_check to include
-- 'petty_purchase'; existing rows already satisfy both. The custom part below
-- adds RLS and backfills the new permission codes into stored role rows.
CREATE TABLE "purchase_return_lines" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_return_id" uuid NOT NULL,
	"goods_receipt_line_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid,
	"batch_code" varchar(40),
	"quantity" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4) NOT NULL,
	"line_value_idr" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_return_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_return_lines_return_receipt_line_key" UNIQUE("tenant_id","purchase_return_id","goods_receipt_line_id"),
	CONSTRAINT "purchase_return_lines_return_line_no_key" UNIQUE("tenant_id","purchase_return_id","line_no"),
	CONSTRAINT "purchase_return_lines_quantity_check" CHECK ("purchase_return_lines"."quantity" > 0),
	CONSTRAINT "purchase_return_lines_unit_cost_check" CHECK ("purchase_return_lines"."unit_cost_idr" >= 0),
	CONSTRAINT "purchase_return_lines_value_check" CHECK ("purchase_return_lines"."line_value_idr" >= 0),
	CONSTRAINT "purchase_return_lines_line_no_check" CHECK ("purchase_return_lines"."line_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"number" varchar(40) NOT NULL,
	"reason" varchar(20) NOT NULL,
	"returned_on" date NOT NULL,
	"returned_at" timestamp with time zone NOT NULL,
	"returned_by" text NOT NULL,
	"value_idr" bigint NOT NULL,
	"uninvoiced_value_idr" bigint NOT NULL,
	"invoiced_value_idr" bigint NOT NULL,
	"ppn_idr" bigint NOT NULL,
	"note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_returns_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_returns_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "purchase_returns_tenant_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "purchase_returns_reason_check" CHECK ("purchase_returns"."reason" IN ('damaged', 'wrong_item', 'expired', 'quality_reject', 'over_delivery', 'other')),
	CONSTRAINT "purchase_returns_amounts_check" CHECK ("purchase_returns"."value_idr" >= 0
        AND "purchase_returns"."uninvoiced_value_idr" >= 0
        AND "purchase_returns"."invoiced_value_idr" >= 0
        AND "purchase_returns"."ppn_idr" >= 0),
	CONSTRAINT "purchase_returns_split_check" CHECK ("purchase_returns"."value_idr" = "purchase_returns"."uninvoiced_value_idr" + "purchase_returns"."invoiced_value_idr"),
	CONSTRAINT "purchase_returns_ppn_check" CHECK ("purchase_returns"."ppn_idr" = 0 OR "purchase_returns"."invoiced_value_idr" > 0),
	CONSTRAINT "purchase_returns_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "petty_purchase_policies" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid,
	"limit_idr" bigint NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_purchase_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "petty_purchase_policies_limit_check" CHECK ("petty_purchase_policies"."limit_idr" > 0),
	CONSTRAINT "petty_purchase_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "petty_purchases" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_name" varchar(150) NOT NULL,
	"description" varchar(200) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"photo_object_id" uuid NOT NULL,
	"paid_by" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"limit_idr_applied" bigint NOT NULL,
	"note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_purchases_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "petty_purchases_tenant_photo_key" UNIQUE("tenant_id","photo_object_id"),
	CONSTRAINT "petty_purchases_amount_check" CHECK ("petty_purchases"."amount_idr" > 0),
	CONSTRAINT "petty_purchases_limit_check" CHECK ("petty_purchases"."limit_idr_applied" > 0),
	CONSTRAINT "petty_purchases_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "core_storage_objects" DROP CONSTRAINT "core_storage_objects_source_kind_check";--> statement-breakpoint
ALTER TABLE "purchasing_document_sequences" DROP CONSTRAINT "purchasing_document_sequences_kind_check";--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_fk" FOREIGN KEY ("tenant_id","outlet_id","purchase_return_id") REFERENCES "public"."purchase_returns"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_receipt_line_fk" FOREIGN KEY ("tenant_id","goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_po_line_fk" FOREIGN KEY ("tenant_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_returned_by_user_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_receipt_fk" FOREIGN KEY ("tenant_id","outlet_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_purchase_policies" ADD CONSTRAINT "petty_purchase_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_purchase_policies" ADD CONSTRAINT "petty_purchase_policies_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_purchases" ADD CONSTRAINT "petty_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_purchases" ADD CONSTRAINT "petty_purchases_paid_by_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_purchases" ADD CONSTRAINT "petty_purchases_photo_fk" FOREIGN KEY ("tenant_id","photo_object_id") REFERENCES "public"."core_storage_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_return_lines_tenant_receipt_line_idx" ON "purchase_return_lines" USING btree ("tenant_id","goods_receipt_line_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_tenant_outlet_returned_idx" ON "purchase_returns" USING btree ("tenant_id","outlet_id","returned_at","id");--> statement-breakpoint
CREATE INDEX "purchase_returns_tenant_receipt_idx" ON "purchase_returns" USING btree ("tenant_id","goods_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_purchase_policies_tenant_default_key" ON "petty_purchase_policies" USING btree ("tenant_id") WHERE "petty_purchase_policies"."outlet_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "petty_purchase_policies_tenant_outlet_key" ON "petty_purchase_policies" USING btree ("tenant_id","outlet_id") WHERE "petty_purchase_policies"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "petty_purchases_tenant_outlet_date_idx" ON "petty_purchases" USING btree ("tenant_id","outlet_id","business_date","id");--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_source_kind_check" CHECK ("core_storage_objects"."source_kind" IS NULL OR "core_storage_objects"."source_kind" IN ('purchase_invoice', 'goods_receipt', 'expense', 'cash_deposit', 'reimbursement', 'attendance', 'employee_document', 'employment_contract', 'leave_request', 'menu_item', 'petty_purchase'));--> statement-breakpoint
ALTER TABLE "purchasing_document_sequences" ADD CONSTRAINT "purchasing_document_sequences_kind_check" CHECK ("purchasing_document_sequences"."kind" IN ('PO', 'GR', 'RT'));
--> statement-breakpoint
-- Tenant + outlet RLS (TEN-01/TEN-03), as in 0173. A purchase return and a
-- petty purchase are immutable history: enforce_tenant_rls grants the app role
-- UPDATE/DELETE, so the REVOKE below closes that (a correction is a later
-- document). The petty purchase policy has a nullable outlet_id (NULL is the
-- tenant default), so it gets tenant RLS only; it may be updated (audited) but
-- never deleted.
SELECT app.enforce_tenant_rls('public.purchase_returns'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_returns'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_return_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_return_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.petty_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.petty_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.petty_purchase_policies'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.purchase_returns FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.purchase_return_lines FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.petty_purchases FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.petty_purchase_policies FROM legend_app;
--> statement-breakpoint
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (same pattern as 0172).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- New permission codes. Role rows are seeded once per tenant and the resolver
-- reads the stored rows, so existing tenants need the codes appended to the
-- template rows that hold them in the catalog (packages/shared roles.ts):
--   purchasing.return.create       owner, purchasing, warehouse
--   purchasing.petty.record        owner, general_manager, outlet_manager,
--                                  kitchen_lead, purchasing
--   purchasing.petty_policy.manage owner, finance
-- Idempotent: skips rows that already hold the code.
UPDATE "roles"
SET "permissions" = "permissions" || '["purchasing.return.create"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'purchasing', 'warehouse')
  AND NOT ("permissions" @> '["purchasing.return.create"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["purchasing.petty.record"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager', 'kitchen_lead', 'purchasing')
  AND NOT ("permissions" @> '["purchasing.petty.record"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["purchasing.petty_policy.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'finance')
  AND NOT ("permissions" @> '["purchasing.petty_policy.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
