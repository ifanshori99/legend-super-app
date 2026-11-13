# Sub-brief: payroll followups (ws/payroll-followups, base origin/ws/payroll-run-lock 06f20291)

Tier K (money + tax + migration). Worktree root: `/Users/ifanshori99/Projects/legend super app/legend-918b71d5`. Context: `docs/PROGRESS.md` sections "WS-10 payroll bank file", "Brief 615 payroll money fixes", "ws/payroll-run-lock" (grep `## 13 Nov 2026 — ws/payroll-run-lock`).

## Cards
1. `legend-c2yca` (P1): payroll simulate service persists per-employee results (+ month basis); `lockPayrollRunInTransaction` (apps/api/src/services/payroll-run-lock.service.ts) reads stored results, NOT caller-supplied calculations/taxInput. Caller numbers that differ are rejected/ignored. Add lock route (+ simulate route) if absent, with proper guards (requireAuth, requireTrustedOrigin, requireTenantPermission payroll.lock / suitable perm, jsonBody).
2. `legend-q5dx4` (P1): December annual PPh 21 across two runs in the same month (regular salary + THR/bonus December). Today second run in employee's last tax period is refused (PAYROLL_PPH21_MONTH_STALE). After this card: second run computes annual recalculation over all December runs in the month lock; sum of PPh 21 for the year = annual calculation (no over/under withholding).
3. `legend-ele0u` (P2): runs with rapel cannot be locked (lock refuses PAYROLL_RUN_LOCK_UNSUPPORTED; rapel finalize ~payroll-rapel-finalize.service.ts:310 needs locked run). Break the cycle without bypassing tax checks. Also: month basis + Coretax export cannot read rapel envelopes (422); rapel finalize does not take month advisory lock. Loans/reimbursements/service charge refusal stays unless trivially in scope.

