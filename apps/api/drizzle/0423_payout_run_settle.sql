-- legend-izza4 (911 wave 2), file 3 of 3: a run becomes `paid` only through the
-- payout role.
-- Until now the run guard let the app role turn a run `paid` when the setting
-- app.payout_settle was 'on', and any code with a transaction could set it. The
-- setting is no longer read anywhere. On a run with a batch that is not
-- cancelled, `paid` needs current_user = 'legend_payout' (PAYOUT-22), which only
-- happens inside app.payout_run_settle. L3 (PAYOUT-23: a payment of the run is
-- still open) is unchanged and still applies to the payout role. The 0344 body
-- is copied with that one condition changed.
-- app.payout_run_settle(batch, zero_net_payslips) returns true when the run
-- turned paid in this call, false when it did not (the run is untouched). It is
-- a consequence of payments, not a human step, so it takes no grant. It re-checks
-- in SQL every fact the sealed net pay does not hide: the run is locked, the
-- batch has an approver, the run has payslips, every payslip has a succeeded item
-- (the only exception: a payslip the caller read as net zero or less, which has
-- no item at all and no reconciliation exception), and nothing of the run is
-- still open. `paid_by` is the approver of the batch, never an argument.
-- Error code: PAYOUT-77 (P0002) the batch is not in the tenant.
-- Ownership: as 0420, the function is created by the payout role itself (grant,
-- become, work, return, revoke).
CREATE OR REPLACE FUNCTION app.payroll_runs_payout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'reversed' THEN
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status NOT IN ('completed', 'partially_failed', 'cancelled')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('sending', 'exported', 'unknown', 'succeeded')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-21: payroll run % has a payout in progress or paid items and cannot be reversed', NEW.id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'paid' THEN
    IF current_user IS DISTINCT FROM 'legend_payout' AND EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'PAYOUT-22: payroll run % has disbursement batches and becomes paid only when its items are paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
    -- L3: even the payout settle code cannot mark a run paid while a payment
    -- of it is still open. (That every net pay slip has a succeeded item is not
    -- checkable here: the net amount is sealed; the settle code checks it.)
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status IN ('pending_approval', 'approved', 'sending', 'exported')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('approved', 'sending', 'exported', 'unknown')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-23: payroll run % has a payout that is still open and cannot become paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT UPDATE (status, paid_at, paid_by, updated_at) ON TABLE public.payroll_runs TO legend_payout;
--> statement-breakpoint
-- The rapel trigger on payroll_runs (0302, payroll_rapel_source_reversal_guard)
-- runs as the payout role during settle and reads the rapel tables in a
-- condition that only matters for status 'reversed'. A custom plan folds that
-- away, a generic plan does not, and the permission check then needs SELECT.
-- Only the columns that condition reads, no amounts. Row level security still
-- applies (tenant in force).
GRANT SELECT (tenant_id, rapel_id, source_run_id) ON TABLE public.payroll_rapel_items TO legend_payout;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, status) ON TABLE public.payroll_rapels TO legend_payout;
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

CREATE FUNCTION app.payout_run_settle(p_batch uuid, p_zero_net uuid[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch public.payroll_disbursement_batches%ROWTYPE;
  v_run_status text;
  v_zero uuid[] := COALESCE(p_zero_net, '{}'::uuid[]);
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT b.* INTO v_batch
    FROM public.payroll_disbursement_batches b
   WHERE b.tenant_id = v_tenant AND b.id = p_batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-77: payout batch not found' USING ERRCODE = 'P0002';
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
REVOKE ALL ON FUNCTION app.payout_run_settle(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_run_settle(uuid, uuid[]) TO legend_app;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
