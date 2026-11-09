# Sub-brief 182: payroll posting wiring (legend-4n3r) + employer refund split (legend-w6vah)

Worktree `.worktrees/payroll-posting`, branch `ws/payroll-posting` (base 0705f12f = `ws/payroll-journal`). Do not commit/push. Do not edit: `pos-shift.service.ts`, refund modules, `accounting-auto-journal-guards.ts`, `pos-order-payment.ts`, open bill, `app.ts`, `routes/index.ts`, `edge/runtime.ts`. In `worker-main.ts` only the payroll dispatch line. Keep existing comments. Prettier your files. Never wait on global processes (`pgrep vitest` belongs to other agents).

Context: brief `docs/briefs/sub-174-payroll-journal.md` (previous step). The payroll run tables/service do NOT exist (legend-gfcr, legend-07eg own them). We ship the emit helper the run service will call, the GL consumer, dispatch, and the rules.

## Part 1 — shared (implementer 1): legend-w6vah split + payroll.paid contract

Files: `packages/shared/src/hris/payroll/{pph21.ts,payslip-tax.ts,payslips.ts,events.ts,fixtures.ts}`, `packages/shared/src/accounting/{payroll-journal.ts,posting-rules.ts,fixtures.ts}`.

1. `pph21.ts` result: new `pph21EmployerAllowanceRefundIdr` = part of `pph21EmployerRefundIdr` that returns earlier gross-up tax allowance (booked in 6101). Formula at the refund branch (~:578-601): `refundAllowance = priorEmployerTax > 0 && priorAllowance ? floor(employerRefund * priorAllowance / priorEmployerTax) : 0`, clamped to `<= priorAllowance` and `<= employerRefund`; borne part = employerRefund − refundAllowance (odd rupiah to borne). `priorEmployerTax = priorBorne + priorAllowance` (:423). Comment the rule in the file header.
2. `payslip-tax.ts`: copy it into `tax`. `payslipTaxSchema` (`payslips.ts`): `pph21EmployerAllowanceRefundIdr: nonNegativeIdr.optional()` (absent = 0, like `pph21ReceivableIdr`), refine `<= pph21EmployerRefundIdr`.
3. `payrollRunTotalsSchema`: required `pph21EmployerAllowanceRefundIdr` with check `<= pph21EmployerRefundIdr`; `sumPayrollRunTotals` sums `tax.pph21EmployerAllowanceRefundIdr ?? 0`.
4. `payroll-journal.ts`: keys `pph21EmployerAllowanceRefundIdr` (allowance part) and `pph21EmployerBorneRefundIdr` (= erf − allowance part) replace `pph21EmployerRefundIdr`; update the balance-proof comment.
5. `posting-rules.ts` `PAYROLL_JOURNAL_LINES`: `["salary_expense","credit","pph21EmployerAllowanceRefundIdr"]`, `["pph21_borne_expense","credit","pph21EmployerBorneRefundIdr"]`. Comment that `payroll.reversed` rule stays only as a cross-check; posting reverses the locked entry (legend-4n3r). New rule `payroll.paid` (sourceType `payroll`, "Gaji dibayar", citation `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04`): Dr `salaries_payable` netIdr, Cr `bank` bankTransferIdr, Cr `petty_cash` cashIdr.
6. `events.ts` `payroll.paid` payload: add `bankTransferIdr`, `cashIdr` (non-negative Idr) with refine `netIdr === bankTransferIdr + cashIdr`. Update `hris/payroll/fixtures.ts` paid event and any totals literal; `accounting/fixtures.ts` amounts.
   Check: `heavy pnpm --filter @starter/shared typecheck` (or `cd packages/shared && heavy pnpm typecheck`).

## Part 2 — API (implementer 2): emit helper, GL consumer, dispatch, reversal in tx

Files: `apps/api/src/services/operations-events.ts` (only widen `outletId: string` to `string | null` in `emitOperationsEvent` input), NEW `apps/api/src/services/payroll-events.ts` (helper `emitPayrollEvent(tx, context, definition, {runId|aggregateId, actor, payload, now})` over `emitOperationsEvent` with outletId null; used later by the run service legend-07eg — say so), `apps/api/src/services/accounting-journal.service.ts` (extract the body of `reverseJournal` :850 into exported `reverseJournalInTransaction(tx, context, entryId, input, actorId: UserId | null, now)`; `reverseJournal` keeps its signature and calls it; check `postedBy` is nullable in schema like posting), NEW `apps/api/src/services/payroll-gl-consumer.ts`, `apps/api/src/worker-main.ts` (one line beside `deliverInventoryGlEvent`, same `postsInventoryGl` cloud gate, with a comment `WS-07 (legend-4n3r)`).

