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
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_websites" ADD CONSTRAINT "brand_websites_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Hand-copied from src/db/schema/website.custom.sql (legend-qgr6).
-- Custom SQL migration fragment for legend-qgr6 (WS-08 public brand website
-- content). Append AFTER the drizzle-generated CREATE TABLE for brand_websites.
--
-- Tenant-owned config without per-outlet reach: the featured outlet is data on
-- the row, not an access scope, so only the tenant policy applies. Rows are
-- updated in place (draft/publish) and never deleted by the app role: an
-- unpublished site keeps its content for the next publish.
SELECT app.enforce_tenant_rls('public.brand_websites'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.brand_websites FROM legend_app;
