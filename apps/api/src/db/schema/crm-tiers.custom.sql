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