Consumer `deliverPayrollGlEvent(context, event, tx, now = new Date())`, copy `inventory-gl-consumer.ts` patterns (tenant check, `accountingEnabled`, parse payload with the shared event schema):

- `payroll.locked`: `postJournalFromRuleInTransaction` eventName `payroll.locked`, amounts `payrollJournalAmounts(payload.totals)`, `legalEntityId` from payload, outletId null, entryDate = payload.periodEnd, sourceId = payrollRunId, postedBy null, idempotencyKey `payroll-gl:locked:<runId>`.
- `payroll.paid`: rule `payroll.paid`, amounts {netIdr, bankTransferIdr, cashIdr}, entryDate = business date of paidAt (find the core helper for Asia/Jakarta business date), key `payroll-gl:paid:<runId>`. Skip (no-op) when no locked entry exists for the run (accounting enabled later).
- `payroll.reversed`: find the locked entry by idempotency key `payroll-gl:locked:<runId>` (tenant-scoped); none → no-op. Cross-check: lines of rule `payroll.reversed` built from payload totals must total the locked entry's debit, else throw. Then `reverseJournalInTransaction(tx, context, lockedId, {entryDate: business date of reversedAt, reason: "Payroll dibatalkan (PAYR-05)", idempotencyKey: "payroll-gl:reversed:<runId>"}, null, now)`.
- `employee_loan.disbursed`: rule, amounts {principalIdr}, legalEntityId from payload, key `payroll-gl:loan:<employeeLoanId>`.
- `reimbursement.paid`: payout `payroll` → no-op (the run journal carries it). `cash` → rule variant `cash`, amounts {amountIdr}; legal entity from the employee row (find the column in `db/schema/hris.ts`), key `payroll-gl:reimbursement:<reimbursementId>`.
- Errors propagate (outbox retries / dead-letters); document that in the header.

## Part 3 — tests (implementer 3)

Files: NEW `apps/api/src/test/payroll-gl-consumer.test.ts` (DB; copy setup from `apps/api/src/test/inventory-gl.test.ts` :94-330: tenant with accounting flag, legal entity, provisioned chart via the shared standard template + mappings, open period, `withTenant`), update `apps/api/src/test/accounting-payroll-journal.test.ts` (fuzz + cases use the split; add the w6vah case), `tests/*.test.mjs` literals, payroll pph21 unit tests if they assert full result objects.
REPRO FIRST without racing Part 1/2: copy your two new/changed test files into `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-journal/apps/api/src/test/` (frozen base), run there with `LEGEND_TEST_FILES=... pnpm test` from that worktree root, save the failing output to `docs/briefs/182-repro.log` in THIS worktree, then delete the copies there (leave that worktree clean: `git -C <that> status --short` empty).
Cases:

- w6vah: gross-up-only employee, Jan–Nov TAX_ALLOWANCE (prior allowance > 0, prior borne 0), December annual recalculation with employer refund 150.000 → journal credits 6101 by 150.000, 6111 untouched. Mixed prior (allowance and borne) splits proportionally, parts sum exactly. Build via `computePayslipTax` with a `prior` that yields the refund (tune numbers; assert the refund amount you get, ideally 150.000).
- Consumer: lock posts one balanced entry (debit == credit, source payroll, sourceId runId); replay of the same event posts nothing new; paid posts Dr 2103 = net, Cr 1103/1102 and 2103 nets to 0 after lock+paid; reversed posts one entry with `reversal_of` = locked id and mirrored lines; a second reversal of the same entry is rejected (unique `journal_entries_reversal_once_key`) or returns the same entry by idempotency key — assert which; reversal with mismatching totals throws; reimbursement payout payroll posts nothing, cash posts Dr 6110 Cr 1102; loan disbursed Dr 1204 Cr 1102; accounting disabled → nothing.
- Fuzz in `accounting-payroll-journal.test.ts`: keep ≥2500 cases; add assertions `allowanceRefund <= priorAllowance`, parts sum to erf, journal balanced.
  Run from worktree root: `LEGEND_TEST_FILES="src/test/payroll-gl-consumer.test.ts src/test/accounting-payroll-journal.test.ts" pnpm test` once Parts 1–2 exist (check files, do not poll processes).
