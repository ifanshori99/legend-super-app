-- legend-911 (P1-2, P2-3). Function bodies and triggers only; no row is edited.
-- (P1-2) Closed-key swap. The closed-key triggers of 0413 fired on INSERT and on
--     UPDATE OF status only, so an open correction / overpaid proposal (or a
--     claim) could have its evidence_key replaced by a closed (frozen) key
--     without a status change. They now also fire on UPDATE OF evidence_key, and
--     app.payout_proof_closed_key_guard (0413, unchanged) tests the NEW key.
--     The bindings trigger gets the same UPDATE OF evidence_key (it was INSERT
--     only). A closed key is therefore refused whatever column moves it in.
-- (P2-3) app.payout_bind_proof (0411) now requires the stored proof record to
--     belong to the batch being bound (f.batch_id = p_batch) and to a batch of
--     the same legal entity. Before, a proof uploaded for another batch (or
--     entity) of the tenant could back this batch. Refusal is PAYOUT-46
--     (23514), like the other proof record refusals. The signature, owner and
--     ACL (EXECUTE for legend_app) are unchanged.
DROP TRIGGER IF EXISTS payroll_payout_proof_bindings_closed_key_trg ON public.payroll_payout_proof_bindings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_proof_bindings_closed_key_trg
  BEFORE INSERT OR UPDATE OF evidence_key ON public.payroll_payout_proof_bindings
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_return_claims_closed_key_trg ON public.payroll_payout_return_claims;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_claims_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_return_claims
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_failed_corrections_closed_key_trg ON public.payroll_payout_failed_corrections;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_failed_corrections_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_failed_corrections
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_overpaid_proposals_closed_key_trg ON public.payroll_payout_overpaid_proposals;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_overpaid_proposals_closed_key_trg
  BEFORE INSERT OR UPDATE OF status, evidence_key ON public.payroll_payout_overpaid_proposals
  FOR EACH ROW EXECUTE FUNCTION app.payout_proof_closed_key_guard();
--> statement-breakpoint
-- (P2-3) The function is owned by legend_payout (0411), and the migrator cannot
-- inherit that role (INHERIT FALSE), so the replacement runs as the payout role:
-- grant, become, replace, return, revoke (as 0410). CREATE OR REPLACE keeps the
-- owner and the ACL.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_bind_proof(
  p_batch uuid, p_kind text, p_item_ids uuid[], p_key varchar, p_actor text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_entity uuid;
  v_content varchar;
  v_stored varchar;
  v_id uuid;
  v_empty constant varchar := 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('overpaid', 'return', 'correction') THEN
    RAISE EXCEPTION 'PAYOUT-45: unknown payout proof operation kind' USING ERRCODE = '23514';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = p_actor) THEN
    RAISE EXCEPTION 'PAYOUT-46: the actor of a payout proof binding must be a user'
      USING ERRCODE = '23514';
  END IF;
  SELECT b.legal_entity_id INTO v_entity
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-45: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- A non-empty set of distinct items, all in this batch.
  IF p_item_ids IS NULL
    OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids)
    OR (SELECT pg_catalog.count(*)
          FROM public.payroll_disbursement_items it
         WHERE it.tenant_id = v_tenant AND it.batch_id = p_batch AND it.id = ANY (p_item_ids))
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-45: the items of a payout proof binding must be distinct items of the batch'
      USING ERRCODE = '23514';
  END IF;
  -- The hashes come from the stored proof record, both present, not both empty.
  -- The record must have been uploaded for this very batch, and that batch must
  -- be of the same legal entity (P2-3): a proof of another batch or entity of
  -- the tenant never backs this one.
  SELECT f.content_sha256, f.stored_sha256
    INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
    JOIN public.payroll_disbursement_batches fb
      ON fb.tenant_id = f.tenant_id AND fb.id = f.batch_id
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key
     AND f.batch_id = p_batch
     AND fb.legal_entity_id = v_entity;
  IF NOT FOUND OR v_content IS NULL OR v_stored IS NULL
    OR (v_content = v_empty AND v_stored = v_empty) THEN
    RAISE EXCEPTION 'PAYOUT-46: the payout proof has no complete record for this batch'
      USING ERRCODE = '23514';
  END IF;
  -- Fail closed, globally: no new binding while any tenant's proof history is
  -- unfinished, and none over bytes a legacy duplicate contested.
  IF app.payout_proof_history_pending() THEN
    RAISE EXCEPTION 'PAYOUT-48: payout proof history is still being reconciled'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_proof_contested(ARRAY[v_content, v_stored]::varchar[]) THEN
    RAISE EXCEPTION 'PAYOUT-49: payout proof is contested' USING ERRCODE = '23514';
  END IF;

  -- A taken key or a held hash raises its unique violation here (not caught).
  INSERT INTO public.payroll_payout_proof_bindings (
    tenant_id, batch_id, kind, item_set_hash, evidence_key, content_sha256,
    stored_sha256, legacy_duplicate, created_by, created_at)
  VALUES (
    v_tenant, p_batch, p_kind, app.payout_item_set_hash(p_item_ids), p_key,
    v_content, v_stored, false, p_actor, pg_catalog.statement_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
