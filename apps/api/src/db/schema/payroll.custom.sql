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
-- A statutory version is born a draft; publishing is an UPDATE the guard
-- above checks (no direct insert of a published, possibly backdated row).
CREATE OR REPLACE FUNCTION app.statutory_rates_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'PAYR-02: statutory version % must be inserted as a draft', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "statutory_rates_insert_guard_trg"
  BEFORE INSERT ON "statutory_rates"
  FOR EACH ROW EXECUTE FUNCTION app.statutory_rates_insert_guard();
--> statement-breakpoint
-- PAYR-01/02/04/05: a run moves only along the contract's transition table
-- (run.ts runTransitions) and is born a draft. Once locked, its pinned
-- configuration, totals, period, policy and approvals are fixed; the only
-- moves left are locked -> paid and locked -> reversed (approved reversal).
-- While locked, `reversal` may change (request, reject, approve); paid and
-- reversed runs change nothing.
CREATE OR REPLACE FUNCTION app.payroll_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'PAYR-01: payroll run % must be created as a draft', NEW.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'simulated')
    OR (OLD.status = 'simulated' AND NEW.status IN ('hr_approved', 'draft'))
    OR (OLD.status = 'hr_approved' AND NEW.status IN ('approved', 'draft'))
    OR (OLD.status = 'approved' AND NEW.status IN ('locked', 'draft'))
    OR (OLD.status = 'locked' AND NEW.status IN ('paid', 'reversed')))
  THEN
    RAISE EXCEPTION 'PAYR-01: payroll run % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYR-01: payroll run % identity cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('locked', 'paid', 'reversed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('paid', 'reversed') THEN
    RAISE EXCEPTION 'PAYR-02: payroll run % is % and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.legal_entity_id <> OLD.legal_entity_id
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
    OR (NEW.status = 'reversed' AND NEW.paid_at IS DISTINCT FROM OLD.paid_at)
  THEN
    RAISE EXCEPTION 'PAYR-02: locked payroll run % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payroll_runs_guard_trg"
  BEFORE INSERT OR UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_guard();
--> statement-breakpoint
-- PAYR-01/04: payslips are written only by the lock (the run is set to
-- `locked` first, in the same transaction) and a bank file only for a locked
-- or paid run. A payslip of a reversed run is void (PAYR-05); no column marks
-- it. The PDF key and the first PIN view are set once, never repointed.
CREATE OR REPLACE FUNCTION app.payroll_run_child_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
BEGIN
  SELECT r.status INTO run_status FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id;
  IF TG_TABLE_NAME = 'payslips' AND run_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'PAYR-01: payslips need a locked run (run % is %)', NEW.payroll_run_id, run_status
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'bank_transfer_files'
    AND (run_status IS NULL OR run_status NOT IN ('locked', 'paid'))
  THEN
    RAISE EXCEPTION 'PAYR-04: a bank file needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payslips_insert_guard_trg"
  BEFORE INSERT ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_run_child_guard();
--> statement-breakpoint
CREATE TRIGGER "bank_transfer_files_insert_guard_trg"
  BEFORE INSERT ON "bank_transfer_files"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_run_child_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payslips_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key)
    OR (OLD.viewed_at IS NOT NULL AND NEW.viewed_at IS DISTINCT FROM OLD.viewed_at)
  THEN
    RAISE EXCEPTION 'PAYR-04: payslip % PDF key and first view are set once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payslips_update_guard_trg"
  BEFORE UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION app.payslips_update_guard();
--> statement-breakpoint
-- HR-03 + PAYR-02: pay windows of one employee and component never overlap
-- (a component is never paid twice for a day), and a window is closed once:
-- effective_to goes from NULL to a date on or after effective_from, never
-- back. btree_gist exists since 0044.
ALTER TABLE public.employee_pay_components
  ADD CONSTRAINT employee_pay_components_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    component_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_pay_components_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL THEN
    RAISE EXCEPTION 'PAYR-02: pay window % can only be closed once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "employee_pay_components_guard_trg"
  BEFORE UPDATE ON "employee_pay_components"
  FOR EACH ROW EXECUTE FUNCTION app.employee_pay_components_guard();
