-- Define FKs while this new table is empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "prep_item_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"shelf_life_minutes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "prep_item_settings_tenant_outlet_item_key" UNIQUE("tenant_id","outlet_id","inventory_item_id"),
	CONSTRAINT "prep_item_settings_lifetime_check" CHECK ("prep_item_settings"."shelf_life_minutes" > 0),
	CONSTRAINT "prep_item_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "prep_item_settings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "prep_item_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "prep_item_settings_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "prep_item_settings_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "prep_item_settings_tenant_outlet_updated_idx" ON "prep_item_settings" USING btree ("tenant_id","outlet_id","updated_at","id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.prep_item_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.prep_item_settings'::regclass);
