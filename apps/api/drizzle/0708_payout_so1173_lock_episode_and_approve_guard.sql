-- 1179 Potongan A (SO 1173 P1, tier K: money). Function bodies only: ownership and ACL
-- are kept by CREATE OR REPLACE, no row is edited, nobody is paid by it, and both
-- changes only hold a slip back.
-- 1. legend-qqsw8: app.payout_recon_flag (0473 body). A night-recon waiter that gave up on
--    the operation lock raises `evidence_read_locked:<Jakarta day>`. The day alone does
--    not tell two timeouts apart: a second timeout on the same day, after two people
--    closed the first flag, hit the old flag (ON CONFLICT DO NOTHING), its fingerprint
--    did not change and the old clearance kept the slip free while a new holder was
--    stuck. The timeout episode is now part of the flag identity: when the latest flag
--    of the same kind, operation, item and day has an approved clearance, the next
--    timeout raises a new flag whose reason is `<reason>#<n>` (n = 2, 3, ...). While
--    the latest flag has no approved clearance, waiters (also concurrent ones, serialised
--    by an advisory lock per operation and item) reuse it: one flag per episode. The
--    first flag of a day keeps the plain reason. Other reasons are unchanged.
-- 2. legend-1hpqt: app.payout_recon_clear_approve (0707 body). The check on pg_locks of
--    0706/0707 was not atomic with the approval: a holder could start while the approval
--    waited for another lock. The check is replaced by pg_try_advisory_xact_lock on the
--    key of the operation, taken after the last wait and held until the end of the
--    transaction; when it is not granted the approval is PAYOUT-91 (409).
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_recon_clear_approve(p_clearance uuid, p_grant text)
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
  PERFORM app.payout_recon_flag_see(v_tenant, v_row.exception_id);
  -- legend-1hpqt: the advisory lock of the operation is taken here, after every wait above
  -- (flag_see may queue behind another approver), and kept to the end of this transaction.
  -- A run that holds it (reading the proof) makes this approval PAYOUT-91; a run that
  -- starts later waits for the lock until this approval has ended. Same key as the
  -- reconciliation read and app.payout_recon_evidence_observe.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = v_tenant AND e.id = v_row.exception_id
       AND e.reason LIKE 'evidence\_read\_locked:%'
       AND NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
             'payout_recon_evidence_observe:' || e.tenant_id::text || ':' || e.operation_id::text,
             0))) THEN
    RAISE EXCEPTION 'PAYOUT-91: the proof file of the operation is still being read by a run that holds its lock; clear after that run has ended'
      USING ERRCODE = '23514';
  END IF;
  -- legend-1hpqt (architect P2): the observation and fingerprint checks run after the
  -- operation lock is held, so they cannot go stale while this approval waits.
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = v_tenant AND e.id = v_row.exception_id
       AND (SELECT o.state
              FROM public.payroll_payout_recon_evidence_observations o
             WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
             ORDER BY o.seq DESC
             LIMIT 1) = 'error') THEN
    RAISE EXCEPTION 'PAYOUT-91: the proof file of the operation could not be read; clear after a successful read'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_recon_flag_fingerprint(v_tenant, v_row.exception_id)
       IS DISTINCT FROM v_row.flag_sha256 THEN
    RAISE EXCEPTION 'PAYOUT-91: the flagged data changed since the clearance was proposed'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.payroll_payout_recon_clearances
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_clearance AND approved_at IS NULL;
  RETURN p_clearance;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_recon_flag(
  p_tenant uuid, p_kind text, p_operation uuid, p_item uuid, p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_payslip uuid;
  v_exception uuid;
  v_reason text;
  v_last_reason text;
  v_last_id uuid;
  v_last_n integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a flag is raised in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw')
    OR p_operation IS NULL OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'PAYOUT-68: the flag needs a kind, an operation and a reason'
      USING ERRCODE = '23514';
  END IF;
  SELECT i.payslip_id INTO v_payslip
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-68: the flagged item is not an item of the tenant'
      USING ERRCODE = '23514';
  END IF;
  v_reason := pg_catalog.left(p_reason, 200);
  IF v_reason LIKE 'evidence\_read\_locked:%' THEN
    -- Timeout episode (legend-qqsw8): one flag per episode, a new one once the latest
    -- flag of this day has been cleared by two people.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'payout_recon_lock_episode:' || p_tenant::text || ':' || p_kind || ':'
        || p_operation::text || ':' || p_item::text, 0));
    SELECT x.id, x.reason, x.n INTO v_last_id, v_last_reason, v_last_n
      FROM (
        SELECT e.id, e.reason,
               CASE WHEN e.reason = v_reason THEN 1
                    WHEN pg_catalog.substr(e.reason, pg_catalog.length(v_reason) + 2) ~ '^[0-9]+$'
                      THEN pg_catalog.substr(e.reason, pg_catalog.length(v_reason) + 2)::integer
               END AS n
          FROM public.payroll_payout_recon_exceptions e
         WHERE e.tenant_id = p_tenant AND e.kind = p_kind AND e.operation_id = p_operation
           AND e.item_id = p_item
           AND (e.reason = v_reason
                OR pg_catalog.starts_with(e.reason, v_reason || '#'))) x
     WHERE x.n IS NOT NULL
     ORDER BY x.n DESC
     LIMIT 1;
    IF v_last_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public.payroll_payout_recon_clearances c
         WHERE c.tenant_id = p_tenant AND c.exception_id = v_last_id
           AND c.approved_at IS NOT NULL) THEN
        v_reason := pg_catalog.left(v_reason || '#' || (v_last_n + 1)::text, 200);
      ELSE
        v_reason := v_last_reason;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.payroll_payout_recon_exceptions (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, flagged_at)
  VALUES (
    p_tenant, p_kind, p_operation, p_item, v_payslip,
    v_reason, pg_catalog.statement_timestamp())
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_exceptions_flag_key DO NOTHING
  RETURNING id INTO v_exception;
  IF v_exception IS NULL THEN
    SELECT e.id INTO v_exception
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.kind = p_kind AND e.operation_id = p_operation
       AND e.item_id = p_item AND e.reason = v_reason;
  END IF;
  PERFORM app.payout_recon_flag_see(p_tenant, v_exception);
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
