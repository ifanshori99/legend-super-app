-- legend-rtrbj: the loan ledger trigger from 0461 did not watch principal_idr, so a
-- direct UPDATE of principal on a disbursed loan with locked deductions could
-- skip the balance check. (B) refuses a principal change once the loan has left
-- 'pending'; (A) also re-checks the ledger at commit whenever principal_idr is
-- written, so a pending-to-disbursed update that moves principal is still caught.
CREATE OR REPLACE FUNCTION app.employee_loans_principal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYR-02: loan % principal cannot change after it left pending', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS employee_loans_principal_guard_trg ON public.employee_loans;
--> statement-breakpoint
CREATE TRIGGER employee_loans_principal_guard_trg
  BEFORE UPDATE OF principal_idr ON public.employee_loans
  FOR EACH ROW
  WHEN (OLD.principal_idr IS DISTINCT FROM NEW.principal_idr AND OLD.status <> 'pending')
  EXECUTE FUNCTION app.employee_loans_principal_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS employee_loans_ledger_trg ON public.employee_loans;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employee_loans_ledger_trg
  AFTER INSERT OR UPDATE OF outstanding_idr, status, principal_idr ON public.employee_loans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.employee_loans_ledger_check();
