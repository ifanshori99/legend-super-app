-- legend-l2zru (918): "not me", freeze a payout batch, unfreeze it.
-- A person who finds an approval in their name that they did not make disowns
-- that approval-log row. The batch is frozen for as long as a dispute has no
-- unfreeze row. Frozen state lives in two append-only tables, not in the batch
-- status: `halted` is reachable from `sending` only, legend_app can write the
-- batch status, and halt_reason is a provider reason.
-- 1. payroll_payout_batch_disputes and payroll_payout_batch_unfreezes. All
--    foreign keys are inside CREATE TABLE (tenant, batch, approval log, grant,
--    dispute). Owner: the migrator. legend_app reads; the payout role inserts;
--    triggers refuse UPDATE, DELETE and TRUNCATE for every role (PAYOUT-80,
--    23514). Row level security as every tenant table.
-- 2. Grant kinds `disown` (step record) and `unfreeze` (step approve): the kind
--    CHECK grows, and the detail of both is the sha256 (hex) of the reason, so
--    the reason is bound to the step-up. The payout role reads the approval log.
-- 3. app.payout_assert_session(tenant, actor, session): a lighter check than
--    app.payout_assert_actor. User not banned, session alive, any active role
--    assignment in the tenant. No payroll permission and no MFA age, so an
--    approver whose permission an attacker removed can still freeze the batch.
-- 4. app.payout_grant_issue (0425 body): disown/record is password step-up only
--    and its ref must be an approval-log row of this tenant, this batch, this
--    actor (PAYOUT-81); unfreeze/approve needs payroll.disburse.approve and an
--    active tenant-scope owner or finance assignment (PAYOUT-82). Every other
--    kind is refused a grant on a frozen batch (PAYOUT-79).
-- 5. app.payout_approval_disown(log, grant, reason) -> dispute id and
--    app.payout_batch_unfreeze(batch, grant, reason) -> number of disputes
--    released. EXECUTE for legend_app only.
-- 6. app.payout_batch_assert_open(tenant, batch) and its lock-free twin
--    app.payout_batch_assert_open_nolock: a null batch passes; the locked one
--    takes FOR UPDATE on the batch first (it serialises with the FOR UPDATE of a
--    disown); an open dispute on the batch, or on another batch that shares a
--    payslip with it, is PAYOUT-79. The calls themselves, in the old functions
--    and in triggers, are migration 0428.
-- Error codes: PAYOUT-79 (23514) a frozen batch refuses the step, PAYOUT-80
-- (23514) the dispute tables cannot change, PAYOUT-81 (42501) disown refused,
-- PAYOUT-82 (23514, 42501 for the grant) unfreeze refused.
-- Ownership: as 0654, the functions are created by the payout role itself
-- (grant, become, work, return, revoke); table and trigger DDL runs as the
-- migrator before that. No row is written or changed by this migration.
CREATE TABLE "payroll_payout_batch_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"log_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"session_id" text NOT NULL,
	"reason" varchar(500),
	"batch_status_at" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint DEFAULT pg_catalog.txid_current() NOT NULL,
	CONSTRAINT "payroll_payout_batch_disputes_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_batch_disputes_tenant_id_batch_key" UNIQUE("tenant_id","id","batch_id"),
	CONSTRAINT "payroll_payout_batch_disputes_grant_key" UNIQUE("tenant_id","grant_id"),
	CONSTRAINT "payroll_payout_batch_disputes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_disputes_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_disputes_log_fk" FOREIGN KEY ("tenant_id","log_id") REFERENCES "public"."payroll_payout_approval_log"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_disputes_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "payroll_payout_batch_unfreezes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"dispute_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"session_id" text NOT NULL,
	"role_template" varchar(8) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint DEFAULT pg_catalog.txid_current() NOT NULL,
	CONSTRAINT "payroll_payout_batch_unfreezes_dispute_key" UNIQUE("tenant_id","dispute_id"),
	CONSTRAINT "payroll_payout_batch_unfreezes_role_check" CHECK ("payroll_payout_batch_unfreezes"."role_template" IN ('owner', 'finance')),
	CONSTRAINT "payroll_payout_batch_unfreezes_reason_check" CHECK (pg_catalog.char_length(pg_catalog.btrim("payroll_payout_batch_unfreezes"."reason")) >= 10),
	CONSTRAINT "payroll_payout_batch_unfreezes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_unfreezes_dispute_fk" FOREIGN KEY ("tenant_id","dispute_id","batch_id") REFERENCES "public"."payroll_payout_batch_disputes"("tenant_id","id","batch_id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_unfreezes_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_batch_unfreezes_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_batch_disputes_tenant_batch_idx" ON "payroll_payout_batch_disputes" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_batch_disputes_tenant_log_idx" ON "payroll_payout_batch_disputes" USING btree ("tenant_id","log_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_batch_unfreezes_tenant_batch_idx" ON "payroll_payout_batch_unfreezes" USING btree ("tenant_id","batch_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_batch_disputes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_batch_unfreezes'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; both tables are the opposite of
-- app-writable. legend_app reads (the batch screen, the finance exception, the
-- worker sweep); the payout role reads and inserts; nobody updates, deletes or
-- truncates.
REVOKE ALL ON TABLE public.payroll_payout_batch_disputes FROM PUBLIC, legend_app;
--> statement-breakpoint
REVOKE ALL ON TABLE public.payroll_payout_batch_unfreezes FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_batch_disputes TO legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_batch_unfreezes TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_batch_disputes TO legend_payout;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_batch_unfreezes TO legend_payout;
--> statement-breakpoint
-- The disown and unfreeze functions read the approval log (0426 gave the payout
-- role INSERT only).
GRANT SELECT ON TABLE public.payroll_payout_approval_log TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payroll_payout_batch_disputes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-80: a payout batch dispute or unfreeze cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_batch_disputes_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_batch_disputes
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_batch_disputes_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_batch_disputes_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_batch_disputes
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_batch_disputes_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_batch_unfreezes_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_batch_unfreezes
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_batch_disputes_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_batch_unfreezes_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_batch_unfreezes
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_batch_disputes_guard();
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_kind_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_detail_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'disown', 'unfreeze'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_detail_check" CHECK (("payroll_payout_grants"."kind" = 'resolve' AND "payroll_payout_grants"."detail" IN ('failed', 'not_sent')) OR ("payroll_payout_grants"."kind" = 'bank_confirm' AND "payroll_payout_grants"."detail" = 'succeeded') OR ("payroll_payout_grants"."kind" IN ('disown', 'unfreeze') AND "payroll_payout_grants"."detail" ~ '^[0-9a-f]{64}$') OR ("payroll_payout_grants"."kind" NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze') AND "payroll_payout_grants"."detail" IS NULL));
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The lighter check of the human behind a disown (owner-only: no EXECUTE for
-- PUBLIC or legend_app; the grant issue function calls it as owner). The
-- tenant in force, never an argument. Returns the snapshot the grant stores.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_assert_session(p_tenant uuid, p_actor text, p_session text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_session public."session"%ROWTYPE;
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
  IF NOT EXISTS (
    SELECT 1 FROM public.role_assignments ra
     WHERE ra.tenant_id = p_tenant AND ra.user_id = p_actor
       AND ra.valid_from <= v_now
       AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-42: payout actor has no active role in the tenant'
      USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'user_id', p_actor,
    'session_id', v_session.id,
    'session_created_at', v_session.created_at,
    'mfa_verified_at', v_session.mfa_verified_at,
    'permission', NULL,
    'check', 'session');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_assert_session(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The helpers every guarded step calls. A null batch passes. A batch is frozen
-- when it has an open dispute (a dispute row without an unfreeze row) OR when it
-- shares a payslip with ANOTHER batch that has one: a retry batch made before
-- the disown must not pay what the disputed batch may already have paid
-- (read only, no lock on the sibling). The open dispute is PAYOUT-79.
-- app.payout_batch_assert_open takes FOR UPDATE on the batch row first (the
-- project lock order is batch, then items, so it is the first lock of a
-- trusted step, and it serialises with the FOR UPDATE of a disown; FOR UPDATE
-- and not FOR KEY SHARE, so a step that later locks the row FOR UPDATE does
-- not wait on its own kind). app.payout_batch_assert_open_nolock reads only,
-- for the row triggers that already hold a row. SECURITY DEFINER so the
-- triggers of legend_app can call them.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_batch_frozen(p_tenant uuid, p_batch uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_batch_disputes d
     WHERE d.tenant_id = p_tenant
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_payout_batch_unfreezes u
          WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)
       AND (d.batch_id = p_batch
         OR EXISTS (
           SELECT 1
             FROM public.payroll_disbursement_items mine
             JOIN public.payroll_disbursement_items sibling
               ON sibling.tenant_id = mine.tenant_id
              AND sibling.payslip_id = mine.payslip_id
            WHERE mine.tenant_id = p_tenant AND mine.batch_id = p_batch
              AND sibling.batch_id = d.batch_id))
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_frozen(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.payout_batch_assert_open(p_tenant uuid, p_batch uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_batch IS NULL THEN
    RETURN;
  END IF;
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-79: the tenant is not the tenant in force'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = p_tenant AND b.id = p_batch
     FOR UPDATE;
  IF app.payout_batch_frozen(p_tenant, p_batch) THEN
    RAISE EXCEPTION 'PAYOUT-79: the payout batch is frozen, a dispute on it is open'
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_assert_open(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_batch_assert_open(uuid, uuid) TO legend_app, legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_batch_assert_open_nolock(p_tenant uuid, p_batch uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_batch IS NULL THEN
    RETURN;
  END IF;
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-79: the tenant is not the tenant in force'
      USING ERRCODE = '42501';
  END IF;
  IF app.payout_batch_frozen(p_tenant, p_batch) THEN
    RAISE EXCEPTION 'PAYOUT-79: the payout batch is frozen, a dispute on it is open'
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_assert_open_nolock(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_batch_assert_open_nolock(uuid, uuid) TO legend_app, legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Issue a grant (grantor login only): the 0425 body plus disown/record and
-- unfreeze/approve. The detail of both is the sha256 (hex) of the reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_grant_issue(
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
  IF NOT ((p_kind = 'correction' AND p_step IN ('propose', 'approve', 'withdraw'))
       OR (p_kind = 'overpaid' AND p_step IN ('propose', 'record', 'withdraw'))
       OR (p_kind = 'return' AND p_step IN ('propose', 'confirm'))
       OR (p_kind = 'closure' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'posting_source' AND p_step = 'record')
       OR (p_kind = 'resolve' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'bank_confirm' AND p_step = 'record')
       OR (p_kind = 'disown' AND p_step = 'record')
       OR (p_kind = 'unfreeze' AND p_step = 'approve')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  -- The detail of a grant: the outcome for resolve, 'succeeded' for a bank
  -- confirmation, the sha256 (hex) of the reason for disown and unfreeze,
  -- nothing for every other kind (the table CHECK says the same).
  IF NOT ((p_kind = 'resolve' AND p_detail IN ('failed', 'not_sent'))
       OR (p_kind = 'bank_confirm' AND p_detail = 'succeeded')
       OR (p_kind IN ('disown', 'unfreeze') AND p_detail ~ '^[0-9a-f]{64}$')
       OR (p_kind NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze') AND p_detail IS NULL)) THEN
    RAISE EXCEPTION 'PAYOUT-72: the detail of this payout grant is not valid for its kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('password', 'mfa_challenge') THEN
    RAISE EXCEPTION 'PAYOUT-72: unknown step-up method for a payout grant'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'disown' THEN
    -- Password only, no payroll permission and no MFA age: a revoked approver
    -- can still say "not me". The ref is the log row, which must be this
    -- actor's own on this batch.
    IF p_method <> 'password' THEN
      RAISE EXCEPTION 'PAYOUT-72: a disown grant needs a password step-up'
        USING ERRCODE = '22023';
    END IF;
    v_assertion := app.payout_assert_session(v_tenant, p_actor, p_session);
    IF p_batch IS NULL OR p_ref IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.payroll_payout_approval_log l
       WHERE l.tenant_id = v_tenant AND l.id = p_ref
         AND l.actor = p_actor AND l.batch_id = p_batch
    ) THEN
      RAISE EXCEPTION 'PAYOUT-81: only the actor of an approval log row of this batch can disown it'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
    IF p_kind = 'unfreeze' THEN
      IF p_batch IS NULL OR NOT EXISTS (
        SELECT 1
          FROM public.role_assignments ra
          JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         WHERE ra.tenant_id = v_tenant AND ra.user_id = p_actor
           AND ra.scope_type = 'tenant'
           AND ra.valid_from <= v_now
           AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
           AND r.template_key IN ('owner', 'finance')
      ) THEN
        RAISE EXCEPTION 'PAYOUT-82: only a tenant-wide owner or finance role can unfreeze a batch'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF p_batch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-72: the batch of a payout grant is not in the tenant'
      USING ERRCODE = '22023';
  END IF;
  -- No grant for a frozen batch (PAYOUT-79), for every kind but the two that
  -- end a freeze or start one. Read only: the grantor connection must not wait
  -- on a batch lock of the request it serves. Consume checks again, locked.
  IF p_kind NOT IN ('disown', 'unfreeze') THEN
    PERFORM app.payout_batch_assert_open_nolock(v_tenant, p_batch);
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

-- ---------------------------------------------------------------------------
-- "Not me": the actor of an approval-log row disowns it. The grant is spent
-- with the batch of the log row and the log row as ref; its detail is the
-- sha256 of the reason (null reason = empty string). Repeating a disown returns
-- the same dispute id. Allowed on a final or an already frozen batch.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_approval_disown(p_log uuid, p_grant text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_log public.payroll_payout_approval_log%ROWTYPE;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_status varchar;
  v_id uuid;
BEGIN
  IF p_reason IS NOT NULL AND pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-81: a disown reason has at most 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT l.* INTO v_log
    FROM public.payroll_payout_approval_log l
   WHERE l.tenant_id = v_tenant AND l.id = p_log;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-81: approval log row not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'disown', 'record', v_log.batch_id,
           NULL, NULL, p_log, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(COALESCE(p_reason, ''), 'UTF8')), 'hex')) AS g;
  IF v_actor IS DISTINCT FROM v_log.actor THEN
    RAISE EXCEPTION 'PAYOUT-81: only the actor of an approval log row can disown it'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.status INTO v_status
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_log.batch_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- Under the batch lock: an OPEN dispute of this log row is returned again;
  -- after an unfreeze the same row may be disowned anew (a new dispute row).
  SELECT d.id INTO v_id
    FROM public.payroll_payout_batch_disputes d
   WHERE d.tenant_id = v_tenant AND d.log_id = p_log
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_batch_unfreezes u
        WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)
   ORDER BY d.created_at, d.id
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  INSERT INTO public.payroll_payout_batch_disputes (
    tenant_id, batch_id, log_id, grant_id, actor, session_id, reason, batch_status_at)
  VALUES (
    v_tenant, v_log.batch_id, p_log, v_grant, v_actor, v_session, p_reason, v_status)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_approval_disown(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_approval_disown(uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Unfreeze: one unfreeze row per open dispute of the batch, one person is
-- enough. The approver must hold an active tenant-scope owner or finance role
-- and must have taken no part in the batch: not its requester, approver or
-- exporter, not a confirmer or resolver of any item, not the actor of any log
-- row (and the same for every batch that shares a payslip with it, such as a
-- retry batch). One exception: the approver is the disputant of every open dispute (a
-- person withdrawing their own claim). The reason is the finance check result.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_batch_unfreeze(p_batch uuid, p_grant text, p_reason text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_template text;
  v_open integer;
  v_mine integer;
  v_involved boolean;
  v_rows integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-82: an unfreeze needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'unfreeze', 'approve', p_batch,
           NULL, NULL, NULL, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(p_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   ORDER BY (r.template_key = 'owner') DESC
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-82: only a tenant-wide owner or finance role can unfreeze a batch'
      USING ERRCODE = '23514';
  END IF;
  -- A claim is withdrawn only from the session that filed it: a stolen login
  -- of the disputant, on another session, cannot lift its own owner's freeze.
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (WHERE d.actor = v_actor AND d.session_id = v_session)
    INTO v_open, v_mine
    FROM public.payroll_payout_batch_disputes d
   WHERE d.tenant_id = v_tenant AND d.batch_id = p_batch
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_batch_unfreezes u
        WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id);
  IF v_open = 0 THEN
    RAISE EXCEPTION 'PAYOUT-82: the payout batch has no open dispute'
      USING ERRCODE = '23514';
  END IF;
  -- "Took part" covers every batch that shares a payslip with this one (the
  -- retry batch of the same pay, made before or after the claim), not only
  -- this batch: the person who asked for or approved the sibling batch moved
  -- the same pay.
  v_involved := EXISTS (
      WITH related AS (
        SELECT p_batch AS batch_id
        UNION
        SELECT sibling.batch_id
          FROM public.payroll_disbursement_items mine
          JOIN public.payroll_disbursement_items sibling
            ON sibling.tenant_id = mine.tenant_id
           AND sibling.payslip_id = mine.payslip_id
         WHERE mine.tenant_id = v_tenant AND mine.batch_id = p_batch
      )
      SELECT 1 FROM public.payroll_disbursement_batches rb
        JOIN related r ON r.batch_id = rb.id
       WHERE rb.tenant_id = v_tenant
         AND (rb.requested_by = v_actor OR rb.approved_by = v_actor
              OR rb.exported_by = v_actor)
      UNION ALL
      SELECT 1 FROM public.payroll_disbursement_items i
        JOIN related r ON r.batch_id = i.batch_id
       WHERE i.tenant_id = v_tenant
         AND (i.confirmed_by = v_actor OR i.resolved_by = v_actor
              OR i.resolved_by_2 = v_actor OR i.returned_by = v_actor
              OR i.returned_by_2 = v_actor)
      UNION ALL
      SELECT 1 FROM public.payroll_payout_approval_log l
        JOIN related r ON r.batch_id = l.batch_id
       WHERE l.tenant_id = v_tenant AND l.actor = v_actor
      UNION ALL
      -- Steps attested before the approval log existed (0426).
      SELECT 1 FROM public.payroll_payout_attestations att
        JOIN related r ON r.batch_id = att.batch_id
       WHERE att.tenant_id = v_tenant AND att.actor = v_actor
  );
  IF v_involved AND v_mine <> v_open THEN
    RAISE EXCEPTION 'PAYOUT-82: a person who took part in this batch cannot unfreeze it'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.payroll_payout_batch_unfreezes (
    tenant_id, batch_id, dispute_id, grant_id, actor, session_id, role_template, reason)
  SELECT v_tenant, p_batch, d.id, v_grant, v_actor, v_session, v_template, p_reason
    FROM public.payroll_payout_batch_disputes d
   WHERE d.tenant_id = v_tenant AND d.batch_id = p_batch
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_payout_batch_unfreezes u
        WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_batch_unfreeze(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_batch_unfreeze(uuid, text, text) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
