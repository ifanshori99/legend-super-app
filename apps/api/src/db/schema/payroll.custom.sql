-- Payroll core tables (bead legend-gfcr; PRD v1.7 §3 D.30-31, §6 H, R20,
-- PAYR-02, HR-03). Appended to the generated migration 0167_payroll_core.
-- Every table is tenant-owned: forced, restrictive tenant RLS (TEN-01/02).
-- service_charge_pools carries outlet_id NOT NULL, so it also gets the TEN-03
-- outlet backstop. Every CHECK / unique constraint lives in schema/payroll.ts.
-- Restore FORCE on the parents lifted at the top of 0167 (legend-m007).
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.statutory_rates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.thr_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pay_components'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employee_pay_components'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payslips'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_transfer_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_tax_exports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.service_charge_pools'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.service_charge_pools'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.service_charge_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employee_loans'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reimbursement_categories'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reimbursements'::regclass);
--> statement-breakpoint
-- Payroll history is never deleted by the app role (audit, PAYR-04/05).
-- Allocations are the exception: a pool recalculated before approval
-- replaces its allocations (calculated -> calculated, service-charge.ts).
REVOKE DELETE, TRUNCATE ON TABLE
  public.statutory_rates, public.payroll_policies, public.thr_schedules,
  public.pay_components, public.employee_pay_components, public.payroll_runs,
  public.payslips, public.bank_transfer_files, public.payroll_tax_exports,
  public.service_charge_pools, public.employee_loans,
  public.reimbursement_categories, public.reimbursements
  FROM legend_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE public.service_charge_allocations FROM legend_app;
--> statement-breakpoint
-- HR-03 + PAYR-02: a sealed pay amount is never rewritten; a new amount is a
-- new row from its effective date. Only the end date of the previous row may
-- be set when the next one starts.
REVOKE UPDATE ON TABLE public.employee_pay_components FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (effective_to) ON TABLE public.employee_pay_components TO legend_app;
--> statement-breakpoint
-- A payslip is written once when the run locks (PAYR-04). Afterwards only the
-- rendered PDF key and the first PIN view may be recorded.
REVOKE UPDATE ON TABLE public.payslips FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (pdf_object_key, viewed_at) ON TABLE public.payslips TO legend_app;
--> statement-breakpoint
-- A bank file is derived from the locked payslips and never edited (PAYR-04).
REVOKE UPDATE ON TABLE public.bank_transfer_files FROM legend_app;
--> statement-breakpoint
-- PAYR-02 / R20: a published or archived statutory version never changes. A
-- draft may be edited and then published or archived exactly once. Enforced
-- here so a direct write cannot slip past the service.
CREATE OR REPLACE FUNCTION app.statutory_rates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'PAYR-02: statutory version % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'PAYR-02: statutory version % is % and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.type <> OLD.type OR NEW.version <> OLD.version
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYR-02: statutory version % identity cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "statutory_rates_guard_trg"
  BEFORE UPDATE OR DELETE ON "statutory_rates"
  FOR EACH ROW EXECUTE FUNCTION app.statutory_rates_guard();
--> statement-breakpoint
-- PAYR-02 / PAYR-04 / PAYR-05: once a run is locked, its pinned configuration,
-- totals, period, policy and approvals are fixed. The only moves left are
-- locked -> paid, and locked/paid -> reversed through the reversal record.
CREATE OR REPLACE FUNCTION app.payroll_runs_lock_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status NOT IN ('locked', 'paid', 'reversed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'reversed'
    OR (NEW.status <> OLD.status AND NOT (
      (OLD.status = 'locked' AND NEW.status IN ('paid', 'reversed'))
      OR (OLD.status = 'paid' AND NEW.status = 'reversed')))
  THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % is % and cannot move to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.legal_entity_id <> OLD.legal_entity_id
    OR NEW.payroll_policy_id <> OLD.payroll_policy_id
    OR NEW.run_type <> OLD.run_type
    OR NEW.thr_schedule_id IS DISTINCT FROM OLD.thr_schedule_id
    OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
    OR NEW.pay_date <> OLD.pay_date
    OR NEW.simulation_count <> OLD.simulation_count
    OR NEW.last_simulated_at IS DISTINCT FROM OLD.last_simulated_at
    OR NEW.totals IS DISTINCT FROM OLD.totals
    OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
    OR NEW.approved_by_hr IS DISTINCT FROM OLD.approved_by_hr
    OR NEW.approved_by_hr_at IS DISTINCT FROM OLD.approved_by_hr_at
    OR NEW.approved_by_finance IS DISTINCT FROM OLD.approved_by_finance
    OR NEW.approved_by_finance_at IS DISTINCT FROM OLD.approved_by_finance_at
    OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
    OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR (OLD.paid_at IS NOT NULL AND (
      NEW.paid_at IS DISTINCT FROM OLD.paid_at
      OR NEW.paid_by IS DISTINCT FROM OLD.paid_by))
  THEN
    RAISE EXCEPTION 'PAYR-02: locked payroll run % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payroll_runs_lock_guard_trg"
  BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_lock_guard();
