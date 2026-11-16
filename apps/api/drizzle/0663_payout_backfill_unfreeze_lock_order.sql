-- legend-yd9u2 (923): unfreeze catch-up and historical proof binding use the
-- same lock order: run, batches by id, items, then GL advisory locks.
-- 0662 already locks the run. Lock all its batches before the unfreeze target
-- so catch-up never starts with a higher-id batch held ahead of its siblings.
-- Only row lock acquisition changes; grants, freeze and money rules are kept.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
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
  -- Catch-up can recover a lower-id sibling after this function returns. Take
  -- every batch of the locked run in id order before taking the target row.
  PERFORM 1
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant
     AND b.payroll_run_id = (
       SELECT target.payroll_run_id
         FROM public.payroll_disbursement_batches target
        WHERE target.tenant_id = v_tenant AND target.id = p_batch)
   ORDER BY b.id
     FOR UPDATE;
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
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
