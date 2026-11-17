-- legend-snwnn (1005): withdraw an open return claim, two people.
-- A return claim (step one of a return: someone recorded the bank reference and
-- the proof of money that came back) stays `open` until a second person confirms
-- it. When the first person got it wrong, the claim burned the proof, the bank
-- reference and the items for good. Now two finance people can withdraw an
-- OPEN claim: propose, then approve, each under a one-time payout grant (kind
-- return_withdraw, password step-up only, tenant-wide owner or finance role plus
-- payroll.disburse.approve). Pattern of recon_clear (0580/0581).
--   * A claim moves open -> withdrawn (never consumed -> withdrawn: a consumed
--     claim posted a journal and its items are `returned`; that is terminal).
--   * The five return columns of its items (returned_by, return_evidence_key,
--     return_note, return_claim_id, return_bank_ref) go back to NULL; the item
--     status stays `succeeded`, so nothing is paid again by itself and no
--     journal, batch or payment record is touched.
--   * The claim row, its proof file, binding and hashes stay (append-only): the
--     withdrawn proof stays burned, a new claim needs a NEW proof file. Only the
--     unique bank_ref index ignores a withdrawn claim (it never moved money), so
--     the right reference can be used again.
-- 1. payroll_payout_return_claims: status widened to varchar(16) (`withdrawn` has
--    9 characters), withdrawn_at, status and consumed CHECKs, bank_ref unique
--    index made partial, guard: open -> withdrawn only for the payout role and
--    only with an approved withdrawal row of the claim.
-- 2. payroll_payout_return_withdrawals (new, FORCE RLS, read-only to legend_app,
--    written by the payout functions below only, an approval moves it once).
-- 3. Kind return_withdraw in the grant, attestation and recon-exception CHECKs.
-- 4. app.payout_grant_issue (0581 body): kind return_withdraw, step propose and
--    approve. Detail = sha256 (hex) of the reason. Ref = the claim (propose) or
--    the withdrawal (approve); batch = batch of the claim. The batch requester
--    cannot hold either step (PAYOUT-64). The proposer, and the session that
--    proposed, cannot get the approve grant (PAYOUT-94).
-- 5. app.payout_return_withdraw_propose(claim, grant, reason) -> withdrawal id
--    and app.payout_return_withdraw_approve(withdrawal, grant) -> items restored.
--    EXECUTE for legend_app only. Attested (kind return_withdraw, operation = the
--    withdrawal, step propose / approve, the proof of the claim and its binding).
-- 6. app.payout_return_confirm (0583 body): the message for a claim that is not
--    open says so (a withdrawn claim cannot be confirmed). Rules unchanged.
-- 7. Item guard (0581 body): the claim link leaves an item only through a
--    withdrawn claim (PAYOUT-93).
-- Error codes: PAYOUT-92 (23514) a withdrawal reason of 10 to 500 characters,
-- PAYOUT-93 (23514) the claim cannot be withdrawn (not open, items changed,
-- return journal exists), PAYOUT-94 (42501) the proposer (user or session)
-- cannot approve, PAYOUT-95 (23514) the withdrawal is already approved (or
-- cannot change). A claim or withdrawal of another tenant, or missing:
-- PAYOUT-69 (P0002). The batch requester: PAYOUT-64. A role without owner or
-- finance at tenant scope: PAYOUT-42. A grant that does not match: PAYOUT-70.
-- Ownership: as 0581, the trusted functions are created by the payout role; the
-- tables, the guards and the item guard (invoker functions) by the migrator.
ALTER TABLE "payroll_payout_return_claims" DROP CONSTRAINT "payroll_payout_return_claims_status_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" DROP CONSTRAINT "payroll_payout_return_claims_consumed_check";--> statement-breakpoint
-- The closed-key trigger (0418) is declared UPDATE OF status: Postgres refuses to
-- change the type of a column a trigger definition names (0A000). Drop and
-- recreate it with the same definition around the widening.
DROP TRIGGER IF EXISTS payroll_payout_return_claims_closed_key_trg ON public.payroll_payout_return_claims;--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ALTER COLUMN "status" SET DATA TYPE varchar(16);--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_claims_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_return_claims
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "payroll_payout_return_claims_bank_ref_key";--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_claims_bank_ref_key" ON "payroll_payout_return_claims" USING btree ("tenant_id","bank_ref") WHERE "payroll_payout_return_claims"."bank_ref" IS NOT NULL AND "payroll_payout_return_claims"."status" <> 'withdrawn';--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD CONSTRAINT "payroll_payout_return_claims_status_check" CHECK ("payroll_payout_return_claims"."status" IN ('open', 'consumed', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD CONSTRAINT "payroll_payout_return_claims_consumed_check" CHECK (("payroll_payout_return_claims"."status" = 'open' AND "payroll_payout_return_claims"."consumed_at" IS NULL AND "payroll_payout_return_claims"."withdrawn_at" IS NULL) OR ("payroll_payout_return_claims"."status" = 'consumed' AND "payroll_payout_return_claims"."consumed_at" IS NOT NULL AND "payroll_payout_return_claims"."withdrawn_at" IS NULL) OR ("payroll_payout_return_claims"."status" = 'withdrawn' AND "payroll_payout_return_claims"."consumed_at" IS NULL AND "payroll_payout_return_claims"."withdrawn_at" IS NOT NULL));--> statement-breakpoint
CREATE TABLE "payroll_payout_return_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reason_sha256" varchar(64) NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_session_id" text NOT NULL,
	"proposed_grant_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_session_id" text,
	"approved_grant_id" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_return_withdrawals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_return_withdrawals_reason_check" CHECK (char_length(btrim("payroll_payout_return_withdrawals"."reason")) >= 10 AND char_length("payroll_payout_return_withdrawals"."reason") <= 500),
	CONSTRAINT "payroll_payout_return_withdrawals_sha_check" CHECK ("payroll_payout_return_withdrawals"."reason_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payroll_payout_return_withdrawals_approved_check" CHECK (("payroll_payout_return_withdrawals"."approved_by" IS NULL AND "payroll_payout_return_withdrawals"."approved_session_id" IS NULL AND "payroll_payout_return_withdrawals"."approved_grant_id" IS NULL AND "payroll_payout_return_withdrawals"."approved_at" IS NULL) OR ("payroll_payout_return_withdrawals"."approved_by" IS NOT NULL AND "payroll_payout_return_withdrawals"."approved_session_id" IS NOT NULL AND "payroll_payout_return_withdrawals"."approved_grant_id" IS NOT NULL AND "payroll_payout_return_withdrawals"."approved_at" IS NOT NULL AND "payroll_payout_return_withdrawals"."approved_by" <> "payroll_payout_return_withdrawals"."proposed_by" AND "payroll_payout_return_withdrawals"."approved_session_id" <> "payroll_payout_return_withdrawals"."proposed_session_id")),
	CONSTRAINT "payroll_payout_return_withdrawals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_return_withdrawals_claim_fk" FOREIGN KEY ("tenant_id","batch_id","claim_id") REFERENCES "public"."payroll_payout_return_claims"("tenant_id","batch_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_return_withdrawals_proposed_grant_fk" FOREIGN KEY ("tenant_id","proposed_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_return_withdrawals_approved_grant_fk" FOREIGN KEY ("tenant_id","approved_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_withdrawals_open_key" ON "payroll_payout_return_withdrawals" USING btree ("tenant_id","claim_id") WHERE "payroll_payout_return_withdrawals"."approved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_withdrawals_approved_key" ON "payroll_payout_return_withdrawals" USING btree ("tenant_id","claim_id") WHERE "payroll_payout_return_withdrawals"."approved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payroll_payout_return_withdrawals_tenant_batch_idx" ON "payroll_payout_return_withdrawals" USING btree ("tenant_id","batch_id");--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_detail_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" DROP CONSTRAINT "payroll_payout_attestations_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_exceptions" DROP CONSTRAINT "payroll_payout_recon_exceptions_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw', 'disown', 'unfreeze', 'recon_clear'));--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_detail_check" CHECK (("payroll_payout_grants"."kind" = 'resolve' AND "payroll_payout_grants"."detail" IN ('failed', 'not_sent')) OR ("payroll_payout_grants"."kind" = 'bank_confirm' AND "payroll_payout_grants"."detail" = 'succeeded') OR ("payroll_payout_grants"."kind" IN ('disown', 'unfreeze', 'recon_clear', 'return_withdraw') AND "payroll_payout_grants"."detail" ~ '^[0-9a-f]{64}$') OR ("payroll_payout_grants"."kind" NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear', 'return_withdraw') AND "payroll_payout_grants"."detail" IS NULL));--> statement-breakpoint
ALTER TABLE "payroll_payout_attestations" ADD CONSTRAINT "payroll_payout_attestations_kind_check" CHECK ("payroll_payout_attestations"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw'));--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_exceptions" ADD CONSTRAINT "payroll_payout_recon_exceptions_kind_check" CHECK ("payroll_payout_recon_exceptions"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw'));
--> statement-breakpoint
-- legend-snwnn (1005): withdrawal of a return claim. Owner: the migrator. Written
-- only by the trusted functions of legend_payout (app.payout_return_withdraw_propose
-- / _approve, below); legend_app may only read. Pattern of
-- payroll_payout_recon_clearances (0580).
SELECT app.enforce_tenant_rls('public.payroll_payout_return_withdrawals'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is the opposite.
REVOKE ALL ON TABLE public.payroll_payout_return_withdrawals FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_return_withdrawals TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_return_withdrawals TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (approved_by, approved_session_id, approved_grant_id, approved_at)
  ON TABLE public.payroll_payout_return_withdrawals TO legend_payout;
--> statement-breakpoint
-- A withdrawal moves once: the approve step fills approved_by, approved_session_id,
-- approved_grant_id and approved_at from NULL (the CHECK says the approver is not
-- the proposer, nor the session that proposed); every other column stays, and a
-- row is never deleted (PAYOUT-95, 23514).
CREATE FUNCTION app.payroll_payout_return_withdrawals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
    AND (to_jsonb(NEW) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-95: a return withdrawal cannot be changed or erased once approved'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_withdrawals_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_return_withdrawals
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_return_withdrawals_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_withdrawals_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_return_withdrawals
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_return_withdrawals_guard();
--> statement-breakpoint
-- A claim moves open -> consumed (0381, 0389) or, new in 1005, open -> withdrawn:
-- only the payout role, only with withdrawn_at set, and only while the claim has
-- an approved withdrawal row (the approve function writes that row first).
-- It may also take the two proof hashes of a claim that predates them (NULL to a
-- value, each once). Nothing else about a claim may change.
CREATE OR REPLACE FUNCTION app.payroll_payout_return_claims_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'consumed' AND NEW.consumed_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'consumed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumed_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'withdrawn' AND NEW.withdrawn_at IS NOT NULL
    AND current_user = 'legend_payout'
    AND (to_jsonb(NEW) - 'status' - 'withdrawn_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_at')
    AND EXISTS (
      SELECT 1 FROM public.payroll_payout_return_withdrawals w
       WHERE w.tenant_id = OLD.tenant_id AND w.claim_id = OLD.id
         AND w.approved_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'content_sha256' - 'stored_sha256')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'content_sha256' - 'stored_sha256')
    AND (OLD.content_sha256 IS NULL OR NEW.content_sha256 IS NOT DISTINCT FROM OLD.content_sha256)
    AND (OLD.stored_sha256 IS NULL OR NEW.stored_sha256 IS NOT DISTINCT FROM OLD.stored_sha256) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-31: return claim % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

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
  v_status varchar;
  v_requester text;
  v_clr_proposer text;
  v_clr_session text;
  v_clr_done boolean;
  v_wd_proposer text;
  v_wd_session text;
  v_wd_done boolean;
BEGIN
  IF NOT ((p_kind = 'correction' AND p_step IN ('propose', 'approve', 'withdraw'))
       OR (p_kind = 'overpaid' AND p_step IN ('propose', 'record', 'withdraw'))
       OR (p_kind = 'return' AND p_step IN ('propose', 'confirm'))
       OR (p_kind = 'closure' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'posting_source' AND p_step = 'record')
       OR (p_kind = 'resolve' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'bank_confirm' AND p_step = 'record')
       OR (p_kind = 'disown' AND p_step = 'record')
       OR (p_kind = 'unfreeze' AND p_step = 'approve')
       OR (p_kind = 'recon_clear' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'return_withdraw' AND p_step IN ('propose', 'approve'))
       OR (p_kind = 'batch_approve' AND p_step = 'approve')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  -- The detail of a grant: the outcome for resolve, 'succeeded' for a bank
  -- confirmation, the sha256 (hex) of the reason for disown, unfreeze and
  -- recon_clear and return_withdraw, nothing for every other kind (the table CHECK says the same).
  IF NOT ((p_kind = 'resolve' AND p_detail IN ('failed', 'not_sent'))
       OR (p_kind = 'bank_confirm' AND p_detail = 'succeeded')
       OR (p_kind IN ('disown', 'unfreeze', 'recon_clear', 'return_withdraw') AND p_detail ~ '^[0-9a-f]{64}$')
       OR (p_kind NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear', 'return_withdraw') AND p_detail IS NULL)) THEN
    RAISE EXCEPTION 'PAYOUT-72: the detail of this payout grant is not valid for its kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('password', 'mfa_challenge') THEN
    RAISE EXCEPTION 'PAYOUT-72: unknown step-up method for a payout grant'
      USING ERRCODE = '22023';
  END IF;
  -- Unfreeze is password only as well (PAYOUT-72): the one exception of the
  -- unfreeze rules (the disputant withdrawing their own claim) then always
  -- rests on a fresh password, never on an MFA challenge alone.
  IF p_kind = 'unfreeze' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: an unfreeze grant needs a password step-up'
      USING ERRCODE = '22023';
  END IF;
  -- Clearing a reconciliation flag (990) is password only too: no MFA challenge
  -- alone can lift a hold that exists because something looked forged.
  IF p_kind = 'recon_clear' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: a reconciliation clearance grant needs a password step-up'
      USING ERRCODE = '22023';
  END IF;
  -- Withdrawing a return claim (1005) is password only too: no MFA challenge
  -- alone can undo the record of money that came back.
  IF p_kind = 'return_withdraw' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: a return withdrawal grant needs a password step-up'
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
    -- Clear a reconciliation flag (990): a tenant-wide owner or finance role
    -- (as unfreeze), the ref is the flag (propose) or the clearance (approve) of
    -- this tenant, the batch is the batch of the flagged item. Approve: the
    -- proposer, and the session that proposed, cannot hold the grant
    -- (PAYOUT-86); an approved clearance takes no second approval (PAYOUT-87).
    IF p_kind = 'recon_clear' THEN
      IF p_batch IS NULL OR p_ref IS NULL THEN
        RAISE EXCEPTION 'PAYOUT-72: a reconciliation clearance grant needs a batch and a ref'
          USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM public.role_assignments ra
          JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         WHERE ra.tenant_id = v_tenant AND ra.user_id = p_actor
           AND ra.scope_type = 'tenant'
           AND ra.valid_from <= v_now
           AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
           AND r.template_key IN ('owner', 'finance')
      ) THEN
        RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
          USING ERRCODE = '42501';
      END IF;
      IF p_step = 'propose' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.payroll_payout_recon_exceptions e
            JOIN public.payroll_disbursement_items it
              ON it.tenant_id = e.tenant_id AND it.id = e.item_id
           WHERE e.tenant_id = v_tenant AND e.id = p_ref AND it.batch_id = p_batch
        ) THEN
          RAISE EXCEPTION 'PAYOUT-72: the reconciliation flag of this grant is not in the tenant or batch'
            USING ERRCODE = '22023';
        END IF;
      ELSE
        SELECT c.proposed_by, c.proposed_session_id, c.approved_at IS NOT NULL
          INTO v_clr_proposer, v_clr_session, v_clr_done
          FROM public.payroll_payout_recon_clearances c
          JOIN public.payroll_payout_recon_exceptions e
            ON e.tenant_id = c.tenant_id AND e.id = c.exception_id
          JOIN public.payroll_disbursement_items it
            ON it.tenant_id = e.tenant_id AND it.id = e.item_id
         WHERE c.tenant_id = v_tenant AND c.id = p_ref AND it.batch_id = p_batch;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'PAYOUT-72: the reconciliation clearance of this grant is not in the tenant or batch'
            USING ERRCODE = '22023';
        END IF;
        IF v_clr_done THEN
          RAISE EXCEPTION 'PAYOUT-87: the reconciliation clearance is already approved'
            USING ERRCODE = '23514';
        END IF;
        IF v_clr_proposer = p_actor OR v_clr_session = p_session THEN
          RAISE EXCEPTION 'PAYOUT-86: the proposer of a reconciliation clearance cannot approve it'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    -- Withdraw an open return claim (1005): a tenant-wide owner or finance role
    -- (as recon_clear), the ref is the claim (propose) or the withdrawal
    -- (approve) of this tenant, the batch is the batch of the claim. The
    -- requester of the batch cannot hold either step (PAYOUT-64). Approve: the
    -- proposer, and the session that proposed, cannot hold the grant
    -- (PAYOUT-94); an approved withdrawal takes no second approval (PAYOUT-95).
    IF p_kind = 'return_withdraw' THEN
      IF p_batch IS NULL OR p_ref IS NULL THEN
        RAISE EXCEPTION 'PAYOUT-72: a return withdrawal grant needs a batch and a ref'
          USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM public.role_assignments ra
          JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         WHERE ra.tenant_id = v_tenant AND ra.user_id = p_actor
           AND ra.scope_type = 'tenant'
           AND ra.valid_from <= v_now
           AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
           AND r.template_key IN ('owner', 'finance')
      ) THEN
        RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can withdraw a return claim'
          USING ERRCODE = '42501';
      END IF;
      SELECT b.requested_by INTO v_requester
        FROM public.payroll_disbursement_batches b
       WHERE b.tenant_id = v_tenant AND b.id = p_batch;
      IF v_requester IS NOT DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'PAYOUT-64: the requester of the batch cannot withdraw its return claims'
          USING ERRCODE = '42501';
      END IF;
      IF p_step = 'propose' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.payroll_payout_return_claims c
           WHERE c.tenant_id = v_tenant AND c.id = p_ref AND c.batch_id = p_batch
        ) THEN
          RAISE EXCEPTION 'PAYOUT-69: return claim not found' USING ERRCODE = 'P0002';
        END IF;
      ELSE
        SELECT w.proposed_by, w.proposed_session_id, w.approved_at IS NOT NULL
          INTO v_wd_proposer, v_wd_session, v_wd_done
          FROM public.payroll_payout_return_withdrawals w
         WHERE w.tenant_id = v_tenant AND w.id = p_ref AND w.batch_id = p_batch;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'PAYOUT-69: return withdrawal not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_wd_done THEN
          RAISE EXCEPTION 'PAYOUT-95: the return withdrawal is already approved'
            USING ERRCODE = '23514';
        END IF;
        IF v_wd_proposer = p_actor OR v_wd_session = p_session THEN
          RAISE EXCEPTION 'PAYOUT-94: the proposer of a return withdrawal cannot approve it'
            USING ERRCODE = '42501';
        END IF;
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
  -- The main approval of a batch (PAYOUT-83): the grant names one batch that
  -- waits for approval, and its requester (PAYOUT-16) and anyone who said "not
  -- me" to a main approval of it (PAYOUT-84) cannot hold it.
  IF p_kind = 'batch_approve' THEN
    IF p_batch IS NULL THEN
      RAISE EXCEPTION 'PAYOUT-72: a batch approval grant needs a batch'
        USING ERRCODE = '22023';
    END IF;
    SELECT b.status, b.requested_by INTO v_status, v_requester
      FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch;
    IF v_requester IS NOT DISTINCT FROM p_actor THEN
      RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot approve it'
        USING ERRCODE = '23514';
    END IF;
    IF app.payout_batch_approval_disowned_by(v_tenant, p_batch, p_actor) THEN
      RAISE EXCEPTION 'PAYOUT-84: the disowner of a batch approval cannot approve it again'
        USING ERRCODE = '42501';
    END IF;
    IF v_status IS DISTINCT FROM 'pending_approval' THEN
      RAISE EXCEPTION 'PAYOUT-83: only a batch that waits for approval can get an approval grant'
        USING ERRCODE = '22023';
    END IF;
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
-- Withdrawal, step one: a finance person proposes to withdraw an open return
-- claim with a reason. Grant binding: kind return_withdraw, step propose, the
-- batch of the claim, ref = the claim, detail = sha256 of the reason. A claim
-- that has an open withdrawal returns that withdrawal (the reason stays as first
-- proposed, nothing new is attested); a claim that is not open, or whose items
-- changed, is PAYOUT-93.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_withdraw_propose(p_claim uuid, p_grant text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_template text;
  v_requester text;
  v_claim public.payroll_payout_return_claims%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_rows integer;
  v_binding uuid;
  v_sha varchar;
  v_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-92: a withdrawal of a return claim needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT c.batch_id INTO v_batch
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: return claim not found' USING ERRCODE = 'P0002';
  END IF;
  v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_reason, 'UTF8')), 'hex');
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return_withdraw', 'propose', v_batch,
           NULL, NULL, p_claim, NULL, v_sha) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can withdraw a return claim'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.requested_by INTO v_requester
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch;
  IF v_requester IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of the batch cannot withdraw its return claims'
      USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_claim
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim
     FOR UPDATE;
  IF v_claim.status <> 'open' THEN
    RAISE EXCEPTION 'PAYOUT-93: only an open return claim can be withdrawn' USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(
    SELECT i.id FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch AND i.return_claim_id = p_claim
     ORDER BY i.id);
  v_n := pg_catalog.cardinality(v_items);
  SELECT pg_catalog.count(*) INTO v_rows
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
     AND i.status = 'succeeded' AND i.returned_by = v_claim.created_by
     AND i.returned_by_2 IS NULL AND i.return_evidence_key = v_claim.evidence_key;
  IF v_n = 0 OR v_rows <> v_n OR app.payout_item_set_hash(v_items) <> v_claim.item_set_hash THEN
    RAISE EXCEPTION 'PAYOUT-93: the items of the return claim are not as the claim recorded them'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_return_withdrawals (
    tenant_id, claim_id, batch_id, reason, reason_sha256, proposed_by,
    proposed_session_id, proposed_grant_id)
  VALUES (v_tenant, p_claim, v_batch, p_reason, v_sha, v_actor, v_session, v_grant)
  ON CONFLICT (tenant_id, claim_id) WHERE approved_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT w.id INTO v_id
      FROM public.payroll_payout_return_withdrawals w
     WHERE w.tenant_id = v_tenant AND w.claim_id = p_claim AND w.approved_at IS NULL;
    RETURN v_id;
  END IF;
  SELECT pb.id INTO v_binding
    FROM public.payroll_payout_proof_bindings pb
   WHERE pb.tenant_id = v_tenant AND pb.evidence_key = v_claim.evidence_key
     AND pb.kind = 'return' AND pb.batch_id = v_batch;
  PERFORM app.payout_attest(v_tenant, 'return_withdraw', v_id, 'propose', v_batch, v_items,
    v_claim.evidence_key, v_binding, v_grant, v_assertion);
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_withdraw_propose(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_withdraw_propose(uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Withdrawal, step two: another finance person approves it. Grant binding: kind
-- return_withdraw, step approve, the batch of the claim, ref = the withdrawal,
-- detail = sha256 of the reason on the withdrawal. Locks as the return confirm
-- (batch, items, claim), then the withdrawal. An approved withdrawal is
-- PAYOUT-95; the proposer, or the session that proposed, is PAYOUT-94; a claim
-- that is no longer open, or items that changed, or a return journal that
-- exists, is PAYOUT-93 and nothing changes. The claim becomes withdrawn, the
-- return columns of its items are cleared (the status stays succeeded). Returns
-- how many items were restored.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_withdraw_approve(p_withdrawal uuid, p_grant text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_claim_id uuid;
  v_sha varchar;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_template text;
  v_brow public.payroll_disbursement_batches%ROWTYPE;
  v_claim public.payroll_payout_return_claims%ROWTYPE;
  v_wd public.payroll_payout_return_withdrawals%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_rows integer;
  v_binding uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT w.batch_id, w.claim_id, w.reason_sha256 INTO v_batch, v_claim_id, v_sha
    FROM public.payroll_payout_return_withdrawals w
   WHERE w.tenant_id = v_tenant AND w.id = p_withdrawal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: return withdrawal not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return_withdraw', 'approve', v_batch,
           NULL, NULL, p_withdrawal, NULL, v_sha) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can withdraw a return claim'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.* INTO v_brow
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch
     FOR UPDATE;
  v_items := ARRAY(
    SELECT i.id FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch AND i.return_claim_id = v_claim_id
     ORDER BY i.id);
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT c.* INTO v_claim
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = v_claim_id
     FOR UPDATE;
  SELECT w.* INTO v_wd
    FROM public.payroll_payout_return_withdrawals w
   WHERE w.tenant_id = v_tenant AND w.id = p_withdrawal
     FOR UPDATE;
  IF v_wd.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-95: the return withdrawal is already approved' USING ERRCODE = '23514';
  END IF;
  IF v_wd.proposed_by = v_actor OR v_wd.proposed_session_id = v_session THEN
    RAISE EXCEPTION 'PAYOUT-94: the proposer of a return withdrawal cannot approve it'
      USING ERRCODE = '42501';
  END IF;
  IF v_brow.requested_by IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of the batch cannot withdraw its return claims'
      USING ERRCODE = '42501';
  END IF;
  IF v_claim.status <> 'open' THEN
    RAISE EXCEPTION 'PAYOUT-93: only an open return claim can be withdrawn' USING ERRCODE = '23514';
  END IF;
  v_n := pg_catalog.cardinality(v_items);
  SELECT pg_catalog.count(*) INTO v_rows
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
     AND i.status = 'succeeded' AND i.returned_by = v_claim.created_by
     AND i.returned_by_2 IS NULL AND i.return_evidence_key = v_claim.evidence_key;
  IF v_n = 0 OR v_rows <> v_n OR app.payout_item_set_hash(v_items) <> v_claim.item_set_hash THEN
    RAISE EXCEPTION 'PAYOUT-93: the items of the return claim are not as the claim recorded them'
      USING ERRCODE = '23514';
  END IF;
  -- No posted return journal for any of the items (the confirm step posts it,
  -- and a claim that posted one is consumed, never open).
  IF EXISTS (
       SELECT 1
         FROM public.journal_entries j
         JOIN pg_catalog.unnest(v_items) AS u(id)
           ON j.idempotency_key = 'payroll-payout-return:' || u.id::text
        WHERE j.tenant_id = v_tenant)
     OR EXISTS (
       SELECT 1
         FROM public.payroll_payout_gl_postings p
         JOIN pg_catalog.unnest(v_items) AS u(id)
           ON p.journal_key = 'payroll-payout-return:' || u.id::text
        WHERE p.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'PAYOUT-93: a return journal exists for the items of this claim'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'return_withdraw'
       AND a.operation_id = p_withdrawal AND a.step = 'propose'
       AND a.actor = v_wd.proposed_by AND a.session_id = v_wd.proposed_session_id
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the first step of this withdrawal is not attested'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.payroll_payout_return_withdrawals
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_withdrawal AND approved_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-95: the return withdrawal changed while it was approved'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_payout_return_claims
     SET status = 'withdrawn', withdrawn_at = v_now
   WHERE tenant_id = v_tenant AND id = v_claim_id AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-93: the return claim changed while it was withdrawn'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET returned_by = NULL, return_evidence_key = NULL, return_note = NULL,
         return_claim_id = NULL, return_bank_ref = NULL, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = v_batch AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by = v_claim.created_by AND returned_by_2 IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-93: the items changed while the return claim was withdrawn'
      USING ERRCODE = '23514';
  END IF;
  SELECT pb.id INTO v_binding
    FROM public.payroll_payout_proof_bindings pb
   WHERE pb.tenant_id = v_tenant AND pb.evidence_key = v_claim.evidence_key
     AND pb.kind = 'return' AND pb.batch_id = v_batch;
  PERFORM app.payout_attest(v_tenant, 'return_withdraw', p_withdrawal, 'approve', v_batch, v_items,
    v_claim.evidence_key, v_binding, v_grant, v_assertion);
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_withdraw_approve(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_withdraw_approve(uuid, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step two (0583 body): only the message changes. A claim that is not
-- open (consumed, or since 1005 withdrawn) cannot be confirmed (PAYOUT-63).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_return_confirm(
  p_claim uuid, p_key varchar, p_grant text, p_bank_ref varchar
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch_id uuid;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_claim public.payroll_payout_return_claims%ROWTYPE;
  v_items uuid[];
  v_binding uuid;
  v_n integer;
  v_rows integer;
  v_ref varchar;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  v_ref := app.payout_normalize_bank_ref(p_bank_ref);
  -- The grant binds the batch and the items of the claim (read first; the items
  -- are tied to a claim in the transaction that creates it).
  SELECT c.batch_id INTO v_batch_id
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: return claim not found' USING ERRCODE = 'P0002';
  END IF;
  v_items := ARRAY(
    SELECT i.id FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.return_claim_id = p_claim
     ORDER BY i.id);
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return', 'confirm', v_batch_id,
           v_items, p_key, p_claim, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = v_batch_id
     FOR UPDATE;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = v_batch_id AND i.return_claim_id = p_claim
   ORDER BY i.id
     FOR UPDATE;
  SELECT c.* INTO v_claim
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim
     FOR UPDATE;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a return is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.status <> 'open' THEN
    RAISE EXCEPTION 'PAYOUT-63: the return claim is not open (it is consumed or withdrawn)' USING ERRCODE = '23514';
  END IF;
  IF v_claim.evidence_key <> p_key THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded'
      USING ERRCODE = '23514';
  END IF;
  -- (990) The second person confirms the bank reference the first one recorded.
  IF v_claim.bank_ref IS DISTINCT FROM v_ref THEN
    RAISE EXCEPTION 'PAYOUT-89: the bank reference must be the one the first person recorded'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.created_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a return needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR v_batch.requested_by = v_claim.created_by THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot return its items'
      USING ERRCODE = '42501';
  END IF;
  v_n := pg_catalog.cardinality(v_items);
  IF v_n = 0 OR app.payout_item_set_hash(v_items) <> v_claim.item_set_hash THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of the claim are not the items of the request'
      USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.count(*) INTO v_rows
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.id = ANY (v_items)
     AND i.status = 'succeeded' AND i.returned_by = v_claim.created_by
     AND i.returned_by_2 IS NULL AND i.return_evidence_key = p_key;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: there are items that are not paid or are already returned'
      USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'return', v_batch_id, v_items, p_key);
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'return'
       AND a.operation_id = p_claim AND a.step = 'propose'
       AND a.actor = v_claim.created_by AND a.evidence_key = p_key
       AND a.item_ids @> v_items AND a.item_ids <@ v_items
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the first step of this return is not attested'
      USING ERRCODE = '42501';
  END IF;
  -- ... and with a grant (911).
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_attestations a
     WHERE a.tenant_id = v_tenant AND a.kind = 'return'
       AND a.operation_id = p_claim AND a.step = 'propose'
       AND a.actor = v_claim.created_by AND a.evidence_key = p_key
       AND a.grant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this return has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.payroll_payout_return_claims
     SET status = 'consumed', consumed_at = v_now
   WHERE tenant_id = v_tenant AND id = p_claim AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PAYOUT-63: the return claim changed while it was confirmed'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET returned_by_2 = v_actor, status = 'returned', returned_at = v_now, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = v_batch_id AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by = v_claim.created_by AND returned_by_2 IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was confirmed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', p_claim, 'confirm', v_batch_id, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_confirm(uuid, varchar, text, varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_confirm(uuid, varchar, text, varchar) TO legend_app;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint

-- (1005) the item guard (0581 body) refuses to clear the claim link of an item
-- unless its claim is withdrawn.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  slip_run uuid;
  slip_employee uuid;
  slip_method text;
  batch_status text;
  batch_requester text;
  batch_approver text;
  sealed_changed boolean;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('prepared', 'blocked') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item starts prepared or blocked (got %)', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.returned_by IS NOT NULL OR NEW.returned_by_2 IS NOT NULL
        OR NEW.return_evidence_key IS NOT NULL OR NEW.return_note IS NOT NULL
        OR NEW.return_claim_id IS NOT NULL OR NEW.returned_at IS NOT NULL)
      AND current_user IS DISTINCT FROM 'legend_payout' THEN
      RAISE EXCEPTION 'PAYOUT-61: a new disbursement item carries no return record'
        USING ERRCODE = '23514';
    END IF;
    SELECT b.status INTO batch_status FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'PAYOUT-11: items can only be added to a draft batch (batch % is %)', NEW.batch_id, batch_status
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status INTO run_status FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('locked', 'paid') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    SELECT s.payroll_run_id, s.employee_id, s.payment_method
      INTO slip_run, slip_employee, slip_method
      FROM public.payslips s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.payslip_id;
    IF slip_run IS DISTINCT FROM NEW.payroll_run_id
      OR slip_employee IS DISTINCT FROM NEW.employee_id
      OR slip_method IS DISTINCT FROM (CASE WHEN NEW.channel = 'cash' THEN 'cash' ELSE 'bank_transfer' END)
    THEN
      RAISE EXCEPTION 'PAYOUT-11: item % does not match the run, employee and payment method of its payslip', NEW.id
        USING ERRCODE = '23514';
    END IF;
    -- (905) the nightly reconciliation held this payslip back: no new attempt.
    -- (990) a flag with an approved clearance (two finance people, step-up)
    -- no longer holds the payslip: app.payout_payslip_held_by_recon.
    IF app.payout_payslip_held_by_recon(NEW.tenant_id, NEW.payslip_id) THEN
      RAISE EXCEPTION 'PAYOUT-62: payslip % is held back by a reconciliation exception', NEW.payslip_id
        USING ERRCODE = '23514';
    END IF;
    -- (911) a payslip with an overpaid attempt is settled by hand, never by a
    -- new attempt (the service said so; now the database does).
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items o
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND o.status = 'overpaid'
    ) THEN
      RAISE EXCEPTION 'PAYOUT-62: payslip % has an overpaid attempt and is settled by hand, never by a new attempt', NEW.payslip_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYOUT-12: the identity of disbursement item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- (947) approved -> prepared: only the reopening of its batch after "not me" on
  -- the main approval (app.payout_batch_unfreeze): the payout role, nothing but
  -- the status changes, the batch is pending_approval again, and an unfreeze row
  -- of this transaction releases a dispute of the batch_approve log row.
  IF OLD.status = 'approved' AND NEW.status = 'prepared'
    AND current_user = 'legend_payout'
    AND (to_jsonb(NEW) - 'updated_at' - 'status') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status')
    AND EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches rb
       WHERE rb.tenant_id = NEW.tenant_id AND rb.id = NEW.batch_id
         AND rb.status = 'pending_approval')
    AND app.payout_unfreeze_revert_proof(NEW.tenant_id, NEW.batch_id) THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND (NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
      OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
      OR NEW.inquiry_account_name_encrypted IS DISTINCT FROM OLD.inquiry_account_name_encrypted
      OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version)
  THEN
    -- Reseal bypass (PAYR-KEY, as 0248): the sealed amount, fee and inquiry
    -- name move together with a higher key version, only inside the reseal
    -- job's transaction, never above the active version, with no other column
    -- changed. Valid for any status, including a final item.
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF NEW.pii_key_version IS NULL
      OR NEW.pii_key_version <= OLD.pii_key_version
      OR NEW.amount_encrypted IS NOT DISTINCT FROM OLD.amount_encrypted
    THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must change the sealed amount and raise the key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
      RAISE EXCEPTION 'PAYR-KEY: item % key version is above the active key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version')
      IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version') THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must not change any other column', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('failed', 'not_sent', 'cancelled', 'returned', 'overpaid')
    AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
    -- (905) failed -> overpaid: only the payout role (app.payout_overpaid_record);
    -- only the status and the posting link move.
    AND NOT (
      OLD.status = 'failed' AND NEW.status = 'overpaid'
      AND current_user = 'legend_payout'
      AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'gl_posting_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'gl_posting_id')
    )
    -- (legend-mejr2, 905) the one other way out of `failed`: a correction, by
    -- the payout role (app.payout_correction_approve). Only the status and the
    -- payment record of the corrected payment move.
    AND NOT (
      OLD.status = 'failed' AND NEW.status = 'succeeded'
      AND current_user = 'legend_payout'
      AND (to_jsonb(NEW) - 'updated_at' - 'status' - 'confirmed_by' - 'confirmation_ref' - 'confirmation_evidence_key' - 'settled_at')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'confirmed_by' - 'confirmation_ref' - 'confirmation_evidence_key' - 'settled_at')
    ) THEN
    RAISE EXCEPTION 'PAYOUT-12: disbursement item % is final (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  -- (905, amendment A1) a paid, overpaid or returned item changes status only
  -- through a trusted function: succeeded -> failed would reopen a retry and
  -- pay the employee a second time.
  IF OLD.status IN ('succeeded', 'overpaid', 'returned')
    AND NEW.status IS DISTINCT FROM OLD.status
    AND current_user IS DISTINCT FROM 'legend_payout' THEN
    RAISE EXCEPTION 'PAYOUT-60: item % leaves % only through the payout role', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  -- (905) the return record is written by the payout role only.
  IF (NEW.returned_by IS DISTINCT FROM OLD.returned_by
      OR NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2
      OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
      OR NEW.return_note IS DISTINCT FROM OLD.return_note
      OR NEW.return_claim_id IS DISTINCT FROM OLD.return_claim_id
      OR NEW.returned_at IS DISTINCT FROM OLD.returned_at)
    AND current_user IS DISTINCT FROM 'legend_payout' THEN
    RAISE EXCEPTION 'PAYOUT-61: the return record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- (1005) the return claim link leaves an item only through a withdrawn claim:
  -- the payout role (app.payout_return_withdraw_approve), the item still paid
  -- (succeeded, no second person, no return time), the five return columns all
  -- cleared, nothing else changed, and the claim of the item is withdrawn.
  IF OLD.return_claim_id IS NOT NULL AND NEW.return_claim_id IS NULL
    AND NOT (
      OLD.status = 'succeeded' AND NEW.status = 'succeeded'
      AND OLD.returned_by_2 IS NULL AND OLD.returned_at IS NULL
      AND NEW.returned_by IS NULL AND NEW.return_evidence_key IS NULL
      AND NEW.return_note IS NULL AND NEW.return_bank_ref IS NULL
      AND (to_jsonb(NEW) - 'updated_at' - 'returned_by' - 'return_evidence_key' - 'return_note' - 'return_claim_id' - 'return_bank_ref')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'returned_by' - 'return_evidence_key' - 'return_note' - 'return_claim_id' - 'return_bank_ref')
      AND EXISTS (
        SELECT 1 FROM public.payroll_payout_return_claims wc
         WHERE wc.tenant_id = OLD.tenant_id AND wc.batch_id = OLD.batch_id
           AND wc.id = OLD.return_claim_id AND wc.status = 'withdrawn')
    ) THEN
    RAISE EXCEPTION 'PAYOUT-93: the return claim of item % leaves it only through a withdrawn claim', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('prepared', 'blocked')
    AND (NEW.bank_snapshot_id IS DISTINCT FROM OLD.bank_snapshot_id
      OR NEW.bank_code IS DISTINCT FROM OLD.bank_code) THEN
    RAISE EXCEPTION 'PAYOUT-13: the payee of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  sealed_changed := NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
    OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version;
  IF sealed_changed AND OLD.status NOT IN ('prepared', 'blocked') THEN
    RAISE EXCEPTION 'PAYOUT-13: the amount of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'prepared' AND NEW.status IN ('blocked', 'approved', 'cancelled'))
      OR (OLD.status = 'blocked' AND NEW.status = 'cancelled')
      OR (OLD.status = 'approved' AND NEW.status IN ('not_sent', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status = 'exported' AND NEW.channel = 'manual_bank')
      OR (OLD.status = 'approved' AND NEW.status = 'succeeded' AND NEW.channel = 'cash')
      -- (911) out of `exported`: the payout role only (app.payout_bank_confirm,
      -- app.payout_resolve_approve), each under a one-time grant.
      OR (OLD.status = 'exported' AND NEW.status IN ('succeeded', 'failed', 'not_sent')
          AND current_user = 'legend_payout')
      -- (905) succeeded -> returned: the payout role (app.payout_return_confirm).
      OR (OLD.status = 'succeeded' AND NEW.status = 'returned'
          AND current_user = 'legend_payout')
      -- (905) failed -> overpaid: the payout role, with the overpaid posting of
      -- this item, on a payslip that another attempt paid.
      OR (OLD.status = 'failed' AND NEW.status = 'overpaid'
          AND current_user = 'legend_payout'
          AND NEW.gl_posting_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.payroll_payout_gl_postings p
            WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.gl_posting_id
              AND p.kind = 'overpaid'
              AND p.journal_key = 'payroll-payout-overpaid:' || NEW.id::text)
          AND EXISTS (
            SELECT 1 FROM public.payroll_disbursement_items o
            WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
              AND o.id <> NEW.id AND o.status = 'succeeded'))
      -- (legend-mejr2, 905) failed -> succeeded only through a `corrected` row of
      -- this item (two different people, neither the batch requester nor either
      -- resolver of the failure), by the payout role, on a manual bank item whose
      -- payslip has no other attempt that is live, paid back, or overpaid. The
      -- payment record of the item is the correction's: the corrector, its
      -- proof, the time.
      OR (OLD.status = 'failed' AND NEW.status = 'succeeded'
          AND current_user = 'legend_payout'
          AND NEW.channel = 'manual_bank'
          AND OLD.resolution_outcome IS NOT DISTINCT FROM 'failed'
          AND OLD.resolved_by IS NOT NULL
          AND OLD.resolved_by_2 IS NOT NULL
          AND NEW.confirmed_by IS NOT NULL
          AND NEW.confirmation_ref IS NOT NULL
          AND NEW.settled_at IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM public.payroll_payout_failed_corrections c
              JOIN public.payroll_disbursement_batches b
                ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
             WHERE c.tenant_id = NEW.tenant_id AND c.item_id = NEW.id
               AND c.batch_id = NEW.batch_id
               AND c.status = 'corrected'
               AND c.corrected_by IS NOT NULL
               AND c.corrected_by <> c.proposed_by
               AND NEW.confirmed_by = c.corrected_by
               AND NEW.confirmation_evidence_key IS NOT DISTINCT FROM c.evidence_key
               AND c.corrected_by IS DISTINCT FROM OLD.resolved_by
               AND c.corrected_by IS DISTINCT FROM OLD.resolved_by_2
               AND c.proposed_by IS DISTINCT FROM OLD.resolved_by
               AND c.proposed_by IS DISTINCT FROM OLD.resolved_by_2
               AND c.corrected_by IS DISTINCT FROM b.requested_by
               AND c.proposed_by IS DISTINCT FROM b.requested_by)
          AND EXISTS (
            SELECT 1 FROM public.payroll_runs r
            WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
              AND r.status IN ('locked', 'paid'))
          AND NOT EXISTS (
            SELECT 1 FROM public.payroll_disbursement_items o
            WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
              AND o.id <> NEW.id
              AND o.status IN ('prepared', 'blocked', 'approved', 'sending', 'exported',
                               'unknown', 'succeeded', 'returned', 'overpaid')))
    ) THEN
      RAISE EXCEPTION 'PAYOUT-14: item % cannot move from % to % on channel %', OLD.id, OLD.status, NEW.status, NEW.channel
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' THEN
      SELECT b.status, b.approved_by, b.requested_by
        INTO batch_status, batch_approver, batch_requester
        FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
      IF batch_status IS DISTINCT FROM 'approved'
        OR batch_approver IS NULL
        OR batch_approver = batch_requester THEN
        RAISE EXCEPTION 'PAYOUT-15: item % can be approved only by an approved batch with a second person', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'succeeded' AND (
       NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
    -- L4: the record of a payment is evidence; only returned_at and the
    -- succeeded -> returned status move after it.
    RAISE EXCEPTION 'PAYOUT-19: the payment record of succeeded item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.confirmed_by = batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot confirm payment of item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- (911) the resolution record is written by the payout role only
  -- (app.payout_resolve_propose / app.payout_resolve_approve, each under a
  -- grant). The one exception is the withdraw of a step-one proposal by the app
  -- role: all four step-one columns go to NULL at once, nothing else changes
  -- (this only lowers payout).
  IF (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
      OR NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2
      OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
      OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note)
    AND current_user IS DISTINCT FROM 'legend_payout'
    AND NOT (
      OLD.status = 'exported'
      AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND OLD.resolved_by IS NOT NULL
      AND OLD.resolved_by_2 IS NULL
      AND NEW.resolved_by_2 IS NULL
      AND NEW.resolved_by IS NULL
      AND NEW.resolution_outcome IS NULL
      AND NEW.resolution_evidence_key IS NULL
      AND NEW.resolution_note IS NULL
      AND (to_jsonb(NEW) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
    ) THEN
    RAISE EXCEPTION 'PAYOUT-74: the resolution record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- (911) the bank payment record is written by the payout role only
  -- (app.payout_bank_confirm). The one exception is the cash handover by the app
  -- role: approved -> succeeded on a cash item, with no reference and no proof.
  IF (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
      OR NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
      OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key
      OR NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    AND current_user IS DISTINCT FROM 'legend_payout'
    AND NOT (
      OLD.status = 'approved' AND NEW.status = 'succeeded' AND NEW.channel = 'cash'
      AND NEW.confirmation_ref IS NULL
      AND NEW.confirmation_evidence_key IS NULL
    ) THEN
    RAISE EXCEPTION 'PAYOUT-74: the payment record of item % is written only by the payout role', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- H2: a manual resolution (failed / not_sent) frees the payslip for a new
  -- payment, so it takes two different people, both other than the batch
  -- requester, plus evidence. The first one records the proposal and the item
  -- stays exported; once recorded, the proposal cannot be rewritten.
  IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    OR NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2
    OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
    OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
    IF OLD.status NOT IN ('exported', 'unknown') THEN
      RAISE EXCEPTION 'PAYOUT-18: item % can be resolved only while exported or unknown (is %)', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    IF ((OLD.resolved_by IS NOT NULL AND (
           NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
        OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
        OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note))
      OR (OLD.resolved_by_2 IS NOT NULL AND NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2))
      -- Withdraw (legend-5rh26): a step-one proposal on an exported item may be
      -- cleared as a whole (all four columns NULL at once), only while no step
      -- two exists, with the status and every other column unchanged.
      AND NOT (
        OLD.status = 'exported'
        AND NEW.status IS NOT DISTINCT FROM OLD.status
        AND OLD.resolved_by IS NOT NULL
        AND OLD.resolved_by_2 IS NULL
        AND NEW.resolved_by_2 IS NULL
        AND NEW.resolved_by IS NULL
        AND NEW.resolution_outcome IS NULL
        AND NEW.resolution_evidence_key IS NULL
        AND NEW.resolution_note IS NULL
        AND (to_jsonb(NEW) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
          IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'resolved_by' - 'resolution_outcome' - 'resolution_evidence_key' - 'resolution_note')
      ) THEN
      RAISE EXCEPTION 'PAYOUT-18: the recorded resolution of item % cannot be rewritten', OLD.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NOT DISTINCT FROM batch_requester
      OR NEW.resolved_by_2 IS NOT DISTINCT FROM batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('failed', 'not_sent') AND NEW.status IS DISTINCT FROM OLD.status AND OLD.status = 'exported' THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NULL
      OR NEW.resolved_by_2 IS NULL
      OR NEW.resolved_by = NEW.resolved_by_2
      OR NEW.resolved_by = batch_requester
      OR NEW.resolved_by_2 = batch_requester
      OR NEW.resolution_evidence_key IS NULL
      OR NEW.resolution_outcome IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'PAYOUT-18: exported item % can become % only after two different people (not the requester) resolved it with evidence', OLD.id, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- (1005) the two-person return rule and posting link rule (0351 body): steps aside
-- for the clearing of a withdrawn claim's return record. RETURN NEW is safe: the
-- gl_posting_id and status are unchanged in that case.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_payout_gl_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  batch_requester text;
BEGIN
  IF NEW.gl_posting_id IS DISTINCT FROM OLD.gl_posting_id THEN
    IF OLD.gl_posting_id IS NOT NULL OR NEW.gl_posting_id IS NULL
      OR NOT (NEW.status = 'succeeded' OR (OLD.status = 'failed' AND NEW.status = 'overpaid')) THEN
      RAISE EXCEPTION 'PAYOUT-31: the GL posting of item % is set once, on a succeeded or overpaid item', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- (1005) clearing the return record of a paid item for a withdrawn claim is not
  -- a return: nobody is recorded as returning, the item stays succeeded. The
  -- main item guard (0615) already demands the withdrawn claim and the exact
  -- columns; this rule only steps aside for it.
  IF OLD.return_claim_id IS NOT NULL AND NEW.return_claim_id IS NULL
    AND OLD.status = 'succeeded' AND NEW.status = 'succeeded'
    AND OLD.returned_by_2 IS NULL AND NEW.returned_by_2 IS NULL
    AND NEW.returned_by IS NULL AND NEW.return_evidence_key IS NULL
    AND NEW.return_note IS NULL
    AND EXISTS (
      SELECT 1 FROM public.payroll_payout_return_claims wc
       WHERE wc.tenant_id = OLD.tenant_id AND wc.batch_id = OLD.batch_id
         AND wc.id = OLD.return_claim_id AND wc.status = 'withdrawn') THEN
    RETURN NEW;
  END IF;
  IF NEW.returned_by IS DISTINCT FROM OLD.returned_by
    OR NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2
    OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
    OR NEW.return_note IS DISTINCT FROM OLD.return_note THEN
    IF OLD.status <> 'succeeded' THEN
      RAISE EXCEPTION 'PAYOUT-32: item % can be returned only while succeeded (is %)', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.returned_by IS NOT NULL AND (
           NEW.returned_by IS DISTINCT FROM OLD.returned_by
        OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
        OR NEW.return_note IS DISTINCT FROM OLD.return_note))
      OR (OLD.returned_by_2 IS NOT NULL AND NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2) THEN
      RAISE EXCEPTION 'PAYOUT-32: the recorded return of item % cannot be rewritten', OLD.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.returned_by IS NOT DISTINCT FROM batch_requester
      OR NEW.returned_by_2 IS NOT DISTINCT FROM batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-32: the requester of the batch cannot return item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Every move into returned is complete: two different people (neither the
  -- requester) with evidence, whether or not it came through the service.
  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.returned_by IS NULL
      OR NEW.returned_by_2 IS NULL
      OR NEW.returned_by = NEW.returned_by_2
      OR NEW.returned_by = batch_requester
      OR NEW.returned_by_2 = batch_requester
      OR NEW.return_evidence_key IS NULL
      OR NEW.returned_at IS NULL THEN
      RAISE EXCEPTION 'PAYOUT-32: item % can become returned only after two different people (not the requester) agreed with evidence', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

