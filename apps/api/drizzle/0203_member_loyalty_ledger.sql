-- legend-111j (WS-08 member foundation, docs/design/ws08-member-loyalty.md
-- §3 "0193", renumbered 0203): member profiles, consent policy versions,
-- loyalty program, append-only point ledger, earn records, visits, anomalies,
-- order attach columns, member RLS, ledger triggers and per-column grants.
-- Foreign keys of the new tables are inline (docs/plan/contracts.md pattern 1).
CREATE TABLE "consent_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"version" varchar(20) NOT NULL,
	"text_hash" varchar(64) NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_policy_versions_key" UNIQUE("tenant_id","purpose","version"),
	CONSTRAINT "consent_policy_versions_purpose_check" CHECK ("consent_policy_versions"."purpose" IN ('loyalty', 'marketing', 'ai')),
	CONSTRAINT "consent_policy_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text,
	"whatsapp_hash" varchar(64),
	"name" varchar(120) NOT NULL,
	"birth_month_day" varchar(5),
	"points_balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_spend_idr" bigint DEFAULT 0 NOT NULL,
	"visits_count" integer DEFAULT 0 NOT NULL,
	"first_visit_at" timestamp with time zone,
	"last_visit_at" timestamp with time zone,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"referral_code" varchar(20),
	"membership_status" varchar(30) NOT NULL,
	"whatsapp_verified_at" timestamp with time zone,
	"home_outlet_id" uuid,
	"merged_into_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profiles_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_profiles_tenant_referral_code_key" UNIQUE("tenant_id","referral_code"),
	CONSTRAINT "customer_profiles_points_balance_check" CHECK ("customer_profiles"."points_balance" >= 0),
	CONSTRAINT "customer_profiles_counters_check" CHECK ("customer_profiles"."lifetime_spend_idr" >= 0 AND "customer_profiles"."visits_count" >= 0),
	CONSTRAINT "customer_profiles_status_check" CHECK ("customer_profiles"."membership_status" IN ('pending_verification', 'active', 'suspended', 'closed')),
	CONSTRAINT "customer_profiles_active_verified_check" CHECK ("customer_profiles"."membership_status" <> 'active' OR "customer_profiles"."whatsapp_verified_at" IS NOT NULL),
	CONSTRAINT "customer_profiles_birth_month_day_check" CHECK ("customer_profiles"."birth_month_day" IS NULL OR "customer_profiles"."birth_month_day" ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
	CONSTRAINT "customer_profiles_referral_code_check" CHECK ("customer_profiles"."referral_code" IS NULL OR "customer_profiles"."referral_code" ~ '^[A-Z0-9]{4,20}$'),
	CONSTRAINT "customer_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_profiles_home_outlet_id_outlets_id_fk" FOREIGN KEY ("home_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(120) DEFAULT 'Poin Member' NOT NULL,
	"earn_spend_idr" bigint DEFAULT 10000 NOT NULL,
	"earn_points" integer DEFAULT 1 NOT NULL,
	"expiry_months" integer DEFAULT 12 NOT NULL,
	"rolling_months" integer DEFAULT 12 NOT NULL,
	"point_value_idr" bigint DEFAULT 100 NOT NULL,
	"daily_point_cap_per_customer" bigint DEFAULT 1000,
	"phone_lookup_daily_cap_per_cashier" integer DEFAULT 20 NOT NULL,
	"employee_self_serve_ban" boolean DEFAULT true NOT NULL,
	"referral" jsonb DEFAULT '{"enabled":false,"referrerPoints":100,"refereePoints":50,"qualifyingEvent":"first_paid_order","minFirstOrderIdr":0,"maxReferralsPerCustomerPerMonth":10}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"point_value_locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "loyalty_programs_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "loyalty_programs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "loyalty_programs_earn_check" CHECK ("loyalty_programs"."earn_spend_idr" > 0 AND "loyalty_programs"."earn_points" > 0),
	CONSTRAINT "loyalty_programs_months_check" CHECK ("loyalty_programs"."expiry_months" BETWEEN 1 AND 60 AND "loyalty_programs"."rolling_months" BETWEEN 1 AND 60),
	CONSTRAINT "loyalty_programs_point_value_check" CHECK ("loyalty_programs"."point_value_idr" > 0),
	CONSTRAINT "loyalty_programs_daily_cap_check" CHECK ("loyalty_programs"."daily_point_cap_per_customer" IS NULL OR "loyalty_programs"."daily_point_cap_per_customer" > 0),
	CONSTRAINT "loyalty_programs_phone_lookup_cap_check" CHECK ("loyalty_programs"."phone_lookup_daily_cap_per_cashier" > 0),
	CONSTRAINT "loyalty_programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "member_profile_user_index" (
	"profile_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(30) NOT NULL,
	CONSTRAINT "member_profile_user_index_profile_id_pk" PRIMARY KEY("profile_id")
);
--> statement-breakpoint
CREATE TABLE "customer_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"visited_at" timestamp with time zone NOT NULL,
	"spend_idr" bigint NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_visits_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_visits_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "customer_visits_amounts_check" CHECK ("customer_visits"."spend_idr" >= 0 AND "customer_visits"."item_count" >= 0),
	CONSTRAINT "customer_visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_visits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_visits_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_visits_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "loyalty_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"customer_profile_id" uuid,
	"order_id" uuid,
	"kind" varchar(30) NOT NULL,
	"actor_user_id" text,
	"business_date" date,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "loyalty_anomalies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "loyalty_anomalies_kind_check" CHECK ("loyalty_anomalies"."kind" IN ('daily_cap_hit', 'self_serve_blocked', 'refund_after_redeem', 'phone_lookup_attach', 'phone_lookup_cap_hit', 'balance_mismatch')),
	CONSTRAINT "loyalty_anomalies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "loyalty_anomalies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "point_earn_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"state" varchar(20) NOT NULL,
	"outcome_reason" varchar(40),
	"business_date" date NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"eligible_spend_idr" bigint DEFAULT 0 NOT NULL,
	"computed_points" bigint DEFAULT 0 NOT NULL,
	"capped_points" bigint DEFAULT 0 NOT NULL,
	"booked_points" bigint DEFAULT 0 NOT NULL,
	"refunded_eligible_idr" bigint DEFAULT 0 NOT NULL,
	"reversed_points" bigint DEFAULT 0 NOT NULL,
	"reversal_shortfall_points" bigint DEFAULT 0 NOT NULL,
	"earn_entry_id" char(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "point_earn_records_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "point_earn_records_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "point_earn_records_state_check" CHECK ("point_earn_records"."state" IN ('booked', 'reversed', 'skipped', 'blocked', 'capped')),
	CONSTRAINT "point_earn_records_points_check" CHECK ("point_earn_records"."computed_points" >= 0 AND "point_earn_records"."capped_points" >= 0 AND "point_earn_records"."booked_points" >= 0
          AND "point_earn_records"."reversed_points" >= 0 AND "point_earn_records"."reversed_points" <= "point_earn_records"."booked_points"
          AND "point_earn_records"."reversal_shortfall_points" >= 0
          AND "point_earn_records"."refunded_eligible_idr" >= 0 AND "point_earn_records"."refunded_eligible_idr" <= "point_earn_records"."eligible_spend_idr"),
	CONSTRAINT "point_earn_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_earn_records_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_earn_records_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_earn_records_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "point_ledger" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"outlet_id" uuid,
	"type" varchar(10) NOT NULL,
	"points" bigint NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" text,
	"reverses_entry_id" char(26),
	"expires_at" timestamp with time zone,
	"point_value_idr" bigint DEFAULT 0 NOT NULL,
	"liability_idr" bigint DEFAULT 0 NOT NULL,
	"business_date" date,
	"reason" varchar(300),
	"created_by" text,
	"posting_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "point_ledger_posting_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "point_ledger_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "point_ledger_type_check" CHECK ("point_ledger"."type" IN ('earn', 'redeem', 'expire', 'reverse', 'bonus', 'adjust')),
	CONSTRAINT "point_ledger_sign_check" CHECK (CASE WHEN "point_ledger"."type" IN ('earn', 'bonus') THEN "point_ledger"."points" > 0
               WHEN "point_ledger"."type" IN ('redeem', 'expire', 'reverse') THEN "point_ledger"."points" < 0
               ELSE "point_ledger"."points" <> 0 END),
	CONSTRAINT "point_ledger_source_type_check" CHECK (CASE "point_ledger"."type"
            WHEN 'earn' THEN "point_ledger"."source_type" = 'order'
            WHEN 'bonus' THEN "point_ledger"."source_type" IN ('mission', 'referral', 'birthday', 'adjustment')
            WHEN 'redeem' THEN "point_ledger"."source_type" = 'reward_redemption'
            WHEN 'expire' THEN "point_ledger"."source_type" = 'expiry'
            WHEN 'reverse' THEN "point_ledger"."source_type" IN ('refund', 'void')
            ELSE "point_ledger"."source_type" = 'adjustment' END),
	CONSTRAINT "point_ledger_source_id_check" CHECK ("point_ledger"."type" NOT IN ('earn', 'redeem', 'reverse') OR "point_ledger"."source_id" IS NOT NULL),
	CONSTRAINT "point_ledger_expires_check" CHECK (CASE WHEN "point_ledger"."type" IN ('earn', 'bonus') THEN "point_ledger"."expires_at" IS NOT NULL
               WHEN "point_ledger"."type" = 'redeem' THEN "point_ledger"."expires_at" IS NULL
               ELSE true END),
	CONSTRAINT "point_ledger_adjust_check" CHECK ("point_ledger"."type" <> 'adjust' OR (
            "point_ledger"."reason" IS NOT NULL
            AND ("point_ledger"."reverses_entry_id" IS NULL OR "point_ledger"."expires_at" IS NULL)
            AND ("point_ledger"."reverses_entry_id" IS NOT NULL OR "point_ledger"."points" < 0 OR "point_ledger"."expires_at" IS NOT NULL))),
	CONSTRAINT "point_ledger_liability_check" CHECK ("point_ledger"."point_value_idr" > 0 AND "point_ledger"."liability_idr" = "point_ledger"."points" * "point_ledger"."point_value_idr"),
	CONSTRAINT "point_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_ledger_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "point_ledger_reverses_entry_fk" FOREIGN KEY ("tenant_id","reverses_entry_id") REFERENCES "public"."point_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- orders is hot (POS): wait at most 5s for its ACCESS EXCLUSIVE lock, then
-- restore the migrator's value (contracts.md, bead legend-76azz). The lock
-- is held to the end of the batch, so the later orders statements in this
-- file do not wait again.
SELECT set_config('legend.lock_timeout_before_0203', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_attached_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_attached_via" varchar(20);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_attached_at" timestamp with time zone;--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0203', true), ''), current_setting('lock_timeout')), true);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_tenant_user_key" ON "customer_profiles" USING btree ("tenant_id","user_id") WHERE "customer_profiles"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_tenant_whatsapp_key" ON "customer_profiles" USING btree ("tenant_id","whatsapp_hash") WHERE "customer_profiles"."whatsapp_hash" IS NOT NULL AND "customer_profiles"."membership_status" <> 'closed';--> statement-breakpoint
CREATE INDEX "member_profile_user_index_user_idx" ON "member_profile_user_index" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_visits_profile_idx" ON "customer_visits" USING btree ("tenant_id","customer_profile_id","visited_at");--> statement-breakpoint
CREATE INDEX "loyalty_anomalies_kind_idx" ON "loyalty_anomalies" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_anomalies_actor_day_idx" ON "loyalty_anomalies" USING btree ("tenant_id","kind","actor_user_id","business_date");--> statement-breakpoint
CREATE INDEX "point_earn_records_profile_day_idx" ON "point_earn_records" USING btree ("tenant_id","customer_profile_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "point_ledger_dedupe_key" ON "point_ledger" USING btree ("tenant_id","type","source_type","source_id") WHERE "point_ledger"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "point_ledger_profile_seq_idx" ON "point_ledger" USING btree ("tenant_id","customer_profile_id","posting_seq");--> statement-breakpoint
-- legend-111j: docs/plan/contracts.md pattern 2 (the design's NOT VALID is
-- refused by contracts.md:161 and migration-force-rls-guard.test.ts). orders
-- is FORCE RLS, so a plain owner's validation scan would need a tenant
-- context; lift FORCE on orders for this statement and restore it right
-- after (customer_profiles is not forced yet at this point of the file).
-- orders.customer_profile_id was never written, so the scan checks nothing
-- but proves it. orders ends the migration with FORCE RLS.
ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_attached_via_check" CHECK ("orders"."customer_attached_via" IS NULL OR "orders"."customer_attached_via" IN ('member_qr', 'phone_lookup', 'pwa_session', 'receipt_claim'));--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- legend-111j hand SQL (copied from src/db/schema/crm-member.custom.sql).
-- ---------------------------------------------------------------------------
-- Tenant RLS on every new tenant table; outlet RLS on the two tables whose
-- outlet_id is NOT NULL. point_ledger and loyalty_anomalies keep a nullable
-- outlet_id (reporting only / balance_mismatch has none): tenant RLS only
-- (docs/plan/contracts.md:41).
SELECT app.enforce_tenant_rls('public.loyalty_programs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_profiles'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.consent_policy_versions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.point_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.point_earn_records'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.point_earn_records'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_visits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_visits'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.loyalty_anomalies'::regclass);
--> statement-breakpoint
-- Member RLS (design §M4). Member routes set app.customer_profile_id
-- (withMemberScope); staff and worker paths never set it, so the RESTRICTIVE
-- policy is inert for them.
CREATE OR REPLACE FUNCTION app.member_profile_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULLIF(current_setting('app.customer_profile_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_member_rls(
  target regclass, column_name name DEFAULT 'customer_profile_id'
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = target AND a.attname = column_name
       AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
  ) THEN
    RAISE EXCEPTION '% has no uuid column %', target, column_name;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid = target AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '% must enforce tenant RLS first', target;
  END IF;
  EXECUTE format('DROP POLICY IF EXISTS member_self ON %s', target);
  EXECUTE format(
    'CREATE POLICY member_self ON %s AS RESTRICTIVE FOR ALL '
    'USING (app.member_profile_id() IS NULL OR %I = app.member_profile_id()) '
    'WITH CHECK (app.member_profile_id() IS NULL OR %I = app.member_profile_id())',
    target, column_name, column_name);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_member_rls(regclass, name) FROM PUBLIC;
--> statement-breakpoint
SELECT app.enforce_member_rls('public.customer_profiles'::regclass, 'id');
--> statement-breakpoint
SELECT app.enforce_member_rls('public.point_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_member_rls('public.customer_visits'::regclass);
--> statement-breakpoint
SELECT app.enforce_member_rls('public.consents'::regclass, 'subject_id');
--> statement-breakpoint
-- customer_profiles.points_balance is written only by the ledger balance
-- trigger below (LOY-02). enforce_tenant_rls granted table-level INSERT and
-- UPDATE; replace them with per-column grants (UPDATE without points_balance).
REVOKE INSERT, UPDATE ON TABLE public.customer_profiles FROM legend_app;
--> statement-breakpoint
-- INSERT keeps points_balance in the grant because the ORM names every
-- column (DEFAULT for omitted ones); the trigger below holds a new profile at
-- a zero balance, so the ledger stays the only way to give points.
GRANT INSERT (id, tenant_id, user_id, whatsapp_hash, name, birth_month_day,
  points_balance, lifetime_spend_idr, visits_count, first_visit_at,
  last_visit_at, marketing_opt_in, referral_code, membership_status,
  whatsapp_verified_at, home_outlet_id, merged_into_profile_id, created_at,
  updated_at)
  ON TABLE public.customer_profiles TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.customer_profile_zero_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.points_balance <> 0 THEN
    RAISE EXCEPTION 'A new member profile starts at zero points (LOY-01)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER customer_profiles_zero_balance BEFORE INSERT
  ON public.customer_profiles
  FOR EACH ROW EXECUTE FUNCTION app.customer_profile_zero_balance();
--> statement-breakpoint
GRANT UPDATE (user_id, whatsapp_hash, name, birth_month_day,
  lifetime_spend_idr, visits_count, first_visit_at, last_visit_at,
  marketing_opt_in, referral_code, membership_status, whatsapp_verified_at,
  home_outlet_id, merged_into_profile_id, updated_at)
  ON TABLE public.customer_profiles TO legend_app;
--> statement-breakpoint
-- A profile is closed, never deleted; the program row is never deleted once
-- points exist (the ledger trigger needs it).
REVOKE DELETE, TRUNCATE ON TABLE public.customer_profiles FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.loyalty_programs FROM legend_app;
--> statement-breakpoint
-- LOY-01: the point ledger is append-only. A trigger (not only a privilege)
-- also blocks the owner and the migrator (pattern 0017 stock_ledger).
CREATE FUNCTION app.reject_point_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'point_ledger is append-only (LOY-01)' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER point_ledger_append_only
BEFORE UPDATE OR DELETE ON public.point_ledger
FOR EACH ROW EXECUTE FUNCTION app.reject_point_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER point_ledger_no_truncate
BEFORE TRUNCATE ON public.point_ledger
FOR EACH STATEMENT EXECUTE FUNCTION app.reject_point_ledger_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_point_ledger_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.point_ledger FROM legend_app;
--> statement-breakpoint
-- Point value and liability (design §M5): callers never pass them. The first
-- ledger row of a tenant locks the program's point value (FOR UPDATE, then
-- point_value_locked_at); later rows read it FOR SHARE, so a program edit and
-- a ledger insert serialize on the program row. No program row: refused.
CREATE FUNCTION app.point_ledger_set_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_value bigint;
  v_locked timestamptz;
BEGIN
  SELECT p.point_value_locked_at INTO v_locked
    FROM public.loyalty_programs p WHERE p.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'loyalty program missing for tenant (LOY-02)'
      USING ERRCODE = '23503';
  END IF;
  IF v_locked IS NOT NULL THEN
    SELECT p.point_value_idr INTO v_value
      FROM public.loyalty_programs p WHERE p.tenant_id = NEW.tenant_id
      FOR SHARE;
  ELSE
    SELECT p.point_value_idr, p.point_value_locked_at INTO v_value, v_locked
      FROM public.loyalty_programs p WHERE p.tenant_id = NEW.tenant_id
      FOR UPDATE;
    IF v_locked IS NULL THEN
      UPDATE public.loyalty_programs SET point_value_locked_at = now()
       WHERE tenant_id = NEW.tenant_id;
    END IF;
  END IF;
  NEW.point_value_idr := v_value;
  NEW.liability_idr := NEW.points * v_value;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.point_ledger_set_value() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER point_ledger_set_value
BEFORE INSERT ON public.point_ledger
FOR EACH ROW EXECUTE FUNCTION app.point_ledger_set_value();
--> statement-breakpoint
-- Balance = sum of the ledger (LOY-02). SECURITY DEFINER (owner of
-- customer_profiles) because legend_app has no privilege on points_balance;
-- the profile is matched by id AND tenant_id from the inserted row, never by
-- session state. The points_balance >= 0 CHECK aborts the insert that would
-- make the balance negative.
CREATE FUNCTION app.point_ledger_apply_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.customer_profiles
     SET points_balance = points_balance + NEW.points,
         updated_at = now()
   WHERE id = NEW.customer_profile_id
     AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'point_ledger profile not found for balance (LOY-02)'
      USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.point_ledger_apply_balance() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER point_ledger_apply_balance
AFTER INSERT ON public.point_ledger
FOR EACH ROW EXECUTE FUNCTION app.point_ledger_apply_balance();
--> statement-breakpoint
-- The point value cannot change once locked, and the lock cannot be cleared
-- (design §M5: changing the value later is a finance project).
CREATE FUNCTION app.loyalty_program_value_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.point_value_locked_at IS NOT NULL AND (
       NEW.point_value_idr IS DISTINCT FROM OLD.point_value_idr
       OR NEW.point_value_locked_at IS DISTINCT FROM OLD.point_value_locked_at
     ) THEN
    RAISE EXCEPTION 'loyalty point value is locked after the first ledger row (LOY-02)'
      USING ERRCODE = '55000', CONSTRAINT = 'loyalty_programs_point_value_locked';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.loyalty_program_value_lock() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER loyalty_programs_value_lock
BEFORE UPDATE ON public.loyalty_programs
FOR EACH ROW EXECUTE FUNCTION app.loyalty_program_value_lock();
--> statement-breakpoint
-- Member on an order (design §M6): once the order is completed or voided the
-- profile cannot change, except NULL to a profile through a receipt claim
-- (the claim card enforces its 24 hour window; claims are off in m1).
CREATE FUNCTION app.orders_customer_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.customer_profile_id IS DISTINCT FROM OLD.customer_profile_id
     AND OLD.status IN ('completed', 'voided')
     AND NOT (OLD.customer_profile_id IS NULL
              AND NEW.customer_attached_via = 'receipt_claim') THEN
    RAISE EXCEPTION 'orders.customer_profile_id is locked after payment (legend-111j)'
      USING ERRCODE = '55000', CONSTRAINT = 'orders_customer_lock';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.orders_customer_lock() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER orders_customer_lock
BEFORE UPDATE OF customer_profile_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION app.orders_customer_lock();
--> statement-breakpoint
-- Cross-tenant profiles of one user for the identity merge (design §M3, 290b).
-- customer_profiles is FORCE RLS, so the lookup reads an id-only index that
-- has RLS enabled, NOT forced, and no policy: legend_app can neither read nor
-- write it (pattern 0126 delivery_store_index). Rows are kept by the SECURITY
-- DEFINER trigger below from the profile row being written, which already
-- passed the tenant RLS of customer_profiles.
ALTER TABLE public.member_profile_user_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.member_profile_user_index FROM legend_app;
--> statement-breakpoint
REVOKE ALL ON public.member_profile_user_index FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.member_profiles_of_user(p_user_id text)
RETURNS TABLE (tenant_id uuid, profile_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.tenant_id, i.profile_id, i.status::text
    FROM public.member_profile_user_index i
   WHERE i.user_id = p_user_id
   ORDER BY i.tenant_id, i.profile_id;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.member_profiles_of_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_profiles_of_user(text) TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.sync_member_profile_user_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM public.member_profile_user_index WHERE profile_id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.user_id IS NOT NULL THEN
    INSERT INTO public.member_profile_user_index
      (profile_id, tenant_id, user_id, status)
    VALUES (NEW.id, NEW.tenant_id, NEW.user_id, NEW.membership_status);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.sync_member_profile_user_index() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER customer_profiles_user_index
AFTER INSERT OR DELETE OR UPDATE OF user_id, membership_status
ON public.customer_profiles
FOR EACH ROW EXECUTE FUNCTION app.sync_member_profile_user_index();
--> statement-breakpoint
-- New permissions for existing tenants (pattern 0171): role rows are seeded
-- per tenant, so the templates that hold them get the codes appended. New
-- tenants get them from the template catalog. Idempotent; custom roles are
-- never touched. FORCE RLS on roles is lifted for these statements only.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.loyalty.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager', 'marketing')
  AND NOT ("permissions" @> '["crm.loyalty.manage"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.loyalty.review"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager', 'marketing')
  AND NOT ("permissions" @> '["crm.loyalty.review"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.loyalty.fulfil"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager', 'cashier')
  AND NOT ("permissions" @> '["crm.loyalty.fulfil"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.customer.pii.read"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager')
  AND NOT ("permissions" @> '["crm.customer.pii.read"]'::jsonb);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.feedback.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager')
  AND NOT ("permissions" @> '["crm.feedback.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
