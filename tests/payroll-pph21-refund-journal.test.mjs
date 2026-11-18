// Payroll PPh 21 refund journal (bead legend-51h1, card 972 "jangan sampai rugi").
// Rule: when PPh 21 withheld exceeds the tax owed (lebih potong, "T"), the
// excess returns to the employee (PPH21_REFUND earning) and/or to the employer
// (tax it bore earlier). The PPh 21 payable (2202) the run credits must equal
//   pph21Idr = withheld + employer borne + receivable - employee refund - employer refund
// and never be LOWER than what must be deposited to the tax office.
// Unit level: `payrollRunTotalsSchema`, `payrollJournalAmounts`, the
// `payroll.locked` / `payroll.reversed` posting rules. Run with `pnpm test`.
//
// ASSUMPTION: the brief says totals have no refund/borne columns; the shared
// schema already carries them (legend-w6vah). These tests pin the contract so a
// regression (refund dropped, payable understated, journal unbalanced) fails.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
import { payrollRunTotalsSchema } from "../packages/shared/src/hris/payroll/payslips.ts";

/** Synthetic map: the account id of a role is the role name, so lines read by role. */
const roles = new Set(
  acc.defaultPostingRules.flatMap((r) => r.lines.map((l) => l.role)),
);
const map = new Map([...roles].map((role) => [role, role]));

/**
 * Consistent totals builder. Inputs (per run): gross, withheld W, borne B,
 * receivable R, employee refund rf, employer refund erf (allowance part erfA),
 * collected, loan, late, custom. Net, deductions and pph21Idr are derived with
 * the contract formulas so the schema accepts them.
 */
function totalsOf({
  gross = 10_000_000,
  withheld = 250_000,
  borne = 0,
  receivable = 0,
  refund = 0,
  employerRefund = 0,
  employerAllowanceRefund = 0,
  collected = 0,
  loan = 0,
  late = 0,
  custom = 0,
  serviceCharge = 0,
  reimbursement = 0,
} = {}) {
  const bpjsEmp = 300_000;
  const deductions = bpjsEmp + withheld + loan + collected + late + custom;
  const net = gross - deductions;
  return {
    employeeCount: 1,
    grossIdr: gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: bpjsEmp,
    bpjsCompanyIdr: 400_000,
    pph21Idr: withheld + borne + receivable - refund - employerRefund,
    pph21WithheldIdr: withheld,
    pph21EmployerBorneIdr: borne,
    pph21RefundIdr: refund,
    pph21EmployerRefundIdr: employerRefund,
    pph21EmployerAllowanceRefundIdr: employerAllowanceRefund,
    loanRepaymentIdr: loan,
    pph21ReceivableIdr: receivable,
    pph21ReceivableCollectedIdr: collected,
    otherDeductionsIdr: late + custom,
    customDeductionsIdr: custom,
    serviceChargeIdr: serviceCharge,
    reimbursementIdr: reimbursement,
    bankTransferIdr: net,
    cashIdr: 0,
  };
}

const rule = (eventName) =>
  acc.resolvePostingRule(acc.defaultPostingRules, { eventName });

/** Build the journal of a run's totals and fold it by role. */
function journalOf(totals, eventName = "payroll.locked") {
  const lines = acc.buildJournalLinesFromRule(
    rule(eventName),
    acc.payrollJournalAmounts(totals),
    map,
    { outletId: null },
  );
  const byRole = {};
  for (const l of lines) {
    const row = (byRole[l.accountId] ??= { debit: 0, credit: 0 });
    row.debit += l.debitIdr;
    row.credit += l.creditIdr;
  }
  const sum = (side) => lines.reduce((s, l) => s + l[`${side}Idr`], 0);
  return { lines, byRole, debit: sum("debit"), credit: sum("credit") };
}

const payable = (j) => j.byRole.pph21_payable?.credit ?? 0;