## Rules
- R1 (temporary): TER increase in THR month is borne following the previous slip. Do not change.
- Do not touch QRIS, settlement, cash/bank (kas bank).
- Migrations only in range 0486-0487. `pnpm db:generate` must be empty after.
- Money (founder): fail-first tests: lock uses stored simulation (different caller numbers rejected/ignored); total PPh 21 for the year with two December runs = annual calc; rapel run lockable and export = transfer total. No employee overpaid, outlet never loses. When unsure: rule that limits payment, report to engineer.
- Branded id types (TenantId, OutletId...): use typed constructors, not `as`/string literal.
- Targeted tests from worktree ROOT: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`. Only ONE subagent runs tests/tsc at a time (heavy token). Implementers do NOT run tests unless told.
- No `pkill`, no merge, no deploy, no push.

## Design
Architect writes design to `docs/briefs/sub-payroll-followups-design.md`. Implementers/test-writer follow it.

## Map card 1 (Explore)
- payroll-run-lock.service.ts:93-105 types `PayrollRunLockEmployee {calculation, taxInput, approvedMonthBasis}`; :260 `lockPayrollRunInTransaction(tx, context, actorUserId, input, now)`; only caller test payroll-run-lock.test.ts:658.
- No simulate service/route exists. e2e-az/az-k-payroll-leave.test.ts:634,764 references simulate (PENDING-BRANCH).
- Schema apps/api/src/db/schema/payroll.ts: payrollRuns :413 (lastSimulatedAt :429), payslips :524, payrollRunMonthPriors :624, status enum `simulated` :140. Custom SQL: payroll.custom.sql, payroll-run-month-priors.custom.sql.
- No hris payroll run routes file; mounts routes/index.ts:366-381; guard pattern payroll-export.routes.ts:51,89.

## Map card 2 (Explore)
- Engine packages/shared/src/hris/payroll/pph21.ts: :384 computePph21Period; :141 monthPrior type; :395-412 monthPrior + lastTaxPeriod throws RangeError; :526-632 annual/December branch (lastTaxPeriod, priorMix, history). payslip-tax.ts:49,102 pass monthPrior.
- payroll-run-pph21.service.ts:150-260 loadMonthBasis (TER payslips only; non-TER throws monthPriorInvalid :247); :394 builds monthPrior; :441-475 lockPayrollRunTax stale compare.
- payroll-run-lock.service.ts:413-436 refusal (lastPeriodIds, loadMonthPriorRunIds -> 409 PAYROLL_PPH21_MONTH_STALE); :438-493 inserts payroll_run_month_priors; :116,564 monthPriorRunIds.
- Schema payroll.ts:625-660; drizzle/0478 insert guard trigger :22-57; reversal reads priors (payroll-run-reversal.service.ts:11).
- Coretax payroll-export.service.ts:950-975 non-TER slips excluded (annualRecalculation); :769 PAYROLL_TAX_EXPORT_TER_MISMATCH.
- Tests: payroll-run-lock.test.ts:1131-1168 [lock-december-two-runs] asserts refusal (flip); payroll-ter-monthly.test.ts:930,992,1313; payroll-pph21-annual/dec-gross-first/guards; payroll-coretax-export.test.ts:935-1003; fixtures test/fixtures/payroll/statutory-tables.ts.

## Map card 3 (Explore), paths under apps/api/src/
- payroll-run-lock.service.ts:131 error def; ~:331-346 rapel refusal (payroll_rapels allocated or payroll_rapel_finalizations row).
- payroll-run-reversal.service.ts:113-146 same guard (called :377).
- payroll-rapel-finalize.service.ts:310 requires regular+locked (cycle); :220 finalizePayrollRapelRunInTransaction, FOR UPDATE :277-305, no month advisory lock. Reuse lockPayrollRunMonth (payroll-run-pph21.service.ts:292).
- payroll-rapel.service.ts:942 allocatePayrollRapel; :1079 loadAllocatedRapelLines.
- Month basis: payroll-run-pph21.service.ts:319 loadMonthPriorRunIds; :130-136 422 PAYROLL_PPH21_MONTH_PRIOR_INVALID. Coretax payroll-export.service.ts:833 start, :960 sealedCalculation, :974 422 PAYROLL_PAYSLIP_UNREADABLE.
- Bank export payroll-export.service.ts:183-255 accepts rapel envelope with finalization receipt; mix refused :459; createBankTransferFile :395.
- Tests: payroll-run-lock.test.ts:1376 [lock-unsupported]; payroll-export-rapel.test.ts:753-809; payroll-rapel.test.ts:46. Prior design docs/briefs/sub-payroll-run-lock-design.md:109; runbook docs/runbooks/payroll-rapel.md.

## Assignments (engineer, after design)
Design = `docs/briefs/sub-payroll-followups-design.md` (binding). Own only your slice files (design §6). Do not run tests/tsc unless your section says so. Report: files changed, signatures, deviations, OPEN items.
- T (test-writer): write tests §7 (1)-(14) + rewrite payroll-run-lock.test.ts callers to simulate-then-lock. Fail-first: run once `LEGEND_TEST_FILES="src/test/payroll-run-simulate.test.ts src/test/payroll-pph21-december-runs.test.ts src/test/payroll-run-lock-rapel.test.ts" heavy pnpm test` from ROOT right after writing; record which fail and the cause (missing module/function or 409 today = correct cause; migration error = note it). You hold the heavy token now.
- A (Opus): slice A. Write services + routes first, migrations 0486/0487 LAST. Use B/C signatures from design (they are being written in parallel). After migrations: `pnpm db:generate` must print no changes; run `node scripts/migration-renumber.mjs check --from-idx 478`. No tests, no tsc.
- B: slice B (card 2). Pure fold + loadTaxYearPriors + lastPeriodEarlier. Do not touch pph21.ts monthPrior path (R1).
- C: slice C (card 3). payroll-run-rapel-lock.ts helpers + finalize month lock first + export total helper.

## Round 2 (engineer decisions)
Slice A was too big, so it is split into 3 parts with fixed names:
- Table export `payrollRunResults` in `db/schema/payroll.ts`. Its columns are in design §1 (camelCase: tenantId, payrollRunId, employeeId, payslipId, simulationNo, paymentMethod, resultEncrypted, piiKeyVersion, createdAt).
- `payroll-run-simulate.service.ts` exports `storedRunResultSchema`, `type StoredRunResult`, `sealRunResult(...)`/`openRunResult(...)` helpers and `simulatePayrollRunInTransaction`.
- A1 (the original A agent): schema, 0486/0487 migrations, custom SQL, `lib/payroll-sealed.ts` binding. Nothing else.
- A2 (Opus): `payroll-run-compose.ts` (pure) and `payroll-run-simulate.service.ts`.
- A3 (Opus): `payroll-run-lock.service.ts` rewrite, `routes/payroll-runs.routes.ts`, `routes/index.ts`, shared validators for simulate/lock bodies (`packages/shared/src/validators/` file of your choice, strict `{ idempotencyKey }`).

B round 2 fixes (reviewer findings):
1. `pph21Idr` may be negative (lebih potong refund): read it as a signed safe integer for the identity check, and keep `wholeRupiah` for the others.
2. Run the cumulative sign checks once, after the loop, not per slip, so the result does not depend on order.
3. An earlier-month annual slip throws only for employees in their last tax period. `loadTaxYearPriors` takes `lastTaxPeriod` per employee, or returns a flag the caller checks.
4. Out-of-order lock: if the same LE and tax year already has a locked/paid run whose pay month is later than this run's month and holds an annual_recalculation slip for the employee, throw 409 `PAYROLL_PPH21_LATER_PERIOD_LOCKED`. Fail closed.
5. `loadTaxYearPriors(tx, tenantId, runId, employees)` reads the LE and payDate from `payroll_runs` itself, not from the caller.
6. Add `lastPeriodEarlier: []` to the fixtures in `payroll-ter-monthly.test.ts`, `payroll-run-pph21-db.test.ts` and `apps/api/src/test/fixtures/payroll/*` where needed. Do NOT touch `payroll-run-lock.test.ts` (test-writer owns it).
Update design §3 signature in the design file to match.

## Tests round 2 (split; WRITE ONLY, do not run; engineer runs fail-first in a base worktree)
Budget: read at most ~10 files (Grep first; reuse seed helpers from payroll-run-lock.test.ts, payroll-rapel.test.ts, payroll-ter-monthly.test.ts), then WRITE the file early and refine. Import new modules by design names (they may not exist yet: that is the fail-first cause).
- T1: `apps/api/src/test/payroll-run-simulate.test.ts` cases (1)-(5) + rewrite `payroll-run-lock.test.ts` callers to simulate-then-lock (input `{ payrollRunId }`); flip `[lock-december-two-runs]` to expect success.
- T2: `apps/api/src/test/payroll-pph21-december-runs.test.ts` cases (6)-(9). Also test: refund slip (negative pph21Idr) in fold OK; out-of-order lock (Nov run after Dec annual locked) -> 409 PAYROLL_PPH21_LATER_PERIOD_LOCKED.
- T3: `apps/api/src/test/payroll-run-lock-rapel.test.ts` cases (10)-(14).

## C round 2 fixes (reviewer)
1. New export `assertAllAllocationsCovered(allocations: Map<employeeId,...>, resultEmployeeIds: ReadonlySet<string>)`. If an allocated employee has no stored result, throw 409 `PAYROLL_RUN_RESULT_STALE` (prevents a rapel left unpaid).
2. `lockRapelInputsForRun(tx, context, run: { runId, legalEntityId, payDate })` takes the values from `lockPayrollRunMonth`. Add `assertRunUnchanged(runRow, expected)`: after the run `FOR UPDATE`, if legalEntityId or payDate differ, throw `runMismatch` (409).
3. Take component advisory locks only for employees with rapels allocated to this run, not the whole LE. Do it in a single SQL statement (`SELECT pg_advisory_xact_lock(...) FROM (... ORDER BY employee_id, component_id)`), not one query per pair.
4. JSDoc on `insertRapelReceipt`: call it after run status = locked and before the payslip insert, in the same tx.

## A3 notes (from C review)
- Call `assertAllAllocationsCovered` and `assertRunUnchanged`. Order: status locked → receipt → payslip.
- A rapel slip seal must carry `payrollRunId` and `rapelAllocationRevision` (v2 header, lib/payroll-sealed.ts:96-103); otherwise the DB trigger rejects it.
## A2 notes
- Simulate: if an employee with a rapel allocated to this run is outside the population, throw 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED` (fail closed).

## Engineer decision: rapel slip seal
Design §1 wins. A rapel slip from the general lock is a v1 seal of the full `PayslipCalculation`. 0487 relaxes the guard (v1 skips the v2 header check only; same-tx receipt sha256, reserved id, eligibility and LE checks stay). The "A3 notes" v2-header bullet is superseded.

## Test round 1 on branch (17 fail / 21 pass), log: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-918b71d5/074d1d65-2805-49d9-8776-85cea9bac6e5/scratchpad/new4.log
- F1 simulate x9: duplicate key `statutory_rates_tenant_type_version_key` at payroll-simulate-kit.ts:56 publishStatutoryTables (called from payroll-run-simulate.test.ts:198). Test-side.
- F2: 409 "Periode/run tidak cocok atau telah beku" in two-runs-same-month tests: lock.test :715 :777 :832, december :799 (concurrent) :835 (reversal), rapel :888 (thr-coretax, 409 vs 200). Likely code (runMismatch / assertRunUnchanged / month basis on 2nd run). ROOT CAUSE first.
- F3 rapel allocation-changed: 23514 on allocation row (rapel.test :843). Allocated is terminal and allocate needs a draft run, so the test must create staleness another way (e.g. raw role edits the stored result's RAPEL line, or re-simulate after reallocation through the allowed path).
- F4 fold-pure employer refund gross_up: expected 1258550, got 1257250 (december :234). Decide: fold math or test expectation wrong.
- F5 december-two-runs: PAYROLL_SNAPSHOT_MISMATCH "Versi tarif ... tidak tersedia" (:772).

## Test round 2 status
- F2 fixed (simulate passes payrollRunId to gross only for regular runs). payroll-run-lock.test.ts green.
- F4: test expectation fixed (fold correct; gross_up split December costs ~1,300 more allowance, by law).
- F1b: kit still collides on `statutory_rates_tenant_type_published_from_key` when files run together (shared tenant). Test-side.
- F6 (MONEY): December file alone: two-runs gross_up year sum 16367550 vs expected 17064300; concurrent gross 150000 vs 235500. Root cause required: code (fold/loadTaxYearPriors/simulate wiring) or test expectation. Year PPh21 must equal annual tax on all income.

## Architect round (xhigh) fixes. Engineer decisions: fail closed
- X (simulate/compose only): (1) any employee with an open PPh 21 receivable balance > 0 from earlier payslips gives 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`. Do not collect; collection is follow-up O2. (3) A THR run whose period is not exactly one calendar month gives 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED`. (4) Add `joinDate` and `endDate` (nullable) to `storedRunResultSchema` and store them per employee. (5) Read all components, active or not, for line flags; snapshot only the active ones.
- Y (`payroll-run-pph21.service.ts`, `lockPayrollRunMonth` only): (2) take advisory lock `payroll-pph21-year:<tenant>:<LE>:<YYYY>` BEFORE the month lock. Same key derivation style as the month lock.
- Z (`payroll-run-lock.service.ts` only): (4) compare the stored joinDate/endDate with the live employee row; any change gives 409 `PAYROLL_RUN_RESULT_STALE`, nothing written.
- T4 (new file `apps/api/src/test/payroll-run-followup-guards.test.ts`, use the kit): fail-first tests: open receivable gives 422 at simulate; concurrent Nov+Dec lock serialized (Dec sees Nov or one gets 409; year invariant holds); 2-month THR run gives 422; end date set after approval gives 409 STALE at lock.

## Test round 3 (tsc 0 errors; 6 fail / 34 pass), log scratchpad/test.log
- G1 december :876 [out-of-order]: "Versi tarif ... tidak tersedia" from run.ts:302 via lock.service:243 loadPinnedPph21Tables. Root cause needed (kit cross-file cleanup? test publishes?).
- G2/G3 rapel :991 :1020: tamperStoredResults gives 422 PAYROLL_RUN_RESULT_UNREADABLE (bad seal/binding). Test helper must seal through `sealRunResult` from payroll-run-simulate.service.ts with the correct binding.
- G4 rapel :1065 thr-coretax: 422 PAYROLL_TAX_EXPORT_POSITION_MISSING. Seed the employee position.
- G5 lock :832 [reversal-blocked]: 422 PAYROLL_RUN_EMPTY at simulate.service:231 (passed before X's round). Root cause needed.
- G6 simulate :592: an extra key gives 422 VALIDATION_ERROR (project convention), not 400. Fix the test expectation to 422 + code VALIDATION_ERROR.

## Mutation fail-first for T4 (in .worktrees/ff-base = full current code copy; NEVER edit the main worktree)
In `/Users/ifanshori99/Projects/legend super app/legend-918b71d5/.worktrees/ff-base` only, neutralize the 4 guards: (1) the open-receivable 422 in simulate (make `assertNoOpenPph21Receivable` return early); (2) the year advisory lock in `lockPayrollRunMonth`; (3) the THR one-month 422; (4) the joinDate/endDate compare in lock.service. Then run from ff-base root: `LEGEND_TEST_FILES="src/test/payroll-run-followup-guards.test.ts" heavy pnpm test`. Report which tests fail and why (the expected cause is the guard's absence).

## Final gate (test-runner, after last change 17:35)
From the worktree root (cd explicitly, print pwd), sequentially, run_in_background + Monitor:
1. `heavy pnpm --filter @starter/api typecheck > <scratchpad>/tsc2.log 2>&1`
2. The same 15-file `LEGEND_TEST_FILES=... heavy pnpm test` as the previous final run, to `<scratchpad>/final2.log`. Files: payroll-run-simulate, payroll-run-lock, payroll-run-lock-rapel, payroll-pph21-december-runs, payroll-run-followup-guards, payroll-ter-monthly, payroll-run-pph21-db, payroll-rapel, payroll-export-rapel, payroll-bank-export, payroll-bank-snapshot, payroll-coretax-export, payroll-key-rotation, payroll-pph21-annual, payroll-pph21-dec-gross-first (all `src/test/<name>.test.ts`).
Scratchpad: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-918b71d5/074d1d65-2805-49d9-8776-85cea9bac6e5/scratchpad. No edits. Report tsc error count (first errors verbatim), summary lines, failing tests + shortest decisive error.
