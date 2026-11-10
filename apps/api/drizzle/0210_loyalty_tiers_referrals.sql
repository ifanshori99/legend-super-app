CREATE TABLE "customer_tier_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"from_tier_id" uuid,
	"to_tier_id" uuid,
	"reason" varchar(12) NOT NULL,
	"rolling_spend_idr" bigint NOT NULL,
	"rolling_visits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tier_history_reason_check" CHECK ("customer_tier_history"."reason" IN ('evaluation', 'manual')),
	CONSTRAINT "customer_tier_history_stats_check" CHECK ("customer_tier_history"."rolling_spend_idr" >= 0 AND "customer_tier_history"."rolling_visits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"rank" integer NOT NULL,
	"threshold_spend_idr" bigint NOT NULL,
	"threshold_visits" integer NOT NULL,
	"benefits" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_tiers_tenant_rank_key" UNIQUE("tenant_id","rank"),
	CONSTRAINT "loyalty_tiers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "loyalty_tiers_rank_check" CHECK ("loyalty_tiers"."rank" > 0),
	CONSTRAINT "loyalty_tiers_threshold_check" CHECK ("loyalty_tiers"."threshold_spend_idr" >= 0 AND "loyalty_tiers"."threshold_visits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"referrer_profile_id" uuid NOT NULL,
	"referee_profile_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"first_order_id" uuid,
	"referrer_points" integer NOT NULL,
	"referee_points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qualified_at" timestamp with time zone,
	"rewarded_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "referrals_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "referrals_tenant_referee_key" UNIQUE("tenant_id","referee_profile_id"),
	CONSTRAINT "referrals_not_self_check" CHECK ("referrals"."referrer_profile_id" <> "referrals"."referee_profile_id"),
	CONSTRAINT "referrals_status_check" CHECK ("referrals"."status" IN ('pending', 'qualified', 'rewarded', 'expired')),
	CONSTRAINT "referrals_code_check" CHECK ("referrals"."code" ~ '^[A-Z0-9]{4,20}$'),
	CONSTRAINT "referrals_points_check" CHECK ("referrals"."referrer_points" >= 0 AND "referrals"."referee_points" >= 0),
	CONSTRAINT "referrals_first_order_check" CHECK (("referrals"."status" IN ('qualified', 'rewarded')) = ("referrals"."first_order_id" IS NOT NULL)),
	CONSTRAINT "referrals_qualified_at_check" CHECK (("referrals"."status" IN ('qualified', 'rewarded')) = ("referrals"."qualified_at" IS NOT NULL)),
	CONSTRAINT "referrals_rewarded_at_check" CHECK (("referrals"."status" = 'rewarded') = ("referrals"."rewarded_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "tier_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "tier_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_tier_history" ADD CONSTRAINT "customer_tier_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tier_history" ADD CONSTRAINT "customer_tier_history_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tier_history" ADD CONSTRAINT "customer_tier_history_from_tier_fk" FOREIGN KEY ("tenant_id","from_tier_id") REFERENCES "public"."loyalty_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tier_history" ADD CONSTRAINT "customer_tier_history_to_tier_fk" FOREIGN KEY ("tenant_id","to_tier_id") REFERENCES "public"."loyalty_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_fk" FOREIGN KEY ("tenant_id","referrer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_fk" FOREIGN KEY ("tenant_id","referee_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_first_order_fk" FOREIGN KEY ("tenant_id","first_order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_tier_history_profile_idx" ON "customer_tier_history" USING btree ("tenant_id","customer_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "referrals_referrer_status_idx" ON "referrals" USING btree ("tenant_id","referrer_profile_id","status");
--> statement-breakpoint
-- Custom SQL migration file, put your code below! ---
-- legend-3zd1: hand SQL of migration 0210 (tables in crm-tiers.ts). Keep this
-- file and the migration in step. The generated CREATE TABLE statements carry
-- every foreign key inline (pattern 1: the new tables are empty, so FORCE RLS
-- needs no lift); only the customer_profiles.tier_id foreign key below, on an
-- existing table, needs pattern 2 (docs/plan/contracts.md "Migrations:
-- foreign keys into FORCE RLS tables").
SELECT app.enforce_tenant_rls('public.loyalty_tiers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_tier_history'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.referrals'::regclass);
--> statement-breakpoint
-- Member RLS is NOT applied to loyalty_tiers (every member reads the ladder)
-- or customer_tier_history. referrals has two member sides, so it gets its own
-- RESTRICTIVE policy (shape of app.enforce_member_rls, design §M6): a member
-- sees a referral only as referrer or referee. Staff and worker paths never
-- set app.customer_profile_id, so the policy is inert for them.
CREATE POLICY member_self ON public.referrals AS RESTRICTIVE FOR ALL
  USING (app.member_profile_id() IS NULL
    OR referrer_profile_id = app.member_profile_id()
    OR referee_profile_id = app.member_profile_id())
  WITH CHECK (app.member_profile_id() IS NULL
    OR referrer_profile_id = app.member_profile_id()
    OR referee_profile_id = app.member_profile_id());
--> statement-breakpoint
-- customer_profiles.tier_id has had no foreign key until now. Pattern 2: lift
-- FORCE on both FORCE tables (the validation scan reads both sides as the
-- migrator), add the constraint (never NOT VALID), restore FORCE. The column
-- is new and NULL on every row, so there are no orphans to repair.
ALTER TABLE public.customer_profiles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loyalty_tiers NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer_profiles ADD CONSTRAINT customer_profiles_tier_fk
  FOREIGN KEY (tenant_id, tier_id)
  REFERENCES public.loyalty_tiers (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.loyalty_tiers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- customer_profiles has per-column grants since 0203 (points_balance is not
-- updatable). Add the two new columns. INSERT needs them too: the ORM names
-- every column.
GRANT INSERT (tier_id, tier_evaluated_at)
  ON TABLE public.customer_profiles TO legend_app;
--> statement-breakpoint
GRANT UPDATE (tier_id, tier_evaluated_at)
  ON TABLE public.customer_profiles TO legend_app;
--> statement-breakpoint
-- Tiers are deactivated and referrals expired, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE public.loyalty_tiers FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.referrals FROM legend_app;
--> statement-breakpoint
-- The tier history is append-only. A trigger (not only a privilege) also
-- blocks the owner and the migrator (pattern app.reject_point_ledger_mutation,
-- migration 0203).
CREATE FUNCTION app.reject_customer_tier_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'customer_tier_history is append-only (legend-3zd1)'
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER customer_tier_history_append_only
BEFORE UPDATE OR DELETE ON public.customer_tier_history
FOR EACH ROW EXECUTE FUNCTION app.reject_customer_tier_history_mutation();
--> statement-breakpoint
CREATE TRIGGER customer_tier_history_no_truncate
BEFORE TRUNCATE ON public.customer_tier_history
FOR EACH STATEMENT EXECUTE FUNCTION app.reject_customer_tier_history_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_customer_tier_history_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_tier_history FROM legend_app;
