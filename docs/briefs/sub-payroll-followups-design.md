# Design: payroll followups (legend-c2yca, legend-q5dx4, legend-ele0u)

Architect output for `docs/briefs/sub-payroll-followups.md`. Tier K (money, tax, migration). Base: ws/payroll-run-lock 06f20291. Items marked **OPEN** need a decision. They must not block the fail-first tests. Use the defaults given here.

## 0. Decisions
1. **Simulation is computed on the server and stored.** New table `payroll_run_results` (0486) holds one sealed result per employee. `lockPayrollRunInTransaction` takes `{ payrollRunId }` only and reads the stored rows. Caller calculations disappear from the type. The routes use strict bodies (`{ idempotencyKey }`), so extra fields get a 400.
2. **December with two runs** uses a cumulative annual recalculation. The later run folds the earlier annual slips of the same month into the engine `prior`. Total PPh 21 for the year = annual tax on all income, to the rupiah. The block "second run in last tax period refused" is removed.
3. **Rapel runs lock through the general lock.** The lock writes full `PayslipCalculation` slips (tax included) plus a `payroll_rapel_finalizations` receipt in the same transaction. Month basis, Coretax and bank export already read full slips. The rapel finalize step takes the month lock first.
4. **Global lock order** (simulate, lock, finalize): month advisory lock, then rapel component advisory locks, then employees and outlets `FOR SHARE`, then run `FOR UPDATE`, then prior runs `FOR SHARE`, then reads, then writes.
5. R1 (TER increase in a THR month) is unchanged: the `monthPrior` path in `pph21.ts` is not touched. QRIS, settlement and cash/bank are not touched.

## 1. Migrations (Slice A owns both)
**0486_payroll_run_results** (Drizzle table in `apps/api/src/db/schema/payroll.ts`, next to `payslips`):
- Columns:
  - `tenant_id uuid NN` (`tenantIdColumn`)
  - `payroll_run_id uuid NN` ($type PayrollRunId)
  - `employee_id uuid NN` ($type EmployeeId)
  - `payslip_id uuid NN` ($type PayslipId): the id the lock will insert. For a rapel employee it is `reserved_payslip_id`.
  - `simulation_no integer NN`, check `>= 1`
  - `payment_method varchar(20) NN`, check in (`bank_transfer`, `cash`)
  - `result_encrypted bytea NN`
  - `pii_key_version smallint NN`, check `>= 1`
  - `created_at timestamptz NN DEFAULT now()`
- Keys:
  - PK `payroll_run_results_pkey (tenant_id, payroll_run_id, employee_id)`
  - unique `payroll_run_results_payslip_key (tenant_id, payslip_id)`
  - FK `payroll_run_results_run_fk` -> `payroll_runs (tenant_id, id)`
  - FK `payroll_run_results_employee_fk` -> `employees (tenant_id, id)`
- Custom SQL in a new file `payroll-run-results.custom.sql`, 0478 style, `SET search_path = pg_catalog`, ERRCODE 23514:
  - `SELECT app.enforce_tenant_rls('public.payroll_run_results'::regclass);` and `REVOKE TRUNCATE ... FROM legend_app`.
  - Trigger `payroll_run_results_guard_trg` BEFORE INSERT OR UPDATE OR DELETE:
    - INSERT and DELETE need the run status in (`draft`, `simulated`). INSERT also needs `NEW.simulation_no = run.simulation_count`.
    - UPDATE may change only `result_encrypted` and `pii_key_version` (for a later reseal).
    - Anything else raises `'PAYR-02: payroll run % results are frozen after approval'`.

