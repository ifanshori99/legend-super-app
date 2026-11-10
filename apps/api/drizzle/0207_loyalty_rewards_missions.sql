CREATE TABLE "mission_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"period_key" varchar(32) NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"reward_issued_at" timestamp with time zone,
	"voucher_id" uuid,
	"voucher_code" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_progress_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mission_progress_period_key" UNIQUE("tenant_id","mission_id","customer_profile_id","period_key"),
	CONSTRAINT "mission_progress_counts_check" CHECK ("mission_progress"."progress" >= 0 AND "mission_progress"."target" > 0),
	CONSTRAINT "mission_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "mission_progress_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "mission_progress_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."vouchers"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"type" varchar(20) NOT NULL,
	"rule" jsonb NOT NULL,
	"reward" jsonb NOT NULL,
	"period" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "missions_type_check" CHECK ("missions"."type" IN ('visit_count', 'try_new_item', 'weekday_visit', 'stamp_card')),
	CONSTRAINT "missions_window_check" CHECK ("missions"."starts_at" IS NULL OR "missions"."ends_at" IS NULL OR "missions"."ends_at" > "missions"."starts_at"),
	CONSTRAINT "missions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "reward_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"order_id" uuid,
	"points_spent" integer NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"redemption_code" varchar(32) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ledger_entry_id" char(26),
	"voucher_id" uuid,
	"outlet_id" uuid,
	"fulfilled_by" text,
	"restore_entry_id" char(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_redemptions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reward_redemptions_idempotency_key" UNIQUE("tenant_id","customer_profile_id","idempotency_key"),
	CONSTRAINT "reward_redemptions_code_key" UNIQUE("tenant_id","redemption_code"),
	CONSTRAINT "reward_redemptions_points_check" CHECK ("reward_redemptions"."points_spent" > 0),
	CONSTRAINT "reward_redemptions_status_check" CHECK ("reward_redemptions"."status" IN ('pending', 'fulfilled', 'cancelled', 'expired')),
	CONSTRAINT "reward_redemptions_fulfilled_check" CHECK (("reward_redemptions"."status" = 'fulfilled') = ("reward_redemptions"."fulfilled_at" IS NOT NULL)),
	CONSTRAINT "reward_redemptions_cancelled_check" CHECK (("reward_redemptions"."status" = 'cancelled') = ("reward_redemptions"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "reward_redemptions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_ledger_entry_fk" FOREIGN KEY ("tenant_id","ledger_entry_id") REFERENCES "public"."point_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_restore_entry_fk" FOREIGN KEY ("tenant_id","restore_entry_id") REFERENCES "public"."point_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reward_redemptions_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."vouchers"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"type" varchar(20) NOT NULL,
	"points_cost" integer NOT NULL,
	"stock" integer,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"menu_item_id" uuid,
	"voucher_value_idr" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"per_customer_limit" integer,
	"redemption_valid_days" integer DEFAULT 30 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "rewards_type_check" CHECK ("rewards"."type" IN ('free_item', 'item_upgrade', 'voucher')),
	CONSTRAINT "rewards_points_cost_check" CHECK ("rewards"."points_cost" > 0),
	CONSTRAINT "rewards_stock_check" CHECK ("rewards"."stock" IS NULL OR "rewards"."stock" >= 0),
	CONSTRAINT "rewards_per_customer_limit_check" CHECK ("rewards"."per_customer_limit" IS NULL OR "rewards"."per_customer_limit" > 0),
	CONSTRAINT "rewards_redemption_valid_days_check" CHECK ("rewards"."redemption_valid_days" BETWEEN 1 AND 365),
	CONSTRAINT "rewards_validity_check" CHECK ("rewards"."valid_until" IS NULL OR "rewards"."valid_until" > "rewards"."valid_from"),
	CONSTRAINT "rewards_type_shape_check" CHECK (CASE WHEN "rewards"."type" = 'voucher'
               THEN "rewards"."voucher_value_idr" IS NOT NULL AND "rewards"."voucher_value_idr" > 0 AND "rewards"."menu_item_id" IS NULL
               ELSE "rewards"."menu_item_id" IS NOT NULL AND "rewards"."voucher_value_idr" IS NULL END),
	CONSTRAINT "rewards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "rewards_menu_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ALTER COLUMN "daily_point_cap_per_customer" SET DEFAULT 500;--> statement-breakpoint
ALTER TABLE "vouchers" DROP CONSTRAINT "vouchers_source_check";--> statement-breakpoint
ALTER TABLE "point_earn_records" ADD COLUMN "applied_reversal_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_progress" ADD CONSTRAINT "mission_progress_mission_fk" FOREIGN KEY ("tenant_id","mission_id") REFERENCES "public"."missions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_reward_fk" FOREIGN KEY ("tenant_id","reward_id") REFERENCES "public"."rewards"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_progress_profile_idx" ON "mission_progress" USING btree ("tenant_id","customer_profile_id");--> statement-breakpoint
CREATE INDEX "missions_tenant_active_idx" ON "missions" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "reward_redemptions_status_expiry_idx" ON "reward_redemptions" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "reward_redemptions_profile_reward_idx" ON "reward_redemptions" USING btree ("tenant_id","customer_profile_id","reward_id");--> statement-breakpoint
CREATE INDEX "rewards_tenant_active_idx" ON "rewards" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_source_check" CHECK ("vouchers"."source" IN ('promo_code', 'apology', 'birthday', 'referral', 'campaign', 'manual', 'loyalty_reward'));--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- legend-m4p5 hand SQL (copied from src/db/schema/crm-rewards.custom.sql).
-- ---------------------------------------------------------------------------
-- legend-m4p5: hand SQL of migration 0207 (tables in crm-rewards.ts). Keep
-- this file and the migration in step. The generated CREATE TABLE statements
-- carry every foreign key inline (pattern 1: the new tables are empty, so
-- FORCE RLS needs no lift); only the vouchers foreign key below, on an
-- existing table, needs pattern 2 (docs/plan/contracts.md "Migrations:
-- foreign keys into FORCE RLS tables").
SELECT app.enforce_tenant_rls('public.rewards'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reward_redemptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.missions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.mission_progress'::regclass);
--> statement-breakpoint
-- vouchers.customer_profile_id has had no foreign key until now. Pattern 2:
-- lift FORCE on both FORCE tables (the validation scan reads both sides as
-- the migrator), add the constraint (never NOT VALID), restore FORCE.
ALTER TABLE public.vouchers NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer_profiles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Orphan rows would fail the validation scan: a voucher whose profile has no
-- customer_profiles row in the same tenant loses the link, and an issued one
-- is cancelled so it cannot be used (vouchers_cancelled_check needs a reason).
UPDATE public.vouchers v
  SET customer_profile_id = NULL,
      status = CASE WHEN v.status = 'issued' THEN 'cancelled' ELSE v.status END,
      cancelled_reason = CASE WHEN v.status = 'issued'
        THEN 'profile_missing_0207' ELSE v.cancelled_reason END
  WHERE v.customer_profile_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.customer_profiles p
      WHERE p.tenant_id = v.tenant_id AND p.id = v.customer_profile_id);
--> statement-breakpoint
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_profile_fk
  FOREIGN KEY (tenant_id, customer_profile_id)
  REFERENCES public.customer_profiles (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.customer_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vouchers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Loyalty rewards issue vouchers with source 'loyalty_reward'.
ALTER TABLE public.vouchers DROP CONSTRAINT vouchers_source_check;
--> statement-breakpoint
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_source_check
  CHECK (source IN ('promo_code', 'apology', 'birthday', 'referral',
    'campaign', 'manual', 'loyalty_reward'));
--> statement-breakpoint
-- Member RLS (design §M4): a member reads only their own redemptions,
-- progress and vouchers. Staff and worker paths never set
-- app.customer_profile_id, so the RESTRICTIVE policy is inert for them.
SELECT app.enforce_member_rls('public.reward_redemptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_member_rls('public.mission_progress'::regclass);
--> statement-breakpoint
SELECT app.enforce_member_rls('public.vouchers'::regclass);
--> statement-breakpoint
-- Rows are closed (cancelled, expired, inactive), never deleted.
REVOKE DELETE, TRUNCATE ON TABLE public.rewards FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.reward_redemptions FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.missions FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.mission_progress FROM legend_app;
--> statement-breakpoint
-- A redemption moves once: pending to fulfilled, cancelled or expired. The
-- identity of the redemption (reward, member, points, code, idempotency key)
-- never changes. A trigger (not only a privilege) also binds the owner.
CREATE FUNCTION app.reward_redemption_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.reward_id IS DISTINCT FROM OLD.reward_id
     OR NEW.customer_profile_id IS DISTINCT FROM OLD.customer_profile_id
     OR NEW.points_spent IS DISTINCT FROM OLD.points_spent
     OR NEW.redemption_code IS DISTINCT FROM OLD.redemption_code
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'reward_redemptions identity columns are immutable (legend-m4p5)'
      USING ERRCODE = '55000', CONSTRAINT = 'reward_redemptions_identity_guard';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending'
              AND NEW.status IN ('fulfilled', 'cancelled', 'expired')) THEN
    RAISE EXCEPTION 'reward_redemptions status cannot move from % to % (legend-m4p5)',
      OLD.status, NEW.status
      USING ERRCODE = '55000', CONSTRAINT = 'reward_redemptions_status_guard';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_redemption_status_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reward_redemptions_status_guard
BEFORE UPDATE ON public.reward_redemptions
FOR EACH ROW EXECUTE FUNCTION app.reward_redemption_status_guard();
