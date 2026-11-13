# Lead brief 615: payroll money fixes (branch fix/payroll-money, base cc0c65b6)

Source brief: `/Users/ifanshori99/Projects/legend super app/legend/docs/briefs/615-payroll-money-fixes.md` (CTO decisions; do not re-ask).
Previous work (same branch lineage): bank file + Coretax export, `apps/api/src/services/payroll-export.service.ts`,
brief `docs/briefs/ws10-payroll-bank-coretax.md`. Tier K (money + tax). Never trust client amounts.

## Card A — legend-89cl7: payee bank snapshot at lock
- At run lock (status -> `locked`; payslips are inserted at lock, DB rule "PAYR-01: payslips need a locked run"),
  store a sealed snapshot of the payee bank details per bank_transfer payslip: bank name/code (if the HR data has it),
  account number, account holder name (fall back to employee full name only if HR data has no holder field; say which).
  Encrypt like other payroll/HR PII (`sealPayrollValue` / `openPayrollValue`, `apps/api/src/lib/payroll-sealed.ts`;
  HR PII `openHrisPii`, `apps/api/src/lib/hris-pii.ts`). Never log it.
- Bank export (`payroll-export.service.ts` ~355-420) reads ONLY the snapshot. Run without snapshot (old runs) ->
  422 `PAYROLL_BANK_SNAPSHOT_MISSING` (fail-closed, clear Indonesian message), never current account.
  Any other payment path that reads `employees.bank_account_encrypted` for a locked run: same rule (grep and list).
- Migration (if a column is needed): number it in range **0472** only (rename the drizzle-generated file/tag to
  `0472_<name>` the way other branches did, e.g. `0440_payment_settlements`; keep `_journal.json` + snapshot consistent).
  `db:generate` must be empty afterwards. Card B must NOT touch `apps/api/drizzle/`.

## Card B — legend-ihjan: TER on monthly total
- When several runs of the same legal entity pay one employee in the same tax month (regular + THR / off-cycle):
  PPh 21 of a later run = round(TER(total monthly taxable gross incl. earlier runs) x rate, policy rounding)
  minus PPh 21 already withheld/borne by earlier locked/approved runs in that month. Never negative unless the
  existing refund mechanics already cover it (prefer: floor at 0 and record; say what you chose).
- Serialize: computing/simulating/locking a run takes a transaction-scoped lock (e.g. `pg_advisory_xact_lock` keyed by
  tenant + legal entity + tax month, or `SELECT ... FOR UPDATE` on the earlier runs) so two runs cannot both compute
  against the same prior total. A run computed against a prior total that later changed must be re-simulated before
  lock (check at lock: stale -> 409).
- Last tax period / December (`annual_recalculation`) keeps the existing annual rule unchanged.
- Engine: `packages/shared/.../pph21*` (`computeTerWithholding`, `lookupTerRate`, `rupiahAtRate`) and the API run
  service that builds slips (find it). Payslip tax object already has `taxableGrossIdr`, `pph21Idr`, `terRateBp`.
- After this, Coretax export (`payroll-export.service.ts` TER guard) must accept multi-run months when
  rate = TER(sum gross) and sum pph21 = round(sum gross x rate). Adjust that guard only if needed (coordinate: Card A
  edits the bank part of that file; Card B may edit only the tax part — `buildBpmp*`/TER guard functions).
- Migration range **0473** only if unavoidable; prefer none. Report to lead before generating one.

## Rules
- Tests via `heavy env LEGEND_TEST_FILES="src/test/<f>.test.ts" pnpm test` — ONLY the lead/test-runner runs them.
- Prettier + `pnpm exec eslint <changed files>` clean before reporting. No secrets. No pkill.
- Founder: no employee under-withheld, no outlet double-pays. When unsure, choose the stricter rule and report.

## Fix R1 (review finding, lead decision; founder confirmation pending via CTO)
Defect: `pph21.ts` `addedSplit` (~line 623) splits ALL of `added = taxOf(at).tax - history` by this run's mix.
`added` includes the rate step-up on the month's EARLIER gross: step = round(monthGross x rate(total)) -
round(monthGross x rate(monthGross)). Net-scheme THR (employeeG = 0) after a gross-scheme salary -> the outlet
bears the step-up on the employee's own salary. Rule (outlet-protective, stricter):
- `monthPrior` gains `pph21EmployeeIdr` (earlier slips' employee-funded tax = sum(pph21WithheldIdr - taxAllowanceIdr
  + receivable field)). Service `payroll-run-pph21.service.ts` sums it into `PayrollMonthBasis` (`priorEmployeeTaxIdr`).
  Validate 0 <= employee <= pph21Idr else monthPriorInvalid.
- In `addedSplit(at)` when monthPrior is set (not last period): stepAt = clamp(round(monthGross x rate(monthGross+at)
  x factor, mode) - round(monthGross x rate(monthGross) x factor, mode), 0, added). Employee share of the step =
  priorTax > 0 ? stepAt x priorEmployeeTax / priorTax : stepAt (no earlier tax -> employee). The remaining
  `added - stepAt` keeps the existing split (proportional: x employeeG/at; gross_first: employeeAloneAdded minus
  its own step at employeeG, floor 0). employeePart capped at `added`. No monthPrior: behaviour byte-identical.
- Update the doc comments. Keep the fixed-point loop monotone (do not break convergence).