**0487_payroll_followup_guards** is custom SQL only. Use `pnpm db:generate --custom --name payroll_followup_guards`. **OPEN**: confirm the flag; otherwise write an empty migration plus a snapshot copy.
- `CREATE OR REPLACE app.payroll_rapel_payslip_insert_guard()`. A v1 ciphertext (`get_byte(...,0) = 1`) for an allocated employee skips only the v2 header check. Every other check stays: the same-transaction receipt with matching sha256, key version and revision count; the reserved id; eligibility; the legal entity. The v2 path is unchanged.
- `CREATE OR REPLACE app.payroll_run_month_priors_guard()`. The prior run can now be in the same legal entity, same tax year, with a pay month <= the later run's pay month. Before, it had to be the same month. This creates the year edges for December.
- Mirror both new function bodies into `payroll-rapel.custom.sql` and `payroll-run-month-priors.custom.sql`.
- Procedure (same as 0478):
  1. Rename the generated files to idx 486/487. Set `prevId` chain 0478, 0486, 0487.
  2. Run `node scripts/migration-renumber.mjs check --from-idx 478`.
  3. Run `pnpm db:migrate`.
  4. Run `pnpm db:generate`. It must print no changes.

## 2. Card 1: simulate service and stored lock (Slice A)
Sealed result (strict zod schema `storedRunResultSchema` in the simulate service). Seal binding is `{ tenantId, table: "payroll_run_results", rowId: payslipId, field: "result" }`. Extend the `PayrollSealBinding` union if it is typed.
`{ calculation: PayslipCalculation, taxInput: Omit<PayrollRunTaxEmployee,"employeeId"|"priorPeriods"|"lastPeriodEarlier">, monthBasis: PayrollMonthBasis|null, priorPayslipIds: string[] /*sorted*/, rapelAllocationRevision: number|null }`

`payroll-run-simulate.service.ts`:
`simulatePayrollRunInTransaction(tx: Tx, context: ScopedTenantContext, actorUserId: string, payrollRunId: PayrollRunId, now = new Date()): Promise<PayrollRun>`
1. Check `assertPayrollTenantCan(..., "payroll.run")`.
2. Take the locks in the §0.4 order. Use `lockPayrollRunMonth`, then `lockRapelInputsForRun` (Slice C), then run `FOR UPDATE`. Then apply reducer `simulate` (from `draft` or `simulated`).
3. Population:
   - Employees where `COALESCE(e.legal_entity_id, outlet.legal_entity_id) = run.LE`, `employment_type ∈ policy.employeeGroup.employmentTypes`, and employment overlaps the period. **OPEN** O7: confirm this rule.
   - `thr` runs: the same, plus THR eligibility from `calculatePayrollRunStatutory(thrAsOfDate)`.
   - `off_cycle` runs: 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`. No population: 422 `PAYROLL_RUN_EMPTY`.
4. Per employee:
   - Gross: `computeEmployeeGrossInTransaction(preview, payrollRunId=run.id, payslipId)`. This includes RAPEL lines.
   - BPJS: `calculatePayrollRunStatutory` with `payableWageIdr = gross.netIdr`.
   - Tax facts from the database:
     - `ptkpStatus`: null gives 422 `PAYROLL_SIMULATION_INPUT_MISSING`.
     - `hasTaxId` = `npwp_hmac` or `nik_hmac` is not null.
     - `monthsWorked`: formula in `fixtures.ts monthsWorkedIn`.
     - `lastTaxPeriod` = pay month 12, or `end_date` month <= pay month.
     - `partialYearTaxSubject = false` (**OPEN** O8).
   - Priors: `loadTaxYearPriors` (Slice B).
5. PPh 21: `calculatePayrollRunTax` for all employees in one call (month basis included). Then the pure `composePayslipCalculation` (new `payroll-run-compose.ts`). It mirrors `fixtures.ts calculate` for line order and categories: TAX_ALLOWANCE, PPH21_REFUND, then BPJS_EMP, PPH21, then the gross deductions.
   - Payment method: `bank_transfer` if `bank_account_hmac` is set, else `cash` (**OPEN** O1).
   - Totals for loans, reimbursements or service charge > 0 give 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`.
6. Writes:
   - UPDATE the run: status, `simulation_count+1`, `last_simulated_at`, `totals = sumPayrollRunTotals`, `config_snapshot`. Build `config_snapshot` from `captureStatutoryForLock`, the policy, components and the PPh 21 ref in force.
   - DELETE the old results, then INSERT the new ones.
   - Audit `payroll.run.simulated`, with counts only. No outbox event (PAYR-01).