--> statement-breakpoint
-- Service charge: a pool moves along service-charge.ts poolTransitions and is
-- born a draft. From approval on, what was approved (outlet, period, amount,
-- rule) is fixed; allocations change only while the pool is draft or
-- calculated (a recalculation replaces them).
CREATE OR REPLACE FUNCTION app.service_charge_pools_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Service charge pool % must be created as a draft', NEW.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('calculated', 'cancelled'))
    OR (OLD.status = 'calculated' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'distributed')
    OR (OLD.status = 'distributed' AND NEW.status = 'approved'))
  THEN
    RAISE EXCEPTION 'Service charge pool % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Service charge pool % is cancelled', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR (OLD.status IN ('approved', 'distributed') AND (
      NEW.outlet_id <> OLD.outlet_id
      OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
      OR NEW.amount_idr <> OLD.amount_idr OR NEW.rule IS DISTINCT FROM OLD.rule
      OR (NEW.status <> 'calculated' AND (
        NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))))
  THEN
    RAISE EXCEPTION 'Service charge pool % is approved and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "service_charge_pools_guard_trg"
  BEFORE INSERT OR UPDATE ON "service_charge_pools"
  FOR EACH ROW EXECUTE FUNCTION app.service_charge_pools_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.service_charge_allocations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  row_tenant uuid;
  row_pool uuid;
  pool_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id; row_pool := OLD.pool_id;
  ELSE
    row_tenant := NEW.tenant_id; row_pool := NEW.pool_id;
  END IF;
  SELECT p.status INTO pool_status FROM public.service_charge_pools p
    WHERE p.tenant_id = row_tenant AND p.id = row_pool;
  IF pool_status IS NULL OR pool_status NOT IN ('draft', 'calculated')
    OR (TG_OP = 'UPDATE' AND (NEW.pool_id <> OLD.pool_id OR NEW.tenant_id <> OLD.tenant_id))
  THEN
    RAISE EXCEPTION 'Allocations of pool % change only before approval (pool is %)', row_pool, pool_status
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "service_charge_allocations_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "service_charge_allocations"
  FOR EACH ROW EXECUTE FUNCTION app.service_charge_allocations_guard();

-- ---------------------------------------------------------------------------
-- Appended to migration 0169_payroll_loan_policy (bead legend-fij0l and the
-- receipt unique index of legend-8399r): payroll_loan_policies, one row per
-- tenant. Constraints and the index live in schema/payroll.ts.
SELECT app.enforce_tenant_rls('public.payroll_loan_policies'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_loan_policies FROM legend_app;

-- ---------------------------------------------------------------------------
-- Payroll 549 / G688h: canonical maker-checker write guard. Applied by amended
-- migrations 0300/0301 and forward correction 0304. Do not reintroduce a CHECK:
-- even NOT VALID CHECKs block status-only updates of legacy maker=approver runs.
ALTER TABLE "payroll_runs" DROP CONSTRAINT IF EXISTS "payroll_runs_distinct_approvers_check";--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_runs_approvers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Existing legacy identities may continue through the allowed run lifecycle.
  -- Assigning the same values is not a new approval decision.
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.created_by, NEW.approved_by_hr, NEW.approved_by_finance)
      IS NOT DISTINCT FROM ROW(OLD.created_by, OLD.approved_by_hr, OLD.approved_by_finance)
    THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW.approved_by_hr IS NOT NULL AND NEW.approved_by_hr = NEW.created_by)
    OR (NEW.approved_by_finance IS NOT NULL AND NEW.approved_by_finance = NEW.created_by)
    OR (NEW.approved_by_hr IS NOT NULL AND NEW.approved_by_finance IS NOT NULL
      AND NEW.approved_by_hr = NEW.approved_by_finance)
  THEN
    RAISE EXCEPTION 'PAYR-01: payroll run % creator, HR and finance approvers must be distinct', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'payroll_runs_distinct_approvers_check';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_runs_approvers_guard_trg" ON "payroll_runs";
--> statement-breakpoint
CREATE TRIGGER "payroll_runs_approvers_guard_trg"
  BEFORE INSERT OR UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_approvers_guard();
