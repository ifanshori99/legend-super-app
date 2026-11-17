-- legend-nsqhm (990, card E): a return of paid payout money needs the bank
-- transaction reference of the funds that came back, besides the proof file
-- fingerprint. 0580 added payroll_payout_return_claims.bank_ref (unique per
-- tenant where set) and payroll_disbursement_items.return_bank_ref.
--   PAYOUT-88  the bank reference is missing or not 4-64 characters once
--              normalized (spaces removed, upper case)
--   PAYOUT-89  the second step names another bank reference than the claim
-- A reference already used by another return claim of the tenant raises the unique
-- violation payroll_payout_return_claims_bank_ref_key (the service answers 409);
-- another tenant may use the same reference. Return claims from before 990 have
-- no reference and cannot be confirmed (PAYOUT-89): the first person proposes again.
-- The old signatures are dropped so the application role has no path without it.
-- Ownership: as 0420/0436, created by the payout role itself.
GRANT UPDATE (return_bank_ref) ON TABLE public.payroll_disbursement_items TO legend_payout;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_return_claims TO legend_payout;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

DROP FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text);
--> statement-breakpoint
DROP FUNCTION app.payout_return_confirm(uuid, varchar, text);
--> statement-breakpoint

-- Normalization of a bank reference (the application does the same before it calls).
CREATE FUNCTION app.payout_normalize_bank_ref(p_ref varchar) RETURNS varchar
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ref varchar;
BEGIN
  v_ref := pg_catalog.upper(pg_catalog.regexp_replace(COALESCE(p_ref, ''), '\s', '', 'g'));
  IF pg_catalog.char_length(v_ref) NOT BETWEEN 4 AND 64 THEN
    RAISE EXCEPTION 'PAYOUT-88: a return needs the bank transaction reference (4 to 64 characters)'
      USING ERRCODE = '23514';
  END IF;
  RETURN v_ref;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_normalize_bank_ref(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_normalize_bank_ref(varchar) TO legend_app, legend_payout;
--> statement-breakpoint

CREATE FUNCTION app.payout_return_propose(
  p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text,
  p_bank_ref varchar
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_grant uuid;
  v_actor text;
  v_session text;
  v_assertion jsonb;
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_items uuid[];
  v_n integer;
  v_binding uuid;
  v_content varchar;
  v_stored varchar;
  v_claim uuid;
  v_ref varchar;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  -- (990) The bank transaction reference of the returned funds is the identity
  -- of the money that came back: normalized (spaces out, upper case) and
  -- required, before anything is consumed.
  v_ref := app.payout_normalize_bank_ref(p_bank_ref);
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'return', 'propose', p_batch,
           p_item_ids, p_key, NULL, NULL, NULL) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items of a return must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-63: a return needs a note of 1 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  v_items := ARRAY(SELECT i FROM pg_catalog.unnest(p_item_ids) AS i ORDER BY i);
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.channel <> 'manual_bank' THEN
    RAISE EXCEPTION 'PAYOUT-63: a return is only for a manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  IF v_batch.requested_by = v_actor THEN
    RAISE EXCEPTION 'PAYOUT-64: the requester of a batch cannot return its items'
      USING ERRCODE = '42501';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'succeeded'
     AND i.returned_by IS NULL AND i.returned_by_2 IS NULL
     AND i.return_evidence_key IS NULL AND i.return_claim_id IS NULL;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: only paid items without a return can be returned'
      USING ERRCODE = '23514';
  END IF;
  -- One proof, one claim.
  IF EXISTS (
    SELECT 1 FROM public.payroll_payout_return_claims c
     WHERE c.tenant_id = v_tenant AND c.evidence_key = p_key
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof already backs a return claim' USING ERRCODE = '23514';
  END IF;
  v_binding := app.payout_assert_proof(v_tenant, 'return', p_batch, v_items, p_key);
  SELECT f.content_sha256, f.stored_sha256 INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key;

  -- A taken hash or a taken bank reference (payroll_payout_return_claims_bank_ref_key,
  -- per tenant) raises its unique violation here (the service maps it).
  INSERT INTO public.payroll_payout_return_claims (
    tenant_id, batch_id, evidence_key, item_set_hash, status, created_by,
    created_at, content_sha256, stored_sha256, bank_ref)
  VALUES (
    v_tenant, p_batch, p_key, app.payout_item_set_hash(v_items), 'open', v_actor,
    v_now, v_content, v_stored, v_ref)
  RETURNING id INTO v_claim;
  UPDATE public.payroll_disbursement_items
     SET returned_by = v_actor, return_evidence_key = p_key, return_note = p_note,
         return_claim_id = v_claim, return_bank_ref = v_ref, updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'succeeded' AND returned_by IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-63: the items changed while the return was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'return', v_claim, 'propose', p_batch, v_items,
    p_key, v_binding, v_grant, v_assertion);
  RETURN v_claim;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_return_propose(uuid, uuid[], varchar, text, text, varchar) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Return, step two: another person, the same claim and proof. Consumes the
-- claim and moves succeeded -> returned. Returns how many items moved. The
-- caller posts the return journal afterwards (checked at commit).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_return_confirm(
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
    RAISE EXCEPTION 'PAYOUT-63: the return claim is already consumed' USING ERRCODE = '23514';
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

-- The return bank reference is written by the payout role only (the application
-- role has no column grant for UPDATE; this closes INSERT).
CREATE FUNCTION app.payroll_disbursement_items_return_bank_ref_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.return_bank_ref IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND NEW.return_bank_ref IS DISTINCT FROM OLD.return_bank_ref) THEN
    IF current_user IS DISTINCT FROM 'legend_payout' THEN
      RAISE EXCEPTION 'PAYOUT-61: the return bank reference of item % is written only by the payout role', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_return_bank_ref_trg
  BEFORE INSERT OR UPDATE ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_return_bank_ref_guard();
