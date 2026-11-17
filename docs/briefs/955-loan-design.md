# 955 / legend-8tfvr: kasbon deduction writer (design, architect xhigh)

Base: cdec4ae29 (949). Money + migration. Scope: simulate writes `payroll_loan_deductions`,
lock lowers `employee_loans.outstanding_idr`, reversal restores it once, and the lock and simulate steps no
longer refuse runs that carry loans. Reimbursement and service charge stay refused.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The **simulate** step plans the installments and writes the rows (reservation). The **lock** step lowers the balance. **Reversal** restores the balance. | PAYR-01: simulate has no side effect on money. A row is only a reservation until lock. Matches the `loans.ts` header and the 0460 guard. |
| D2 | The guard counts `draft, simulated, hr_approved, approved` as reserved. `locked` and `paid` are already inside `outstanding_idr`. `reversed` has no rows. | Keep the 0460 guard unchanged. Invariant I2 below holds across lock and restore. |
| D3 | Only `runType = 'regular'` deducts loans. THR runs deduct nothing. off_cycle is refused already. | Fail toward deducting less. A loan is never deducted more than its outstanding balance in any case. |
| D4 | One `LOAN` line per loan: category `loan_installment`, kind `deduction`, `taxable=false`, `sourceId = loanId`. It comes after `PPH21_RECEIVABLE`. | 1:1 binding between rows and lines. Same order as `fixtures.ts`. |
| D5 | A gross-engine line with category `loan_installment` (a tenant pay component) is refused with 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`. | Only the writer may produce loan lines. Otherwise `loanRepaymentIdr` has no loan behind it. |
| D6 | New DB backstop (migration 0461): a deferred ledger invariant `principal - outstanding = SUM(deductions of locked/paid runs)` for every disbursed or settled loan. | This makes "lock lowers once, reversal restores once" provable in the DB. Payroll is the only path that lowers `outstanding_idr` (`payroll-loans.service.ts` header; a disbursed loan has no transitions). |
| D7 | No kasbon policy row means bp = 0, so nothing is deducted. | This already exists in the snapshot (`loanMaxDeductionOfNetPayBp ?? 0`). |

## 1. Money invariants (each one has a test, see section 6)

- **I1** per row: `0 < amount <= min(installment_idr, outstanding_idr - reserved_by_other_live_runs, room)`.
- **I2** At all times: the sum of rows of runs in `draft..approved` per loan `<= outstanding_idr`. The 0460 insert guard checks it under the loan `FOR UPDATE` lock. Lock moves a reservation into the balance. Restore only raises the balance.
- **I3** (ledger, 0461) For a disbursed or settled loan: `principal_idr - outstanding_idr = SUM(amount_idr)` over rows whose run is `locked` or `paid`. Checked at commit.
- **I4** per run: rows = the `LOAN` lines of the results at `simulation_no = simulation_count`, compared as the set of (employee, loan, amount). Their sum = `totals.loanRepaymentIdr`. At most one line per loan.
- **I5** Lock lowers each loan exactly once. It runs in the same transaction as the guarded `approved -> locked` UPDATE (`WHERE status='approved'`, 1 row).
- **I6** Reversal restores exactly once. The rows are deleted in the same transaction. A second approval is refused by the reducer and finds no rows. The recorded sum must equal the totals.
- **I7** `net >= 0`. Loan total per slip `<= floor(netBeforeLoans * bp / 10000)`, where `netBeforeLoans = gross - other deductions - receivable collected`.
- **I8** settled iff outstanding = 0 (the existing CHECKs). Lock sets `settled` and `settled_at`. Restore sets `disbursed` and `settled_at = NULL`.

## 2. Lock order (all writers)

Global rule: **never lock a `payroll_runs` row after an `employee_loans` row.** Lock loans in `id` order.

- simulate: month advisory, then rapel/employees/outlets FOR SHARE, then run FOR UPDATE, then priors FOR SHARE (`loadTaxYearPriors`), then receivable reads, then **loans FOR UPDATE (id order)**, then reads, then writes.
- lock: month, then receivable scope, then rapel, then run FOR UPDATE, then priors FOR SHARE, then tax/rapel/edges/`lockedAt`, then **loans FOR UPDATE (id order)**, then status UPDATE, then loan UPDATEs, then the remaining writes.
- reversal approve: unchanged (month, then scope, then run, then checks, then `restoreLoanDeductions`, which locks loans in id order).
- return-to-draft: run FOR UPDATE, then status, then DELETE rows. It locks no loans. A stale reservation read by a concurrent simulate is conservative, because it makes the deduction smaller.
- The 0460 trigger takes the own run FOR SHARE (already held) and the loan FOR UPDATE (already held). No new lock edges.

## 3. Code changes (ordered)

1. **`apps/api/src/db/schema/payroll.ts`**: add `index("payroll_loan_deductions_loan_idx").on(tenantId, loanId)` to `payrollLoanDeductions`. Update its doc comment: the balance is lowered at lock.
2. **Migration `apps/api/drizzle/0461_payroll_loan_ledger.sql`**: run `pnpm db:generate` (index only), then append the custom SQL from section 4. Mirror the custom part in a new **`apps/api/src/db/schema/payroll-loan-ledger.custom.sql`**. Do not edit 0460. Running `db:generate` again must produce nothing.
3. **New `apps/api/src/services/payroll-run-loans.ts`** (keeps the large files flat):
   - `lockLoansForRunSimulation(tx, tenantId, { runId, employeeIds, periodEnd })` returns `Map<employeeId, PlannableLoan[]>`. It runs `SELECT id, employee_id, installment_idr, outstanding_idr, disbursed_at FROM employee_loans WHERE tenant_id=$1 AND employee_id = ANY($2) AND status='disbursed' AND outstanding_idr > 0 AND first_deduction_period <= $periodEnd ORDER BY id FOR UPDATE`. After that it reads the reservation sum: `SELECT d.loan_id, SUM(d.amount_idr) FROM payroll_loan_deductions d JOIN payroll_runs r ON r.tenant_id=d.tenant_id AND r.id=d.payroll_run_id WHERE d.tenant_id=$1 AND d.loan_id = ANY($ids) AND d.payroll_run_id <> $runId AND r.status IN ('draft','simulated','hr_approved','approved') GROUP BY d.loan_id`. It sets `outstandingIdr := outstanding - reserved` and drops a loan when the result is `<= 0`. `disbursedAt` is an ISO string for `planLoanDeductions`.
   - `replaceRunLoanDeductions(tx, tenantId, runId, rows)`: DELETE the run's rows, then INSERT the new ones. Call it after the run UPDATE, while the status is `simulated`.
   - `lockLoansForRunLock(tx, tenantId, run, plan, bp)`: the checks for lock. It throws `resultStale()` (409) on any mismatch:
     a. Collect every `loan_installment` line from the stored calculations. Each needs `componentCode='LOAN'`, `sourceId` not null, and a loan id that is unique in the run.
     b. Read the run's rows. The set of (employee, loan, amount) must equal the lines exactly.
     c. Per slip: `loanTotal <= floor((netIdr + loanTotal) * bp / 10000)`, with bp from `configSnapshot.loanMaxDeductionOfNetPayBp`.
     d. Lock the loans with `FOR UPDATE ORDER BY id`. Each needs a matching employee, `status='disbursed'`, `amount <= outstanding_idr`, and `amount <= installment_idr`.
   - `applyLockLoanDeductions(tx, tenantId, rows, now)`: process the loans in id order. Run the UPDATE below and require 1 returned row, else throw `PayrollError("PAYROLL_RUN_INVALID_TRANSITION")`:
     `UPDATE employee_loans SET outstanding_idr = outstanding_idr - $amt, status = CASE WHEN outstanding_idr = $amt THEN 'settled' ELSE 'disbursed' END, settled_at = CASE WHEN outstanding_idr = $amt THEN $now ELSE NULL END, updated_at=$now WHERE tenant_id=$t AND id=$loan AND status='disbursed' AND outstanding_idr >= $amt RETURNING id`.
4. **`apps/api/src/services/payroll-run-compose.ts`**: add optional inputs `loans?: PlannableLoan[]` and `loanMaxDeductionOfNetPayBp?: BasisPoints` (default none and 0). After the receivable step, call `planLoanDeductions(loans, idr(gross - sum(deductions)), bp)`. Push one `LOAN` line per plan with `deductedIdr > 0`. Extend `systemLine` with a `sourceId` argument, and make `loan_installment` map to kind `deduction`. Replace the "OPEN O2" header with D4.
5. **`apps/api/src/services/payroll-run-simulate.service.ts`**:
   - Move the `payrollLoanPolicies` read before the compose loop.
   - If `!isThr`, call `lockLoansForRunSimulation` after `loadTaxYearPriors` (section 2).
   - Refuse any gross-engine line with category `loan_installment` (D5).
   - Pass the loans and bp to `composePayslipCalculation`.
   - Drop `totals.loanRepaymentIdr > 0` from the refusal. Keep reimbursement and service charge.
   - After the `payrollRunResults` insert, call `replaceRunLoanDeductions` with rows from the `LOAN` lines (employee, `sourceId`, amount).
   - Update the snapshot comment: "Kasbon off" means bp 0.
6. **`apps/api/src/services/payroll-run-lock.service.ts`**:
   - Drop `loanRepaymentIdr` from the `lockUnsupported` condition and update the message text.
   - Call `lockLoansForRunLock` after the `lockedAt` computation and before the status UPDATE.
   - Call `applyLockLoanDeductions` right after the status UPDATE (the rows are now frozen by 0460).
   - Rewrite header step 4.
7. **`apps/api/src/services/payroll-run-reversal.service.ts`**: keep `restoreLoanDeductions` as it is. Update the header comment: the lock now writes loans. No logic change; the I3 trigger is the backstop.
8. **`apps/api/src/services/payroll-run-lifecycle.service.ts`**: no change (return-to-draft already deletes the rows after the status UPDATE).

## 4. SQL for 0461 (custom part)

```sql
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
CREATE CONSTRAINT TRIGGER employee_loans_ledger_trg
  AFTER UPDATE OF outstanding_idr, status ON public.employee_loans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.employee_loans_ledger_check();
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
```

Notes:
- No backfill is needed. Before 8tfvr no code lowered `outstanding_idr`, and no locked run has rows.
- The triggers fire only on UPDATE or DELETE, so seeded INSERTs in other tests are untouched.
- The implementer must confirm that `withTenant` RLS context (`SET LOCAL`) is visible to deferred triggers at commit. Follow the 0219 pattern, which already runs deferred under RLS.

## 5. Risks

- **Deadlock**: this happens if loans are locked before `loadTaxYearPriors` (run FOR SHARE). Keep section 2 exactly.
- **Fixtures**: `payroll-loan-deductions.test.ts` `[reversal-restores]` seeds a locked run with replica rows. The seeded loan must satisfy I3 (`outstanding = principal - recorded`). Otherwise the restore commit fails with 23514. Prefer rewriting it on the real simulate -> lock path.
- An employee in two regular runs of one pay month can pay two installments. This is capped by the outstanding balance, so the outlet takes no loss. Not handled; flag it to the CTO.
- Existing tests that expect lock or simulate to refuse loans (`payroll-run-lock.test.ts`, `payroll-run-simulate.test.ts`, `payroll-run-followup-guards.test.ts`; grep `loanRepaymentIdr` and `LOCK_UNSUPPORTED`) must flip. Reimbursement and service-charge refusals stay.

## 6. Required tests (fail first). New file `apps/api/src/test/payroll-run-loans.test.ts` unless noted

1. `[simulate-writes]` A regular run with a disbursed loan gets one row and one `LOAN` line (`sourceId` = loan). amount = min(installment, outstanding). `totals.loanRepaymentIdr` = the row sum. The balance is unchanged after simulate.
2. `[room-cap]` With low net pay, the deduction is `<= floor(netBeforeLoans * bp / 10000)` and net is `>= 0`. With bp 0 or no policy there is no row and no line.
3. `[cross-run-cap]` Run A simulated holds X. Run B on the same loan deducts `<= outstanding - X`. When the loan is fully reserved, B has no row. B is not refused.
4. `[resimulate-replaces]` Simulating twice leaves exactly one row per loan. Return-to-draft deletes the rows and releases the reservation, so run B can now take it.
5. `[lock-lowers-once]` Lock lowers outstanding by exactly the row amount. A second lock is 409 and the balance is unchanged.
6. `[last-installment-settles]` outstanding < installment, so outstanding is deducted. Lock sets status `settled`, `settled_at` set, outstanding 0.
7. `[lock-stale-rows]` A row tampered via replica (deleted, amount changed, or extra loan) makes lock answer 409 `PAYROLL_RUN_RESULT_STALE`. The run stays `approved` and the balance is unchanged.
8. `[reversal-after-real-lock]` Restore brings the balance back to its pre-lock value. A settled loan returns to `disbursed`. A second decide is 409 and the balance is unchanged. The rows are gone.
9. `[ledger-db]` As `legend_app`, a direct `UPDATE employee_loans SET outstanding_idr = outstanding_idr - 1` fails 23514 at commit. A locked run with reversal pending whose rows are deleted without restore, then set `reversed`, also fails 23514.
10. `[gross-loan-component-refused]` A pay component with category `loan_installment` makes simulate answer 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`.
11. `[thr-no-loan]` A THR run with a disbursed loan has no row.
12. `[ineligible-loans]` A pending or approved loan, a loan whose `first_deduction_period` is after `periodEnd`, and another employee's loan are not deducted.
13. `[concurrent-simulate]` Two runs (different months) simulated in parallel on one loan: the row sum is `<= outstanding` and there is no deadlock (both finish or one gets a clean retryable error).
14. `[gl-unchanged]` (in `payroll-gl-consumer.test.ts`): the locked run's journal credits `employee_receivable` by `loanRepaymentIdr`.

Gate: `LEGEND_TEST_FILES` with the new file plus `payroll-loan-deductions`, `payroll-run-lock`, `payroll-run-simulate`, `payroll-run-followup-guards`, and `payroll-gl-consumer`. Then the AGENTS.md pre-gate (`db:generate` empty).
