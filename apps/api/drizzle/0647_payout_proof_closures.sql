-- legend-6htrf (905, card 3): close a stuck proof key. A stuck key (unreadable,
-- hash_conflict, legacy_duplicate, shared_key, bind_failed) held the global gate
-- app.payout_proof_history_pending() (0641) forever. Two finance people (the
-- approver is neither the proposer nor the requester of a batch the key backs)
-- close it through trusted functions of the payout role legend_payout (0644):
-- - app.payout_proof_closure_propose(key, note, actor, session) -> closure id:
--   the key must have a stuck row not yet resolved. An open closure of the key
--   is returned as is (idempotent); a closed key is refused.
-- - app.payout_proof_closure_approve(closure, actor, session) -> boolean (the
--   global gate is still pending): contests every hash the key is known by
--   (bindings, upload records, return claims), so no operation over those bytes
--   runs again in any tenant (the key is frozen for good, never opens a new
--   payment), sets closed_at / closed_by and resolves the stuck row. Approving
--   a closed closure only answers the gate again.
-- - app.payout_proof_key_closed(tenant, key): the one test of "closed".
-- - app.payout_proof_tenant_pending() (0641) ignores closed keys in its four
--   conditions.
-- - Backstops: a closed key is refused on new bindings, on claims, corrections
--   and overpaid proposals (insert, and any status change, so an open proposal
--   cannot finish), and on item proof key columns; a payslip with an open
--   correction / overpaid proposal on a closed key gets no new attempt (retry
--   hold). Closing never changes an item.
-- Error codes sit in the message text before the colon:
-- PAYOUT_PROOF_STUCK_NOT_FOUND (P0002), PAYOUT_CLOSURE_SAME_PERSON and
-- PAYOUT_CLOSURE_REQUESTER (42501), PAYOUT_CLOSURE_ALREADY_CLOSED and
-- PAYOUT_PROOF_CLOSED (23514).
CREATE OR REPLACE FUNCTION app.payout_proof_key_closed(p_tenant uuid, p_key varchar) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_proof_closures z
     WHERE z.tenant_id = p_tenant AND z.evidence_key = p_key AND z.closed_at IS NOT NULL)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_proof_tenant_pending() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.payroll_payout_return_claims c
            WHERE c.tenant_id = app.require_tenant_id()
              AND (c.content_sha256 IS NULL OR c.stored_sha256 IS NULL)
              AND NOT app.payout_proof_key_closed(c.tenant_id, c.evidence_key))
      OR EXISTS (
           SELECT 1
             FROM public.payroll_payout_evidence_files f
            WHERE f.tenant_id = app.require_tenant_id()
              AND f.stored_sha256 IS NULL
              AND NOT app.payout_proof_key_closed(f.tenant_id, f.evidence_key))
      OR EXISTS (
           SELECT 1
             FROM public.payroll_disbursement_items i
            CROSS JOIN LATERAL (VALUES
              (i.resolution_evidence_key),
              (i.confirmation_evidence_key),
              (i.return_evidence_key)) AS k(evidence_key)
            WHERE i.tenant_id = app.require_tenant_id()
              AND k.evidence_key IS NOT NULL
              AND NOT app.payout_proof_key_closed(i.tenant_id, k.evidence_key)
              AND NOT EXISTS (
                SELECT 1
                  FROM public.payroll_payout_evidence_files f
                 WHERE f.tenant_id = i.tenant_id
                   AND f.evidence_key = k.evidence_key))
      OR EXISTS (
           SELECT 1
             FROM app.payout_proof_operations() o
            WHERE NOT app.payout_proof_key_closed(app.require_tenant_id(), o.evidence_key)
              AND NOT EXISTS (
              SELECT 1
                FROM public.payroll_payout_proof_bindings b
               WHERE b.tenant_id = app.require_tenant_id()
                 AND b.evidence_key = o.evidence_key
                 AND ((b.kind = o.kind
                       AND b.batch_id = o.batch_id
                       AND b.item_set_hash = o.item_set_hash)
                      OR app.payout_proof_contested(
                           ARRAY[b.content_sha256, b.stored_sha256]::varchar[]))))
