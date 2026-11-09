# Sub-brief 174: balanced payroll journal (legend-s8a3)

Worktree: `.worktrees/payroll-journal`, branch `ws/payroll-journal`. Do not commit, push or touch other worktrees. Do not edit: accounting-provisioning service, POS/refund auto-journal, `pos-shift.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`. Keep existing comments. Run prettier on files you change.

## Why

The placeholder rule `payroll_run.completed` (`packages/shared/src/accounting/posting-rules.ts:245`) is unbalanced: credit − debit = B − employee refund − employer refund − LATE/other − loan. Repro: `apps/api/src/test/accounting-payroll-journal-repro.test.ts` (5 of 6 fail). Replace it with `payroll.locked` + `payroll.reversed` fed from `payrollRunTotalsSchema`.

## Facts

- Per slip (`hris/payroll/payslips.ts:200`): `pph21 = withheld W + borne B + receivable R − refund rf − employerRefund erf`.
- Employee refund rf is paid as an EARNING line `PPH21_REFUND` (custom_earning), so it is inside gross. Tax allowance is an earning line inside gross and also inside W.
- B (net scheme) has no line; it is not in gross.
- Totals: `deductions = bpjsEmp + W + loan + collected + other`, `net = gross − deductions`; `other` = LATE + custom deductions.
- Engine (`buildJournalLinesFromRule`): one amount key per line, the same key may sit on several lines, zero skips, negative flips side, `assertJournalBalanced` at end.

## Part A — shared core (implementer A)

Files: `packages/shared/src/hris/payroll/payslips.ts`, `packages/shared/src/accounting/coa.ts`, `packages/shared/src/accounting/posting-rules.ts`, NEW `packages/shared/src/accounting/payroll-journal.ts` (+ export from the accounting barrel `packages/shared/src/accounting/index.ts`), `packages/shared/src/events/catalog.ts`, `packages/shared/src/accounting/fixtures.ts`, `packages/shared/src/hris/payroll/fixtures.ts` only if a totals literal breaks.

1. `payrollRunTotalsSchema`: add `pph21EmployerBorneIdr`, `pph21RefundIdr`, `pph21EmployerRefundIdr` (all `nonNegativeIdr`, JSDoc each: borne = net scheme, no line; refund = paid as PPH21_REFUND earning inside gross; employer refund = returns to employer). New superRefine checks: `pph21Idr === pph21WithheldIdr + pph21EmployerBorneIdr + pph21ReceivableIdr − pph21RefundIdr − pph21EmployerRefundIdr`; `serviceChargeIdr + reimbursementIdr + pph21RefundIdr <= grossIdr` (replace the old SC+reimb check). `sumPayrollRunTotals` sums them from `slip.tax`.
2. `coa.ts`: new role `reimbursement_expense: "expense"` (JSDoc: employee reimbursements, PRD §3 reimbursement via payroll or kas) and standard row `["6110", "Beban Reimbursement Karyawan", "operating_expense", "6100", ["reimbursement_expense"]]` after 6109.
3. `payroll-journal.ts`: `export function payrollJournalAmounts(totals: PayrollRunTotals): Record<PayrollJournalAmountKey, number>` (type-only import from `../hris/payroll/payslips.ts`; parse with the schema first so invariants hold). Keys and values:
   - `salaryExpenseIdr` = gross − pph21Refund − serviceCharge − reimbursement
   - `pph21EmployerBorneIdr`, `pph21EmployerRefundIdr`, `otherDeductionsIdr`, `serviceChargeIdr`, `reimbursementIdr`, `bpjsCompanyIdr`, `pph21ReceivableIdr`, `netIdr`, `pph21Idr` (signed), `pph21ReceivableCollectedIdr`, `loanRepaymentIdr`: straight from totals
   - `bpjsTotalIdr` = bpjsEmployee + bpjsCompany
     Header comment: the balance proof (debits = gross − rf + bpjsCo + B + R = credits).
