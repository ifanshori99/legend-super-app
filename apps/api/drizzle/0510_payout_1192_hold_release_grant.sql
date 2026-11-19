-- 1192 (legend-6o7pc, tier K: money). Part 2 of 3: the grant for releasing a hold.
-- app.payout_grant_issue is copied from 0472 (its latest definition; no later
-- migration replaces it) with ONE addition for the new kind hold_release (CHECKs in
-- 0509). Every other kind behaves exactly as in 0472. The additions:
--   * step list: hold_release may take the steps propose and approve;
--   * detail: for hold_release the sha256 (hex) of the reason, as recon_clear;
--   * method: hold_release needs the password step-up (PAYOUT-72), as recon_clear;
--   * branch (as recon_clear): tenant-wide owner or finance role (PAYOUT-42); the ref
--     is the hold (propose: it must exist in the tenant and the batch of its item, and
--     no approved release may exist for it, PAYOUT-87) or the release (approve: not yet
--     approved PAYOUT-87; the proposer and the session that proposed cannot hold the
--     grant, PAYOUT-86). The batch of the grant is the batch of the held item.
-- Signature, owner, SECURITY DEFINER, search_path and ACL (CREATE OR REPLACE) are
-- unchanged. app.payout_grant_consume needs no change: it matches the grant by its
-- binding and has no kind-specific rule beyond disown and unfreeze.
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
       OR (p_kind = 'hold_release' AND p_step IN ('propose', 'approve'))
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
       OR (p_kind IN ('disown', 'unfreeze', 'recon_clear', 'return_withdraw', 'hold_release') AND p_detail ~ '^[0-9a-f]{64}$')
       OR (p_kind NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear', 'return_withdraw', 'hold_release') AND p_detail IS NULL)) THEN
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
  -- Releasing a hold (1192) is password only too: no MFA challenge alone can lift
  -- a hold that exists because something looked forged.
  IF p_kind = 'hold_release' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: a hold release grant needs a password step-up'
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
    -- Release a hold of a flag that could not be written (1192): a tenant-wide owner
    -- or finance role (as recon_clear), the ref is the hold (propose) or the release
    -- (approve) of this tenant, the batch is the batch of the held item. A hold that
    -- an approved release lifted takes no new proposal (PAYOUT-87). Approve: the
    -- proposer, and the session that proposed, cannot hold the grant (PAYOUT-86); an
    -- approved release takes no second approval (PAYOUT-87).
    IF p_kind = 'hold_release' THEN
      IF p_batch IS NULL OR p_ref IS NULL THEN
        RAISE EXCEPTION 'PAYOUT-72: a hold release grant needs a batch and a ref'
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
        RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can release a hold'
          USING ERRCODE = '42501';
      END IF;
      IF p_step = 'propose' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.payroll_payout_recon_unwritten_holds h
            JOIN public.payroll_disbursement_items it
              ON it.tenant_id = h.tenant_id AND it.id = h.item_id
           WHERE h.tenant_id = v_tenant AND h.id = p_ref AND it.batch_id = p_batch
        ) THEN
          RAISE EXCEPTION 'PAYOUT-72: the hold of this grant is not in the tenant or batch'
            USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM public.payroll_payout_recon_hold_releases r
           WHERE r.tenant_id = v_tenant AND r.hold_id = p_ref
             AND r.approved_at IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'PAYOUT-87: the hold is already released'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        SELECT r.proposed_by, r.proposed_session_id, r.approved_at IS NOT NULL
          INTO v_clr_proposer, v_clr_session, v_clr_done
          FROM public.payroll_payout_recon_hold_releases r
          JOIN public.payroll_payout_recon_unwritten_holds h
            ON h.tenant_id = r.tenant_id AND h.id = r.hold_id
          JOIN public.payroll_disbursement_items it
            ON it.tenant_id = h.tenant_id AND it.id = h.item_id
         WHERE r.tenant_id = v_tenant AND r.id = p_ref AND it.batch_id = p_batch;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'PAYOUT-72: the hold release of this grant is not in the tenant or batch'
            USING ERRCODE = '22023';
        END IF;
        IF v_clr_done THEN
          RAISE EXCEPTION 'PAYOUT-87: the hold release is already approved'
            USING ERRCODE = '23514';
        END IF;
        IF v_clr_proposer = p_actor OR v_clr_session = p_session THEN
          RAISE EXCEPTION 'PAYOUT-86: the proposer of a hold release cannot approve it'
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
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