$$;;
--> statement-breakpoint
-- Backstop (a): a closed key takes no new row, and a row on it does not move.
-- Bindings, return claims, corrections and overpaid proposals all carry
-- tenant_id and evidence_key; only INSERT and status changes are guarded.
CREATE OR REPLACE FUNCTION app.payout_proof_closed_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF app.payout_proof_key_closed(NEW.tenant_id, NEW.evidence_key) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payout proof key is closed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proof_closed_key_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_proof_bindings_closed_key_trg ON public.payroll_payout_proof_bindings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_proof_bindings_closed_key_trg
  BEFORE INSERT ON public.payroll_payout_proof_bindings
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_return_claims_closed_key_trg ON public.payroll_payout_return_claims;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_claims_closed_key_trg
  BEFORE INSERT OR UPDATE OF status ON public.payroll_payout_return_claims
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_failed_corrections_closed_key_trg ON public.payroll_payout_failed_corrections;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_failed_corrections_closed_key_trg
  BEFORE INSERT OR UPDATE OF status ON public.payroll_payout_failed_corrections
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_overpaid_proposals_closed_key_trg ON public.payroll_payout_overpaid_proposals;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_overpaid_proposals_closed_key_trg
  BEFORE INSERT OR UPDATE OF status ON public.payroll_payout_overpaid_proposals
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
-- Backstop (b): an item takes no closed key in its proof columns (a column that
-- keeps its value is not a new use), and no new attempt is made for a payslip
-- with an open correction / overpaid proposal on a closed key (retry hold).
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_closed_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.resolution_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.resolution_evidence_key))
    OR (NEW.confirmation_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.confirmation_evidence_key))
    OR (NEW.return_evidence_key IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key)
      AND app.payout_proof_key_closed(NEW.tenant_id, NEW.return_evidence_key)) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payout proof key is closed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (
    EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_items o
        JOIN public.payroll_payout_failed_corrections c
          ON c.tenant_id = o.tenant_id AND c.item_id = o.id
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND c.status = 'proposed'
         AND app.payout_proof_key_closed(c.tenant_id, c.evidence_key))
    OR EXISTS (
      SELECT 1
        FROM public.payroll_disbursement_items o
        JOIN public.payroll_payout_overpaid_proposals p
          ON p.tenant_id = o.tenant_id AND p.item_id = o.id
       WHERE o.tenant_id = NEW.tenant_id AND o.payslip_id = NEW.payslip_id
         AND p.status = 'proposed'
         AND app.payout_proof_key_closed(p.tenant_id, p.evidence_key))) THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_CLOSED: the payslip has an open proposal on a closed proof key'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payroll_disbursement_items_closed_key_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_closed_key_trg ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_closed_key_trg
  BEFORE INSERT OR UPDATE OF resolution_evidence_key, confirmation_evidence_key, return_evidence_key
  ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_closed_key_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
-- What the functions read and write (idempotent grants; 0644 grants the rest).
GRANT SELECT ON TABLE public."session", public.payroll_disbursement_batches,
  public.payroll_disbursement_items, public.payroll_payout_return_claims,
  public.payroll_payout_failed_corrections, public.payroll_payout_overpaid_proposals,
  public.payroll_payout_evidence_files, public.payroll_payout_proof_bindings,
  public.payroll_payout_proof_backfill_stuck, public.payroll_payout_proof_closures
  TO legend_payout;
