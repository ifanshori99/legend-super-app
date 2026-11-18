-- legend-628t9 (954): a payout grant that expires while its caller waits for the
-- run/batch lock must not be spent. app.payout_grant_consume (0428 body) took
-- v_now first, then waited in payout_batch_assert_open for the run lock (0429),
-- then compared expires_at with the old v_now. Plain SQL as legend_app could
-- start before the expiry, wait past it and still get the grant.
-- Fix, same signature, same ACL: the clock is read after every wait. The wait
-- for the grant row itself (a concurrent consumer) happens in the FOR UPDATE
-- probe; the UPDATE then runs on a row this transaction already locks, so the
-- v_now it uses is taken right before it. A refusal raises PAYOUT-70 and rolls
-- back, so the grant stays unspent. Every kind that consumes a grant gets the
-- fix, because they all go through this function.
-- Ownership: as 0428/0433, replaced by the payout role itself.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.payout_grant_consume(
  p_tenant uuid, p_grant text, p_kind text, p_step text, p_batch uuid,
  p_item_ids uuid[], p_key varchar, p_ref uuid, p_target uuid, p_detail varchar)
RETURNS TABLE (grant_id uuid, actor text, session_id text, assertion jsonb)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz;
  v_hash text;
  v_set text;
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
  IF p_kind IS DISTINCT FROM 'disown' AND p_kind IS DISTINCT FROM 'unfreeze' THEN
    PERFORM app.payout_batch_assert_open(p_tenant, p_batch);
  END IF;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(p_grant, 'hex')), 'hex');
  v_set := app.payout_item_set_hash(COALESCE(p_item_ids, '{}'::uuid[]));
  -- Wait for the grant row here (a concurrent consumer holds it). After the
  -- wait the predicate is re-read, so a grant spent meanwhile is not matched.
  PERFORM 1
    FROM public.payroll_payout_grants g
   WHERE g.tenant_id = p_tenant
     AND g.secret_sha256 = v_hash
     AND g.consumed_at IS NULL
     AND g.kind = p_kind
     AND g.step = p_step
     AND g.batch_id IS NOT DISTINCT FROM p_batch
     AND g.item_set_hash IS NOT DISTINCT FROM v_set
     AND g.evidence_key IS NOT DISTINCT FROM p_key
     AND g.ref_id IS NOT DISTINCT FROM p_ref
     AND g.target_id IS NOT DISTINCT FROM p_target
     AND g.detail IS NOT DISTINCT FROM p_detail
     FOR UPDATE;
  -- The clock is read after the run lock, the batch lock and the grant row lock.
  v_now := pg_catalog.clock_timestamp();
  UPDATE public.payroll_payout_grants g
     SET consumed_at = v_now,
         consumed_txid = pg_catalog.txid_current()
   WHERE g.tenant_id = p_tenant
     AND g.secret_sha256 = v_hash
     AND g.consumed_at IS NULL
     AND g.expires_at > v_now
     AND g.kind = p_kind
     AND g.step = p_step
     AND g.batch_id IS NOT DISTINCT FROM p_batch
     AND g.item_set_hash IS NOT DISTINCT FROM v_set
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
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
