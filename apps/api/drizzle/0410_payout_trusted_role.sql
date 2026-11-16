-- legend-i01jp / legend-kjht5 / legend-6htrf (905): the payout role and its
-- tables. The money steps of a failed-item correction, an overpaid record, a
-- return, a posting source fill and a proof closure move to SECURITY DEFINER
-- functions owned by `legend_payout`, a NOLOGIN, non-superuser, non-BYPASSRLS
-- role that nobody can assume (the migrator holds membership only while a
-- migration runs). This file only prepares the ground; the functions come in
-- 0411 (proof binding), 0412 (posting source), 0413 (closures) and 0414
-- (transitions, item guard, revokes from legend_app).
-- 1. The role. RLS still applies to it: the tenant policies name no role.
-- 2. Ownership pattern (repeated by every file that creates a function of the
--    role): GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--    GRANT CREATE ON SCHEMA app TO legend_payout; ALTER FUNCTION ... OWNER TO
--    legend_payout; REVOKE CREATE ON SCHEMA app FROM legend_payout; REVOKE SET
--    OPTION FOR legend_payout FROM CURRENT_USER (the migrator login must end
--    with ADMIN OPTION only, see src/db/migrator-role.ts assertManagesOnly).
-- 3. Three tables, tenant RLS, legend_app may only SELECT:
--    - payroll_payout_attestations: who did each step (user, live MFA session,
--      permission snapshot). Insert-only; the only change is replacing the
--      step-one entry of the same operation while it is still open.
--    - payroll_payout_recon_exceptions: what the nightly reconciliation (C4)
--      flagged; insert-only, it holds a slip back from a new attempt.
--    - payroll_payout_proof_closures: two-person closure of a stuck proof key.
-- 4. app.payout_assert_actor: the one check of the human behind a step. The
--    app role can write user, session, role_assignments and roles, so this
--    proves consistency, not identity; the nightly reconciliation closes the
--    rest (design 905).
-- Error codes: PAYOUT-39 actor unknown or banned, PAYOUT-40 session not the
-- actor's or not live, PAYOUT-41 MFA stale or in the future, PAYOUT-42 no
-- permission in the tenant, PAYOUT-43 attestation cannot change, PAYOUT-44
-- closure cannot change. All 42501 except 43 and 44 (23514).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout') THEN
    CREATE ROLE legend_payout NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_payout' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
                 OR rolcanlogin OR rolinherit)) THEN
    RAISE EXCEPTION 'legend_payout exists with unsafe privileges';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, public TO legend_payout;