`payroll-run-lock.service.ts` (rewrite):
- New input type: `PayrollRunLockInput = { payrollRunId: PayrollRunId }`. Result type unchanged.
- Steps:
  1. Permission check.
  2. Locks in the §0.4 order.
  3. Reducer `lock`.
  4. Refuse loans, reimbursements or service charge (unchanged). **Rapel is no longer refused.**
  5. Load results where `simulation_no = run.simulation_count`. If a row is unreadable: 422 `PAYROLL_RUN_RESULT_UNREADABLE`. If the count ≠ `totals.employeeCount`, or the sum ≠ `totals`: 409 `PAYROLL_RUN_RESULT_STALE`.
  6. `loadTaxYearPriors` again. If the payslip ids differ from `priorPayslipIds`: 409 `PAYROLL_PPH21_MONTH_STALE`.
  7. Call `lockPayrollRunTax` with the pinned tables, stored `taxInput` plus the fresh priors, and `approvedMonthBasis` from the stored rows.
  8. Each computed tax must deep-equal `calculation.tax`, else STALE.
  9. Rapel check (Slice C helpers).
  10. Edges = same-month priors (all employees) ∪ `runIds` from year priors (last-tax-period employees only).
  11. Writes in this order: status `locked`, receipts (rapel), payslips (`id = payslip_id`, v1 seal of `calculation`), edges, bank snapshot, event, audit.
- Delete the lastTaxPeriod refusal block (lines ~414-436).

Routes: new `apps/api/src/routes/payroll-runs.routes.ts` (`payrollRunsRouter`), registered in `routes/index.ts` as `apiRouter.use("/hris/payroll/runs", payrollRunsRouter)` before `/hris`.
- Put the guards on each route, not `router.use`, so bank-file paths fall through untouched.
- `POST /:payrollRunId/simulate`: `requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission("payroll.run"), jsonBody`. Body `simulatePayrollRun.body`. Wrapped in `withTenant` and `idempotentHrisWrite("payroll.run.simulate")`.
- `POST /:payrollRunId/lock`: the same guards with `"payroll.lock"` and `lockPayrollRun.body`. Idempotency key `"payroll.run.lock"`. Responds with the run DTO.

## 3. Card 2: December across runs (Slice B)
Shared, in `packages/shared/src/hris/payroll/payslip-tax.ts`:
`buildPph21PriorWithLastPeriod(periods: readonly Pph21PriorPeriod[], lastPeriodEarlier: readonly Pph21PriorPeriod[]): Pph21Prior`
- Start from `buildPph21Prior(periods)`, which takes TER slips only (unchanged).
- Fold each earlier annual slip `s` of the **same** last tax period:
  - gross += `X`
  - deductible += `s.employeeDeductibleIdr`
  - grossScheme / employerScheme += the stored bases
  - receivable += `s.pph21ReceivableIdr`
  - withheld += `W - refund - empAllowRefund`
  - allowance += `allow - empAllowRefund`
  - borne += `borne - (empRefund - empAllowRefund)`
- Per slip, throw `RangeError` if:
  - `s.method ≠ annual_recalculation`;
  - the identity `pph21Idr = W + borne + recv - refund - empRefund` fails. `pph21Idr` is signed (a lebih potong refund can make it negative), so it is read as a signed safe integer. The other amounts stay non-negative whole rupiah.
- The cumulative sign checks run once, after the loop, so the result does not depend on the slip order: throw `RangeError` if withheld, allowance or borne < 0, or allowance > withheld.
- Proof: `priorTax' = taxJanNov + A.pph21Idr = annual(Jan–Dec A)`. So `B = annual(all) - annual(A-year)`, and the year sum is `annual(all)` exactly. The rounding is done once on the total.

