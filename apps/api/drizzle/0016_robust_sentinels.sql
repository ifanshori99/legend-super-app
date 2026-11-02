CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"category" varchar(50) NOT NULL,
	"type" varchar(20) DEFAULT 'raw_material' NOT NULL,
	"base_uom_id" uuid NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"par_min" numeric(14,4),
	"par_max" numeric(14,4),
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_items_type_check" CHECK ("inventory_items"."type" IN ('raw_material', 'semi_finished')),
	CONSTRAINT "inventory_items_par_check" CHECK (("inventory_items"."par_min" IS NULL OR "inventory_items"."par_min" >= 0) AND ("inventory_items"."par_max" IS NULL OR "inventory_items"."par_max" >= 0) AND ("inventory_items"."par_min" IS NULL OR "inventory_items"."par_max" IS NULL OR "inventory_items"."par_max" >= "inventory_items"."par_min"))
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"avg_cost_idr" numeric(14,4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_pkey" PRIMARY KEY("tenant_id","location_id","inventory_item_id"),
	CONSTRAINT "stock_balances_avg_cost_check" CHECK ("stock_balances"."avg_cost_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"batch_code" varchar(40) NOT NULL,
	"expires_on" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batches_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_batches_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id")
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"movement_type" varchar(20) NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4) NOT NULL,
	"batch_id" uuid,
	"source_type" varchar(30) NOT NULL,
	"source_id" uuid NOT NULL,
	"idempotency_key" varchar(255),
	"request_fingerprint" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ledger_idempotency_pair_check" CHECK (("stock_ledger"."idempotency_key" IS NULL) = ("stock_ledger"."request_fingerprint" IS NULL)),
	CONSTRAINT "stock_ledger_quantity_check" CHECK ("stock_ledger"."quantity" <> 0),
	CONSTRAINT "stock_ledger_unit_cost_check" CHECK ("stock_ledger"."unit_cost_idr" >= 0),
	CONSTRAINT "stock_ledger_movement_type_check" CHECK ("stock_ledger"."movement_type" IN ('receipt', 'sale', 'production_in', 'production_out', 'transfer_in', 'transfer_out', 'waste', 'adjustment', 'duty_meal', 'return')),
	CONSTRAINT "stock_ledger_source_type_check" CHECK ("stock_ledger"."source_type" IN ('goods_receipt', 'order', 'production_order', 'stock_transfer', 'stock_count', 'waste_log', 'purchase_return', 'duty_meal')),
	CONSTRAINT "stock_ledger_source_pair_check" CHECK (("stock_ledger"."movement_type", "stock_ledger"."source_type") IN (
        ('receipt', 'goods_receipt'),
        ('sale', 'order'),
        ('production_in', 'production_order'),
        ('production_out', 'production_order'),
        ('transfer_in', 'stock_transfer'),
        ('transfer_out', 'stock_transfer'),
        ('waste', 'waste_log'),
        ('adjustment', 'stock_count'),
        ('duty_meal', 'duty_meal'),
        ('return', 'purchase_return'),
        ('return', 'order')
      )),
	CONSTRAINT "stock_ledger_direction_check" CHECK ((
        ("stock_ledger"."movement_type" IN ('receipt', 'production_in', 'transfer_in') AND "stock_ledger"."quantity" > 0)
        OR ("stock_ledger"."movement_type" IN ('sale', 'production_out', 'transfer_out', 'waste', 'duty_meal') AND "stock_ledger"."quantity" < 0)
        OR ("stock_ledger"."movement_type" = 'adjustment')
        OR ("stock_ledger"."movement_type" = 'return' AND "stock_ledger"."source_type" = 'purchase_return' AND "stock_ledger"."quantity" < 0)
        OR ("stock_ledger"."movement_type" = 'return' AND "stock_ledger"."source_type" = 'order' AND "stock_ledger"."quantity" > 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_locations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_locations_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "stock_locations_type_check" CHECK ("stock_locations"."type" IN ('warehouse', 'chiller', 'freezer', 'bar', 'kitchen', 'pastry'))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14,4) NOT NULL,
	CONSTRAINT "stock_transfer_lines_tenant_pair_key" UNIQUE("tenant_id","transfer_id","inventory_item_id"),
	CONSTRAINT "stock_transfer_lines_quantity_check" CHECK ("stock_transfer_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"moved_by" text NOT NULL,
	"idempotency_key" varchar(100),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "stock_transfers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_transfers_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "stock_transfers_locations_check" CHECK ("stock_transfers"."from_location_id" <> "stock_transfers"."to_location_id")
);
--> statement-breakpoint
CREATE TABLE "uom_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"from_uom_id" uuid NOT NULL,
	"to_uom_id" uuid NOT NULL,
	"factor" numeric(14,4) NOT NULL,
	CONSTRAINT "uom_conversions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "uom_conversions_tenant_item_pair_key" UNIQUE("tenant_id","inventory_item_id","from_uom_id","to_uom_id"),
	CONSTRAINT "uom_conversions_factor_check" CHECK ("uom_conversions"."factor" > 0 AND "uom_conversions"."from_uom_id" <> "uom_conversions"."to_uom_id")
);
--> statement-breakpoint
CREATE TABLE "uoms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(150) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uoms_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "uoms_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_base_uom_fk" FOREIGN KEY ("tenant_id","base_uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_batch_fk" FOREIGN KEY ("tenant_id","outlet_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_fk" FOREIGN KEY ("tenant_id","outlet_id","transfer_id") REFERENCES "public"."stock_transfers"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_moved_by_user_id_fk" FOREIGN KEY ("moved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_fk" FOREIGN KEY ("tenant_id","outlet_id","from_location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_fk" FOREIGN KEY ("tenant_id","outlet_id","to_location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_from_uom_fk" FOREIGN KEY ("tenant_id","from_uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_to_uom_fk" FOREIGN KEY ("tenant_id","to_uom_id") REFERENCES "public"."uoms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_tenant_idempotency_key" ON "inventory_items" USING btree ("tenant_id","idempotency_key") WHERE "inventory_items"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_items_tenant_name_idx" ON "inventory_items" USING btree ("tenant_id","name","id");--> statement-breakpoint
CREATE INDEX "inventory_items_tenant_category_idx" ON "inventory_items" USING btree ("tenant_id","category","name");--> statement-breakpoint
CREATE INDEX "stock_balances_tenant_outlet_item_idx" ON "stock_balances" USING btree ("tenant_id","outlet_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "stock_batches_tenant_outlet_received_idx" ON "stock_batches" USING btree ("tenant_id","outlet_id","received_at","id");--> statement-breakpoint
CREATE INDEX "stock_batches_tenant_outlet_expiry_idx" ON "stock_batches" USING btree ("tenant_id","outlet_id","expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ledger_tenant_idempotency_key_idx" ON "stock_ledger" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_ledger_tenant_location_item_idx" ON "stock_ledger" USING btree ("tenant_id","location_id","inventory_item_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "stock_ledger_tenant_outlet_occurred_idx" ON "stock_ledger" USING btree ("tenant_id","outlet_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "stock_locations_tenant_outlet_name_idx" ON "stock_locations" USING btree ("tenant_id","outlet_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_idempotency_key_idx" ON "stock_transfers" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_outlet_occurred_idx" ON "stock_transfers" USING btree ("tenant_id","outlet_id","occurred_at","id");