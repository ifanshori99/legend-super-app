-- legend-8tfvr: a disbursed or settled loan owes its principal minus what locked or
-- paid payroll runs deducted from it. Payroll is the only path that lowers
-- outstanding_idr; lock lowers it once, an approved reversal restores it once
-- and deletes the rows. Checked at commit (deferred), so the lock and reversal
-- transactions may write the run, the rows and the loan in any order.
CREATE OR REPLACE FUNCTION app.employee_loan_ledger_assert(p_tenant uuid, p_loan uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE l_principal bigint; l_outstanding bigint; l_status text; applied bigint;
BEGIN
  SELECT principal_idr, outstanding_idr, status INTO l_principal, l_outstanding, l_status
    FROM public.employee_loans WHERE tenant_id = p_tenant AND id = p_loan;
  IF l_status IS NULL OR l_status NOT IN ('disbursed', 'settled') THEN RETURN; END IF;
  SELECT COALESCE(SUM(d.amount_idr), 0) INTO applied
    FROM public.payroll_loan_deductions d
    JOIN public.payroll_runs r ON r.tenant_id = d.tenant_id AND r.id = d.payroll_run_id
    WHERE d.tenant_id = p_tenant AND d.loan_id = p_loan AND r.status IN ('locked', 'paid');
  IF l_principal - l_outstanding <> applied THEN
    RAISE EXCEPTION 'PAYR-02: loan % balance does not match its locked payroll deductions', p_loan
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_loans_ledger_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN PERFORM app.employee_loan_ledger_assert(NEW.tenant_id, NEW.id); RETURN NULL; END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_loan_deductions_ledger_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN PERFORM app.employee_loan_ledger_assert(OLD.tenant_id, OLD.loan_id); RETURN NULL; END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_runs_loan_ledger_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT d.loan_id FROM public.payroll_loan_deductions d
      WHERE d.tenant_id = NEW.tenant_id AND d.payroll_run_id = NEW.id ORDER BY d.loan_id LOOP
    PERFORM app.employee_loan_ledger_assert(NEW.tenant_id, rec.loan_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- legend-rtrbj: principal_idr is watched too; once a loan left 'pending' its
-- principal cannot change at all (guard below), and a pending-to-disbursed update
-- that moves principal is still caught by the deferred ledger check.
CREATE CONSTRAINT TRIGGER employee_loans_ledger_trg
  AFTER INSERT OR UPDATE OF outstanding_idr, status, principal_idr ON public.employee_loans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.employee_loans_ledger_check();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_loans_principal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYR-02: loan % principal cannot change after it left pending', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER employee_loans_principal_guard_trg
  BEFORE UPDATE OF principal_idr ON public.employee_loans
  FOR EACH ROW
  WHEN (OLD.principal_idr IS DISTINCT FROM NEW.principal_idr AND OLD.status <> 'pending')
  EXECUTE FUNCTION app.employee_loans_principal_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_loans_status_backward_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYR-03: loan % was paid out and cannot go back to status %', NEW.id, NEW.status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER employee_loans_status_backward_trg
  BEFORE UPDATE OF status ON public.employee_loans
  FOR EACH ROW
  WHEN (OLD.status IN ('disbursed', 'settled') AND NEW.status NOT IN ('disbursed', 'settled'))
  EXECUTE FUNCTION app.employee_loans_status_backward_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_loan_deductions_ledger_trg
  AFTER DELETE ON public.payroll_loan_deductions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.payroll_loan_deductions_ledger_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_runs_loan_ledger_trg
  AFTER UPDATE OF status ON public.payroll_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.status IN ('locked', 'paid')) IS DISTINCT FROM (NEW.status IN ('locked', 'paid')))
  EXECUTE FUNCTION app.payroll_runs_loan_ledger_check();
