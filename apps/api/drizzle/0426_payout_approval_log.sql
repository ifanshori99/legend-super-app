-- legend-7gghu (915): append-only receipt of every attested payout step.
-- Until now a payout step left its trace only in payroll_payout_attestations,
-- where the step-one entry of an operation is replaced when the proposer
-- proposes again, and where nobody tells the person that something was done in
-- their name. This file adds a log that is never replaced, and the data for a
-- notification to the actor ("was this you?").
-- 1. payroll_payout_approval_log: one row per consumed grant (UNIQUE tenant,
--    grant), so a repeated propose leaves two rows. It holds who (actor and
--    session, from the grant row), what (kind, step, operation, batch, number of
--    items) and when. No amount: the batch total is sealed. All foreign keys
--    are inside CREATE TABLE (tenant, grant, batch).
-- 2. Rights: the table stays owned by the migrator. Only the payout role inserts
--    (through app.payout_attest); legend_app only reads. Nobody gets UPDATE,
--    DELETE or TRUNCATE; triggers refuse them for every role, the owner too
--    (PAYOUT-78, 23514). Row level security as every tenant table.
-- 3. app.payout_attest (0654 body, same signature): the attestation upsert gets
--    RETURNING id, then one row is written to the log, with actor and session
--    taken from the grant row. Every step is logged, step one included. The
--    log row is in the same transaction as the attestation: a step that rolls
--    back leaves no log.
-- Error code: PAYOUT-78 (23514) the approval log cannot change.
-- Ownership: as 0654, the function is created by the payout role itself (grant,
-- become, work, return, revoke); table and trigger DDL runs as the migrator
-- before that.
CREATE TABLE "payroll_payout_approval_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"attestation_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"step" varchar(8) NOT NULL,
	"operation_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_count" integer NOT NULL,
	"actor" text NOT NULL,
	"session_id" text NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint DEFAULT pg_catalog.txid_current() NOT NULL,
	CONSTRAINT "payroll_payout_approval_log_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_approval_log_grant_key" UNIQUE("tenant_id","grant_id"),
	CONSTRAINT "payroll_payout_approval_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_approval_log_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_approval_log_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_approval_log_tenant_logged_idx" ON "payroll_payout_approval_log" USING btree ("tenant_id","logged_at");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_approval_log'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; the log is the opposite of
-- app-writable. legend_app reads it (the worker sweep, the rule); the payout
-- role inserts; nobody updates, deletes or truncates.
REVOKE ALL ON TABLE public.payroll_payout_approval_log FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_approval_log TO legend_app;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_approval_log TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payroll_payout_approval_log_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-78: the payout approval log cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_approval_log_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_approval_log
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_approval_log_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_approval_log_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_approval_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_approval_log_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Internal helper: one attestation row, written from a consumed grant (0654
-- body). New: the upsert returns the attestation id and one row goes to
-- payroll_payout_approval_log, actor and session from the grant row. A step-one
-- entry that is replaced keeps its earlier log row (one row per grant).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_attest(
  p_tenant uuid, p_kind text, p_operation uuid, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_binding uuid, p_grant uuid, p_assertion jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text;
  v_session text;
  v_created timestamptz;
  v_mfa timestamptz;
  v_rows integer;
  v_attestation uuid;
BEGIN
  SELECT g.actor, g.session_id INTO v_actor, v_session
    FROM public.payroll_payout_grants g
   WHERE g.tenant_id = p_tenant AND g.id = p_grant
     AND g.kind = p_kind AND g.step = p_step AND g.consumed_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-66: an attestation needs the consumed grant of its step'
      USING ERRCODE = '23514';
  END IF;
  SELECT s.created_at, s.mfa_verified_at INTO v_created, v_mfa
    FROM public."session" s
   WHERE s.id = v_session AND s.user_id = v_actor;
  IF NOT FOUND OR v_mfa IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-66: an attestation needs the live MFA session of the actor'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    assertion, attested_at, txid, grant_id)
  VALUES (
    p_tenant, p_kind, p_operation, p_step, p_batch, p_item_ids, p_key,
    p_binding, v_actor, v_session, v_created, v_mfa,
    p_assertion, pg_catalog.statement_timestamp(), pg_catalog.txid_current(), p_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_attestations_step_key DO UPDATE
     SET batch_id = EXCLUDED.batch_id, item_ids = EXCLUDED.item_ids,
         evidence_key = EXCLUDED.evidence_key, binding_id = EXCLUDED.binding_id,
         actor = EXCLUDED.actor, session_id = EXCLUDED.session_id,
         session_created_at = EXCLUDED.session_created_at,
         mfa_verified_at = EXCLUDED.mfa_verified_at,
         assertion = EXCLUDED.assertion, attested_at = EXCLUDED.attested_at,
         txid = EXCLUDED.txid, grant_id = EXCLUDED.grant_id
   WHERE payroll_payout_attestations.step = 'propose'
  RETURNING id INTO v_attestation;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR v_attestation IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-66: the % step of this operation is already attested', p_step
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_approval_log (
    tenant_id, grant_id, attestation_id, kind, step, operation_id, batch_id,
    item_count, actor, session_id)
  VALUES (
    p_tenant, p_grant, v_attestation, p_kind, p_step, p_operation, p_batch,
    COALESCE(pg_catalog.cardinality(p_item_ids), 0), v_actor, v_session);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