`payroll-run-pph21.service.ts`:
- `PayrollRunTaxEmployee` gains `lastPeriodEarlier: readonly Pph21PriorPeriod[]` (required). `taxOfPayslips` uses the new fold.
- `loadTaxYearPriors(tx, tenantId, runId: PayrollRunId, employees: readonly { employeeId: string; joinDate: BusinessDate; lastTaxPeriod: boolean }[]): Promise<Map<string, { periods: Pph21PriorPeriod[]; lastPeriodEarlier: Pph21PriorPeriod[]; payslipIds: string[]; runIds: PayrollRunId[] }>>`
  - The legal entity and pay date come from the stored run (`loadStoredRun`), not from the caller. The caller holds the month lock.
  - Lock the runs of the same legal entity and tax year (locked/paid, `≠ run`) `FOR SHARE`, ordered by id. This includes later months.
  - Out-of-order guard: if a locked/paid run of a LATER month of the same year holds an `annual_recalculation` slip of any of the employees, throw 409 `PAYROLL_PPH21_LATER_PERIOD_LOCKED` (fail closed). An unreadable later slip is 422 `PAYROLL_PPH21_MONTH_PRIOR_INVALID`.
  - Take slips of the same legal entity with `payDate ∈ [Y-01-01, nextMonthStart)`, `≠ run`, and `payDate ≥ month start of joinDate` (current period of service).
  - Sort them: `ter` goes to `periods`. `annual_recalculation` in the same month goes to `lastPeriodEarlier`. Annual in an earlier month: 422 `PAYROLL_PPH21_MONTH_PRIOR_INVALID` only when the employee has `lastTaxPeriod = true`; for other employees the slip is skipped. Unreadable: 422 `PAYROLL_PPH21_MONTH_PRIOR_INVALID`.
  - `employeeDeductibleIdr` = employee JHT + JP from `calc.bpjs`.
- Concurrent December runs: the month lock serializes them, and the loser gets 409 STALE (prior ids changed). Re-simulate, then lock.

## 4. Card 3: rapel lock path (Slice C)
New `apps/api/src/services/payroll-run-rapel-lock.ts`:
- `lockRapelInputsForRun(tx, context, runId: PayrollRunId): Promise<void>`: component advisory locks (key format as in finalize), then employees and outlets `FOR SHARE`, sorted. Call it before the run row lock.
- `loadRunRapelAllocations(tx, context, runId): Promise<Map<string /*employeeId*/, { reservedPayslipId: PayslipId; revision: number; lines: { sourceId: string; amountIdr: Idr }[] }>>`. It uses the `toDto` total, exported from `payroll-rapel.service.ts`.
- `assertRapelResultMatches(allocation, result): void`. These must all match, else 409 `PAYROLL_RUN_RESULT_STALE`:
  - `result.payslipId = reservedPayslipId`;
  - `revision = rapelAllocationRevision`;
  - the multiset of RAPEL lines `(sourceId, amountIdr)` = the allocations.
  - An employee with no allocation must have no RAPEL line.
- `insertRapelReceipt(tx, tenantId, { payslipId, employeeId, runId, revision, sealed: Buffer, keyVersion, actorId, now }): Promise<void>`: `calculationSha256 = sha256(sealed)`.

`payroll-rapel-finalize.service.ts`: take `lockPayrollRunMonth` first, before the component locks. A run locked by the general lock replays to 409 (fail closed).