4. `posting-rules.ts`: delete `payroll_run.completed`. Add `payroll.locked` (sourceType `payroll`, "Payroll dikunci", citation `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04`) with lines, built from one shared `const PAYROLL_JOURNAL_LINES: L[]`:
   - debit: salary_expense salaryExpenseIdr; salary_expense pph21EmployerBorneIdr; service_charge serviceChargeIdr; reimbursement_expense reimbursementIdr; bpjs_expense bpjsCompanyIdr; employee_receivable pph21ReceivableIdr
   - credit: salaries_payable netIdr; bpjs_payable bpjsTotalIdr; pph21_payable pph21Idr; employee_receivable pph21ReceivableCollectedIdr; employee_receivable loanRepaymentIdr; salary_expense otherDeductionsIdr; salary_expense pph21EmployerRefundIdr
     Keep the founder B8 comment on the receivable lines. Add `payroll.reversed` ("Payroll dibatalkan (jurnal balik)", citation `... PAYR-05`) = same lines with sides swapped (amounts = the locked totals in the payload). Add `employee_loan.disbursed` (sourceType: pick the closest existing journalSourceType; if none fits use `payroll`): Dr employee_receivable principalIdr, Cr cash_on_hand principalIdr. Add `reimbursement.paid` variant `cash`: Dr reimbursement_expense amountIdr, Cr cash_on_hand amountIdr (payout `payroll` posts nothing here: the run journal carries it; say so in a comment).
5. `catalog.ts`: remove `payroll_run.completed` from WS-10.
6. `accounting/fixtures.ts` October payroll: use `{ eventName: "payroll.locked" }` with `payrollJournalAmounts(...)` of an equivalent totals object (gross 42.000.000, bpjsCo 2.184.000, bpjsEmp 840.000, W 630.000, net 40.530.000, the rest 0) — keep the posted journal identical.

Check: `pnpm --filter @starter/shared exec tsc --noEmit -p .` is heavy → run it as `heavy pnpm --filter @starter/shared exec tsc --noEmit -p .` (find the right tsconfig). Report the diff summary.

## Part B — data migration (implementer B)

Files: NEW `apps/api/drizzle/0134_<name>.sql`, `apps/api/drizzle/meta/_journal.json` (idx 134, `when` > 1794204874726, same `version`/`breakpoints`), and a DB test `apps/api/src/test/accounting-coa-backfill-1204.test.ts`. Do NOT run `db:generate` snapshots for schema changes (there are none); check how earlier data-only migrations (e.g. `0116_ai_approval_policies_data.sql`) handled `meta/*_snapshot.json` and copy that.

SQL, idempotent, only for `(tenant_id, legal_entity_id)` pairs that already have at least one `account_mappings` row (provisioned):

