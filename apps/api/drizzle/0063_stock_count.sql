CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"system_qty" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4) NOT NULL,
	"counted_qty" numeric(14,4),
	"variance_qty" numeric(14,4),
	"variance_idr" bigint,
	"counted_by" text,
	"counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_count_lines_tenant_count_item_key" UNIQUE("tenant_id","stock_count_id","inventory_item_id"),
	CONSTRAINT "stock_count_lines_counted_check" CHECK ("stock_count_lines"."counted_qty" IS NULL OR "stock_count_lines"."counted_qty" >= 0),
	CONSTRAINT "stock_count_lines_counter_check" CHECK (("stock_count_lines"."counted_by" IS NULL) = ("stock_count_lines"."counted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"status" varchar(30) NOT NULL,
	"blind" boolean NOT NULL,
	"business_date" date NOT NULL,
	"note" text,
	"counted_by" text NOT NULL,
	"count_version" integer DEFAULT 0 NOT NULL,
	"snapshot_at" timestamp with time zone,
	"counted_at" timestamp with time zone,
	"approval_chain_id" uuid,
	"approval_version" integer,
	"lines_hash" varchar(64),
	"total_variance_idr" bigint,
	"gross_variance_idr" bigint,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"create_idempotency_key" varchar NOT NULL,
	"create_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_counts_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "stock_counts_tenant_create_idempotency_key" UNIQUE("tenant_id","create_idempotency_key"),
	CONSTRAINT "stock_counts_type_check" CHECK ("stock_counts"."type" IN ('full', 'cycle')),
	CONSTRAINT "stock_counts_status_check" CHECK ("stock_counts"."status" IN ('draft', 'counting', 'pending_approval', 'approved', 'posted', 'cancelled')),
	CONSTRAINT "stock_counts_version_check" CHECK ("stock_counts"."count_version" >= 0),
	CONSTRAINT "stock_counts_approved_check" CHECK ("stock_counts"."status" NOT IN ('approved', 'posted') OR ("stock_counts"."approved_by" IS NOT NULL AND "stock_counts"."approved_at" IS NOT NULL)),
	CONSTRAINT "stock_counts_posted_check" CHECK ("stock_counts"."status" <> 'posted' OR "stock_counts"."posted_at" IS NOT NULL),
	CONSTRAINT "stock_counts_approval_bound_check" CHECK ("stock_counts"."status" NOT IN ('pending_approval', 'approved', 'posted') OR ("stock_counts"."approval_chain_id" IS NOT NULL AND "stock_counts"."approval_version" IS NOT NULL AND "stock_counts"."lines_hash" IS NOT NULL AND "stock_counts"."counted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_by_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("tenant_id","outlet_id","stock_count_id") REFERENCES "public"."stock_counts"("tenant_id","outlet_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_fk" FOREIGN KEY ("tenant_id","outlet_id","location_id") REFERENCES "public"."stock_locations"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_lines_tenant_count_idx" ON "stock_count_lines" USING btree ("tenant_id","stock_count_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_open_location_idx" ON "stock_counts" USING btree ("tenant_id","location_id") WHERE "stock_counts"."status" IN ('draft', 'counting', 'pending_approval', 'approved');--> statement-breakpoint
CREATE INDEX "stock_counts_tenant_outlet_created_idx" ON "stock_counts" USING btree ("tenant_id","outlet_id","created_at","id");