describe("legend-51h1 PPh 21 payable = withheld + borne + receivable - refunds", () => {
  test("employee refund: payable shrinks by the refund and the journal balances", () => {
    // Withheld 250.000, tax owed 200.000: 50.000 paid back as an earning line.
    const totals = totalsOf({ withheld: 250_000, refund: 50_000 });
    const j = journalOf(totals);
    assert.equal(payable(j), 200_000);
    assert.equal(payable(j), totals.pph21Idr);
    assert.equal(j.debit, j.credit);
  });

  test("employer refund (borne part): payable shrinks and 6111 is credited back", () => {
    const totals = totalsOf({
      withheld: 250_000,
      borne: 100_000,
      employerRefund: 40_000,
    });
    const j = journalOf(totals);
    assert.equal(payable(j), 250_000 + 100_000 - 40_000);
    // The borne tax debited 100.000; 40.000 of it returns to the employer.
    assert.deepEqual(j.byRole.pph21_borne_expense, {
      debit: 100_000,
      credit: 40_000,
    });
    assert.equal(j.debit, j.credit);
  });

  test("employer refund (gross-up allowance part): credits salary_expense, not borne expense", () => {
    const totals = totalsOf({
      withheld: 250_000,
      employerRefund: 40_000,
      employerAllowanceRefund: 30_000,
    });
    const j = journalOf(totals);
    assert.equal(payable(j), 250_000 - 40_000);
    assert.equal(j.byRole.salary_expense.credit, 30_000);
    assert.equal(j.byRole.pph21_borne_expense.credit, 10_000);
    assert.equal(j.debit, j.credit);
  });

  test("employee refund + employer refund + borne + receivable + collected in one run", () => {
    const totals = totalsOf({
      gross: 12_000_000,
      withheld: 300_000,
      borne: 80_000,
      receivable: 25_000,
      refund: 60_000,
      employerRefund: 20_000,
      employerAllowanceRefund: 5_000,
      collected: 15_000,
      loan: 100_000,
      late: 10_000,
      custom: 20_000,
      serviceCharge: 500_000,
      reimbursement: 150_000,
    });
    const j = journalOf(totals);
    assert.equal(payable(j), 300_000 + 80_000 + 25_000 - 60_000 - 20_000);
    assert.equal(payable(j), totals.pph21Idr);
    assert.equal(j.debit, j.credit);
    // payroll.reversed mirrors every line of payroll.locked.
    const r = journalOf(totals, "payroll.reversed");
    assert.equal(r.debit, r.credit);
    for (const [role, row] of Object.entries(j.byRole))
      assert.deepEqual(r.byRole[role], {
        debit: row.credit,
        credit: row.debit,
      });
  });

  test("withheld > tax owed with no refund booked is refused (payable cannot be understated)", () => {
    // pph21Idr below the contract formula would under-deposit tax: refuse.
    const bad = { ...totalsOf({ withheld: 250_000 }), pph21Idr: 200_000 };
    assert.equal(payrollRunTotalsSchema.safeParse(bad).success, false);
    assert.throws(() => acc.payrollJournalAmounts(bad));
  });

  test("a refund larger than what the run withheld stays inside the contract formula", () => {
    // Employee refund of an earlier over-withholding can exceed this run's
    // withheld; pph21Idr may then be negative (idrSchema) and the journal flips
    // the line to a debit instead of crediting a negative amount.
    const totals = totalsOf({ withheld: 0, refund: 30_000 });
    assert.equal(totals.pph21Idr, -30_000);
    const j = journalOf(totals);
    assert.equal(j.debit, j.credit);
    assert.deepEqual(j.byRole.pph21_payable, { debit: 30_000, credit: 0 });
  });

  test("allowance refund part cannot exceed the employer refund", () => {
    const bad = totalsOf({
      employerRefund: 10_000,
      employerAllowanceRefund: 20_000,
    });
    assert.equal(payrollRunTotalsSchema.safeParse(bad).success, false);
  });

  test("employee refund + service charge + reimbursement cannot exceed gross", () => {
    const bad = totalsOf({
      gross: 100_000,
      refund: 60_000,
      serviceCharge: 30_000,
      reimbursement: 20_000,
      withheld: 0,
    });
    assert.equal(payrollRunTotalsSchema.safeParse(bad).success, false);
  });

  test("sweep: every combination of refunds balances, payable equals pph21Idr, never below the formula", () => {
    const cases = [0, 1, 25_000, 90_000];
    for (const refund of cases)
      for (const employerRefund of cases)
        for (const borne of [0, 120_000])
          for (const receivable of [0, 35_000])
            for (const allowancePart of [0, employerRefund]) {
              const totals = totalsOf({
                withheld: 250_000,
                refund,
                employerRefund,
                employerAllowanceRefund: allowancePart,
                borne,
                receivable,
              });
              const j = journalOf(totals);
              const formula =
                250_000 + borne + receivable - refund - employerRefund;
              assert.equal(j.debit, j.credit, JSON.stringify(totals));
              assert.equal(payable(j), formula, JSON.stringify(totals));
              assert.ok(payable(j) >= formula);
            }
  });

  test("totals without refund columns (zero) post exactly as a plain run", () => {
    const j = journalOf(totalsOf());
    assert.equal(payable(j), 250_000);
    assert.equal(j.byRole.pph21_borne_expense, undefined);
  });
});
