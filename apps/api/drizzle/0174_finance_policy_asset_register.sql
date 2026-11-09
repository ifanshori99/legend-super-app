CREATE TABLE "asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_categories_name_check" CHECK (length(btrim("asset_categories"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "finance_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"bank_matching_date_tolerance_days" integer DEFAULT 2 NOT NULL,
	"max_days_undeposited" integer DEFAULT 2 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_policies_tolerance_check" CHECK ("finance_policies"."bank_matching_date_tolerance_days" BETWEEN 0 AND 14),
	CONSTRAINT "finance_policies_undeposited_check" CHECK ("finance_policies"."max_days_undeposited" BETWEEN 0 AND 30)
);
--> statement-breakpoint
-- legend-dux2: add-only. "code" is added nullable, backfilled deterministically
-- per (tenant, legal entity) from creation order (created_at, then id), then
-- made NOT NULL before the unique key below is attached. Existing columns and
-- rows are otherwise untouched.
ALTER TABLE "fixed_assets" ADD COLUMN "code" varchar(40);--> statement-breakpoint
-- The migrator may be a plain table owner (no BYPASSRLS): FORCE RLS would apply
-- the tenant policy to the backfill and raise 42501 (no app.tenant_id). Lift it
-- for this transaction only and restore it right after (same pattern as 0139).
ALTER TABLE public.fixed_assets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "fixed_assets" fa SET "code" = 'FA-' || lpad(n.seq::text, 5, '0')
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "tenant_id", "legal_entity_id" ORDER BY "created_at", "id") AS seq
  FROM "fixed_assets"
) n
WHERE fa."id" = n."id";--> statement-breakpoint
ALTER TABLE public.fixed_assets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_policies" ADD CONSTRAINT "finance_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_tenant_name_key" ON "asset_categories" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."asset_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenant_entity_code_key" UNIQUE("tenant_id","legal_entity_id","code");--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_code_check" CHECK (length(btrim("fixed_assets"."code")) > 0);--> statement-breakpoint
-- Tenant RLS on the two new tables, same call as schema/accounting-ap-fa.custom.sql.
SELECT app.enforce_tenant_rls('public.asset_categories'::regclass);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.finance_policies'::regclass);
