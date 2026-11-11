-- HPP read model and recompute queue (bead legend-2qq). Hand-written in the
-- drizzle-kit style; meta/0259_snapshot.json was rebuilt by the merge train and
-- `pnpm db:generate` is empty against it. Renumbered from temporary 0278.
-- RLS: the same statements as hpp.custom.sql.
CREATE TABLE "hpp_outlet_state" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"stale_at" timestamp with time zone,
	"rebuilt_at" timestamp with time zone,
	CONSTRAINT "hpp_outlet_state_pkey" PRIMARY KEY("tenant_id","outlet_id"),
	CONSTRAINT "hpp_outlet_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hpp_outlet_state_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hpp_outlet_state_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "hpp_recompute_queue" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hpp_recompute_queue_pkey" PRIMARY KEY("tenant_id","outlet_id","item_id"),
	CONSTRAINT "hpp_recompute_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hpp_recompute_queue_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hpp_recompute_queue_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hpp_recompute_queue_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- menu_costs foreign keys are inside CREATE TABLE (not ALTER TABLE ... ADD CONSTRAINT):
-- outlets forces RLS, so a later ADD CONSTRAINT by a non-superuser owner fails with
-- "tenant context is required" (same pattern as 0244/0246, merge train 48d).
CREATE TABLE "menu_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"modifier_id" uuid,
	"recipe_id" uuid,
	"recipe_complete" boolean NOT NULL,
	"theoretical_cost_idr" numeric(14,4),
	"price_idr" bigint NOT NULL,
	"gross_margin_bp" integer,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "menu_costs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."item_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_modifier_fk" FOREIGN KEY ("tenant_id","modifier_id") REFERENCES "public"."modifiers"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_recipe_fk" FOREIGN KEY ("tenant_id","recipe_id") REFERENCES "public"."recipes"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_costs_cost_check" CHECK ("menu_costs"."theoretical_cost_idr" IS NULL OR "menu_costs"."theoretical_cost_idr" >= 0),
	CONSTRAINT "menu_costs_price_check" CHECK ("menu_costs"."price_idr" >= 0),
	CONSTRAINT "menu_costs_complete_check" CHECK (("menu_costs"."recipe_complete" AND "menu_costs"."recipe_id" IS NOT NULL AND "menu_costs"."theoretical_cost_idr" IS NOT NULL AND "menu_costs"."gross_margin_bp" IS NOT NULL)
        OR (NOT "menu_costs"."recipe_complete" AND "menu_costs"."theoretical_cost_idr" IS NULL AND "menu_costs"."gross_margin_bp" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "hpp_recompute_queue_enqueued_idx" ON "hpp_recompute_queue" USING btree ("tenant_id","enqueued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_costs_target_key" ON "menu_costs" USING btree ("tenant_id","outlet_id","menu_item_id",coalesce("variant_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("modifier_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "menu_costs_recipe_idx" ON "menu_costs" USING btree ("tenant_id","outlet_id","recipe_id");--> statement-breakpoint
-- TEN-01/TEN-03: menu_costs and hpp_recompute_queue are tenant + outlet scoped
-- (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
-- hpp_outlet_state gets TENANT RLS only (no outlet policy): it holds only stale
-- markers, so outlet scoping adds nothing, and an outlet-scoped actor must be
-- able to mark the brand's or tenant's other outlets stale (markHppStale).
SELECT app.enforce_tenant_rls('public.hpp_outlet_state'::regclass);