## 5. Error codes
New:
- 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`
- 422 `PAYROLL_RUN_EMPTY`
- 422 `PAYROLL_SIMULATION_INPUT_MISSING` (employee ids only)
- 422 `PAYROLL_RUN_RESULT_UNREADABLE`
- 409 `PAYROLL_PPH21_LATER_PERIOD_LOCKED`

Reused: `PAYROLL_RUN_RESULT_STALE`, `PAYROLL_PPH21_MONTH_STALE`, `PAYROLL_PPH21_MONTH_PRIOR_INVALID`, `PAYROLL_RUN_LOCK_UNSUPPORTED` (now loans, reimbursements and service charge only), `PAYROLL_RUN_REVERSAL_BLOCKED`, `PAYROLL_SNAPSHOT_MISMATCH`.

## 6. Slices (no file overlaps)
- **A (card 1, engineer Opus):**
  - `db/schema/payroll.ts`
  - `db/schema/payroll-run-results.custom.sql` (new)
  - `db/schema/payroll-rapel.custom.sql`
  - `db/schema/payroll-run-month-priors.custom.sql`
  - `drizzle/0486*`, `drizzle/0487*`, `meta/0486_snapshot.json`, `meta/0487_snapshot.json`, `meta/_journal.json`
  - `lib/payroll-sealed.ts` (binding union only)
  - `services/payroll-run-simulate.service.ts` (new)
  - `services/payroll-run-compose.ts` (new)
  - `services/payroll-run-lock.service.ts`
  - `routes/payroll-runs.routes.ts` (new), `routes/index.ts`
- **B (card 2):**
  - `packages/shared/src/hris/payroll/payslip-tax.ts` (plus `index.ts` export if needed)
  - `services/payroll-run-pph21.service.ts`
- **C (card 3):**
  - `services/payroll-run-rapel-lock.ts` (new)
  - `services/payroll-rapel.service.ts` (export the total helper)
  - `services/payroll-rapel-finalize.service.ts`
- B and C code against the signatures above, in parallel. A integrates last.

## 7. Fail-first tests (test-writer writes these before the code; one test runner at a time)
- `apps/api/src/test/payroll-run-simulate.test.ts` (new):
  - (1) `[simulate-stores]`: rows = employees, `totals = Σ results`, no payslips, no outbox.
  - (2) `[results-frozen]`: after approval, INSERT, DELETE or a value UPDATE gives 23514.
  - (3) `[lock-reads-stored]`: the sealed slip deep-equals the stored calculation. A lock route body carrying `employees` with other numbers gives 400, and the run stays `approved`.
  - (4) A deleted result row then lock gives 409 `PAYROLL_RUN_RESULT_STALE`, with nothing written.
  - (5) Route guards return 401, 403 (origin) and 403 (permission).
- `payroll-run-lock.test.ts`: move `[lock-atomic]`, `[lock-parallel-month]` and `[reversal-blocked]` to simulate-then-lock. Grep other tests for the old `employees:` lock input.
- `payroll-pph21-december-runs.test.ts` (new):
  - (6) Pure fold: the identity holds; a fold with a lebih potong refund stays >= 0; an earlier-month annual slip is refused.
  - (7) Jan–Nov locked TER runs, December regular A, then THR B. B locks (409 today). `Σ pph21Idr` for the year = `annualTaxIdr` from one engine call with A + B earnings merged. Run this for the gross, gross_up and net schemes.
  - (8) Concurrent lock of A and B: one passes, the other gets 409 STALE. Re-simulate, lock, and check the invariant.
  - (9) Reversing November after B locks gives 409 `PAYROLL_RUN_REVERSAL_BLOCKED` (year edge).
- `payroll-run-lock-rapel.test.ts` (new; reuse `seedRapelTarget`):
  - (10) Simulate, approve, lock: the run is `locked`, slips are full calculations with RAPEL lines and PPh 21, and receipts exist. The bank file `totalIdr == totals.bankTransferIdr`.
  - (11) Allocations changed after simulation give 409 STALE, with nothing written.
  - (12) A THR run in the same month simulates (no 422) and the Coretax export works.
  - (13) Finalize on a run locked by the general lock gives 409.
  - (14) A v1 slip with no receipt in the same transaction gives 23514.
- Regression: `payroll-ter-monthly` (R1), `payroll-run-pph21-db`, `payroll-rapel`, `payroll-export-rapel`, `payroll-bank-export`, `payroll-bank-snapshot`, `payroll-coretax-export`, `payroll-key-rotation`.

## 8. OPEN and follow-up beads
- O1: payment method source (bank account present → transfer).
- O2: collecting an open PPh 21 receivable is not in the composer.
- O3: the reseal job (`worker/hris-pii-reseal.job.ts`) does not yet cover `payroll_run_results`.
- O4: reversal of a rapel run is still refused.
- O5: legacy envelope slips still give 422 in month basis and Coretax (no production data).
- O6: routes for create, approve and return-to-draft are absent; tests use SQL.
- O7: population rule. O8: partial-year subject.
