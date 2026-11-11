CREATE TABLE "menu_recommendation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"min_margin_bps" integer DEFAULT 2000 NOT NULL,
	"exclude_out_of_stock" boolean DEFAULT true NOT NULL,
	"max_suggestions" integer DEFAULT 5 NOT NULL,
	"min_pair_support" integer DEFAULT 3 NOT NULL,
	"lookback_days" integer DEFAULT 90 NOT NULL,
	"member_history_enabled" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_recommendation_rules_key" UNIQUE("tenant_id","outlet_id"),
	CONSTRAINT "menu_recommendation_rules_min_margin_bps_check" CHECK ("menu_recommendation_rules"."min_margin_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "menu_recommendation_rules_max_suggestions_check" CHECK ("menu_recommendation_rules"."max_suggestions" BETWEEN 1 AND 20),
	CONSTRAINT "menu_recommendation_rules_min_pair_support_check" CHECK ("menu_recommendation_rules"."min_pair_support" >= 2),
	CONSTRAINT "menu_recommendation_rules_lookback_days_check" CHECK ("menu_recommendation_rules"."lookback_days" BETWEEN 7 AND 365),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): an ALTER TABLE ... ADD FOREIGN KEY
	-- validates under the FORCE RLS parent's policy and aborts the migration
	-- without app.tenant_id. Inside CREATE TABLE no validation scan runs.
	CONSTRAINT "menu_recommendation_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_recommendation_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_recommendation_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "menu_recommendation_item_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"hour_from" smallint,
	"hour_to" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_recommendation_item_rules_key" UNIQUE("tenant_id","outlet_id","menu_item_id"),
	CONSTRAINT "menu_recommendation_item_rules_hours_check" CHECK (("menu_recommendation_item_rules"."hour_from" IS NULL AND "menu_recommendation_item_rules"."hour_to" IS NULL) OR ("menu_recommendation_item_rules"."hour_from" IS NOT NULL AND "menu_recommendation_item_rules"."hour_to" IS NOT NULL AND "menu_recommendation_item_rules"."hour_from" BETWEEN 0 AND 23 AND "menu_recommendation_item_rules"."hour_to" BETWEEN 0 AND 23)),
	-- Foreign keys inline, same reason as above.
	CONSTRAINT "menu_recommendation_item_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_recommendation_item_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_recommendation_item_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "menu_recommendation_item_rules_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- AI-01 menu recommendation tables: tenant-owned AND outlet-owned (outlet_id
-- NOT NULL), so each gets the RESTRICTIVE tenant policy and, right after it,
-- the outlet policy (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.menu_recommendation_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_recommendation_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.menu_recommendation_item_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_recommendation_item_rules'::regclass);