--> statement-breakpoint
CREATE TABLE "payroll_payout_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"operation_id" uuid NOT NULL,
	"step" varchar(8) NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_key" varchar(500),
	"binding_id" uuid,
	"actor" text NOT NULL,
	"session_id" text NOT NULL,
	"session_created_at" timestamp with time zone NOT NULL,
	"mfa_verified_at" timestamp with time zone NOT NULL,
	"assertion" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint DEFAULT pg_catalog.txid_current() NOT NULL,
	CONSTRAINT "payroll_payout_attestations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_attestations_step_key" UNIQUE("tenant_id","kind","operation_id","step"),
	CONSTRAINT "payroll_payout_attestations_kind_check" CHECK ("payroll_payout_attestations"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure')),
	CONSTRAINT "payroll_payout_attestations_step_check" CHECK ("payroll_payout_attestations"."step" IN ('propose', 'approve', 'record', 'confirm')),
	CONSTRAINT "payroll_payout_attestations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_attestations_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_attestations_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."payroll_payout_proof_bindings"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_attestations_tenant_batch_idx" ON "payroll_payout_attestations" USING btree ("tenant_id","batch_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_attestations'::regclass);
--> statement-breakpoint
CREATE TABLE "payroll_payout_recon_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"operation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"reason" varchar(200) NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_recon_exceptions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_recon_exceptions_flag_key" UNIQUE("tenant_id","kind","operation_id","item_id","reason"),
	CONSTRAINT "payroll_payout_recon_exceptions_kind_check" CHECK ("payroll_payout_recon_exceptions"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure')),
	CONSTRAINT "payroll_payout_recon_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_exceptions_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."payroll_disbursement_items"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_exceptions_payslip_fk" FOREIGN KEY ("tenant_id","payslip_id") REFERENCES "public"."payslips"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_exceptions_tenant_item_idx" ON "payroll_payout_recon_exceptions" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_exceptions_tenant_payslip_idx" ON "payroll_payout_recon_exceptions" USING btree ("tenant_id","payslip_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_exceptions'::regclass);
--> statement-breakpoint
CREATE TABLE "payroll_payout_proof_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"note" varchar(500) NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_session_id" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_session_id" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_proof_closures_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_proof_closures_evidence_key" UNIQUE("tenant_id","evidence_key"),
	CONSTRAINT "payroll_payout_proof_closures_closed_check" CHECK (("payroll_payout_proof_closures"."closed_at" IS NULL AND "payroll_payout_proof_closures"."closed_by" IS NULL) OR ("payroll_payout_proof_closures"."closed_at" IS NOT NULL AND "payroll_payout_proof_closures"."closed_by" IS NOT NULL AND "payroll_payout_proof_closures"."closed_by" <> "payroll_payout_proof_closures"."proposed_by")),
	CONSTRAINT "payroll_payout_proof_closures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_proof_closures'::regclass);
--> statement-breakpoint
-- legend_app reads these (screens, reconciliation) and writes none of them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.payroll_payout_attestations,
  public.payroll_payout_recon_exceptions,
  public.payroll_payout_proof_closures
  FROM legend_app;
--> statement-breakpoint
-- An attestation is the record of who did a step. The only change: while the
-- operation is still open, the same step-one entry is replaced (the proposer
-- re-proposes with another proof), by the payout role only; the identity of
-- the entry (tenant, kind, operation, step) never moves.
CREATE OR REPLACE FUNCTION app.payroll_payout_attestations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'legend_payout'
    AND OLD.step = 'propose'
    AND NEW.tenant_id = OLD.tenant_id
    AND NEW.kind = OLD.kind
    AND NEW.operation_id = OLD.operation_id
    AND NEW.step = OLD.step THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-43: attestation % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_attestations_guard_trg ON public.payroll_payout_attestations;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_attestations_guard_trg
  BEFORE UPDATE ON public.payroll_payout_attestations
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_attestations_guard();
--> statement-breakpoint
-- A closure moves once, open -> closed (by someone else, checked by the CHECK
-- above); nothing else about it changes.
CREATE OR REPLACE FUNCTION app.payroll_payout_proof_closures_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
    AND (to_jsonb(NEW) - 'closed_at' - 'closed_by' - 'closed_session_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'closed_at' - 'closed_by' - 'closed_session_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-44: proof closure % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_proof_closures_guard_trg ON public.payroll_payout_proof_closures;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_proof_closures_guard_trg
  BEFORE UPDATE ON public.payroll_payout_proof_closures
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_proof_closures_guard();
--> statement-breakpoint
-- What the payout role reads. Tenant RLS binds it like every other role.
GRANT SELECT ON TABLE
  public."user", public."session", public.roles, public.role_assignments,
  public.payroll_runs, public.payslips, public.payroll_disbursement_batches,
  public.payroll_disbursement_items, public.payroll_payout_gl_postings,
  public.payroll_payout_evidence_files, public.payroll_payout_proof_bindings,
  public.payroll_payout_failed_corrections, public.payroll_payout_overpaid_proposals,
  public.payroll_payout_return_claims, public.payroll_payout_proof_backfill_stuck,
  public.payroll_payout_attestations, public.payroll_payout_recon_exceptions,
  public.payroll_payout_proof_closures,
  public.journal_entries, public.journal_lines, public.account_mappings,
  public.bank_accounts, public.chart_of_accounts
  TO legend_payout;
--> statement-breakpoint
-- What it writes: the proposal / claim / correction rows, the attestations, the
-- exceptions (insert-only), the closures, bindings and contests; and, on an
-- item, only the status and payment record, the posting link and the return
-- record; on a posting, only the source account.
GRANT INSERT, UPDATE ON TABLE
  public.payroll_payout_failed_corrections, public.payroll_payout_overpaid_proposals,
  public.payroll_payout_return_claims, public.payroll_payout_attestations,
  public.payroll_payout_proof_closures
  TO legend_payout;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_recon_exceptions, public.payroll_payout_proof_bindings
  TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (status, confirmed_by, confirmation_ref, confirmation_evidence_key, settled_at,
  updated_at, gl_posting_id, returned_by, returned_by_2, return_evidence_key, return_note,
  return_claim_id, returned_at)
  ON TABLE public.payroll_disbursement_items TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (source_gl_account_id) ON TABLE public.payroll_payout_gl_postings TO legend_payout;
--> statement-breakpoint
-- The global contest table has no tenant and no policy for anyone else (0398,
-- pattern 0126): only the payout role gets a policy, to record and to read.
GRANT SELECT, INSERT ON TABLE public.payroll_payout_proof_hash_contests TO legend_payout;
--> statement-breakpoint
CREATE POLICY payout_contests_select ON public.payroll_payout_proof_hash_contests
  FOR SELECT TO legend_payout USING (true);
--> statement-breakpoint
CREATE POLICY payout_contests_insert ON public.payroll_payout_proof_hash_contests
  FOR INSERT TO legend_payout WITH CHECK (true);
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contested(varchar[]) TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_history_pending() TO legend_payout;
--> statement-breakpoint
-- The one check of the human behind a step (owner-only: no EXECUTE for PUBLIC
-- or legend_app; the trusted functions of the role call it as owner). Tenant:
-- the one in force (app.require_tenant_id), never an argument. Returns the
-- snapshot that the attestation stores.
CREATE FUNCTION app.payout_assert_actor(p_tenant uuid, p_actor text, p_session text, p_perm text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_session public."session"%ROWTYPE;
  v_roles uuid[];
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-39: the actor is checked in the tenant in force only'
      USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL OR p_session IS NULL OR NOT EXISTS (
    SELECT 1 FROM public."user" u
     WHERE u.id = p_actor
       AND (COALESCE(u.banned, false) = false
            OR (u.ban_expires IS NOT NULL AND u.ban_expires <= v_now))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-39: payout actor is unknown or banned'
      USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_session
    FROM public."session" s
   WHERE s.id = p_session AND s.user_id = p_actor
     AND s.revoked_at IS NULL AND s.expires_at > v_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-40: payout session is not a live session of the actor'
      USING ERRCODE = '42501';
  END IF;
  -- Fresh step-up: at most 15 minutes old, never in the future (one minute of
  -- clock difference between the app host and the database is tolerated).
  IF v_session.mfa_verified_at IS NULL
    OR v_session.mfa_verified_at < v_now - interval '15 minutes'
    OR v_session.mfa_verified_at > v_now + interval '1 minute' THEN
    RAISE EXCEPTION 'PAYOUT-41: payout session has no fresh MFA verification'
      USING ERRCODE = '42501';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT r.id ORDER BY r.id) INTO v_roles
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = p_tenant AND ra.user_id = p_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND pg_catalog.jsonb_exists(r.permissions, p_perm);
  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: payout actor has no % permission in the tenant', p_perm
      USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'user_id', p_actor,
    'session_id', v_session.id,
    'session_created_at', v_session.created_at,
    'mfa_verified_at', v_session.mfa_verified_at,
    'permission', p_perm,
    'role_ids', pg_catalog.to_jsonb(v_roles));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_assert_actor(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
-- The moment this migration was applied: the boundary the nightly
-- reconciliation uses (money moved before it has no attestations). The value is
-- baked into the function body at migration time.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION app.payout_trusted_since() RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $f$ SELECT %L::timestamptz $f$',
    pg_catalog.clock_timestamp()::text);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_trusted_since() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_trusted_since() TO legend_app, legend_payout;
--> statement-breakpoint
-- Ownership: grant, move, revoke (the migrator keeps no way to become the role).
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_assert_actor(uuid, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
