-- legend-4us1a: facility operating hours with an effective date, plus the
-- floor_zones.is_wfc and menu_items.is_breakfast flags (both default false).
--
-- facility_operating_hours_versions: one row per (facility, effective_from).
-- Seeded with one version per existing facility at 1970-01-01, copied from
-- facilities.operating_hours, so every existing facility keeps its hours.
--
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS; see
-- 0065). The seed INSERT ... SELECT reads facilities under FORCE ROW LEVEL
-- SECURITY, which raises 42501 without app.tenant_id. Lift FORCE on
-- facilities for this transaction only; it is restored right after the seed
-- (drizzle applies pending migrations in one transaction). The new table gets
-- its RLS only after the seed, so the seed is not filtered by its policies.
CREATE TABLE "facility_operating_hours_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"operating_hours" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_operating_hours_versions_key" UNIQUE("tenant_id","facility_id","effective_from"),
	CONSTRAINT "facility_operating_hours_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_operating_hours_versions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_operating_hours_versions_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "facility_operating_hours_versions_lookup_idx" ON "facility_operating_hours_versions" USING btree ("tenant_id","facility_id","effective_from");--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "is_breakfast" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_zones" ADD COLUMN "is_wfc" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE public.facilities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "facility_operating_hours_versions" ("tenant_id", "outlet_id", "facility_id", "effective_from", "operating_hours") SELECT "tenant_id", "outlet_id", "id", DATE '1970-01-01', "operating_hours" FROM "facilities";--> statement-breakpoint
ALTER TABLE public.facilities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.facility_operating_hours_versions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_operating_hours_versions'::regclass);
