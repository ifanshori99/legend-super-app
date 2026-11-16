-- legend-911 (P1-1 of the second opinion on 905): one-time payout step grant.
-- Until now the trusted payout functions took (actor, session) as arguments, so
-- any code that could read a live `session` row could act as two approvers. The
-- authority to name a human behind a money step moves to a separate database
-- login that `legend_app` cannot use:
-- 1. `legend_payout_grantor`: NOLOGIN group that may only EXECUTE
--    app.payout_grant_issue. A LOGIN member `legend_grant_<16 hex>` is made by
--    provision-roles (same pattern as `legend_maintenance`, migration 0187). The
--    API reaches it through its own small pool (PAYOUT_GRANTOR_DATABASE_URL).
-- 2. `payroll_payout_grants`: one row per grant. Only the SHA-256 of a 32-byte
--    secret is stored. The grant is bound to tenant, actor, session, kind, step,
--    batch, item set, evidence key, ref, target and detail; expires after two
--    minutes; is used once. `legend_app` has no write right and no right on the
--    secret hash or the assertion; `legend_payout` inserts and marks consumed.
-- 3. app.payout_grant_issue (grantor only): checks the human with
--    app.payout_assert_actor (live session, MFA at most 15 minutes old,
--    permission), then stores the grant and returns the secret once.
-- 4. app.payout_grant_consume (owner only): the atomic single-use spend that the
--    trusted step functions of migration 0654 call first.
-- 5. payroll_payout_attestations.grant_id: composite FK to the grant (tenant,
--    id, kind, step, actor, session). The CHECK "no attestation after the
--    cutover without a grant" comes at the end of 0654, once every writer uses
--    grants.
-- Error codes: PAYOUT-70 no valid grant for this step (42501), PAYOUT-72 grant
-- cannot be issued for these arguments (22023), PAYOUT-75 grant row cannot
-- change (23514). PAYOUT-71 (step one carries no grant) is raised in 0654.
-- (The numbers 70 to 72 are also used by 0649 for other, unrelated checks; the
-- message text tells them apart.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout_grantor') THEN
    CREATE ROLE legend_payout_grantor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout_grantor' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'legend_payout_grantor exists with unsafe privileges';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO legend_payout_grantor;
--> statement-breakpoint
CREATE TABLE "payroll_payout_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"secret_sha256" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"step" varchar(8) NOT NULL,
	"batch_id" uuid,
	"item_set_hash" varchar(64),
	"evidence_key" varchar(500),
	"ref_id" uuid,
	"target_id" uuid,
	"detail" varchar(64),
	"actor" text NOT NULL,
	"session_id" text NOT NULL,
	"step_up_method" varchar(16) NOT NULL,
	"assertion" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_txid" bigint,
	CONSTRAINT "payroll_payout_grants_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_grants_secret_key" UNIQUE("secret_sha256"),
	CONSTRAINT "payroll_payout_grants_attest_key" UNIQUE("tenant_id","id","kind","step","actor","session_id"),
	CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'closure', 'posting_source')),
	CONSTRAINT "payroll_payout_grants_step_check" CHECK ("payroll_payout_grants"."step" IN ('propose', 'approve', 'record', 'confirm')),
	CONSTRAINT "payroll_payout_grants_method_check" CHECK ("payroll_payout_grants"."step_up_method" IN ('password', 'mfa_challenge')),
	CONSTRAINT "payroll_payout_grants_expiry_check" CHECK ("payroll_payout_grants"."expires_at" > "payroll_payout_grants"."issued_at" AND "payroll_payout_grants"."expires_at" <= "payroll_payout_grants"."issued_at" + interval '2 minutes'),
	CONSTRAINT "payroll_payout_grants_consumed_check" CHECK (("payroll_payout_grants"."consumed_at" IS NULL) = ("payroll_payout_grants"."consumed_txid" IS NULL)),
	CONSTRAINT "payroll_payout_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_grants_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_grants_tenant_batch_idx" ON "payroll_payout_grants" USING btree ("tenant_id","batch_id");--> statement-breakpoint
