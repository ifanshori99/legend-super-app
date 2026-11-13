# Sub-brief: payroll run lock + rapel bank export (legend-b9y4y, legend-yod9z)

Worktree: this repo root (branch from fix/payroll-money 0638b6e5). Tier K (money + tax).
Migrations: only numbers 0478-0479 allowed. `pnpm db:generate` must be empty afterwards.
Founder rule "jangan sampai rugi": no employee paid more, outlet never loses. When in doubt, the rule that limits payment wins; stop and report.

## Card 1 — legend-b9y4y (P1): payroll run lock step
No general create/simulate/lock run service exists yet. Build the run **lock** step:
- In ONE transaction: call `calculatePayrollRunTax` / `lockPayrollRunTax` with `monthScope` (advisory month lock, stale check `PAYROLL_PPH21_MONTH_STALE`) AND `snapshotPayeeBankForLock` for payslips with method bank_transfer and net > 0.
- Run reversal takes the same month advisory lock and is refused while a later run of that month depends on it (`monthPrior`).
- Fit existing approval flow: check `docs/PRD.md` (payroll / WS-10 / PAYR-*), `docs/design/`, `docs/contracts/`, existing `apps/api/src/routes/payroll*.routes.ts` and `apps/api/src/services/payroll*.service.ts`.
- TER increase split rule (R1, pending founder Q5): follow the tax split of the previous payslip. Do not change it.

## Card 2 — legend-yod9z (P2): bank export for rapel-finalized payslips
`payroll-rapel-finalize.service.ts` seals payslip calculation as `payrollGrossEnvelopeSchema`; `payroll-export.service.ts` `sealedCalculation` requires full `payslipCalculationSchema` -> 422 `PAYROLL_PAYSLIP_UNREADABLE`. Make export read the net from the envelope payslip with the same PAYR-04 rule. Bank export total for a rapel run = run total transfer.

## Fail-first tests required (vitest, `apps/api/src/test/`)
1. Run lock writes monthly tax + bank snapshot in one transaction (failure in one -> neither persisted).
2. Two parallel locks of runs in the same month: no double or missing withholding.
3. Reversal refused when a later run of the same month depends on it.
4. Rapel export total == run total transfer; no payee gets more than net.

Run targeted tests: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` from worktree root. Only ONE subagent may hold heavy (tsc/vitest) at a time; engineer assigns it. Branded id types: use project brand helpers, not `as`/string literals.

## Design
Architect output goes to `docs/briefs/sub-payroll-run-lock-design.md`. Implementers follow it.

## Code map (Explore, 14:3x)
- Latest migration: 0472_payslip_bank_snapshots. No run create/approve/lock/reverse service or route exists; nearest lock-like code: `services/payroll-rapel-finalize.service.ts` (only caller of `snapshotPayeeBankForLock`, :432).
- `RUN_STATUSES` db/schema/payroll.ts:137 (draft, simulated, hr_approved, approved, locked, paid, reversed); payrollRuns :412; payslips :523; payslipBankSnapshots :573.
- services/payroll-run-pph21.service.ts: PayrollRunMonthScope :92, monthPriorInvalid :132, advisory lock :160, calculatePayrollRunTax :361, lockPayrollRunTax :388, PAYROLL_PPH21_MONTH_STALE :412. Shared monthPrior: packages/shared/src/hris/payroll/payslip-tax.ts:49.
- services/payroll-bank-snapshot.service.ts:100 snapshotPayeeBankForLock(tx, tenantId, payrollRunId, payees[{payslipId, employeeId}]).
- Envelope: apps/api/src/lib/payroll-gross-envelope.ts:15-57 (gross, deductions, net, overtime, lines, optional payrollRunId/rapelAllocationRevision; no employeeId/paymentMethod -> take from payslip row).
- Export: services/payroll-export.service.ts sealedCalculation :139-163 (422 PAYROLL_PAYSLIP_UNREADABLE), bank rows :344-367, tax export second call :864. PAYR-04 check: packages/shared/src/hris/payroll/payslips.ts:658-680 (PAYROLL_BANK_FILE_MISMATCH).
- Tests: payroll-run-pph21-db.test.ts, payroll-ter-monthly.test.ts:1313 (stale), payroll-bank-snapshot.test.ts:957-1021 ([snapshot-rapel-finalize]), payroll-bank-export.test.ts.

## Round 2: architect review fixes (commit dd19a755)
SCRATCH=/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-1edb31c2/ad5665ed-1399-46dc-9bc5-023087cb7814/scratchpad
Implementers edit ONLY the scratch copies $SCRATCH/payroll-run-lock.service.ts and $SCRATCH/payroll-run-reversal.service.ts (engineer copies them back after the red run). Test-writer edits apps/api/src/test/payroll-run-lock.test.ts.
- F1 HIGH (lock): lastTaxPeriod employees skip month-stale check (pph21.service.ts:370, lock.service.ts:371-393). Two December runs same LE (regular + THR) can both lock blind -> double/missing annual withholding. Fix: before first write, if any lastTaxPeriod employee has a payslip in another locked/paid run of same LE + month -> 409 PAYROLL_PPH21_MONTH_STALE. (Fail closed.)
- F5 LOW (lock): lock.service.ts:384-387 build tax employee as `{ ...entry.taxInput, employeeId: entry.calculation.employeeId }` so calc employeeId wins.
- F2 HIGH (reversal): reversal after bank file exported frees the period -> rerun pays twice. Fix: in request AND approve, if a bank_transfer_files row exists for the run -> 409 PAYROLL_RUN_REVERSAL_BLOCKED (message: bank file already made).
- F3 MED (tests): add fail-first tests for F1 (December lastTaxPeriod two runs), F2 (reversal refused after createBankTransferFile), and guards PAYROLL_RUN_RESULT_STALE (totals mismatch, tax mismatch) + PAYROLL_RUN_LOCK_UNSUPPORTED (loan/reimbursement/service charge > 0).
- F6 LOW: create apps/api/src/db/schema/payroll-run-month-priors.custom.sql mirroring the custom SQL part of drizzle/0478 (follow existing *.custom.sql convention, e.g. 0472's mirror).

## Round 3: second architect review (F2 race)
R3=/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-1edb31c2/ad5665ed-1399-46dc-9bc5-023087cb7814/scratchpad/r3
Implementers edit ONLY the copies in $R3 (engineer applies after red run). 0478 is branch-local/unreleased: amend its custom SQL tail (no new migration, no snapshot change); keep the .custom.sql mirror an exact suffix of 0478.
- G1 HIGH (race): reversal approve can commit while a concurrent bank file export (payroll-export.service.ts:348-356 loadRun, no row lock) inserts a file -> reversed run with bank file -> rerun pays twice. Fix A: in createBankTransferFile, read the run with `.for("share")` before assertExportable (READ COMMITTED then waits for approve commit and sees `reversed`). Fix B (DB backstop): extend `app.payroll_runs_reversal_dependency_guard` to also RAISE (ERRCODE 23514, 'PAYR-05: payroll run % has a bank transfer file') when a bank_transfer_files row exists for NEW.id; and `REVOKE DELETE ON public.bank_transfer_files FROM legend_app` (first grep that no app code/test deletes bank_transfer_files rows legitimately; report if any).
- G2 MED: payroll-run-lock.service.ts:~433 F1 message -> say a second payroll in the employee's last tax period of this month is not supported yet (keep code PAYROLL_PPH21_MONTH_STALE).
- G3 test: payroll-run-lock.test.ts: direct SQL `UPDATE payroll_runs SET status='reversed', reversal=<approved json>` while a bank file exists -> SQLSTATE 23514.
