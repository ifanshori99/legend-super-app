CREATE TABLE "goods_receipts" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"number" varchar(40) NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"received_on" date NOT NULL,
	"qc_notes" varchar(500),
	"note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "goods_receipts_tenant_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "goods_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipts_received_by_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipts_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipts_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"quantity_received" numeric(14,4) NOT NULL,
	"quantity_rejected" numeric(14,4) NOT NULL,
	"accepted_base_quantity" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4) NOT NULL,
	"batch_code" varchar(40),
	"expires_on" date,
	"batch_id" uuid,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "goods_receipt_lines_receipt_po_line_key" UNIQUE("tenant_id","goods_receipt_id","purchase_order_line_id"),
	CONSTRAINT "goods_receipt_lines_receipt_line_no_key" UNIQUE("tenant_id","goods_receipt_id","line_no"),
	CONSTRAINT "goods_receipt_lines_received_check" CHECK ("goods_receipt_lines"."quantity_received" > 0),
	CONSTRAINT "goods_receipt_lines_rejected_check" CHECK ("goods_receipt_lines"."quantity_rejected" >= 0
        AND "goods_receipt_lines"."quantity_rejected" <= "goods_receipt_lines"."quantity_received"),
	CONSTRAINT "goods_receipt_lines_accepted_base_check" CHECK ("goods_receipt_lines"."accepted_base_quantity" >= 0),
	CONSTRAINT "goods_receipt_lines_unit_cost_check" CHECK ("goods_receipt_lines"."unit_cost_idr" >= 0),
	CONSTRAINT "goods_receipt_lines_expiry_batch_check" CHECK ("goods_receipt_lines"."expires_on" IS NULL OR "goods_receipt_lines"."batch_code" IS NOT NULL),
	CONSTRAINT "goods_receipt_lines_line_no_check" CHECK ("goods_receipt_lines"."line_no" > 0),
	CONSTRAINT "goods_receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_po_line_fk" FOREIGN KEY ("tenant_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_uom_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_lines_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_media" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"storage_object_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_media_pkey" PRIMARY KEY("tenant_id","goods_receipt_id","storage_object_id"),
	CONSTRAINT "goods_receipt_media_receipt_position_key" UNIQUE("tenant_id","goods_receipt_id","position"),
	CONSTRAINT "goods_receipt_media_position_check" CHECK ("goods_receipt_media"."position" BETWEEN 0 AND 9),
	CONSTRAINT "goods_receipt_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_media_receipt_fk" FOREIGN KEY ("tenant_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "goods_receipt_media_storage_object_fk" FOREIGN KEY ("tenant_id","storage_object_id") REFERENCES "public"."core_storage_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "purchasing_document_sequences" DROP CONSTRAINT "purchasing_document_sequences_kind_check";
--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_tenant_po_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","purchase_order_line_id");
--> statement-breakpoint
CREATE INDEX "goods_receipts_tenant_outlet_received_idx" ON "goods_receipts" USING btree ("tenant_id","outlet_id","received_at","id");
--> statement-breakpoint
CREATE INDEX "goods_receipts_tenant_order_idx" ON "goods_receipts" USING btree ("tenant_id","purchase_order_id");
--> statement-breakpoint
ALTER TABLE "purchasing_document_sequences" ADD CONSTRAINT "purchasing_document_sequences_kind_check" CHECK ("purchasing_document_sequences"."kind" IN ('PO', 'GR'));
--> statement-breakpoint
-- legend-o1o4s: tenant + outlet RLS (TEN-01/TEN-03). A goods receipt is
-- immutable history: enforce_tenant_rls grants the app role UPDATE/DELETE, so
-- the REVOKE below closes that (a correction is a later receipt or adjustment).
SELECT app.enforce_tenant_rls('public.goods_receipts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.goods_receipts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.goods_receipt_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.goods_receipt_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.goods_receipt_media'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.goods_receipt_media'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.goods_receipts FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.goods_receipt_lines FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.goods_receipt_media FROM legend_app;
