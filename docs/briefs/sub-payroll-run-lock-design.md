# Design: payroll run lock + rapel bank export (legend-b9y4y, legend-yod9z)

Architect output for `docs/briefs/sub-payroll-run-lock.md`. Tier K (money + tax). Implementers follow this file; open questions are marked **OPEN** and must not block the fail-first tests.

## 0. Decisions in one screen

1. Lock step = trusted in-transaction writer `lockPayrollRunInTransaction` (same boundary style as `finalizePayrollRapelRunInTransaction`). No route yet: no create/simulate run service exists, so the caller supplies the approved per-employee results. The step re-proves them under the month lock before writing anything.
2. ONE transaction (the caller's `withTenant` tx): month advisory lock, run row lock, PPh 21 recompute + stale check (`lockPayrollRunTax`), status `approved -> locked`, payslip inserts, month-dependency edges, bank snapshot (`snapshotPayeeBankForLock`), `payroll.locked` outbox event, audit. Any throw rolls back all of it.
3. Global lock order: **month advisory lock first, then the `payroll_runs` row `FOR UPDATE`, then plain reads, then inserts.** Lock and reversal both follow it. Never take the month lock after a run row lock.
4. Reversal dependency is stored explicitly: new table `payroll_run_month_priors` (migration **0478**), written at lock. Reversal approval takes the month lock and refuses while a live (locked/paid) dependent exists; a DB trigger enforces the same rule. **0479 is not used.**
5. Rapel bank export reads net from the sealed gross envelope only when the slip is bound to the run AND matches its `payroll_rapel_finalizations` receipt; then the unchanged PAYR-04 rule (`assertBankFileMatchesRun`, total == `totals.bankTransferIdr`).
6. "Jangan sampai rugi": the lock and the reversal refuse runs whose side effects this card does not perform (loans, reimbursements, service charge, rapel). Refusing never pays anyone more.
7. TER increase split (R1, founder Q5 pending): unchanged. The engine `monthPrior.pph21EmployeeIdr` path in `pph21.ts` stays as is.

## 1. Files

| File | Change |
|---|---|
| `apps/api/src/services/payroll-run-pph21.service.ts` | export `lockPayrollRunMonth`, export `loadMonthPriorRunIds`; `monthBasisForInput` reuses `lockPayrollRunMonth` |
| `apps/api/src/services/payroll-run-lock.service.ts` | NEW: `lockPayrollRunInTransaction`, private `loadPinnedPph21Tables` |
| `apps/api/src/services/payroll-run-reversal.service.ts` | NEW: `requestPayrollRunReversalInTransaction`, `decidePayrollRunReversalInTransaction` |
| `apps/api/src/services/payroll-rapel-finalize.service.ts` | export `openRapelFinalizedPayslip` (same checks as the finalize replay branch) |
| `apps/api/src/services/payroll-export.service.ts` | bank export: `bankSlipOf` (full calculation OR verified rapel envelope) |
| `apps/api/src/db/schema/payroll.ts` | NEW table `payrollRunMonthPriors` (next to `payslipBankSnapshots`) |
| `apps/api/src/db/schema/payroll-run-month-priors.custom.sql` | NEW: RLS, grants, insert guard, reversal guard trigger |
| `apps/api/drizzle/0478_payroll_run_month_priors.sql` + `meta/0478_snapshot.json` + `_journal.json` | NEW migration idx 478 |
| `apps/api/src/test/payroll-run-lock.test.ts` | NEW: tests 1-3 |
| `apps/api/src/test/payroll-bank-snapshot.test.ts` | add test 4 (reuse `seedRapelTarget`), update the "Known gap" comment at ~line 999 |

Branded ids: `payslipIdSchema.parse(randomUUID())`, `payrollRunIdSchema.parse(...)`, `employeeIdSchema.parse(...)`. No `as` casts or string literals for ids.

## 2. Migration 0478 (only one)

Table `payroll_run_month_priors` in `payroll.ts`:

- `tenant_id uuid NOT NULL` (`tenantIdColumn(() => tenants.id)`)
- `payroll_run_id uuid NOT NULL` (`$type<PayrollRunId>()`): the later run, the one that was locked
- `prior_payroll_run_id uuid NOT NULL` (`$type<PayrollRunId>()`): the earlier locked/paid run it was computed against
- `created_at timestamptz NOT NULL DEFAULT now()`
- primary key `(tenant_id, payroll_run_id, prior_payroll_run_id)`, name `payroll_run_month_priors_pkey`
- FK `payroll_run_month_priors_run_fk (tenant_id, payroll_run_id) -> payroll_runs (tenant_id, id)`
- FK `payroll_run_month_priors_prior_fk (tenant_id, prior_payroll_run_id) -> payroll_runs (tenant_id, id)`
- index `payroll_run_month_priors_prior_idx (tenant_id, prior_payroll_run_id)`
- check `payroll_run_month_priors_distinct_check`: `payroll_run_id <> prior_payroll_run_id`

`payroll-run-month-priors.custom.sql` (copy the 0472 style, `SET search_path = pg_catalog`, ERRCODE `23514`):

1. `SELECT app.enforce_tenant_rls('public.payroll_run_month_priors'::regclass);`
2. `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_run_month_priors FROM legend_app;` (append-only)
3. `app.payroll_run_month_priors_guard()` BEFORE INSERT: the run is `locked`; the prior run is `locked` or `paid`; same `legal_entity_id`; `date_trunc('month', pay_date)` equal. Else `RAISE 'PAYR-05: ...'`.
4. `app.payroll_runs_reversal_dependency_guard()` + trigger `payroll_runs_reversal_dependency_trg BEFORE UPDATE OF status ON payroll_runs FOR EACH ROW WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed')`: raise if a row `d` exists with `d.tenant_id = NEW.tenant_id AND d.prior_payroll_run_id = NEW.id`, joined to a run in status `locked` or `paid`. Message: `'PAYR-05: payroll run % has later runs of its tax month computed on it'`. This is a separate trigger. Do not edit `app.payroll_runs_guard`.

Procedure: `pnpm db:generate --name payroll_run_month_priors`. Rename the output to idx/tag `0478_payroll_run_month_priors`, and rename `meta/0478_snapshot.json` with `prevId` = the id of the 0472 snapshot. Then append the custom SQL, as 0472 did. Then run `node scripts/migration-renumber.mjs check --from-idx 472`, `pnpm db:migrate`, and `pnpm db:generate` (it must print no changes). Add the table to any RLS or table registry test that enumerates tenant tables, if one fails.

## 3. Card 1: lock step

### 3.1 `payroll-run-pph21.service.ts` additions

```ts
/** Advisory month lock of the stored run; re-reads the run under the lock (409 PAYROLL_PPH21_RUN_MISMATCH if LE/pay date moved). */
export async function lockPayrollRunMonth(
  tx: Tx, tenantId: TenantId, runId: PayrollRunId,
): Promise<{ legalEntityId: string; payDate: BusinessDate; month: string /* YYYY-MM */ }>;

/** Other locked/paid runs of the same LE + month that hold a payslip of any of `employeeIds` (caller holds the month lock). */
export async function loadMonthPriorRunIds(
  tx: Tx, tenantId: TenantId,
  run: { runId: PayrollRunId; legalEntityId: string; month: string },
  employeeIds: readonly string[],
): Promise<PayrollRunId[]>; // sorted, unique
```

`monthBasisForInput` calls `lockPayrollRunMonth`, then compares `input.run.payDate` (same 409). The advisory lock is re-entrant inside one transaction, so `lockPayrollRunTax` taking it again does not wait. The edge set is a superset of the strict `monthPrior` set: it also covers `lastTaxPeriod` employees (December runs in the same month). Doubt limits reversal.

### 3.2 `payroll-run-lock.service.ts`

```ts
export type PayrollRunLockEmployee = {
  /** Approved simulation result (full payslip body, tax included). */
  calculation: PayslipCalculation;
  /** Engine input of that simulation; employeeId comes from `calculation`. */
  taxInput: Omit<PayrollRunTaxEmployee, "employeeId">;
  /** Month basis the simulation computed against; null when lastTaxPeriod. */
  approvedMonthBasis: PayrollMonthBasis | null;
};
export type PayrollRunLockInput = {
  payrollRunId: PayrollRunId;
  employees: readonly PayrollRunLockEmployee[];
};
export type PayrollRunLockResult = {
  payrollRunId: PayrollRunId;
  payslips: { payslipId: PayslipId; employeeId: EmployeeId; paymentMethod: PayslipPaymentMethod; netIdr: Idr }[];
  bankSnapshotCount: number;
  monthPriorRunIds: PayrollRunId[];
};
export async function lockPayrollRunInTransaction(
  tx: Tx, context: ScopedTenantContext, actorUserId: string,
  input: PayrollRunLockInput, now = new Date(),
): Promise<PayrollRunLockResult>;
```

Steps, in this order, all inside `tx`:

1. `actor = assertPayrollTenantCan(tx, context, actorUserId, "payroll.lock")`.
2. Re-parse every `calculation` with `payslipCalculationSchema`. Require at least 1 employee and unique employee ids, then sort by employeeId. Bad input gives 409 `PAYROLL_RUN_RESULT_STALE`.
3. **LOCK 1**: `month = lockPayrollRunMonth(tx, tenantId, runId)`.
4. **LOCK 2**: `SELECT * FROM payroll_runs WHERE tenant AND id FOR UPDATE`. Missing gives 404 `PAYROLL_RUN_NOT_FOUND`. If LE or pay date differ from `month`: 409 `PAYROLL_PPH21_RUN_MISMATCH`.
5. Map the row to `payrollRunSchema`, then `next = applyPayrollRunCommand(run, { action: "lock", actorId: actor, at })`. This gives `PAYROLL_RUN_INVALID_TRANSITION` (409) unless the status is `approved`, and `PAYROLL_RUN_NOT_APPROVED` (409) without two distinct approvers, totals and snapshot.
6. Unsupported side effects: 409 `PAYROLL_RUN_LOCK_UNSUPPORTED` if `totals.loanRepaymentIdr`, `reimbursementIdr` or `serviceChargeIdr` > 0. The same code applies if any `payroll_rapels` row has `payroll_run_id = run` and `status = 'allocated'`, or any `payroll_rapel_finalizations` row exists for the run. Rapel runs keep their own path.
7. Plan vs approval: every `calculation.periodStart/periodEnd/payDate` must equal the run; the plan length must equal `totals.employeeCount`; and `isDeepStrictEqual(sumPayrollRunTotals(calcs), payrollRunTotalsSchema.parse(run.totals))` must hold. Else 409 `PAYROLL_RUN_RESULT_STALE`.
8. `tables = loadPinnedPph21Tables(tx, tenantId, run)`: read the `statutory_rates` rows named by `configSnapshot.statutoryVersions` for `ptkp`, `pph21_ter` and `pph21_annual`. Map them like `toVersion` in `payroll-statutory.service.ts` and validate with `statutoryVersionsForRun({ status: "locked", payDate, configSnapshot }, versions, types)`; a missing or changed version gives `PAYROLL_SNAPSHOT_MISMATCH`. Build `{ ptkp, ter, annual }` from the parameters. **OPEN Q-a**: pinned-at-simulation is used, not in-force-at-lock. That is consistent with "what was approved is what locks"; the PPh 21 policy keeps its existing approved-ref check.
9. Call `tax = lockPayrollRunTax(context, { run: { status: "approved", payDate, configSnapshot }, tables, employees: plan.map(e => ({ employeeId: e.calculation.employeeId, ...e.taxInput })), monthScope: { runId } }, configSnapshot.pph21Policy, tx, approvedBasis)`. `approvedBasis` is a Map built from the non-null `approvedMonthBasis`. This gives 409 `PAYROLL_PPH21_MONTH_STALE`, 409 `PAYROLL_SNAPSHOT_MISMATCH`, or 422 `PAYROLL_PPH21_MONTH_PRIOR_INVALID`.
10. Per employee: `isDeepStrictEqual(payslipTaxSchema.parse(computed.tax), calculation.tax)` must hold. Also, the earnings multiset `(amountIdr, taxable)` of `taxInput.earnings` must equal the calculation's earning lines, excluding `tax_allowance` and the PPh 21 refund line. Else 409 `PAYROLL_RUN_RESULT_STALE`. **OPEN Q-c**: confirm the refund line's category (the fixture uses component code `PPH21_REFUND`; `components.ts` has no `pph21_refund` category).
11. `priorRunIds = loadMonthPriorRunIds(tx, tenantId, { runId, legalEntityId, month }, employeeIds)`.
12. Run `UPDATE payroll_runs SET status='locked', locked_by=actor, locked_at=now, updated_at=now WHERE tenant AND id AND status='approved' RETURNING id`. Zero rows gives `PAYROLL_RUN_INVALID_TRANSITION`. Do not touch `totals` or `config_snapshot`; they already equal what was approved.
13. INSERT one `payslips` row per employee. The id is `payslipIdSchema.parse(randomUUID())`; `payment_method` is `calculation.paymentMethod`; `calculation_encrypted` is `sealPayrollValue(JSON.stringify(calculation), { tenantId, table: "payslips", rowId: id, field: "calculation" }, PAYROLL_SEAL_KEY_VERSION)`.
14. INSERT the `payroll_run_month_priors` rows `(runId, priorRunId)`.
15. Call `bankSnapshotCount = snapshotPayeeBankForLock(tx, tenantId, runId, slips.filter(s => s.paymentMethod === "bank_transfer" && s.netIdr > 0))`. It throws 422 `PAYROLL_BANK_ACCOUNT_MISSING` or `PAYROLL_BANK_ACCOUNT_UNREADABLE`.
16. `emitPayrollEvent(tx, context, payrollLocked, { aggregateId: runId, actor, payload: { ...runRef, totals, lockedBy: actor, lockedAt } })`. **OPEN Q-d**: copy the `OperationsEventActor` shape from the existing callers in `payroll-gl-consumer.test.ts`.
17. `recordAudit` with `payroll.run.locked`. `maskedChanges` holds only `employeeCount` and `bankSnapshotCount`, never amounts.

Transaction boundary: the caller wraps `withTenant(db, context, tx => lockPayrollRunInTransaction(...))`. Steps 12-17 are the only writes, and all of them sit after every check. A throw anywhere rolls back status, payslips, edges, snapshots, event and audit (test 1).

## 4. Reversal (`payroll-run-reversal.service.ts`)

```ts
export async function requestPayrollRunReversalInTransaction(
  tx: Tx, context: ScopedTenantContext, actorUserId: string,
  payrollRunId: PayrollRunId, reason: string, now = new Date(),
): Promise<PayrollRun>;
export async function decidePayrollRunReversalInTransaction(
  tx: Tx, context: ScopedTenantContext, actorUserId: string,
  payrollRunId: PayrollRunId, decision: "approve" | "reject", now = new Date(),
): Promise<PayrollRun>;
```

- Permissions: request uses `payroll.lock` (**OPEN Q-b**: the PRD names no request permission); decide uses `payroll.cancel.approve`.
- Request: run `FOR UPDATE`, then `applyPayrollRunCommand(request_reversal)`. Fast-fail with the dependents query below (same 409), then UPDATE `reversal`. Status stays `locked`.
- Decide: **LOCK 1** `lockPayrollRunMonth`, then **LOCK 2** run `FOR UPDATE`, then `applyPayrollRunCommand(approve_reversal | reject_reversal)`. That reducer gives 403 `PAYROLL_APPROVER_NOT_DISTINCT` and 409 `PAYROLL_RUN_INVALID_TRANSITION`. For approve only:
  - Refuse with 409 `PAYROLL_RUN_LOCK_UNSUPPORTED` if totals carry loans, reimbursements or service charge, or if the run has rapel finalizations.
  - Dependents: `SELECT d.payroll_run_id FROM payroll_run_month_priors d JOIN payroll_runs r ON (r.tenant_id, r.id) = (d.tenant_id, d.payroll_run_id) WHERE d.tenant_id = $t AND d.prior_payroll_run_id = $run AND r.status IN ('locked','paid')`. If any exist: 409 `PAYROLL_RUN_REVERSAL_BLOCKED`, "Payroll lain di bulan pajak ini dihitung dari payroll ini. Batalkan payroll yang lebih baru dulu." List the run ids only.
  - Then `UPDATE status='reversed', reversal=<approved JSON>`, emit `payrollReversed`, and write the audit row `payroll.run.reversed`.
- Run status transitions (unchanged contract, `run.ts` + `payroll_runs_guard`):
  - `approved -lock-> locked`
  - `locked -request_reversal/reject_reversal-> locked` (`reversal` JSON changes)
  - `locked -approve_reversal-> reversed`
  - `paid` is never reversed.
- A reversed run leaves the month basis (`MONTH_PRIOR_STATUSES`). A later run that was simulated against it and is not yet locked gets `PAYROLL_PPH21_MONTH_STALE` at its lock (existing behaviour).

## 5. Card 2: rapel bank export under PAYR-04

`payroll-rapel-finalize.service.ts`: export

```ts
export function openRapelFinalizedPayslip(
  slip: { id: PayslipId; tenantId: TenantId; employeeId: string; calculationEncrypted: Buffer; piiKeyVersion: number },
  receipt: typeof payrollRapelFinalizations.$inferSelect | undefined,
  runId: PayrollRunId,
): z.infer<typeof payrollGrossEnvelopeSchema>;
```

It opens the slip and parses `payrollGrossEnvelopeSchema`. It requires all of:
- `envelope.payrollRunId` (lower-cased) == `runId`;
- `rapelAllocationRevision` is present;
- the receipt exists with `payrollRunId == runId`, `employeeId == slip.employeeId` and `allocationRevision == envelope.rapelAllocationRevision`;
- `slip.piiKeyVersion >= receipt.piiKeyVersion`;
- when the key versions are equal, `sha256(calculationEncrypted) == receipt.calculationSha256`.

These are the same rules as the replay branch; refactor that branch to call this helper.

`payroll-export.service.ts` `createBankTransferFile`:

1. Load the receipts once: `payroll_rapel_finalizations WHERE tenant AND payroll_run_id = run`, as a Map by `payslipId`.
2. Replace `sealedCalculation(row)` with `bankSlipOf(row, runId, receipts)`, which returns `{ employeeId, paymentMethod, netIdr, source: "full" | "rapel" }`:
   - The sealed value opens and parses as `payslipCalculationSchema`: keep the existing column-agreement check and return `source: "full"`.
   - Otherwise call `openRapelFinalizedPayslip`. Take `employeeId` and `paymentMethod` from the row columns (they are bound by AAD and the receipt) and `netIdr` from the envelope. Return `source: "rapel"`.
   - Undecryptable or neither schema: 422 `PAYROLL_PAYSLIP_UNREADABLE` (unchanged message). Readable but not bound or no matching receipt: 409 `PAYROLL_BANK_FILE_MISMATCH`.
   - Mixed `full` and `rapel` slips in one run: 409 `PAYROLL_BANK_FILE_MISMATCH`.
3. The rest is unchanged: filter `bank_transfer && netIdr > 0`, run `assertBankFileMatchesRun(rows, slips, totals)` so the file total == `totals.bankTransferIdr` (the run's total transfer), use snapshot-only payees, and set `amountIdr = netIdr`. No payee can receive more than the sealed net.

The Coretax export stays on the full schema only (see risks).

## 6. Fail-first tests (write first, run red, then implement)

`apps/api/src/test/payroll-run-lock.test.ts`. Seed it like `payroll-ter-monthly.test.ts` (`seedRun`, the SQL approval steps, the worked TER numbers) and add employees with a bank account like `payroll-bank-snapshot.test.ts`.

1. `[lock-atomic]`
   - (a) Two bank_transfer employees with net > 0; one has no account. Expect 422 `PAYROLL_BANK_ACCOUNT_MISSING`. Assert the run is still `approved`, with 0 payslips, 0 snapshots, 0 `payroll_run_month_priors` rows and 0 outbox events for the run.
   - (b) A wrong `approvedMonthBasis`. Expect 409 `PAYROLL_PPH21_MONTH_STALE`; nothing is written.
   - (c) Happy path. The status is `locked`; the sealed slip opens and its tax equals the recompute; the snapshot count equals the bank_transfer slips with net > 0 (cash and zero-net slips are excluded).
2. `[lock-parallel-month]`: a regular run A (gross 8.000.020) and a THR run B (gross 5.000.310), same LE, same month, same employee. Both are approved with a zero basis.
   - Lock both concurrently with `Promise.allSettled`. Exactly one is fulfilled; the other is 409 `PAYROLL_PPH21_MONTH_STALE`.
   - Re-simulate the loser with SQL `return_to_draft -> simulated -> hr_approved -> approved` and new totals, then lock it.
   - Assert that the PPh 21 of both slips sums to 650.017 (half_up), with no double or missing withholding. Assert the loser has exactly one edge to the winner.
3. `[reversal-blocked]`: from the test 2 state.
   - Request a reversal of the earlier run (user X) and approve it as user Y. Expect 409 `PAYROLL_RUN_REVERSAL_BLOCKED`; the run stays `locked`.
   - A direct SQL `UPDATE ... status='reversed'` with an approved reversal JSON fails with SQLSTATE 23514.
   - Reverse the later run first: it succeeds. Then the earlier run succeeds.
   - Approving as the requester gives 403 `PAYROLL_APPROVER_NOT_DISTINCT`.
4. `payroll-bank-snapshot.test.ts`, new describe `[rapel-bank-export]`: `seedRapelTarget`, then finalize, then `createBankTransferFile` (generic_csv). Expect `totalIdr == totals.bankTransferIdr`, each row amount == the envelope net, and rowCount == the bank slips with net > 0. Negative case: insert an envelope payslip with SQL into a locked run that has no receipt. Expect 409 `PAYROLL_BANK_FILE_MISMATCH` and no file row.

Run: `LEGEND_TEST_FILES="src/test/payroll-run-lock.test.ts src/test/payroll-bank-snapshot.test.ts" heavy pnpm test` (only one heavy holder at a time). Regression set afterwards: `payroll-ter-monthly`, `payroll-run-pph21-db`, `payroll-rapel`, `payroll-bank-export`.

## 7. Ordered steps

1. test-writer: tests 1-4 as above, then confirm they fail (red log).
2. engineer: migration 0478 (schema + custom SQL + journal/snapshot). Check that `db:generate` is empty and the renumber check passes.
3. engineer: §3.1 changes to the pph21 service (existing pph21 tests must stay green).
4. engineer: `payroll-run-lock.service.ts`.
5. engineer: `payroll-run-reversal.service.ts`.
6. engineer: `openRapelFinalizedPayslip` + the export change. Update the "Known gap" comment in the bank snapshot test.
7. Targeted tests green, then one architect review (xhigh, money), then second-opinion per area before the release gate.

## 8. Risks and follow-ups (file beads)

- A month that contains a rapel-finalized run: `loadMonthBasis` and the Coretax export cannot read envelopes, so they refuse (422). This fails closed with no money risk, but it blocks operations. Follow-up: an envelope-aware month basis and BPMP. Rapel finalize does not take the month lock today; when it does, it must take the month lock before its component locks.
- Cross-month dependency (December annual recalculation over earlier months) is not covered by the reversal block; this design covers the same month only. Exposure is small because only locked, unpaid runs can be reversed.
- The lock trusts the caller's calculations until a simulate service persists per-employee results. Guards: equality with the approved totals, equality with the recomputed tax, earnings consistency. Follow-up: a simulate service that stores results and basis, so lock reads them instead of caller input.
- Lock and reversal refuse runs with loans, reimbursements, service charge or rapel until those side effects are built (PAYROLL_RUN_LOCK_UNSUPPORTED).
- New codes (`PAYROLL_RUN_RESULT_STALE`, `PAYROLL_RUN_LOCK_UNSUPPORTED`, `PAYROLL_RUN_REVERSAL_BLOCKED`) are API-local `HttpError`, like `PAYROLL_PPH21_MONTH_STALE`. A UI catalog entry comes later.
- OPEN Q-a (pinned vs in-force statutory at lock), Q-b (request-reversal permission), Q-c (refund line category), Q-d (event actor shape). Defaults above; report the chosen value in the PR.
