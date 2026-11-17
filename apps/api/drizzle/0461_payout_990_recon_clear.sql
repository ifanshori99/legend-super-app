-- legend-xbagc (990, card A): a way out of a reconciliation flag.
-- A flag in payroll_payout_recon_exceptions held a payslip back from a new
-- attempt for good (insert-only table). Now two finance people can clear it:
-- propose, then approve, each under a one-time payout grant (kind recon_clear,
-- password step-up only, tenant-wide owner or finance role plus
-- payroll.disburse.approve). The table payroll_payout_recon_clearances is
-- migration 0460.
-- 1. app.payout_payslip_held_by_recon(tenant, payslip): true when a flag of the
--    payslip has no approved clearance. The one test of "held": the item guard
--    (insert of a new attempt, PAYOUT-62) and app.payout_resolve_approve
--    (PAYOUT-62) use it. The overpaid check (second PAYOUT-62) is unchanged.
--    app.payout_run_settle (0429) reads the flags only for a payslip without any
--    item; a flag always names an item, so it needs no change.
-- 2. app.payout_grant_issue (0433 body): kind recon_clear, step propose and
--    approve. Detail = sha256 (hex) of the reason (propose: the proposed reason;
--    approve: the reason on the clearance row). Ref = the flag (propose) or the
--    clearance (approve) of this tenant; the batch is the batch of the flagged
--    item. The proposer, and the session that proposed, cannot get the approve
--    grant (PAYOUT-86). app.payout_grant_consume needs no change: it matches the
--    grant row, whatever the kind.
-- 3. app.payout_recon_clear_propose(flag, grant, reason) -> clearance id and
--    app.payout_recon_clear_approve(clearance, grant) -> clearance id. EXECUTE
--    for legend_app only, as app.payout_batch_unfreeze.
-- 4. app.payout_recon_flag (0432) is unchanged: ON CONFLICT DO NOTHING on the
--    flag key. A flag that was cleared and is found again by the nightly
--    reconciliation for the same key does not come back: the old row, with its
--    clearance, stays. A different key (another operation, item or reason) is a
--    new flag that holds the payslip again.
-- Error codes: PAYOUT-85 (23514) a clearance reason of 10 to 500 characters,
-- PAYOUT-86 (42501) the proposer cannot approve (user or session), PAYOUT-87
-- (23514) the clearance is already approved (or cannot change). A flag or a
-- clearance of another tenant, or missing: PAYOUT-69 (P0002). A role without
-- owner/finance at tenant scope: PAYOUT-42 (42501). A grant that does not
-- match: PAYOUT-70 (42501).
-- Ownership: as 0433, the trusted functions are created by the payout role
-- itself; the helper and the item guard (invoker functions) by the migrator.
CREATE OR REPLACE FUNCTION app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.payslip_id = p_payslip
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_clearances c
          WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
            AND c.approved_at IS NOT NULL))
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_payslip_held_by_recon(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_payslip_held_by_recon(uuid, uuid) TO legend_app, legend_payout;
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
       OR (p_kind = 'batch_approve' AND p_step = 'approve')) THEN
    RAISE EXCEPTION 'PAYOUT-72: no payout grant exists for this kind and step'
      USING ERRCODE = '22023';
  END IF;
  -- The detail of a grant: the outcome for resolve, 'succeeded' for a bank
  -- confirmation, the sha256 (hex) of the reason for disown, unfreeze and
  -- recon_clear, nothing for every other kind (the table CHECK says the same).
  IF NOT ((p_kind = 'resolve' AND p_detail IN ('failed', 'not_sent'))
       OR (p_kind = 'bank_confirm' AND p_detail = 'succeeded')
       OR (p_kind IN ('disown', 'unfreeze', 'recon_clear') AND p_detail ~ '^[0-9a-f]{64}$')
       OR (p_kind NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear') AND p_detail IS NULL)) THEN
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
-- Clearance, step one: a finance person proposes to clear a flag with a reason.
-- Grant binding: kind recon_clear, step propose, the batch of the flagged item,
-- ref = the flag, detail = sha256 of the reason. A flag that has an open
-- clearance returns that clearance (the reason stays as first proposed); an
-- approved one is PAYOUT-87.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_clear_propose(p_exception uuid, p_grant text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_id uuid;
  v_done timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-85: a clearance of a reconciliation flag needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT it.batch_id INTO v_batch
    FROM public.payroll_payout_recon_exceptions e
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = e.tenant_id AND it.id = e.item_id
   WHERE e.tenant_id = v_tenant AND e.id = p_exception;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation flag not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'recon_clear', 'propose', v_batch,
           NULL, NULL, p_exception, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(p_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
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
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.payroll_payout_recon_clearances (
    tenant_id, exception_id, reason, proposed_by, proposed_session_id, proposed_grant_id)
  VALUES (v_tenant, p_exception, p_reason, v_actor, v_session, v_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_clearances_exception_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.id, c.approved_at INTO v_id, v_done
      FROM public.payroll_payout_recon_clearances c
     WHERE c.tenant_id = v_tenant AND c.exception_id = p_exception;
    IF v_done IS NOT NULL THEN
      RAISE EXCEPTION 'PAYOUT-87: the reconciliation flag is already cleared'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_clear_propose(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_clear_propose(uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Clearance, step two: another finance person approves it. Grant binding: kind
-- recon_clear, step approve, the batch of the flagged item, ref = the
-- clearance, detail = sha256 of the reason on the clearance. The row is locked;
-- an approved clearance is PAYOUT-87; the proposer, or the session that
-- proposed, is PAYOUT-86.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_clear_approve(p_clearance uuid, p_grant text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_reason text;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_row public.payroll_payout_recon_clearances%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT it.batch_id, c.reason INTO v_batch, v_reason
    FROM public.payroll_payout_recon_clearances c
    JOIN public.payroll_payout_recon_exceptions e
      ON e.tenant_id = c.tenant_id AND e.id = c.exception_id
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = e.tenant_id AND it.id = e.item_id
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation clearance not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'recon_clear', 'approve', v_batch,
           NULL, NULL, p_clearance, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(v_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
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
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
      USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_row
    FROM public.payroll_payout_recon_clearances c
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance
     FOR UPDATE;
  IF v_row.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-87: the reconciliation clearance is already approved'
      USING ERRCODE = '23514';
  END IF;
  IF v_row.proposed_by = v_actor OR v_row.proposed_session_id = v_session THEN
    RAISE EXCEPTION 'PAYOUT-86: the proposer of a reconciliation clearance cannot approve it'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.payroll_payout_recon_clearances
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_clearance AND approved_at IS NULL;
  RETURN p_clearance;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_clear_approve(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_clear_approve(uuid, text) TO legend_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.payout_resolve_approve(
  p_batch uuid, p_item_ids uuid[], p_outcome text, p_key varchar, p_grant text
) RETURNS integer
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
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'resolve', 'approve', p_batch,
           p_item_ids, p_key, NULL, NULL, p_outcome) AS g;
  v_assertion := app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  IF p_outcome IS NULL OR p_outcome NOT IN ('failed', 'not_sent') THEN
    RAISE EXCEPTION 'PAYOUT-76: the outcome of a resolution is failed or not_sent'
      USING ERRCODE = '23514';
  END IF;
  IF p_item_ids IS NULL OR pg_catalog.cardinality(p_item_ids) = 0
    OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_item_ids) AS i)
         <> pg_catalog.cardinality(p_item_ids) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items of a resolution must be a non-empty set of distinct items'
      USING ERRCODE = '23514';
  END IF;
  IF p_key IS NULL OR pg_catalog.char_length(p_key) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution needs a proof key of 1 to 500 characters'
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
  IF v_batch.channel <> 'manual_bank' OR v_batch.status <> 'exported' THEN
    RAISE EXCEPTION 'PAYOUT-76: a resolution is only for an exported manual bank batch'
      USING ERRCODE = '23514';
  END IF;
  PERFORM i.id
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
   ORDER BY i.id
     FOR UPDATE;
  -- Every item is exported with a step-one proposal of the same outcome.
  SELECT pg_catalog.count(*) INTO v_n
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
     AND i.status = 'exported'
     AND i.resolved_by IS NOT NULL AND i.resolved_by_2 IS NULL
     AND i.resolution_outcome = p_outcome;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: only exported items with a proposal of this outcome can be approved'
      USING ERRCODE = '23514';
  END IF;
  -- The proof is the one the first person recorded.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolution_evidence_key IS DISTINCT FROM p_key
  ) OR NOT EXISTS (
    SELECT 1 FROM public.payroll_payout_evidence_files f
     WHERE f.tenant_id = v_tenant AND f.evidence_key = p_key AND f.batch_id = p_batch
  ) THEN
    RAISE EXCEPTION 'PAYOUT-65: the proof must be the one the first person recorded for this batch'
      USING ERRCODE = '23514';
  END IF;
  -- A closed key frees no slip: same refusal code as the item guard (0415).
  IF app.payout_proof_key_closed(v_tenant, p_key) THEN
    RAISE EXCEPTION 'PAYOUT-72: the payout proof key is closed, the payslip is not released for a new attempt'
      USING ERRCODE = '23514';
  END IF;
  -- Two different people, neither the requester of the batch.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolved_by = v_actor
  ) THEN
    RAISE EXCEPTION 'PAYOUT-64: the second step of a resolution needs another person'
      USING ERRCODE = '42501';
  END IF;
  IF v_batch.requested_by = v_actor OR EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND i.resolved_by = v_batch.requested_by
  ) THEN
    RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve its items'
      USING ERRCODE = '23514';
  END IF;
  -- Step one was made under a grant of this outcome, by the person on the item.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_attestations a
           JOIN public.payroll_payout_grants gr
             ON gr.tenant_id = a.tenant_id AND gr.id = a.grant_id
          WHERE a.tenant_id = v_tenant AND a.kind = 'resolve' AND a.step = 'propose'
            AND a.grant_id IS NOT NULL
            AND a.batch_id = p_batch
            AND a.actor = i.resolved_by
            AND a.evidence_key = i.resolution_evidence_key
            AND i.id = ANY (a.item_ids)
            AND gr.detail = i.resolution_outcome)
  ) THEN
    RAISE EXCEPTION 'PAYOUT-71: the first step of this resolution has no grant; propose it again'
      USING ERRCODE = '23514';
  END IF;
  -- A payslip held by the reconciliation (a flag without an approved clearance,
  -- 990), or settled by hand as overpaid, is not freed for a new payment here.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.batch_id = p_batch AND i.id = ANY (v_items)
       AND (app.payout_payslip_held_by_recon(i.tenant_id, i.payslip_id)
         OR EXISTS (
              SELECT 1 FROM public.payroll_disbursement_items o
               WHERE o.tenant_id = i.tenant_id AND o.payslip_id = i.payslip_id
                 AND o.status = 'overpaid'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-62: a payslip of these items is held back or settled as overpaid'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_disbursement_items
     SET resolved_by_2 = v_actor, status = p_outcome,
         failure_class = CASE WHEN p_outcome = 'failed' THEN 'definitive' END,
         updated_at = v_now
   WHERE tenant_id = v_tenant AND batch_id = p_batch AND id = ANY (v_items)
     AND status = 'exported' AND resolved_by IS NOT NULL AND resolved_by_2 IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'PAYOUT-76: the items changed while the resolution was approved'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_attest(v_tenant, 'resolve', v_operation, 'approve', p_batch, v_items,
    p_key, NULL, v_grant, v_assertion);
  RETURN v_n;
END $$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint

-- (990) the item guard (0433 body) asks app.payout_payslip_held_by_recon.
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
