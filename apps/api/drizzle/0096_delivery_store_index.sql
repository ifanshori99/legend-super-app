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
ALTER TABLE "delivery_channel_orders" ADD COLUMN "seen_payload_hashes" varchar(64)[] DEFAULT '{}'::varchar[] NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_channel_orders" ADD COLUMN "last_signed_at" timestamp with time zone;--> statement-breakpoint
-- The foreign key below needs its target unique key first (hand-ordered).
ALTER TABLE "delivery_channels" ADD CONSTRAINT "delivery_channels_store_ref_key" UNIQUE("tenant_id","outlet_id","platform","store_external_id");--> statement-breakpoint
ALTER TABLE "delivery_store_index" ADD CONSTRAINT "delivery_store_index_channel_fk" FOREIGN KEY ("tenant_id","outlet_id","platform","store_external_id") REFERENCES "public"."delivery_channels"("tenant_id","outlet_id","platform","store_external_id") ON DELETE cascade ON UPDATE no action;