-- An attestation names the grant it was made under. NULL only for entries
-- before the cutover (the CHECK in 0654). MATCH SIMPLE: no grant, no check.
-- The attestations table is FORCED under row level security. A migrator without
-- BYPASSRLS has no tenant in force, so the FK check (which reads the table under
-- the tenant policy) fails with "tenant context is required". The column is new
-- and NULL on every row, so the check has nothing to find: lift FORCE for these
-- three statements and restore it (same as 0065). Same transaction, no window.
-- The grants table is not under row level security yet at this point, for the same
-- reason (it is the other table the FK check reads).
ALTER TABLE "payroll_payout_attestations" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD COLUMN "grant_id" uuid;
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD CONSTRAINT "payroll_payout_attestations_grant_fk" FOREIGN KEY ("tenant_id","grant_id","kind","step","actor","session_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id","kind","step","actor","session_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD CONSTRAINT "payroll_payout_attestations_grant_key" UNIQUE ("tenant_id","grant_id");
--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_grants'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; a grant is the opposite of
-- app-writable. legend_app keeps column SELECT on the non-secret columns only
-- (the nightly reconciliation); no DELETE or TRUNCATE for anybody.
REVOKE ALL ON TABLE public.payroll_payout_grants FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, kind, step, batch_id, item_set_hash, evidence_key, ref_id,
  target_id, detail, actor, session_id, step_up_method, issued_at, expires_at,
  consumed_at, consumed_txid)
  ON TABLE public.payroll_payout_grants TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_grants TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (consumed_at, consumed_txid) ON TABLE public.payroll_payout_grants TO legend_payout;
--> statement-breakpoint
-- The only change a grant ever sees: consumed_at and consumed_txid from NULL to
-- a value, by the payout role. Every other column stays as issued.
CREATE FUNCTION app.payroll_payout_grants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'legend_payout'
    AND OLD.consumed_at IS NULL AND OLD.consumed_txid IS NULL
    AND NEW.consumed_at IS NOT NULL AND NEW.consumed_txid IS NOT NULL
    AND (to_jsonb(NEW) - 'consumed_at' - 'consumed_txid')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'consumed_at' - 'consumed_txid') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-75: payout grant % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_grants_guard_trg
  BEFORE UPDATE ON public.payroll_payout_grants
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_grants_guard();
--> statement-breakpoint
-- The moment this migration was applied: the boundary of the attestation
-- CHECK (0654) and of the nightly reconciliation (attestations before it carry
-- no grant). Baked into the function body at migration time, same pattern as
-- app.payout_trusted_since() in 0644.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION app.payout_grants_since() RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $f$ SELECT %L::timestamptz $f$',
    pg_catalog.clock_timestamp()::text);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_grants_since() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_grants_since() TO legend_app, legend_payout;
