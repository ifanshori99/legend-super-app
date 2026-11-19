-- 1164 Kartu E (bead legend-jsrcs, tier K: money): the two-person clearance of an
-- `evidence_read_locked:<day>` flag (raised by a night-recon waiter that timed out on
-- the advisory lock of the operation, legend-q2nkl) is refused at approve while another
-- backend still holds that lock. The holder is the run that is reading the proof; until
-- it is gone nobody has read the proof, so closing the flag would free a slip on an
-- unread proof. Once the holder ends or is killed the lock is gone and the old rule
-- applies again.
-- app.payout_recon_clear_approve (0481 body) + one check: the flag reason is
-- 'evidence_read_locked:%' and some other backend holds a granted advisory lock on the key
-- hashtextextended('payout_recon_evidence_observe:'||tenant||':'||operation, 0)
-- (pg_locks: classid = high 32 bits, objid = low 32 bits, objsubid = 1) -> PAYOUT-91.
-- Function body only: ownership and ACL are kept by CREATE OR REPLACE, no row is edited,
-- nobody is paid by it, and it only holds a slip back.
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
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = v_tenant AND e.id = v_row.exception_id
       AND e.reason LIKE 'evidence\_read\_locked:%'
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_locks l,
                pg_catalog.hashtextextended(
                  'payout_recon_evidence_observe:' || e.tenant_id::text || ':' || e.operation_id::text,
                  0) AS k
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
            AND l.objsubid = 1
            AND l.classid::bigint = ((k >> 32) & 4294967295)
            AND l.objid::bigint = (k & 4294967295))) THEN
    RAISE EXCEPTION 'PAYOUT-91: the proof file of the operation is still being read by a run that holds its lock; clear after that run has ended'
      USING ERRCODE = '23514';
  END IF;
  IF app.payout_recon_flag_fingerprint(v_tenant, v_row.exception_id)
       IS DISTINCT FROM v_row.flag_sha256 THEN
    RAISE EXCEPTION 'PAYOUT-91: the flagged data changed since the clearance was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_recon_flag_see(v_tenant, v_row.exception_id);
  UPDATE public.payroll_payout_recon_clearances
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_clearance AND approved_at IS NULL;
  RETURN p_clearance;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
