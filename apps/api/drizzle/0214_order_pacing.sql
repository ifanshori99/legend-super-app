CREATE TABLE "kitchen_channel_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"station_id" uuid,
	"channels" jsonb NOT NULL,
	"reason" varchar(20) NOT NULL,
	"paused_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "kitchen_channel_pauses_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_channel_pauses_reason_check" CHECK ("kitchen_channel_pauses"."reason" IN ('station_capacity', 'long_prep', 'manual')),
	CONSTRAINT "kitchen_channel_pauses_channels_check" CHECK (jsonb_typeof("kitchen_channel_pauses"."channels") = 'array' AND jsonb_array_length("kitchen_channel_pauses"."channels") > 0),
	CONSTRAINT "kitchen_channel_pauses_station_reason_check" CHECK ("kitchen_channel_pauses"."reason" <> 'station_capacity' OR "kitchen_channel_pauses"."station_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "kitchen_menu_loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"load_points" integer NOT NULL,
	"prep_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_menu_loads_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_menu_loads_points_check" CHECK ("kitchen_menu_loads"."load_points" BETWEEN 1 AND 100),
	CONSTRAINT "kitchen_menu_loads_prep_check" CHECK ("kitchen_menu_loads"."prep_seconds" BETWEEN 1 AND 7200)
);
--> statement-breakpoint
CREATE TABLE "kitchen_pacing_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"level" varchar(20) NOT NULL,
	"used_points" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "kitchen_pacing_state_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_pacing_state_station_key" UNIQUE("tenant_id","outlet_id","station_id"),
	CONSTRAINT "kitchen_pacing_state_level_check" CHECK ("kitchen_pacing_state"."level" IN ('available', 'near_capacity', 'at_capacity')),
	CONSTRAINT "kitchen_pacing_state_points_check" CHECK ("kitchen_pacing_state"."used_points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_menu_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."item_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_channel_pauses" ADD CONSTRAINT "kitchen_channel_pauses_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD CONSTRAINT "kitchen_menu_loads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD CONSTRAINT "kitchen_menu_loads_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD CONSTRAINT "kitchen_menu_loads_menu_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD CONSTRAINT "kitchen_menu_loads_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."item_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD CONSTRAINT "kitchen_menu_loads_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pacing_state" ADD CONSTRAINT "kitchen_pacing_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pacing_state" ADD CONSTRAINT "kitchen_pacing_state_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pacing_state" ADD CONSTRAINT "kitchen_pacing_state_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pacing_state" ADD CONSTRAINT "kitchen_pacing_state_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_channel_pauses_auto_live_key" ON "kitchen_channel_pauses" USING btree ("tenant_id","outlet_id","station_id","menu_item_id",COALESCE("variant_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "kitchen_channel_pauses"."reason" = 'station_capacity' AND "kitchen_channel_pauses"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "kitchen_channel_pauses_live_idx" ON "kitchen_channel_pauses" USING btree ("tenant_id","outlet_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_menu_loads_line_key" ON "kitchen_menu_loads" USING btree ("tenant_id","outlet_id","menu_item_id",COALESCE("variant_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_menu_loads'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_menu_loads'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_channel_pauses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_channel_pauses'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_pacing_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_pacing_state'::regclass);
