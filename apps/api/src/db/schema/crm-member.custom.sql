-- Custom SQL migration file, put your code below! ---
-- legend-111j: hand SQL of migration 0203_member_loyalty_ledger (tables in
-- crm-member.ts and crm-ledger.ts). Keep this file and the migration in step.
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
--> statement-breakpoint
-- Spent member QR nonces of points redeemed at the POS (weexf, migration 0490):
-- tenant and outlet owned.
SELECT app.enforce_tenant_rls('public.member_qr_redeem_nonces'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.member_qr_redeem_nonces'::regclass);
--> statement-breakpoint
-- Redeem QRs minted by the member PWA (legend-0ne0z, migration 0733): tenant
-- and outlet owned.
SELECT app.enforce_tenant_rls('public.member_qr_redeem_mints'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.member_qr_redeem_mints'::regclass);