--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE public.payroll_payout_proof_closures TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (resolved_at) ON TABLE public.payroll_payout_proof_backfill_stuck TO legend_payout;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_proof_hash_contests, public.payroll_payout_attestations
  TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_history_pending() TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_proof_closure_propose(
  p_key varchar, p_note text, p_actor text, p_session text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_stuck public.payroll_payout_proof_backfill_stuck%ROWTYPE;
  v_closure public.payroll_payout_proof_closures%ROWTYPE;
  v_id uuid;
  v_binding uuid;
  v_session_created timestamptz;
  v_session_mfa timestamptz;
BEGIN
  PERFORM app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT z.* INTO v_closure
    FROM public.payroll_payout_proof_closures z
   WHERE z.tenant_id = v_tenant AND z.evidence_key = p_key;
  IF FOUND THEN
    IF v_closure.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'PAYOUT_CLOSURE_ALREADY_CLOSED: the payout proof key is already closed'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_closure.id;
  END IF;
  SELECT s.* INTO v_stuck
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = p_key AND s.resolved_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO public.payroll_payout_proof_closures (id, tenant_id, evidence_key, note, proposed_by, proposed_at)
  VALUES (v_id, v_tenant, p_key, p_note, p_actor, pg_catalog.statement_timestamp());
  SELECT b.id INTO v_binding
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = v_tenant AND b.evidence_key = p_key;
  SELECT s.created_at, s.mfa_verified_at INTO v_session_created, v_session_mfa
    FROM public."session" s WHERE s.id = p_session;
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    attested_at, txid)
  VALUES (
    v_tenant, 'closure', v_id, 'propose', v_stuck.batch_id, ARRAY[]::uuid[], p_key,
    v_binding, p_actor, p_session, v_session_created, v_session_mfa,
    pg_catalog.statement_timestamp(), pg_catalog.txid_current());
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_proof_closure_propose(varchar, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_closure_propose(varchar, text, text, text) TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.payout_proof_closure_approve(
  p_closure uuid, p_actor text, p_session text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_closure public.payroll_payout_proof_closures%ROWTYPE;
  v_stuck public.payroll_payout_proof_backfill_stuck%ROWTYPE;
  v_binding uuid;
  v_session_created timestamptz;
  v_session_mfa timestamptz;
BEGIN
  PERFORM app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve');
  SELECT z.* INTO v_closure
    FROM public.payroll_payout_proof_closures z
   WHERE z.tenant_id = v_tenant AND z.id = p_closure
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no such payout proof closure'
      USING ERRCODE = 'P0002';
  END IF;
  -- Idempotent: a closed closure only answers the gate again.
  IF v_closure.closed_at IS NOT NULL THEN
    RETURN app.payout_proof_history_pending();
  END IF;
  IF v_closure.proposed_by = p_actor THEN
    RAISE EXCEPTION 'PAYOUT_CLOSURE_SAME_PERSON: the closure needs a second person'
      USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_stuck
    FROM public.payroll_payout_proof_backfill_stuck s
   WHERE s.tenant_id = v_tenant AND s.evidence_key = v_closure.evidence_key
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_PROOF_STUCK_NOT_FOUND: no stuck payout proof for this key'
      USING ERRCODE = 'P0002';
  END IF;
  -- The approver requested none of the batches the key backs or is stuck on.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.requested_by = p_actor
       AND (b.id = v_stuck.batch_id
            OR b.id IN (SELECT o.batch_id FROM app.payout_proof_operations() o
                         WHERE o.evidence_key = v_closure.evidence_key)
            OR b.id IN (SELECT pb.batch_id FROM public.payroll_payout_proof_bindings pb
                         WHERE pb.tenant_id = v_tenant AND pb.evidence_key = v_closure.evidence_key))
  ) THEN
    RAISE EXCEPTION 'PAYOUT_CLOSURE_REQUESTER: the requester of the batch cannot close its proof'
      USING ERRCODE = '42501';
  END IF;
  -- Freeze every hash the key is known by, in every tenant.
  INSERT INTO public.payroll_payout_proof_hash_contests (sha256, contested_at)
  SELECT DISTINCT h.sha, pg_catalog.statement_timestamp()
    FROM (
      SELECT x.sha
        FROM public.payroll_payout_proof_bindings b
        CROSS JOIN LATERAL (VALUES (b.content_sha256), (b.stored_sha256)) AS x(sha)
       WHERE b.tenant_id = v_tenant AND b.evidence_key = v_closure.evidence_key
      UNION ALL
      SELECT x.sha
        FROM public.payroll_payout_evidence_files f
        CROSS JOIN LATERAL (VALUES (f.content_sha256), (f.stored_sha256)) AS x(sha)
       WHERE f.tenant_id = v_tenant AND f.evidence_key = v_closure.evidence_key
      UNION ALL
      SELECT x.sha
        FROM public.payroll_payout_return_claims c
        CROSS JOIN LATERAL (VALUES (c.content_sha256), (c.stored_sha256)) AS x(sha)
       WHERE c.tenant_id = v_tenant AND c.evidence_key = v_closure.evidence_key
    ) h
   WHERE h.sha IS NOT NULL
     AND h.sha <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ON CONFLICT (sha256) DO NOTHING;
  UPDATE public.payroll_payout_proof_closures
     SET closed_at = pg_catalog.statement_timestamp(), closed_by = p_actor
   WHERE tenant_id = v_tenant AND id = v_closure.id AND closed_at IS NULL;
  UPDATE public.payroll_payout_proof_backfill_stuck
     SET resolved_at = pg_catalog.statement_timestamp()
   WHERE tenant_id = v_tenant AND evidence_key = v_closure.evidence_key AND resolved_at IS NULL;
  SELECT b.id INTO v_binding
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = v_tenant AND b.evidence_key = v_closure.evidence_key;
  SELECT s.created_at, s.mfa_verified_at INTO v_session_created, v_session_mfa
    FROM public."session" s WHERE s.id = p_session;
  INSERT INTO public.payroll_payout_attestations (
    tenant_id, kind, operation_id, step, batch_id, item_ids, evidence_key,
    binding_id, actor, session_id, session_created_at, mfa_verified_at,
    attested_at, txid)
  VALUES (
    v_tenant, 'closure', v_closure.id, 'approve', v_stuck.batch_id, ARRAY[]::uuid[],
    v_closure.evidence_key, v_binding, p_actor, p_session, v_session_created,
    v_session_mfa, pg_catalog.statement_timestamp(), pg_catalog.txid_current());
  RETURN app.payout_proof_history_pending();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_proof_closure_approve(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_closure_approve(uuid, text, text) TO legend_app;
--> statement-breakpoint
-- ACL first (the migrator stops being able to change it once the owner moves).
ALTER FUNCTION app.payout_proof_closure_propose(varchar, text, text, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_proof_closure_approve(uuid, text, text) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
