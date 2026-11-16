-- legend-l2zru (920): one lock order for the freeze, run first.
-- The freeze rules of 0660 and 0661 locked the batch row, so two steps on two
-- sibling batches of one run (they share payslips, PAYOUT-11 binds items,
-- payslips and batches to one run) could both pass the freeze check while a
-- disown of the third was still waiting. The parent of every freeze is the
-- payroll_runs row now. The order of every path is run, batch, items, then the
-- GL advisory lock.
-- 1. app.payout_lock_run_of_batch(tenant, batch): reads the run id of the batch
--    without a lock, then takes the run row FOR UPDATE. Internal: no grant to
--    legend_app (the definer functions below call it as the payout role).
-- 2. app.payout_batch_assert_open: takes the run lock before the batch lock, so
--    the 17 functions that consume a grant (through app.payout_grant_consume),
--    app.payout_attest and app.payout_run_settle lock the run first. The freeze
--    is read after the waits, in a later statement, so a dispute that committed
--    while waiting is seen.
-- 3. app.payout_approval_disown and app.payout_batch_unfreeze: lock the run after
--    the grant is spent and before the batch row.
-- 4. app.payout_run_settle (0661 body): assert_open is the first statement (the
--    old batch-then-run order is gone). When another batch of the run is frozen
--    it returns false and does not raise.
-- 5. app.payout_grant_issue (0660 body): an unfreeze grant needs a password
--    step-up (PAYOUT-72, 22023), so the "disputant withdraws their own claim"
--    exception of the unfreeze rules always rests on a password.
-- Ownership as 0661: the functions are replaced by the payout role itself.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

CREATE FUNCTION app.payout_lock_run_of_batch(p_tenant uuid, p_batch uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run uuid;
BEGIN
  IF p_batch IS NULL THEN
    RETURN;
  END IF;
  SELECT b.payroll_run_id INTO v_run
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = p_tenant AND b.id = p_batch;
  IF v_run IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1
    FROM public.payroll_runs r
   WHERE r.tenant_id = p_tenant AND r.id = v_run
     FOR UPDATE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_lock_run_of_batch(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.payout_batch_assert_open(p_tenant uuid, p_batch uuid)
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
  PERFORM app.payout_lock_run_of_batch(p_tenant, p_batch);
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
  -- Unfreeze is password only as well (PAYOUT-72): the one exception of the
  -- unfreeze rules (the disputant withdrawing their own claim) then always
  -- rests on a fresh password, never on an MFA challenge alone.
  IF p_kind = 'unfreeze' AND p_method <> 'password' THEN
    RAISE EXCEPTION 'PAYOUT-72: an unfreeze grant needs a password step-up'
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

CREATE OR REPLACE FUNCTION app.payout_approval_disown(p_log uuid, p_grant text, p_reason text)
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
  PERFORM app.payout_lock_run_of_batch(v_tenant, v_log.batch_id);
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

CREATE OR REPLACE FUNCTION app.payout_batch_unfreeze(p_batch uuid, p_grant text, p_reason text)
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
  PERFORM app.payout_lock_run_of_batch(v_tenant, p_batch);
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
      -- Steps attested before the approval log existed (0659).
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

CREATE OR REPLACE FUNCTION app.payout_run_settle(p_batch uuid, p_zero_net uuid[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_run_status text;
  v_zero uuid[] := COALESCE(p_zero_net, '{}'::uuid[]);
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  -- Lock order run, batch, items: assert_open takes the run row, then the batch
  -- row, and checks the freeze again after the waits (a later statement of a
  -- READ COMMITTED transaction sees a dispute that committed meanwhile).
  PERFORM app.payout_batch_assert_open(v_tenant, p_batch);
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-77: payout batch not found' USING ERRCODE = 'P0002';
  END IF;
  -- A run is not settled while ANY other batch of it is frozen: nothing to
  -- settle yet, so false and no error (confirming a healthy batch must not fail
  -- because a sibling is in dispute). Read only on the others.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches o
     WHERE o.tenant_id = v_tenant AND o.payroll_run_id = v_batch.payroll_run_id
       AND o.id <> p_batch
       AND app.payout_batch_frozen(v_tenant, o.id)
  ) THEN
    RETURN false;
  END IF;
  SELECT r.status INTO v_run_status
    FROM public.payroll_runs r
   WHERE r.tenant_id = v_tenant AND r.id = v_batch.payroll_run_id
     FOR UPDATE;
  IF NOT FOUND OR v_run_status <> 'locked' THEN
    RETURN false;
  END IF;
  -- paid_by is the last approver of the batch: no approver, no paid run.
  IF v_batch.approved_by IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payslips s
     WHERE s.tenant_id = v_tenant AND s.payroll_run_id = v_batch.payroll_run_id
  ) THEN
    RETURN false;
  END IF;
  -- Every payslip has a succeeded item. The one exception is a payslip of net
  -- zero or less (the caller read the sealed net) with no item at all and no
  -- reconciliation exception.
  IF EXISTS (
    SELECT 1 FROM public.payslips s
     WHERE s.tenant_id = v_tenant AND s.payroll_run_id = v_batch.payroll_run_id
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_disbursement_items i
          WHERE i.tenant_id = s.tenant_id AND i.payslip_id = s.id
            AND i.status = 'succeeded')
       AND NOT (
         s.id = ANY (v_zero)
         AND NOT EXISTS (
           SELECT 1 FROM public.payroll_disbursement_items i
            WHERE i.tenant_id = s.tenant_id AND i.payslip_id = s.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.payroll_payout_recon_exceptions e
            WHERE e.tenant_id = s.tenant_id AND e.payslip_id = s.id))
  ) THEN
    RETURN false;
  END IF;
  -- L3: a payment of the run is still open.
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
     WHERE b.tenant_id = v_tenant AND b.payroll_run_id = v_batch.payroll_run_id
       AND b.status IN ('pending_approval', 'approved', 'sending', 'exported')
  ) OR EXISTS (
    SELECT 1 FROM public.payroll_disbursement_items i
     WHERE i.tenant_id = v_tenant AND i.payroll_run_id = v_batch.payroll_run_id
       AND i.status IN ('approved', 'sending', 'exported', 'unknown')
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.payroll_runs
     SET status = 'paid', paid_at = v_now, paid_by = v_batch.approved_by, updated_at = v_now
   WHERE tenant_id = v_tenant AND id = v_batch.payroll_run_id AND status = 'locked';
  RETURN FOUND;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
