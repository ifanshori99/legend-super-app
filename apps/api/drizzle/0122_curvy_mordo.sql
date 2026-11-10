CREATE TABLE "promo_command_idempotency" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_command_idempotency_pkey" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "promo_command_idempotency_fingerprint_check" CHECK ("promo_command_idempotency"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "brand_websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_websites_tenant_brand_key" UNIQUE("tenant_id","brand_id"),
	CONSTRAINT "brand_websites_content_object_check" CHECK (jsonb_typeof("brand_websites"."content") = 'object')
);
--> statement-breakpoint
CREATE TABLE "delivery_channel_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"external_order_id" varchar(100) NOT NULL,
	"order_id" uuid,
	"pickup_number" varchar(30),
	"status" varchar(12) NOT NULL,
	"source" varchar(12) NOT NULL,
	"gross_idr" bigint NOT NULL,
	"commission_idr" bigint NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"seen_payload_hashes" varchar(64)[] DEFAULT '{}'::varchar[] NOT NULL,
	"last_signed_at" timestamp with time zone,
	"customer_note" varchar(300),
	"lines" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" varchar(300),
	"settled_at" timestamp with time zone,
	"settled_net_idr" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_channel_orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "delivery_channel_orders_external_key" UNIQUE("tenant_id","platform","external_order_id"),
	CONSTRAINT "delivery_channel_orders_platform_check" CHECK ("delivery_channel_orders"."platform" IN ('gofood', 'grabfood', 'shopeefood')),
	CONSTRAINT "delivery_channel_orders_status_check" CHECK ("delivery_channel_orders"."status" IN ('received', 'accepted', 'preparing', 'ready', 'picked_up', 'delivered', 'cancelled', 'rejected')),
	CONSTRAINT "delivery_channel_orders_source_check" CHECK ("delivery_channel_orders"."source" IN ('platform', 'manual_pos')),
	CONSTRAINT "delivery_channel_orders_payload_hash_check" CHECK ("delivery_channel_orders"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "delivery_channel_orders_money_check" CHECK ("delivery_channel_orders"."gross_idr" >= 0 AND "delivery_channel_orders"."commission_idr" >= 0 AND "delivery_channel_orders"."commission_idr" <= "delivery_channel_orders"."gross_idr"),
	CONSTRAINT "delivery_channel_orders_lines_check" CHECK (jsonb_typeof("delivery_channel_orders"."lines") = 'array' AND jsonb_array_length("delivery_channel_orders"."lines") >= 1),
	CONSTRAINT "delivery_channel_orders_settled_check" CHECK (("delivery_channel_orders"."settled_at" IS NULL) = ("delivery_channel_orders"."settled_net_idr" IS NULL)),
	CONSTRAINT "delivery_channel_orders_version_check" CHECK ("delivery_channel_orders"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "delivery_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"store_external_id" varchar(100),
	"commission_rate_bps" integer DEFAULT 0 NOT NULL,
	"is_open" boolean DEFAULT false NOT NULL,
	"closed_until" timestamp with time zone,
	"closed_reason" varchar(200),
	"sync_status" varchar(10) DEFAULT 'stale' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_error" varchar(300),
	"menu_item_count" integer DEFAULT 0 NOT NULL,
	"sold_out_item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_channels_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "delivery_channels_outlet_platform_key" UNIQUE("tenant_id","outlet_id","platform"),
	CONSTRAINT "delivery_channels_store_ref_key" UNIQUE("tenant_id","outlet_id","platform","store_external_id"),
	CONSTRAINT "delivery_channels_platform_check" CHECK ("delivery_channels"."platform" IN ('gofood', 'grabfood', 'shopeefood')),
	CONSTRAINT "delivery_channels_sync_status_check" CHECK ("delivery_channels"."sync_status" IN ('ok', 'stale', 'error')),
	CONSTRAINT "delivery_channels_commission_check" CHECK ("delivery_channels"."commission_rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "delivery_channels_counts_check" CHECK ("delivery_channels"."menu_item_count" >= 0 AND "delivery_channels"."sold_out_item_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"external_order_id" varchar(100) NOT NULL,
	"gross_idr" bigint NOT NULL,
	"commission_idr" bigint NOT NULL,
	"settled_net_idr" bigint NOT NULL,
	"delivery_channel_order_id" uuid,
	"status" varchar(14) NOT NULL,
	"variance_idr" bigint NOT NULL,
	"settled_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_settlement_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "delivery_settlement_lines_statement_key" UNIQUE("tenant_id","platform","external_order_id","settled_on"),
	CONSTRAINT "delivery_settlement_lines_platform_check" CHECK ("delivery_settlement_lines"."platform" IN ('gofood', 'grabfood', 'shopeefood')),
	CONSTRAINT "delivery_settlement_lines_status_check" CHECK ("delivery_settlement_lines"."status" IN ('matched', 'variance', 'unknown_order')),
	CONSTRAINT "delivery_settlement_lines_money_check" CHECK ("delivery_settlement_lines"."gross_idr" >= 0 AND "delivery_settlement_lines"."commission_idr" >= 0 AND "delivery_settlement_lines"."commission_idr" <= "delivery_settlement_lines"."gross_idr" AND "delivery_settlement_lines"."settled_net_idr" >= 0),
	CONSTRAINT "delivery_settlement_lines_order_link_check" CHECK (("delivery_settlement_lines"."status" = 'unknown_order') = ("delivery_settlement_lines"."delivery_channel_order_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_store_index" (
	"platform" varchar(20) NOT NULL,
	"store_external_id" varchar(100) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	CONSTRAINT "delivery_store_index_pkey" PRIMARY KEY("platform","store_external_id"),
	CONSTRAINT "delivery_store_index_channel_key" UNIQUE("tenant_id","outlet_id","platform"),
	CONSTRAINT "delivery_store_index_platform_check" CHECK ("delivery_store_index"."platform" IN ('gofood', 'grabfood', 'shopeefood'))
);
--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "outlet_scope" varchar(12) DEFAULT 'all_except' NOT NULL;--> statement-breakpoint
-- legend-wg5t pattern (see 0068): the migrator may be a plain table owner (no
-- SUPERUSER, no BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant
-- policies to it, and with no app.tenant_id set they raise 42501 while the
-- foreign keys below are validated against brands, outlets and orders. Lift
-- FORCE on those three for this transaction only; it is restored right after
-- the last foreign key, before commit (drizzle applies pending migrations in
-- one transaction, so no other session ever sees the lifted state). tenants
-- never had FORCE. delivery_channels is created in this migration and gets
-- FORCE only from the RLS migrations that follow.
ALTER TABLE public.brands NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promo_command_idempotency" ADD CONSTRAINT "promo_command_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD CONSTRAINT "delivery_channel_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD CONSTRAINT "delivery_channel_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD CONSTRAINT "delivery_channel_orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD CONSTRAINT "delivery_channel_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channels" ADD CONSTRAINT "delivery_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channels" ADD CONSTRAINT "delivery_channels_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_channels" ADD CONSTRAINT "delivery_channels_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_settlement_lines" ADD CONSTRAINT "delivery_settlement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_settlement_lines" ADD CONSTRAINT "delivery_settlement_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_settlement_lines" ADD CONSTRAINT "delivery_settlement_lines_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_settlement_lines" ADD CONSTRAINT "delivery_settlement_lines_order_fk" FOREIGN KEY ("tenant_id","delivery_channel_order_id") REFERENCES "public"."delivery_channel_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_store_index" ADD CONSTRAINT "delivery_store_index_channel_fk" FOREIGN KEY ("tenant_id","outlet_id","platform","store_external_id") REFERENCES "public"."delivery_channels"("tenant_id","outlet_id","platform","store_external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.brands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "delivery_channel_orders_outlet_idx" ON "delivery_channel_orders" USING btree ("tenant_id","outlet_id","received_at");--> statement-breakpoint
CREATE INDEX "delivery_channel_orders_order_idx" ON "delivery_channel_orders" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_channels_store_key" ON "delivery_channels" USING btree ("platform","store_external_id") WHERE "delivery_channels"."store_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "delivery_settlement_lines_period_idx" ON "delivery_settlement_lines" USING btree ("tenant_id","outlet_id","platform","settled_on");--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_outlet_scope_check" CHECK ("promotions"."outlet_scope" IN ('all_except', 'only'));
