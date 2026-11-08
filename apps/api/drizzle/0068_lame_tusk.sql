CREATE TABLE "kitchen_station_cursors" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_station_cursors_pkey" PRIMARY KEY("tenant_id","station_id"),
	CONSTRAINT "kitchen_station_cursors_sequence_check" CHECK ("kitchen_station_cursors"."last_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kitchen_station_feed" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"ticket_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "kitchen_station_feed_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_station_feed_station_sequence_key" UNIQUE("tenant_id","station_id","sequence"),
	CONSTRAINT "kitchen_station_feed_sequence_check" CHECK ("kitchen_station_feed"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "kitchen_ticket_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"name" varchar(150) NOT NULL,
	"quantity" smallint NOT NULL,
	"course" varchar(20),
	"modifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" varchar(200),
	"status" varchar(20) NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"served_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"recalled_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_ticket_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_ticket_items_order_item_key" UNIQUE("tenant_id","order_item_id"),
	CONSTRAINT "kitchen_ticket_items_status_check" CHECK ("kitchen_ticket_items"."status" IN ('queued', 'in_progress', 'ready', 'served', 'voided')),
	CONSTRAINT "kitchen_ticket_items_quantity_check" CHECK ("kitchen_ticket_items"."quantity" BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE TABLE "kitchen_ticket_status_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"order_item_id" uuid,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"item_from_status" varchar(20),
	"item_to_status" varchar(20),
	"source" varchar(10) NOT NULL,
	"actor_id" uuid,
	"device_id" uuid,
	"reason" varchar(200),
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "kitchen_ticket_status_changes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_ticket_status_changes_source_check" CHECK ("kitchen_ticket_status_changes"."source" IN ('user', 'device', 'system')),
	CONSTRAINT "kitchen_ticket_status_changes_actor_check" CHECK ("kitchen_ticket_status_changes"."source" = 'system' OR "kitchen_ticket_status_changes"."actor_id" IS NOT NULL),
	CONSTRAINT "kitchen_ticket_status_changes_device_check" CHECK ("kitchen_ticket_status_changes"."source" <> 'device' OR "kitchen_ticket_status_changes"."device_id" IS NOT NULL),
	CONSTRAINT "kitchen_ticket_status_changes_reason_check" CHECK ("kitchen_ticket_status_changes"."to_status" NOT IN ('recalled', 'cancelled') OR "kitchen_ticket_status_changes"."reason" IS NOT NULL OR "kitchen_ticket_status_changes"."order_item_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "kitchen_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"fire_batch_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"served_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"printed_fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_tickets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_tickets_order_station_batch_key" UNIQUE("tenant_id","order_id","station_id","fire_batch_id"),
	CONSTRAINT "kitchen_tickets_status_check" CHECK ("kitchen_tickets"."status" IN ('new', 'in_progress', 'done', 'recalled', 'cancelled')),
	CONSTRAINT "kitchen_tickets_priority_check" CHECK ("kitchen_tickets"."priority" BETWEEN 0 AND 9)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "station_type" varchar(20);--> statement-breakpoint
ALTER TABLE "kitchen_station_cursors" ADD CONSTRAINT "kitchen_station_cursors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_cursors" ADD CONSTRAINT "kitchen_station_cursors_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_cursors" ADD CONSTRAINT "kitchen_station_cursors_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_cursors" ADD CONSTRAINT "kitchen_station_cursors_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_feed" ADD CONSTRAINT "kitchen_station_feed_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_feed" ADD CONSTRAINT "kitchen_station_feed_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_feed" ADD CONSTRAINT "kitchen_station_feed_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_feed" ADD CONSTRAINT "kitchen_station_feed_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."kitchen_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_station_feed" ADD CONSTRAINT "kitchen_station_feed_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."kitchen_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_order_item_fk" FOREIGN KEY ("tenant_id","order_item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_status_changes" ADD CONSTRAINT "kitchen_ticket_status_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_status_changes" ADD CONSTRAINT "kitchen_ticket_status_changes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_status_changes" ADD CONSTRAINT "kitchen_ticket_status_changes_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."kitchen_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_status_changes" ADD CONSTRAINT "kitchen_ticket_status_changes_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_station_feed_ticket_idx" ON "kitchen_station_feed" USING btree ("tenant_id","station_id","ticket_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_items_ticket_idx" ON "kitchen_ticket_items" USING btree ("tenant_id","ticket_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_status_changes_ticket_idx" ON "kitchen_ticket_status_changes" USING btree ("tenant_id","ticket_id","occurred_at");--> statement-breakpoint
CREATE INDEX "kitchen_tickets_station_status_idx" ON "kitchen_tickets" USING btree ("tenant_id","station_id","status");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_station_type_check" CHECK ("menu_items"."station_type" IS NULL OR "menu_items"."station_type" IN ('coffee_bar', 'beverage_bar', 'hot_kitchen', 'cold_kitchen', 'pastry'));