- Insert account `1204` "Piutang Karyawan" (asset, current_asset, parent = that entity's `1200` id or NULL) when no account with code 1204 exists for the pair.
- Insert account `6110` "Beban Reimbursement Karyawan" (expense, operating_expense, parent = `6100` or NULL) the same way.
- Insert mapping `employee_receivable` → the pair's 1204 account, and `reimbursement_expense` → 6110, only when the role mapping is missing AND the target account exists with the right `type` (asset / expense), is active, and has no child accounts. Never update or delete existing rows.
- Handle RLS like 0116 (NO FORCE … FORCE). Respect `0027_accounting_invariants.sql` triggers (read them).
  Test: on a fresh DB set up a provisioned entity, delete its 1204/6110 mappings and accounts, run the migration SQL twice (read the file, split on `--> statement-breakpoint`), assert one account + one mapping each; a second entity with a custom 1204 of type expense gets no mapping; an unprovisioned entity gets nothing. Find how existing DB tests get a pool/tenant (e.g. `apps/api/src/test/hris-db.test.ts`). Run: `LEGEND_TEST_FILES="src/test/accounting-coa-backfill-1204.test.ts" pnpm test` from the worktree root.

## Part C — tests (implementer C)

Files: NEW `apps/api/src/test/accounting-payroll-journal.test.ts`; update `apps/api/src/test/accounting-payroll-receivable.test.ts` (move it to `payroll.locked` + `payrollJournalAmounts`), `tests/accounting-contract.test.mjs` (~line 990), `tests/payroll-contract.test.mjs` (totals literals), and delete `apps/api/src/test/accounting-payroll-journal-repro.test.ts` at the end. Code against the Part A API above (it lands in parallel).

- Per-combination cases, each asserting debit == credit and the Rupiah per account code: LATE, loan, B 124.062 (the real case), employee refund (in gross), employer refund, receivable + collected, service charge (needs a mapping for `service_charge` → 2106, chart has it), reimbursement (6110), all at once, negative pph21 (refund > withheld).
- `payroll.reversed` lines are the exact mirror of `payroll.locked` for the same totals.
- `employee_loan.disbursed` and `reimbursement.paid#cash` balance; 1204 / 6110 used.
- Totals schema rejects a broken pph21 identity and rf+SC+reimb > gross.
- Property (fuzz, seeded LCG, no new deps, ≥2000 cases, seed printed on failure): random payslips built through the real engine — `computePayslipTax` (payslip-tax.ts) with random gross/gross_up/net lines, employer benefit, random `prior` (to get refunds/receivable; use `lastTaxPeriod` true sometimes), random cap — then a slip shaped like `calculateFixturePayslip` (hris/payroll/fixtures.ts ~1124-1320: TAX_ALLOWANCE and PPH21_REFUND earnings, BPJS/PPH21/LATE/receivable/LOAN deductions, service_charge and reimbursement earnings) → `sumPayrollRunTotals` over 1–5 slips → `payrollJournalAmounts` → `buildJournalLinesFromRule` for locked and reversed: never throws, balanced. If building a full `PayslipCalculation` is too heavy, build the totals from the engine results with the same formulas and parse with `payrollRunTotalsSchema`. Report which.
  Run: `LEGEND_TEST_FILES="src/test/accounting-payroll-journal.test.ts src/test/accounting-payroll-receivable.test.ts" pnpm test` from the worktree root, and `node --test tests/accounting-contract.test.mjs tests/payroll-contract.test.mjs` (check package.json for the real root test command).

## Part D — architect fixes (implementer D, after commit 8dc10537)

1. `posting-rules.ts`: `employee_loan.disbursed` and `reimbursement.paid#cash` credit `petty_cash` (1102 Kas Kecil), not `cash_on_hand` (1101 is the POS drawer reconciled by shift close: double credit). Comment why.
2. `coa.ts`: new role `pph21_borne_expense: "expense"` (JSDoc: employer-borne PPh 21, net scheme; not deductible, UU PPh Pasal 9(1)h, koreksi fiskal) and row `["6111", "Beban PPh 21 Ditanggung Perusahaan", "operating_expense", "6100", ["pph21_borne_expense"]]` after 6110. In `PAYROLL_JOURNAL_LINES`, `pph21EmployerBorneIdr` debits and `pph21EmployerRefundIdr` credits `pph21_borne_expense` (reversed rule follows automatically). Update the balance-proof comment in `payroll-journal.ts` if it names salary_expense for B/erf.
3. Migration `apps/api/drizzle/0134_accounting_coa_backfill_1204.sql`: add account 6111 (expense, operating_expense, parent 6100 rule as 6110) and mapping `pph21_borne_expense` → 6111 with the same guards; update its header comment. In `meta/_journal.json` set this entry's `when` to `1794220000000` (must exceed every branch's latest, else drizzle skips it on DBs that already ran later migrations); keep idx/tag (merge train renumbers).
4. Tests: `accounting-payroll-journal.test.ts` (B / employer refund now on 6111; loan and cash reimbursement on 1102; fuzz unchanged) and `accounting-coa-backfill-1204.test.ts` (6111 cases).
5. `tests/payroll-contract.test.mjs`: REMOVE the two lines `pph21ReceivableIdr: 0,` and `pph21ReceivableCollectedIdr: 0,` you find in `zeroTotals` (another agent fixes them on ws/pph21-overwithhold; we merge that). Keep our three new fields. That test will fail until the merge: expected.
   Run: `LEGEND_TEST_FILES="src/test/accounting-payroll-journal.test.ts src/test/accounting-payroll-receivable.test.ts src/test/accounting-coa-backfill-1204.test.ts" pnpm test`, `node --test tests/accounting-contract.test.mjs`, prettier + eslint on changed files. Do not commit.
