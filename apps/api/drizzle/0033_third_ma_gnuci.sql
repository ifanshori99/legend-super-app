CREATE TABLE "menu_item_daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_daily_usage_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_item_daily_usage_quantity_check" CHECK ("menu_item_daily_usage"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menu_item_daily_usage" ADD CONSTRAINT "menu_item_daily_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_daily_usage" ADD CONSTRAINT "menu_item_daily_usage_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_daily_usage" ADD CONSTRAINT "menu_item_daily_usage_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_daily_usage_key" ON "menu_item_daily_usage" USING btree ("tenant_id","outlet_id","menu_item_id","business_date");--> statement-breakpoint
CREATE INDEX "menu_item_daily_usage_outlet_date_idx" ON "menu_item_daily_usage" USING btree ("tenant_id","outlet_id","business_date");
--> statement-breakpoint
-- TEN-01/TEN-03: the daily-usage counter is tenant isolated and outlet-owned,
-- so it carries the tenant policy and the outlet backstop (bead legend-h2a).
-- The tenant policy must exist first; enforce_outlet_rls checks for it.
SELECT app.enforce_tenant_rls('public.menu_item_daily_usage'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_item_daily_usage'::regclass);
