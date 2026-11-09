-- Custom SQL migration file, put your code below! ---
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