--> statement-breakpoint
-- Issue a grant (grantor login only). The tenant is the one in force (the
-- grantor transaction sets app.tenant_id), never an argument. Returns the
-- secret: 64 hex characters from two random uuids (244 random bits, core
-- PostgreSQL only); only its SHA-256 is stored. Which (kind, step) pairs exist:
-- correction {propose, approve}, overpaid {propose, record}, return {propose,
-- confirm}, closure {propose, approve}, posting_source {record}.
CREATE FUNCTION app.payout_grant_issue(
  p_kind text, p_step text, p_batch uuid, p_item_ids uuid[], p_key varchar,
  p_ref uuid, p_target uuid, p_detail varchar, p_actor text, p_session text,
  p_method text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_assertion jsonb;
  v_secret text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT ((p_kind = 'correction' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'overpaid' AND p_step IN ('propose', 'record'))
       OR (p_kind = 'return' AND p_step IN ('propose', 'confirm'))
       OR (p_kind = 'closure' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'posting_source' AND p_step = 'record')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('password', 'mfa_challenge') THEN
    RAISE EXCEPTION 'PAYOUT-72: unknown step-up method for a payout grant'
      USING ERRCODE = '22023';
  END IF;
  v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  IF p_batch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-72: the batch of a payout grant is not in the tenant'
      USING ERRCODE = '22023';
  END IF;
  v_secret := pg_catalog.encode(
    pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
      || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 'hex');
  INSERT INTO public.payroll_payout_grants (
    tenant_id, secret_sha256, kind, step, batch_id, item_set_hash, evidence_key,
    ref_id, target_id, detail, actor, session_id, step_up_method, assertion,
    issued_at, expires_at)
  VALUES (
    v_tenant,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(v_secret, 'hex')), 'hex'),
    p_kind, p_step, p_batch,
    app.payout_item_set_hash(COALESCE(p_item_ids, '{}'::uuid[])),
    p_key, p_ref, p_target, p_detail, p_actor, p_session, p_method, v_assertion,
    v_now, v_now + interval '2 minutes');
  RETURN v_secret;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_grant_issue(text, text, uuid, uuid[], varchar, uuid, uuid, varchar, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_grant_issue(text, text, uuid, uuid[], varchar, uuid, uuid, varchar, text, text, text) TO legend_payout_grantor;
--> statement-breakpoint
-- Spend a grant (owner only: the trusted step functions of the role call it as
-- their first statement). One UPDATE does the whole check, so two concurrent
-- spenders cannot both win: the second re-checks consumed_at after the row lock
-- and gets zero rows. Every binding column must equal the argument (NULL equals
-- NULL). A rollback of the calling step leaves the grant unspent; it then
-- expires unused (only the API process holds the secret).
CREATE FUNCTION app.payout_grant_consume(
  p_tenant uuid, p_grant text, p_kind text, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_ref uuid, p_target uuid, p_detail varchar)
RETURNS TABLE (grant_id uuid, actor text, session_id text, assertion jsonb)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_id uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
BEGIN
  IF p_grant IS NULL OR p_grant !~ '^[0-9a-f]{64}$'
     OR p_tenant IS NULL
     OR p_tenant::text IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'PAYOUT-70: no valid payout grant for this step'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.payroll_payout_grants g
     SET consumed_at = v_now,
         consumed_txid = pg_catalog.txid_current()
   WHERE g.tenant_id = p_tenant
     AND g.secret_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(p_grant, 'hex')), 'hex')
     AND g.consumed_at IS NULL
     AND g.expires_at > v_now
     AND g.kind = p_kind
     AND g.step = p_step
     AND g.batch_id IS NOT DISTINCT FROM p_batch
     AND g.item_set_hash IS NOT DISTINCT FROM app.payout_item_set_hash(COALESCE(p_item_ids, '{}'::uuid[]))
     AND g.evidence_key IS NOT DISTINCT FROM p_key
     AND g.ref_id IS NOT DISTINCT FROM p_ref
     AND g.target_id IS NOT DISTINCT FROM p_target
     AND g.detail IS NOT DISTINCT FROM p_detail
  RETURNING g.id, g.actor, g.session_id, g.assertion
    INTO v_id, v_actor, v_session, v_assertion;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-70: no valid payout grant for this step'
      USING ERRCODE = '42501';
  END IF;
  grant_id := v_id;
  actor := v_actor;
  session_id := v_session;
  assertion := v_assertion;
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_grant_consume(uuid, text, text, text, uuid, uuid[], varchar, uuid, uuid, varchar) FROM PUBLIC;
--> statement-breakpoint
-- Ownership: grant, move, revoke (the migrator keeps no way to become the role).
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_grant_issue(text, text, uuid, uuid[], varchar, uuid, uuid, varchar, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_grant_consume(uuid, text, text, text, uuid, uuid[], varchar, uuid, uuid, varchar) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
