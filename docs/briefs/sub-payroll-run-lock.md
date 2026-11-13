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
