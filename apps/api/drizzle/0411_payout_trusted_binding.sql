-- legend-i01jp (905, card 1, chunk C0c): proof bindings, return-claim hashes and
-- the shared-key contest move behind trusted functions.
-- - app.payout_bind_proof: the only writer of a binding for a live operation.
--   Owned by the NOLOGIN payout role legend_payout (0644). It reads both hashes
--   from the stored proof record (never from an argument), re-checks the kind,
--   the batch and the item set in SQL, and honours the global proof gate and the
--   contested hashes. The services keep their own checks as a first line.
-- - app.payout_backfill_bind: the same for a historical operation. The operation
--   must exist in app.payout_proof_operations() and its item set hash is
--   recomputed here from the item ids the caller names.
-- - app.payout_backfill_claim_hashes: fills the two NULL hashes of a return claim
--   from the stored proof record (the app role cannot update claims after 0648).
-- - app.payout_proof_contest_own: now answers a boolean and contests only when
--   the stored rows of the caller's tenant show more than one operation over the
--   key, or a legacy duplicate binding. A setting naming another tenant cannot
--   block its proofs: the effect comes from stored data, never from the setting.
--   It is not a payout-role function (the contest table has no policy and only
--   its owner writes it), so it keeps the migrator as owner.
-- Insert conflicts (the key's unique constraint, the global hash table) are not
-- caught: the services map those unique violations. Every other refusal is
-- 23514 (P0002 for a missing batch) with PAYOUT-45..49:
--   45 batch / kind / item set refused   46 proof record or actor refused
--   47 historical operation not found    48 proof gate pending / claim not fillable
--   49 proof hash contested

GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
-- What the functions read and write (idempotent grants; 0644 grants the rest).
GRANT SELECT ON TABLE public."user" TO legend_payout;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_disbursement_batches, public.payroll_disbursement_items,
  public.payroll_payout_evidence_files, public.payroll_payout_proof_bindings,
  public.payroll_payout_return_claims, public.payroll_payout_failed_corrections,
  public.payroll_payout_overpaid_proposals TO legend_payout;
--> statement-breakpoint
GRANT INSERT ON TABLE public.payroll_payout_proof_bindings TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (content_sha256, stored_sha256) ON TABLE public.payroll_payout_return_claims TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_history_pending() TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contested(varchar[]) TO legend_payout;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_operations() TO legend_payout;
--> statement-breakpoint
-- Same formula as itemSetHashOf in the services: lowercase uuids sorted
-- bytewise, joined by a newline, SHA-256 hex.
CREATE FUNCTION app.payout_item_set_hash(p_item_ids uuid[]) RETURNS varchar
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.string_agg(i::text, E'\n' ORDER BY i::text COLLATE "C"),
           'UTF8')), 'hex')::varchar
    FROM pg_catalog.unnest(p_item_ids) AS i
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_item_set_hash(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_item_set_hash(uuid[]) TO legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_bind_proof(
  p_batch uuid, p_kind text, p_item_ids uuid[], p_key varchar, p_actor text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
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
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.id = p_batch
  ) THEN
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
  SELECT f.content_sha256, f.stored_sha256
    INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key;
  IF NOT FOUND OR v_content IS NULL OR v_stored IS NULL
    OR (v_content = v_empty AND v_stored = v_empty) THEN
    RAISE EXCEPTION 'PAYOUT-46: the payout proof has no complete record'
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
REVOKE ALL ON FUNCTION app.payout_bind_proof(uuid, text, uuid[], varchar, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_bind_proof(uuid, text, uuid[], varchar, text) TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.payout_backfill_bind(
  p_batch uuid, p_kind text, p_item_ids uuid[], p_key varchar, p_legacy_duplicate boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_hash varchar;
  v_op record;
  v_id uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('overpaid', 'return', 'correction') THEN
    RAISE EXCEPTION 'PAYOUT-45: unknown payout proof operation kind' USING ERRCODE = '23514';
  END IF;
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-45: the items of a payout proof binding must be distinct'
      USING ERRCODE = '23514';
  END IF;
  v_hash := app.payout_item_set_hash(p_item_ids);
  -- The operation must exist in the stored rows of this tenant with exactly
  -- this identity; its hashes come from the stored proof record.
  SELECT o.content_sha256, o.stored_sha256, o.created_by
    INTO v_op
    FROM app.payout_proof_operations() o
   WHERE o.kind = p_kind
     AND o.batch_id = p_batch
     AND o.evidence_key = p_key
     AND o.item_set_hash = v_hash
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-47: no such historical payout operation' USING ERRCODE = '23514';
  END IF;
  IF v_op.content_sha256 IS NULL OR v_op.stored_sha256 IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-47: the proof of the historical operation has no complete record'
      USING ERRCODE = '23514';
  END IF;
  -- A taken key raises the key's unique violation; a held hash raises the hash
  -- table's (retried by the caller as a legacy duplicate). Not caught.
  INSERT INTO public.payroll_payout_proof_bindings (
    tenant_id, batch_id, kind, item_set_hash, evidence_key, content_sha256,
    stored_sha256, legacy_duplicate, created_by, created_at)
  VALUES (
    v_tenant, p_batch, p_kind, v_hash, p_key, v_op.content_sha256,
    v_op.stored_sha256, COALESCE(p_legacy_duplicate, false), v_op.created_by,
    pg_catalog.statement_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_backfill_bind(uuid, text, uuid[], varchar, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_backfill_bind(uuid, text, uuid[], varchar, boolean) TO legend_app;
--> statement-breakpoint
-- Fills the NULL hashes of a return claim from the stored record of its proof
-- (each hash once, as the claim guard allows). False when there is nothing to
-- fill: no such claim, both hashes present, or the record lacks its stored hash.
CREATE FUNCTION app.payout_backfill_claim_hashes(p_claim uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_claim public.payroll_payout_return_claims%ROWTYPE;
  v_content varchar;
  v_stored varchar;
BEGIN
  SELECT c.* INTO v_claim
    FROM public.payroll_payout_return_claims c
   WHERE c.tenant_id = v_tenant AND c.id = p_claim
     FOR UPDATE;
  IF NOT FOUND OR (v_claim.content_sha256 IS NOT NULL AND v_claim.stored_sha256 IS NOT NULL) THEN
    RETURN false;
  END IF;
  SELECT f.content_sha256, f.stored_sha256
    INTO v_content, v_stored
    FROM public.payroll_payout_evidence_files f
   WHERE f.tenant_id = v_tenant AND f.evidence_key = v_claim.evidence_key;
  IF NOT FOUND OR v_stored IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.payroll_payout_return_claims
     SET content_sha256 = COALESCE(v_claim.content_sha256, v_content),
         stored_sha256 = COALESCE(v_claim.stored_sha256, v_stored)
   WHERE tenant_id = v_tenant AND id = v_claim.id
     AND (content_sha256 IS NULL OR stored_sha256 IS NULL);
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_backfill_claim_hashes(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_backfill_claim_hashes(uuid) TO legend_app;
--> statement-breakpoint
-- ACL first (the migrator stops being able to change it once the owner moves).
ALTER FUNCTION app.payout_item_set_hash(uuid[]) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_bind_proof(uuid, text, uuid[], varchar, text) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_backfill_bind(uuid, text, uuid[], varchar, boolean) OWNER TO legend_payout;
--> statement-breakpoint
ALTER FUNCTION app.payout_backfill_claim_hashes(uuid) OWNER TO legend_payout;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
-- The shared-key contest (0641 returned void and trusted the caller to ask only
-- for a key with several operations). Same name, boolean answer: true when it
-- contested, false when the stored rows do not show a contested key (the
-- backfill then fails closed). The identities are those of the key's operations
-- plus the identity of its binding; contested when they differ or when the
-- binding is a legacy duplicate. The hashes contested are those of the binding.
-- SECURITY DEFINER, owner = the migrator (owner of the contest table, which is
-- not FORCED and has no policy); RLS of the bindings still binds the owner to
-- the tenant setting, and the setting alone cannot cause a contest.
DROP FUNCTION IF EXISTS app.payout_proof_contest_own(varchar);
--> statement-breakpoint
CREATE FUNCTION app.payout_proof_contest_own(p_key varchar) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  bound record;
  identities integer;
BEGIN
  SELECT b.kind, b.batch_id, b.item_set_hash, b.legacy_duplicate,
         b.content_sha256, b.stored_sha256
    INTO bound
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = v_tenant
     AND b.evidence_key = p_key;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT pg_catalog.count(*)
    INTO identities
    FROM (
      SELECT o.kind, o.batch_id, o.item_set_hash
        FROM app.payout_proof_operations() o
       WHERE o.evidence_key = p_key
      UNION
      SELECT bound.kind, bound.batch_id, bound.item_set_hash
    ) AS ids;
  IF identities <= 1 AND NOT bound.legacy_duplicate THEN
    RETURN false;
  END IF;
  INSERT INTO public.payroll_payout_proof_hash_contests (sha256, contested_at)
  SELECT DISTINCT h, pg_catalog.statement_timestamp()
    FROM unnest(ARRAY[bound.content_sha256, bound.stored_sha256]::varchar[]) AS h
   WHERE h <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ON CONFLICT (sha256) DO NOTHING;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_proof_contest_own(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contest_own(varchar) TO legend_app;
