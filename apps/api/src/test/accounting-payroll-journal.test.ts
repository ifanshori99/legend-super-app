// Balanced payroll journal (legend-s8a3, brief docs/briefs/sub-174-payroll-journal.md):
// `payroll.locked` and `payroll.reversed` fed from `payrollRunTotalsSchema` via
// `payrollJournalAmounts`, plus `employee_loan.disbursed` and
// `reimbursement.paid#cash`. Pure rule tests, no database.
//
// Three layers:
// 1. one case per combination (LATE, loan, PPh 21 borne, employee refund,
//    employer refund, receivable, service charge, reimbursement, all at once,
//    negative PPh 21) with the Rupiah per account code written out by hand;
// 2. the reversal is the exact mirror of the lock;
// 3. a seeded property test over payslips built with the real PPh 21 engine
//    (`computePayslipTax`), summed by `sumPayrollRunTotals`.
//
// legend-75kr / legend-k8sz / legend-1coh (brief
// docs/briefs/sub-payroll-journal-followups.md) add three more groups below:
// custom deductions credit their own role `payroll_custom_deduction`, a service
// charge mapped to revenue is paid out from salary expense
// (`payroll.locked#service_charge_expense`), and a kasbon is disbursed from
// petty cash or the bank (`employee_loan.disbursed#cash` / `#bank`).
//
// The employer refund is split (legend-w6vah): the part returning an earlier
// gross-up tax allowance credits 6101 (the allowance was booked there), the
// rest credits 6111 (employer-borne PPh 21).

import { describe, expect, it } from "vitest";
import {
  accountIdSchema,
  accountMapFor,
  accountMappingSchema,
  buildJournalLinesFromRule,
  defaultPostingRules,
  legalEntityIdSchema,
  payrollJournalAmounts,
  payrollLockedVariant,
  postingRuleAmountKeys,
  resolvePostingRule,
  standardFnbChartTemplate,
} from "@starter/shared/accounting";
import {
  DEFAULT_PPH21_POLICY,
  computePayslipTax,
  employeeLoanDisbursed,
  payrollRunTotalsSchema,
  payslipCalculationSchema,
  payslipLineSchema,
  payslipWithholdingCap,
  planPph21ReceivableCollection,
  sumPayrollRunTotals,
  type PayrollRunTotals,
  type PayslipLine,
} from "@starter/shared/hris/payroll";
import type { TaxScheme } from "@starter/shared/hris/payroll";
import { idr } from "@starter/shared/core";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

const entity = legalEntityIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
const tenantId = "22222222-2222-4222-8222-222222222222";

const accountIds = new Map(
  standardFnbChartTemplate.map((row, index) => [
    row.code,
    accountIdSchema.parse(
      `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
    ),
  ]),
);
// Extra accounts outside the standard chart: a liability for the remapped
// payroll_custom_deduction role ("Utang Iuran Koperasi") and a revenue account
// for a service charge the tenant maps to revenue.
const koperasiLiabilityId = accountIdSchema.parse(
  "33333333-3333-4333-8333-000000009001",
);
const scRevenueId = accountIdSchema.parse(
  "33333333-3333-4333-8333-000000009002",
);
const codeOfAccount = new Map<string, string>([
  ...[...accountIds].map(([code, id]) => [id as string, code] as const),
  [koperasiLiabilityId as string, "2199"],
  [scRevenueId as string, "4199"],
]);
const accountMap = accountMapFor(
  standardFnbChartTemplate.flatMap((row) =>
    row.roles.map((role) =>
      accountMappingSchema.parse({
        tenantId,
        legalEntityId: entity,
        role,
        accountId: accountIds.get(row.code),
      }),
    ),
  ),
  entity,
);

/** The standard map with some roles pointed at another account (null: unmapped). */
function mapWith(
  over: Partial<Record<string, typeof koperasiLiabilityId | null>>,
) {
  return accountMapFor(
    [
      ...standardFnbChartTemplate.flatMap((row) =>
        row.roles
          .filter((role) => !(role in over))
          .map((role) =>
            accountMappingSchema.parse({
              tenantId,
              legalEntityId: entity,
              role,
              accountId: accountIds.get(row.code),
            }),
          ),
      ),
      ...Object.entries(over)
        .filter(([, accountId]) => accountId)
        .map(([role, accountId]) =>
          accountMappingSchema.parse({
            tenantId,
            legalEntityId: entity,
            role,
            accountId,
          }),
        ),
    ],
    entity,
  );
}
const splitMap = mapWith({ payroll_custom_deduction: koperasiLiabilityId });

type ByCode = Record<string, { debit: number; credit: number }>;
type Built = ReturnType<typeof buildJournalLinesFromRule>;

const rule = (eventName: string, variant?: string) =>
  resolvePostingRule(
    defaultPostingRules,
    variant === undefined ? { eventName } : { eventName, variant },
  );

const lockedRule = rule("payroll.locked");
const reversedRule = rule("payroll.reversed");

function summarise(lines: Built) {
  const byCode: ByCode = {};
  for (const line of lines) {
    const code = codeOfAccount.get(line.accountId as string)!;
    const row = (byCode[code] ??= { debit: 0, credit: 0 });
    row.debit += line.debitIdr;
    row.credit += line.creditIdr;
  }
  return {
    byCode,
    debit: lines.reduce((sum, line) => sum + line.debitIdr, 0),
    credit: lines.reduce((sum, line) => sum + line.creditIdr, 0),
  };
}

const build = (
  postingRule: ReturnType<typeof rule>,
  amounts: Record<string, number>,
  map: typeof accountMap = accountMap,
): Built =>
  buildJournalLinesFromRule(postingRule, amounts, map, {
    outletId: null,
  });

const lockLines = (
  totals: PayrollRunTotals,
  map: typeof accountMap = accountMap,
) => build(lockedRule, payrollJournalAmounts(totals), map);
const reverseLines = (
  totals: PayrollRunTotals,
  map: typeof accountMap = accountMap,
) => build(reversedRule, payrollJournalAmounts(totals), map);

/**
 * Run totals from the parts a payroll has. Everything derived follows the
 * schema identities: pph21 = W + B + R - rf - erf, deductions = employee BPJS
 * + W + loan + collected + other, net = gross - deductions. `gross` already
 * contains the PPh 21 refund, service charge and reimbursement.
 */
type Parts = {
  gross: number;
  bpjsEmp?: number;
  bpjsCo?: number;
  withheld?: number;
  borne?: number;
  receivable?: number;
  refund?: number;
  /** Total employer refund; `employerAllowanceRefund` is the 6101 part of it. */
  employerRefund?: number;
  employerAllowanceRefund?: number;
  loan?: number;
  collected?: number;
  /** LATE (other deductions that are not custom). */
  other?: number;
  /** Custom deductions (koperasi dues etc.); part of otherDeductionsIdr. */
  custom?: number;
  serviceCharge?: number;
  reimbursement?: number;
};
function totalsOf(parts: Parts): PayrollRunTotals {
  const p = {
    bpjsEmp: 0,
    bpjsCo: 0,
    withheld: 0,
    borne: 0,
    receivable: 0,
    refund: 0,
    employerRefund: 0,
    employerAllowanceRefund: 0,
    loan: 0,
    collected: 0,
    other: 0,
    custom: 0,
    serviceCharge: 0,
    reimbursement: 0,
    ...parts,
  };
  const deductions =
    p.bpjsEmp + p.withheld + p.loan + p.collected + p.other + p.custom;
  const net = p.gross - deductions;
  return payrollRunTotalsSchema.parse({
    employeeCount: 1,
    grossIdr: p.gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: p.bpjsEmp,
    bpjsCompanyIdr: p.bpjsCo,
    pph21Idr: p.withheld + p.borne + p.receivable - p.refund - p.employerRefund,
    pph21WithheldIdr: p.withheld,
    pph21EmployerBorneIdr: p.borne,
    pph21RefundIdr: p.refund,
    pph21EmployerRefundIdr: p.employerRefund,
    pph21EmployerAllowanceRefundIdr: p.employerAllowanceRefund,
    loanRepaymentIdr: p.loan,
    pph21ReceivableIdr: p.receivable,
    pph21ReceivableCollectedIdr: p.collected,
    otherDeductionsIdr: p.other + p.custom,
    customDeductionsIdr: p.custom,
    serviceChargeIdr: p.serviceCharge,
    reimbursementIdr: p.reimbursement,
    bankTransferIdr: net,
    cashIdr: 0,
  });
}

// Accounts: 6101 salary expense, 6102 employer BPJS, 6110 reimbursement,
// 6111 employer-borne PPh 21, 2103 salaries payable, 2104 BPJS payable, 2106
// service charge, 2202 PPh 21 payable, 1204 employee receivable, 1102 petty
// cash.
const base = {
  gross: 10_000_000,
  bpjsEmp: 300_000,
  bpjsCo: 400_000,
  withheld: 250_000,
};

const cases: [string, Parts, ByCode][] = [
  [
    "LATE 75.000 (other deduction) credits salary expense",
    { ...base, other: 75_000 },
    {
      "6101": { debit: 10_000_000, credit: 75_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_375_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    },
  ],
  [
    "custom deduction 60.000 with the default mapping credits 6101 like LATE",
    { ...base, custom: 60_000 },
    {
      "6101": { debit: 10_000_000, credit: 60_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_390_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    },
  ],
  [
    "loan installment 500.000 credits employee receivable",
    { ...base, loan: 500_000 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 8_950_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
      "1204": { debit: 0, credit: 500_000 },
    },
  ],
  [
    "PPh 21 borne by the employer B 124.062 (the real case)",
    { ...base, borne: 124_062 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6111": { debit: 124_062, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 374_062 },
    },
  ],
  [
    "employee refund 90.000 paid as an earning inside gross",
    { ...base, gross: 10_090_000, refund: 90_000 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_540_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 160_000 },
    },
  ],
  [
    "employer refund 40.000 of borne tax credits 6111",
    { ...base, employerRefund: 40_000 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6111": { debit: 0, credit: 40_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 210_000 },
    },
  ],
  [
    "employer refund 40.000 of a gross-up allowance credits 6101, not 6111",
    { ...base, employerRefund: 40_000, employerAllowanceRefund: 40_000 },
    {
      "6101": { debit: 10_000_000, credit: 40_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 210_000 },
    },
  ],
  [
    "employer refund 40.000 split 30.000 allowance / 10.000 borne",
    { ...base, employerRefund: 40_000, employerAllowanceRefund: 30_000 },
    {
      "6101": { debit: 10_000_000, credit: 30_000 },
      "6111": { debit: 0, credit: 10_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 210_000 },
    },
  ],
  [
    "receivable 200.000 raised and 100.000 collected",
    { ...base, receivable: 200_000, collected: 100_000 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "1204": { debit: 200_000, credit: 100_000 },
      "2103": { debit: 0, credit: 9_350_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 450_000 },
    },
  ],
  [
    "service charge 1.000.000 inside gross goes to the 2106 liability",
    { ...base, serviceCharge: 1_000_000 },
    {
      "6101": { debit: 9_000_000, credit: 0 },
      "2106": { debit: 1_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    },
  ],
  [
    "reimbursement 300.000 inside gross goes to 6110",
    { ...base, reimbursement: 300_000 },
    {
      "6101": { debit: 9_700_000, credit: 0 },
      "6110": { debit: 300_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    },
  ],
  [
    "everything at once",
    {
      gross: 20_000_000,
      bpjsEmp: 300_000,
      bpjsCo: 400_000,
      withheld: 250_000,
      borne: 124_062,
      receivable: 200_000,
      refund: 90_000,
      employerRefund: 40_000,
      employerAllowanceRefund: 25_000,
      loan: 500_000,
      collected: 100_000,
      other: 75_000,
      custom: 60_000,
      serviceCharge: 1_000_000,
      reimbursement: 300_000,
    },
    {
      // 20.000.000 - 90.000 - 1.000.000 - 300.000; credit = LATE 75.000 +
      // custom 60.000 (default mapping: same account) + the allowance part
      // 25.000 of the employer refund 40.000
      "6101": { debit: 18_610_000, credit: 160_000 },
      "6111": { debit: 124_062, credit: 15_000 },
      "2106": { debit: 1_000_000, credit: 0 },
      "6110": { debit: 300_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "1204": { debit: 200_000, credit: 600_000 },
      "2103": { debit: 0, credit: 18_715_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 444_062 },
    },
  ],
  [
    "negative PPh 21 (refund 200.000 > withheld 50.000) debits 2202",
    { ...base, gross: 10_200_000, withheld: 50_000, refund: 200_000 },
    {
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_850_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 150_000, credit: 0 },
    },
  ],
];

describe("payroll.locked from run totals", () => {
  it("amount keys are exactly what payrollJournalAmounts returns", () => {
    expect(postingRuleAmountKeys(lockedRule)).toEqual(
      Object.keys(payrollJournalAmounts(totalsOf(base))).sort(),
    );
    expect(postingRuleAmountKeys(reversedRule)).toEqual(
      postingRuleAmountKeys(lockedRule),
    );
  });

  it("the placeholder payroll_run.completed rule is gone", () => {
    expect(() => rule("payroll_run.completed")).toThrow(/No posting rule/);
  });

  it.each(cases)("%s", (_name, parts, expected) => {
    const { byCode, debit, credit } = summarise(lockLines(totalsOf(parts)));
    expect(byCode).toEqual(expected);
    expect(debit).toBe(credit);
  });

  it("maps totals to the documented amount keys", () => {
    const [, parts] = cases.find(([name]) => name === "everything at once")!;
    expect(payrollJournalAmounts(totalsOf(parts))).toEqual({
      salaryExpenseIdr: 18_610_000,
      pph21EmployerBorneIdr: 124_062,
      pph21EmployerAllowanceRefundIdr: 25_000,
      pph21EmployerBorneRefundIdr: 15_000,
      lateDeductionsIdr: 75_000,
      customDeductionsIdr: 60_000,
      serviceChargeIdr: 1_000_000,
      reimbursementIdr: 300_000,
      bpjsCompanyIdr: 400_000,
      bpjsTotalIdr: 700_000,
      pph21ReceivableIdr: 200_000,
      pph21ReceivableCollectedIdr: 100_000,
      loanRepaymentIdr: 500_000,
      netIdr: 18_715_000,
      pph21Idr: 444_062,
    });
  });

  it("refuses totals that break an identity before posting anything", () => {
    const good = totalsOf(base);
    expect(() =>
      payrollJournalAmounts({ ...good, pph21Idr: idr(good.pph21Idr + 1) }),
    ).toThrow();
  });
});

describe("payroll.reversed mirrors payroll.locked", () => {
  it.each(cases)("%s", (_name, parts) => {
    const totals = totalsOf(parts);
    const locked = lockLines(totals);
    const reversed = reverseLines(totals);
    expect(reversed).toHaveLength(locked.length);
    expect(
      reversed.map((l) => ({
        accountId: l.accountId,
        debitIdr: l.creditIdr,
        creditIdr: l.debitIdr,
      })),
    ).toEqual(
      locked.map((l) => ({
        accountId: l.accountId,
        debitIdr: l.debitIdr,
        creditIdr: l.creditIdr,
      })),
    );
    const sum = summarise(reversed);
    expect(sum.debit).toBe(sum.credit);
  });

  it("locked and reversed net to zero per account", () => {
    const everything = cases.find(([name]) => name === "everything at once")!;
    const totals = totalsOf(everything[1]);
    const both = summarise([...lockLines(totals), ...reverseLines(totals)]);
    for (const row of Object.values(both.byCode))
      expect(row.debit).toBe(row.credit);
  });
});

describe("payroll.paid settles the salaries payable", () => {
  it("debits 2103 by the net and credits bank and petty cash by the split", () => {
    const { byCode, debit, credit } = summarise(
      build(rule("payroll.paid"), {
        netIdr: 9_450_000,
        bankTransferIdr: 9_000_000,
        cashIdr: 450_000,
      }),
    );
    expect(byCode).toEqual({
      "2103": { debit: 9_450_000, credit: 0 },
      "1103": { debit: 0, credit: 9_000_000 },
      "1102": { debit: 0, credit: 450_000 },
    });
    expect(debit).toBe(credit);
  });

  it("lock then pay nets 2103 to zero", () => {
    const totals = totalsOf({ ...base, employerRefund: 40_000 });
    const both = summarise([
      ...lockLines(totals),
      ...build(rule("payroll.paid"), {
        netIdr: totals.netIdr,
        bankTransferIdr: totals.bankTransferIdr,
        cashIdr: totals.cashIdr,
      }),
    ]);
    expect(both.byCode["2103"]).toEqual({
      debit: totals.netIdr,
      credit: totals.netIdr,
    });
  });
});

describe("employee_loan.disbursed and reimbursement.paid#cash", () => {
  it("disbursing a loan debits 1204 and credits petty cash", () => {
    const { byCode, debit, credit } = summarise(
      build(rule("employee_loan.disbursed"), { principalIdr: 2_000_000 }),
    );
    expect(byCode).toEqual({
      "1204": { debit: 2_000_000, credit: 0 },
      "1102": { debit: 0, credit: 2_000_000 },
    });
    expect(debit).toBe(credit);
  });

  it("a cash reimbursement debits 6110 and credits petty cash", () => {
    const { byCode, debit, credit } = summarise(
      build(rule("reimbursement.paid", "cash"), { amountIdr: 450_000 }),
    );
    expect(byCode).toEqual({
      "6110": { debit: 450_000, credit: 0 },
      "1102": { debit: 0, credit: 450_000 },
    });
    expect(debit).toBe(credit);
  });

  it("a payroll payout posts nothing here: the run journal carries it", () => {
    expect(() => rule("reimbursement.paid", "payroll")).toThrow(
      /No posting rule/,
    );
    expect(() => rule("reimbursement.paid")).toThrow(/No posting rule/);
  });
});

describe("run totals schema guards the journal identities", () => {
  const good = totalsOf({ ...base, borne: 124_062 });

  it("accepts consistent totals", () => {
    expect(payrollRunTotalsSchema.safeParse(good).success).toBe(true);
  });

  it("rejects a broken PPh 21 identity", () => {
    for (const patch of [
      { pph21Idr: good.pph21Idr + 1 },
      { pph21EmployerBorneIdr: good.pph21EmployerBorneIdr + 1 },
      { pph21RefundIdr: 1 },
      { pph21EmployerRefundIdr: 1 },
      { pph21ReceivableIdr: 1 },
    ]) {
      const result = payrollRunTotalsSchema.safeParse({ ...good, ...patch });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues.some((i) => i.path[0] === "pph21Idr")).toBe(
          true,
        );
    }
  });

  it("rejects refund + service charge + reimbursement above gross", () => {
    // Identities hold (pph21 = -refund, net = gross), only the split is wrong.
    const over = {
      ...good,
      grossIdr: 100,
      deductionsIdr: 0,
      netIdr: 100,
      bankTransferIdr: 100,
      bpjsEmployeeIdr: 0,
      bpjsCompanyIdr: 0,
      pph21Idr: -20,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 20,
      pph21EmployerRefundIdr: 0,
      pph21ReceivableIdr: 0,
      pph21ReceivableCollectedIdr: 0,
      loanRepaymentIdr: 0,
      otherDeductionsIdr: 0,
      cashIdr: 0,
      serviceChargeIdr: 60,
      reimbursementIdr: 30,
    };
    const result = payrollRunTotalsSchema.safeParse(over);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((i) => i.path[0])).toEqual([
        "serviceChargeIdr",
      ]);
    expect(
      payrollRunTotalsSchema.safeParse({
        ...over,
        pph21RefundIdr: 10,
        pph21Idr: -10,
      }).success,
    ).toBe(true);
  });
});

// ---- legend-w6vah: employer refund split between 6101 and 6111 -------------

/**
 * December annual recalculation of a gross-up employee (10.000.000 a month,
 * TK/0). `prior` is the Jan-Nov history the payroll run sums: eleven months of
 * 10.000.000 plus the employer-funded tax inside it.
 */
function decemberTax(prior: { allowance: number; borne: number }) {
  return computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    earnings: [{ amountIdr: 10_000_000, taxable: true, taxScheme: "gross_up" }],
    employerBenefitIdr: 0,
    contractTaxScheme: "gross_up",
    employeeDeductibleIdr: 0,
    prior: {
      taxableGrossIdr: 110_000_000 + prior.allowance + prior.borne,
      employeeDeductibleIdr: 0,
      // The gross-up allowance is withheld from the pay and handed back as
      // TAX_ALLOWANCE, so it is part of the withheld history.
      pph21WithheldIdr: prior.allowance,
      pph21EmployerBorneIdr: prior.borne,
      taxAllowanceIdr: prior.allowance,
    },
  }).tax;
}

describe("employer refund split (legend-w6vah)", () => {
  it("gross-up only history: the whole refund 150.000 credits 6101, 6111 untouched", () => {
    // Jan-Nov allowance 3.705.750 (prior borne 0). The annual tax of the year
    // is 3.555.750 lower, so December returns 150.000 to the company.
    const tax = decemberTax({ allowance: 3_705_750, borne: 0 });
    expect(tax.method).toBe("annual_recalculation");
    expect(tax.pph21EmployerRefundIdr).toBe(150_000);
    expect(tax.pph21EmployerAllowanceRefundIdr).toBe(150_000);
    expect(tax.pph21WithheldIdr).toBe(0);
    expect(tax.pph21EmployerBorneIdr).toBe(0);

    const totals = totalsOf({
      gross: 10_000_000,
      employerRefund: tax.pph21EmployerRefundIdr,
      employerAllowanceRefund: tax.pph21EmployerAllowanceRefundIdr ?? 0,
    });
    expect(totals.pph21Idr).toBe(-150_000);
    expect(payrollJournalAmounts(totals)).toMatchObject({
      pph21EmployerAllowanceRefundIdr: 150_000,
      pph21EmployerBorneRefundIdr: 0,
    });
    const { byCode, debit, credit } = summarise(lockLines(totals));
    expect(byCode["6101"]).toEqual({ debit: 10_000_000, credit: 150_000 });
    expect(byCode["6111"]).toBeUndefined();
    // The negative PPh 21 payable (-150.000) flips to the debit side.
    expect(byCode["2202"]).toEqual({ debit: 150_000, credit: 0 });
    expect(byCode["2103"]).toEqual({ debit: 0, credit: 10_000_000 });
    expect(debit).toBe(credit);
  });

  it("mixed history splits proportionally: 300.000 allowance / 100.000 borne", () => {
    // Allowance 3.000.000 + borne 1.000.000 of earlier employer tax; December
    // returns 400.000, floor(400.000 x 3.000.000 / 4.000.000) = 300.000 of it
    // for the allowance.
    const tax = decemberTax({ allowance: 3_000_000, borne: 1_000_000 });
    expect(tax.pph21EmployerRefundIdr).toBe(400_000);
    expect(tax.pph21EmployerAllowanceRefundIdr).toBe(300_000);

    const totals = totalsOf({
      gross: 10_000_000,
      employerRefund: tax.pph21EmployerRefundIdr,
      employerAllowanceRefund: tax.pph21EmployerAllowanceRefundIdr ?? 0,
    });
    const amounts = payrollJournalAmounts(totals);
    expect(amounts.pph21EmployerAllowanceRefundIdr).toBe(300_000);
    expect(amounts.pph21EmployerBorneRefundIdr).toBe(100_000);
    const { byCode, debit, credit } = summarise(lockLines(totals));
    expect(byCode["6101"]).toEqual({ debit: 10_000_000, credit: 300_000 });
    expect(byCode["6111"]).toEqual({ debit: 0, credit: 100_000 });
    expect(debit).toBe(credit);
  });

  it("the parts sum exactly to the refund and the odd rupiah goes to the borne part", () => {
    for (const [allowance, borne] of [
      [3_000_001, 1_000_000],
      [2_999_999, 1_000_003],
      [1_234_567, 2_345_678],
      [3_500_000, 400_000],
    ] as const) {
      const tax = decemberTax({ allowance, borne });
      const erf = tax.pph21EmployerRefundIdr;
      const part = tax.pph21EmployerAllowanceRefundIdr ?? 0;
      expect(erf).toBeGreaterThan(0);
      expect(part).toBe(Math.floor((erf * allowance) / (allowance + borne)));
      expect(part).toBeLessThanOrEqual(allowance);
      expect(part).toBeLessThanOrEqual(erf);
      const amounts = payrollJournalAmounts(
        totalsOf({
          gross: 10_000_000,
          employerRefund: erf,
          employerAllowanceRefund: part,
        }),
      );
      expect(
        amounts.pph21EmployerAllowanceRefundIdr +
          amounts.pph21EmployerBorneRefundIdr,
      ).toBe(erf);
    }
  });

  it("history without an allowance refunds only borne tax", () => {
    const tax = decemberTax({ allowance: 0, borne: 4_000_000 });
    expect(tax.pph21EmployerRefundIdr).toBeGreaterThan(0);
    expect(tax.pph21EmployerAllowanceRefundIdr ?? 0).toBe(0);
  });

  it("the totals schema refuses an allowance refund above the employer refund", () => {
    const good = totalsOf({ ...base, employerRefund: 40_000 });
    const result = payrollRunTotalsSchema.safeParse({
      ...good,
      pph21EmployerAllowanceRefundIdr: 40_001,
    });
    expect(result.success).toBe(false);
  });
});

// ---- legend-75kr: custom deductions have their own role --------------------

describe("custom deductions credit payroll_custom_deduction (legend-75kr)", () => {
  // LATE 75.000 and a koperasi due of 60.000 in the same run.
  const mixed: Parts = { ...base, other: 75_000, custom: 60_000 };

  it("the standard chart maps the role to 6101 together with salary_expense", () => {
    const row = standardFnbChartTemplate.find((r) => r.code === "6101");
    expect(row?.roles).toEqual(["salary_expense", "payroll_custom_deduction"]);
  });

  it("remapped to a liability: custom credits that account, LATE still credits 6101", () => {
    const { byCode, debit, credit } = summarise(
      lockLines(totalsOf(mixed), splitMap),
    );
    expect(byCode).toEqual({
      "6101": { debit: 10_000_000, credit: 75_000 },
      "2199": { debit: 0, credit: 60_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_315_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    });
    expect(debit).toBe(10_400_000);
    expect(debit).toBe(credit);
  });

  it("with the default mapping custom and LATE both land on 6101 (today's posting)", () => {
    const { byCode, debit, credit } = summarise(lockLines(totalsOf(mixed)));
    expect(byCode["6101"]).toEqual({ debit: 10_000_000, credit: 135_000 });
    expect(byCode["2199"]).toBeUndefined();
    expect(debit).toBe(credit);
  });

  it("splits the amount keys: late + custom = otherDeductionsIdr", () => {
    const totals = totalsOf(mixed);
    const amounts = payrollJournalAmounts(totals);
    expect(amounts.lateDeductionsIdr).toBe(75_000);
    expect(amounts.customDeductionsIdr).toBe(60_000);
    expect(amounts.lateDeductionsIdr + amounts.customDeductionsIdr).toBe(
      totals.otherDeductionsIdr,
    );
    expect("otherDeductionsIdr" in amounts).toBe(false);
  });

  it("locked and reversed are balanced and the reversal mirrors the lock (remapped)", () => {
    const totals = totalsOf(mixed);
    const locked = lockLines(totals, splitMap);
    const reversed = reverseLines(totals, splitMap);
    expect(reversed.map((l) => [l.accountId, l.creditIdr, l.debitIdr])).toEqual(
      locked.map((l) => [l.accountId, l.debitIdr, l.creditIdr]),
    );
    const both = summarise([...locked, ...reversed]);
    expect(summarise(reversed).debit).toBe(summarise(reversed).credit);
    for (const row of Object.values(both.byCode))
      expect(row.debit).toBe(row.credit);
    expect(both.byCode["2199"]).toEqual({ debit: 60_000, credit: 60_000 });
  });

  it("custom only: LATE is zero, so 6101 gets no credit when remapped", () => {
    const { byCode, debit, credit } = summarise(
      lockLines(totalsOf({ ...base, custom: 60_000 }), splitMap),
    );
    expect(byCode["6101"]).toEqual({ debit: 10_000_000, credit: 0 });
    expect(byCode["2199"]).toEqual({ debit: 0, credit: 60_000 });
    expect(debit).toBe(credit);
  });

  it("totals written before customDeductionsIdr parse to 0 and post exactly as before", () => {
    const { customDeductionsIdr, ...legacy } = totalsOf({
      ...base,
      other: 75_000,
    });
    void customDeductionsIdr;
    const parsed = payrollRunTotalsSchema.parse(legacy);
    expect(parsed.customDeductionsIdr).toBe(0);
    expect(parsed.otherDeductionsIdr).toBe(75_000);
    const amounts = payrollJournalAmounts(parsed);
    expect(amounts.lateDeductionsIdr).toBe(75_000);
    expect(amounts.customDeductionsIdr).toBe(0);
    // Even with the custom role remapped: all 75.000 stays on 6101, as before.
    const expected = cases.find(([name]) => name.startsWith("LATE 75.000"))![2];
    for (const map of [accountMap, splitMap])
      expect(summarise(lockLines(parsed, map)).byCode).toEqual(expected);
  });

  it("rejects custom deductions above the other deductions", () => {
    const good = totalsOf(mixed);
    expect(payrollRunTotalsSchema.safeParse(good).success).toBe(true);
    const over = payrollRunTotalsSchema.safeParse({
      ...good,
      customDeductionsIdr: good.otherDeductionsIdr + 1,
    });
    expect(over.success).toBe(false);
    if (!over.success)
      expect(over.error.issues.map((i) => i.path[0])).toEqual([
        "customDeductionsIdr",
      ]);
    expect(() =>
      payrollJournalAmounts({
        ...good,
        customDeductionsIdr: good.otherDeductionsIdr + 1,
      } as PayrollRunTotals),
    ).toThrow();
    // All other deductions custom (LATE zero) is fine.
    expect(
      payrollRunTotalsSchema.safeParse({
        ...good,
        customDeductionsIdr: good.otherDeductionsIdr,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative custom deduction total", () => {
    expect(
      payrollRunTotalsSchema.safeParse({
        ...totalsOf(mixed),
        customDeductionsIdr: -1,
      }).success,
    ).toBe(false);
  });

  it("sumPayrollRunTotals sums the custom_deduction lines only", () => {
    const rng = lcg(7);
    const slips = Array.from({ length: 200 }, () => fuzzSlip(rng));
    const expected = slips
      .flatMap((slip) => slip.lines)
      .filter(
        (l) => l.kind === "deduction" && l.category === "custom_deduction",
      )
      .reduce((sum, l) => sum + l.amountIdr, 0);
    const totals = sumPayrollRunTotals(slips);
    expect(expected).toBeGreaterThan(0);
    expect(totals.customDeductionsIdr).toBe(expected);
    expect(totals.otherDeductionsIdr).toBeGreaterThanOrEqual(expected);
  });

  it("with the role unmapped a custom deduction fails closed; zero custom still posts", () => {
    const unmapped = mapWith({ payroll_custom_deduction: null });
    expect(() => lockLines(totalsOf(mixed), unmapped)).toThrow(
      /payroll_custom_deduction/,
    );
    expect(() =>
      lockLines(totalsOf({ ...base, other: 75_000 }), unmapped),
    ).not.toThrow();
  });
});

// ---- legend-k8sz: service charge payout never debits revenue ---------------

describe("service charge mapped to revenue (legend-k8sz)", () => {
  const scMap = mapWith({ service_charge: scRevenueId });
  const withSc: Parts = { ...base, serviceCharge: 1_000_000 };
  const variantRule = rule("payroll.locked", "service_charge_expense");

  it("payrollLockedVariant picks the variant only for revenue; every other type or no mapping keeps the base rule", () => {
    expect(payrollLockedVariant("revenue")).toBe("service_charge_expense");
    expect(payrollLockedVariant("liability")).toBeUndefined();
    expect(payrollLockedVariant("expense")).toBeUndefined();
    expect(payrollLockedVariant("asset")).toBeUndefined();
    expect(payrollLockedVariant("equity")).toBeUndefined();
    expect(payrollLockedVariant(null)).toBeUndefined();
  });

  it("legacy expense / asset / equity mapping: the base rule debits the mapped account, not 6101", () => {
    // 6111 stands for any legacy non-liability account the tenant mapped; the
    // base case (no employer refund) posts nothing else to it.
    const legacyMap = mapWith({ service_charge: accountIds.get("6111")! });
    const { byCode, debit, credit } = summarise(
      lockLines(totalsOf(withSc), legacyMap),
    );
    expect(byCode["6111"]).toEqual({ debit: 1_000_000, credit: 0 });
    expect(byCode["2106"]).toBeUndefined();
    expect(byCode["6101"]).toEqual({ debit: 9_000_000, credit: 0 });
    expect(debit).toBe(credit);
  });

  it("the variant takes the same amount keys as the base rule", () => {
    expect(postingRuleAmountKeys(variantRule)).toEqual(
      postingRuleAmountKeys(lockedRule),
    );
  });

  it("revenue mapping: the 1.000.000 is debited to 6101, never to the revenue account or 2106", () => {
    const { byCode, debit, credit } = summarise(
      build(variantRule, payrollJournalAmounts(totalsOf(withSc)), scMap),
    );
    expect(byCode).toEqual({
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_450_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    });
    expect(byCode["4199"]).toBeUndefined();
    expect(byCode["2106"]).toBeUndefined();
    expect(debit).toBe(credit);
  });

  it("liability mapping keeps the base rule: Dr 2106 (case 'service charge 1.000.000')", () => {
    const [, parts, expected] = cases.find(([name]) =>
      name.startsWith("service charge 1.000.000"),
    )!;
    expect(payrollLockedVariant("liability")).toBeUndefined();
    expect(summarise(lockLines(totalsOf(parts))).byCode).toEqual(expected);
  });

  it("with no service charge the variant posts exactly like the base rule", () => {
    const amounts = payrollJournalAmounts(totalsOf({ ...base, other: 75_000 }));
    expect(summarise(build(variantRule, amounts, scMap)).byCode).toEqual(
      summarise(build(lockedRule, amounts, scMap)).byCode,
    );
  });

  it("everything at once: only the service charge debit moves from 2106 to 6101", () => {
    const [, parts, expected] = cases.find(
      ([name]) => name === "everything at once",
    )!;
    const { byCode, debit, credit } = summarise(
      build(variantRule, payrollJournalAmounts(totalsOf(parts)), scMap),
    );
    const { "2106": moved, ...rest } = expected;
    expect(moved).toEqual({ debit: 1_000_000, credit: 0 });
    expect(byCode).toEqual({
      ...rest,
      "6101": {
        debit: expected["6101"]!.debit + 1_000_000,
        credit: expected["6101"]!.credit,
      },
    });
    expect(debit).toBe(credit);
  });

  it("the lock mirrored (what the consumer's reversal posts) nets every account to zero", () => {
    const amounts = payrollJournalAmounts(totalsOf(withSc));
    const locked = build(variantRule, amounts, scMap);
    const mirrored = locked.map((l) => ({
      ...l,
      debitIdr: l.creditIdr,
      creditIdr: l.debitIdr,
    }));
    const both = summarise([...locked, ...mirrored]);
    for (const row of Object.values(both.byCode))
      expect(row.debit).toBe(row.credit);
  });

  it("no service charge mapping at all: the base rule fails closed when SC > 0", () => {
    const none = mapWith({ service_charge: null });
    expect(() => lockLines(totalsOf(withSc), none)).toThrow(/service_charge/);
  });
});

// ---- legend-1coh: kasbon disbursed through cash or bank ---------------------

describe("employee_loan.disbursed via cash or bank (legend-1coh)", () => {
  const principal = { principalIdr: 2_000_000 };

  it("cash credits petty cash 1102", () => {
    const { byCode, debit, credit } = summarise(
      build(rule("employee_loan.disbursed", "cash"), principal),
    );
    expect(byCode).toEqual({
      "1204": { debit: 2_000_000, credit: 0 },
      "1102": { debit: 0, credit: 2_000_000 },
    });
    expect(debit).toBe(credit);
  });

  it("bank credits the operating bank account 1103", () => {
    const { byCode, debit, credit } = summarise(
      build(rule("employee_loan.disbursed", "bank"), principal),
    );
    expect(byCode).toEqual({
      "1204": { debit: 2_000_000, credit: 0 },
      "1103": { debit: 0, credit: 2_000_000 },
    });
    expect(debit).toBe(credit);
  });

  it("the base rule (events without disbursedVia) still credits petty cash", () => {
    expect(
      summarise(build(rule("employee_loan.disbursed"), principal)).byCode,
    ).toEqual({
      "1204": { debit: 2_000_000, credit: 0 },
      "1102": { debit: 0, credit: 2_000_000 },
    });
  });

  it("all variants take only principalIdr, so one payload feeds any of them", () => {
    for (const variant of [undefined, "cash", "bank"])
      expect(
        postingRuleAmountKeys(rule("employee_loan.disbursed", variant)),
      ).toEqual(["principalIdr"]);
  });

  it("an unknown variant has no rule", () => {
    expect(() => rule("employee_loan.disbursed", "cheque")).toThrow(
      /No posting rule/,
    );
  });

  describe("event payload", () => {
    const payload = {
      employeeLoanId: "66666666-6666-4666-8666-000000000001",
      employeeId: "44444444-4444-4444-8444-000000000001",
      legalEntityId: entity,
      principalIdr: 2_000_000,
      disbursedBy: "77777777-7777-4777-8777-000000000001",
      disbursedAt: "2026-11-27T05:00:00.000Z",
    };

    it("disbursedVia is optional: events emitted before legend-1coh still parse", () => {
      const parsed = employeeLoanDisbursed.payloadSchema.parse(payload);
      expect(parsed.disbursedVia).toBeUndefined();
    });

    it.each(["cash", "bank"] as const)("accepts disbursedVia %s", (via) => {
      expect(
        employeeLoanDisbursed.payloadSchema.parse({
          ...payload,
          disbursedVia: via,
        }).disbursedVia,
      ).toBe(via);
    });

    it("rejects any other disbursedVia", () => {
      for (const via of ["cheque", "Bank", "", null])
        expect(
          employeeLoanDisbursed.payloadSchema.safeParse({
            ...payload,
            disbursedVia: via,
          }).success,
        ).toBe(false);
    });
  });
});

// ---- Property test over the real PPh 21 engine -----------------------------

/** Seeded LCG (Numerical Recipes constants); no dependency, replayable. */
function lcg(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return {
    float: next,
    int: (min: number, max: number) =>
      min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)]!,
  };
}
type Rng = ReturnType<typeof lcg>;

const FUZZ_SEED = 20_261_109;
const FUZZ_CASES = 2_500;
const PTKP_STATUSES = Object.keys(
  REFERENCE_TABLES.ptkp.annualAmountIdrByStatus,
) as (keyof typeof REFERENCE_TABLES.ptkp.annualAmountIdrByStatus)[];

const EMPLOYEE_ID = "44444444-4444-4444-8444-000000000001";
const OUTLET_ID = "55555555-5555-4555-8555-000000000001";

/**
 * One payslip as the payroll run builds it (fixtures.ts `calculate`): taxable
 * earnings through `computePayslipTax`, then TAX_ALLOWANCE and PPH21_REFUND
 * earnings, then deductions in the order BPJS_EMP, PPH21, LATE, receivable,
 * loan, custom, each limited by the pay left.
 */
function fuzzSlip(rng: Rng) {
  type Earning = {
    code: string;
    category: PayslipLine["category"];
    amount: number;
    taxable: boolean;
    scheme: TaxScheme;
  };
  const schemeOf = (): TaxScheme =>
    rng.pick(["gross", "gross", "gross", "gross_up", "net"] as const);
  const earnings: Earning[] = [
    {
      code: "BASIC",
      category: "base_salary",
      amount: rng.int(1_000, 60_000) * 1_000,
      taxable: true,
      scheme: schemeOf(),
    },
  ];
  if (rng.chance(0.4))
    earnings.push({
      code: "ALLOWANCE",
      category: "fixed_allowance",
      amount: rng.int(100, 5_000) * 1_000,
      taxable: true,
      scheme: schemeOf(),
    });
  if (rng.chance(0.5))
    earnings.push({
      code: "MEAL",
      category: "meal_allowance",
      amount: rng.int(10, 1_000) * 1_000,
      taxable: false,
      scheme: "gross",
    });
  if (rng.chance(0.4))
    earnings.push({
      code: "SERVICE_CHARGE",
      category: "service_charge",
      amount: rng.int(100, 3_000) * 1_000,
      taxable: true,
      scheme: "gross",
    });
  if (rng.chance(0.3))
    earnings.push({
      code: "REIMBURSEMENT",
      category: "reimbursement",
      amount: rng.int(50, 2_000) * 1_000,
      taxable: false,
      scheme: "gross",
    });

  // BPJS: employee shares of JHT, JP and health; employer shares of all five.
  const basic = earnings[0]!.amount;
  const pct = (value: number, bp: number) => Math.round((value * bp) / 10_000);
  const bpjs = (
    [
      ["bpjs_kes", 100, 400],
      ["jht", 200, 370],
      ["jkk", 0, 24],
      ["jkm", 0, 30],
      ["jp", 100, 200],
    ] as const
  )
    .filter(() => rng.chance(0.8))
    .map(([type, employeeBp, employerBp]) => ({
      type,
      baseIdr: basic,
      capped: false,
      employeeIdr: pct(basic, employeeBp),
      employerIdr: pct(basic, employerBp),
    }));
  const sumBpjs = (
    keep: (type: string) => boolean,
    side: "employeeIdr" | "employerIdr",
  ) => bpjs.filter((b) => keep(b.type)).reduce((s, b) => s + b[side], 0);
  const bpjsEmployeeIdr = sumBpjs(() => true, "employeeIdr");
  const bpjsCompanyIdr = sumBpjs(() => true, "employerIdr");
  const employerBenefitIdr = sumBpjs(
    (t) => t === "jkk" || t === "jkm" || t === "bpjs_kes",
    "employerIdr",
  );
  const employeeDeductibleIdr = sumBpjs(
    (t) => t === "jht" || t === "jp",
    "employeeIdr",
  );

  const late = rng.chance(0.3);
  const cash = earnings.reduce((s, e) => s + e.amount, 0);
  const lateIdr = late
    ? Math.min(
        rng.int(10, 300) * 1_000,
        Math.floor(Math.max(0, cash - bpjsEmployeeIdr) / 2),
      )
    : 0;

  const lastTaxPeriod = rng.chance(0.35);
  const monthsWorked = lastTaxPeriod ? rng.int(2, 12) : rng.int(1, 12);
  const taxableNow = earnings
    .filter((e) => e.taxable)
    .reduce((s, e) => s + e.amount, 0);
  const prior = {
    taxableGrossIdr: 0,
    employeeDeductibleIdr: 0,
    pph21WithheldIdr: 0,
    pph21EmployerBorneIdr: 0,
  } as {
    taxableGrossIdr: number;
    employeeDeductibleIdr: number;
    pph21WithheldIdr: number;
    pph21EmployerBorneIdr: number;
    grossSchemeBaseIdr?: number;
    employerSchemeBaseIdr?: number;
    taxAllowanceIdr?: number;
    pph21ReceivableIdr?: number;
  };
  if (lastTaxPeriod) {
    const earlier = monthsWorked - 1;
    prior.taxableGrossIdr = Math.round(
      earlier * (taxableNow + employerBenefitIdr) * (0.5 + rng.float()),
    );
    prior.employeeDeductibleIdr = Math.round(
      earlier * employeeDeductibleIdr * (0.5 + rng.float()),
    );
    // Earlier tax anywhere from nothing (a big refund or shortfall) to a lot.
    prior.pph21WithheldIdr = rng.chance(0.2)
      ? 0
      : Math.round(prior.taxableGrossIdr * rng.float() * 0.12);
    if (rng.chance(0.3))
      prior.pph21EmployerBorneIdr = Math.round(
        prior.pph21WithheldIdr * rng.float() * 0.5,
      );
    if (rng.chance(0.3))
      prior.taxAllowanceIdr = Math.round(prior.pph21WithheldIdr * rng.float());
    if (rng.chance(0.2))
      prior.pph21ReceivableIdr = Math.round(rng.float() * 3_000_000);
    if (rng.chance(0.3)) {
      prior.grossSchemeBaseIdr = Math.round(
        prior.taxableGrossIdr * rng.float(),
      );
      prior.employerSchemeBaseIdr =
        prior.taxableGrossIdr - prior.grossSchemeBaseIdr;
      // The engine wants the allowance reported with an employer-scheme history.
      prior.taxAllowanceIdr ??= Math.round(
        prior.pph21WithheldIdr * rng.float(),
      );
    }
  }

  const { tax } = computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: rng.pick(PTKP_STATUSES),
    hasTaxId: rng.chance(0.8),
    lastTaxPeriod,
    monthsWorked,
    earnings: earnings.map((e) => ({
      amountIdr: e.amount,
      taxable: e.taxable,
      taxScheme: e.scheme,
    })),
    employerBenefitIdr,
    contractTaxScheme: earnings[0]!.scheme,
    employeeDeductibleIdr,
    employeeWithholdingCapIdr: payslipWithholdingCap({
      cashEarningsIdr: cash,
      bpjsEmployeeIdr,
      preNetDeductionsIdr: lateIdr,
    }),
    prior,
  });

  // legend-w6vah: the allowance part returns at most the earlier allowance and
  // at most the employer refund; the borne part is what is left.
  const allowanceRefund = tax.pph21EmployerAllowanceRefundIdr ?? 0;
  expect(allowanceRefund).toBeLessThanOrEqual(prior.taxAllowanceIdr ?? 0);
  expect(allowanceRefund).toBeLessThanOrEqual(tax.pph21EmployerRefundIdr);
  // The borne part returns at most the earlier borne tax (6111 never inverts).
  expect(tax.pph21EmployerRefundIdr - allowanceRefund).toBeLessThanOrEqual(
    prior.pph21EmployerBorneIdr ?? 0,
  );
  expect(allowanceRefund + (tax.pph21EmployerRefundIdr - allowanceRefund)).toBe(
    tax.pph21EmployerRefundIdr,
  );

  const line = (
    code: string,
    category: PayslipLine["category"],
    kind: PayslipLine["kind"],
    amountIdr: number,
    taxable = false,
  ) =>
    payslipLineSchema.parse({
      componentCode: code,
      name: code,
      category,
      kind,
      amountIdr,
      taxable,
      quantity: null,
      sourceId: null,
    });
  const earningLines = earnings.map((e) =>
    line(e.code, e.category, "earning", e.amount, e.taxable),
  );
  if (tax.taxAllowanceIdr > 0)
    earningLines.push(
      line("TAX_ALLOWANCE", "tax_allowance", "earning", tax.taxAllowanceIdr),
    );
  if (tax.pph21RefundIdr > 0)
    earningLines.push(
      line("PPH21_REFUND", "custom_earning", "earning", tax.pph21RefundIdr),
    );
  const grossIdr = earningLines.reduce((s, l) => s + l.amountIdr, 0);

  const netBeforeLoans =
    grossIdr - bpjsEmployeeIdr - tax.pph21WithheldIdr - lateIdr;
  const collected = planPph21ReceivableCollection({
    openIdr: rng.chance(0.3) ? rng.int(0, 2_000) * 1_000 : 0,
    roomIdr: netBeforeLoans,
  }).collectedIdr;
  const loanIdr = rng.chance(0.3)
    ? Math.min(
        rng.int(100, 2_000) * 1_000,
        Math.max(0, netBeforeLoans - collected),
      )
    : 0;
  const customIdr = rng.chance(0.2)
    ? Math.min(
        rng.int(10, 500) * 1_000,
        Math.max(0, netBeforeLoans - collected - loanIdr),
      )
    : 0;

  const deductionLines = [
    line("BPJS_EMP", "bpjs_employee", "deduction", bpjsEmployeeIdr),
    line("PPH21", "pph21", "deduction", tax.pph21WithheldIdr),
  ];
  if (lateIdr > 0)
    deductionLines.push(line("LATE", "late_deduction", "deduction", lateIdr));
  if (collected > 0)
    deductionLines.push(
      line("PPH21_RECEIVABLE", "pph21_receivable", "deduction", collected),
    );
  if (loanIdr > 0)
    deductionLines.push(line("LOAN", "loan_installment", "deduction", loanIdr));
  if (customIdr > 0)
    deductionLines.push(
      line("FINE", "custom_deduction", "deduction", customIdr),
    );
  const deductionsIdr = deductionLines.reduce((s, l) => s + l.amountIdr, 0);
  const sumOf = (category: PayslipLine["category"]) =>
    [...earningLines, ...deductionLines]
      .filter((l) => l.category === category)
      .reduce((s, l) => s + l.amountIdr, 0);

  return payslipCalculationSchema.parse({
    employeeId: EMPLOYEE_ID,
    employeeNo: "EMP-0001",
    employeeName: "Fuzz Employee",
    positionName: null,
    outletId: OUTLET_ID,
    periodStart: "2026-10-26",
    periodEnd: "2026-11-25",
    payDate: "2026-11-27",
    grossIdr,
    deductionsIdr,
    netIdr: grossIdr - deductionsIdr,
    pph21Idr: tax.pph21Idr,
    bpjsEmployeeIdr,
    bpjsCompanyIdr,
    serviceChargeIdr: sumOf("service_charge"),
    overtimeIdr: 0,
    lines: [...earningLines, ...deductionLines],
    bpjs,
    tax,
    paymentMethod: rng.chance(0.2) ? "cash" : "bank_transfer",
  });
}

describe("property: payroll journal balances for engine-built payslips", () => {
  it(`${FUZZ_CASES} seeded runs of 1-5 payslips post balanced locked and reversed journals`, () => {
    const seen = {
      withRefund: 0,
      withReceivable: 0,
      withBorne: 0,
      withEmployerRefund: 0,
      withAllowanceRefund: 0,
      negativePph21: 0,
      withCustom: 0,
    };
    for (let i = 0; i < FUZZ_CASES; i += 1) {
      const seed = FUZZ_SEED + i;
      try {
        const rng = lcg(seed);
        const slips = Array.from({ length: rng.int(1, 5) }, () =>
          fuzzSlip(rng),
        );
        const totals = sumPayrollRunTotals(slips);
        const locked = summarise(lockLines(totals));
        const reversed = summarise(reverseLines(totals));

        expect(locked.debit).toBe(locked.credit);
        expect(reversed.debit).toBe(reversed.credit);
        // Debits are gross - refund + employer BPJS + borne + receivable, plus
        // a negative PPh 21 payable that flips to the debit side.
        expect(locked.debit).toBe(
          totals.grossIdr -
            totals.pph21RefundIdr +
            totals.bpjsCompanyIdr +
            totals.pph21EmployerBorneIdr +
            totals.pph21ReceivableIdr +
            Math.max(0, -totals.pph21Idr),
        );
        const net = (code: string) =>
          (locked.byCode[code]?.credit ?? 0) -
          (locked.byCode[code]?.debit ?? 0);
        const owed = (code: string) =>
          (locked.byCode[code]?.debit ?? 0) -
          (locked.byCode[code]?.credit ?? 0);
        expect(net("2103")).toBe(totals.netIdr);
        expect(net("2202")).toBe(totals.pph21Idr);
        expect(net("2104")).toBe(
          totals.bpjsEmployeeIdr + totals.bpjsCompanyIdr,
        );
        expect(owed("1204")).toBe(
          totals.pph21ReceivableIdr -
            totals.pph21ReceivableCollectedIdr -
            totals.loanRepaymentIdr,
        );
        expect(owed("2106")).toBe(totals.serviceChargeIdr);
        expect(owed("6110")).toBe(totals.reimbursementIdr);
        // legend-w6vah: the allowance part of the employer refund credits
        // 6101 next to LATE and the like, only the rest credits 6111.
        const allowanceRefund = totals.pph21EmployerAllowanceRefundIdr;
        const borneRefund = totals.pph21EmployerRefundIdr - allowanceRefund;
        expect(allowanceRefund).toBeLessThanOrEqual(
          totals.pph21EmployerRefundIdr,
        );
        expect(borneRefund).toBeGreaterThanOrEqual(0);
        expect(allowanceRefund + borneRefund).toBe(
          totals.pph21EmployerRefundIdr,
        );
        expect(owed("6101")).toBe(
          totals.grossIdr -
            totals.pph21RefundIdr -
            totals.serviceChargeIdr -
            totals.reimbursementIdr -
            totals.otherDeductionsIdr -
            allowanceRefund,
        );
        expect(owed("6111")).toBe(totals.pph21EmployerBorneIdr - borneRefund);
        if (allowanceRefund > 0) seen.withAllowanceRefund += 1;

        // legend-75kr: customDeductionsIdr is the sum of the custom_deduction
        // lines; remapped to a liability it credits its own account and LATE
        // alone stays on 6101. Balanced, and locked + reversed net to zero.
        const customLines = slips
          .flatMap((slip) => slip.lines)
          .filter(
            (l) => l.kind === "deduction" && l.category === "custom_deduction",
          )
          .reduce((sum, l) => sum + l.amountIdr, 0);
        expect(totals.customDeductionsIdr).toBe(customLines);
        expect(totals.customDeductionsIdr).toBeLessThanOrEqual(
          totals.otherDeductionsIdr,
        );
        const split = summarise(lockLines(totals, splitMap));
        const splitReversed = summarise(reverseLines(totals, splitMap));
        expect(split.debit).toBe(split.credit);
        expect(splitReversed.debit).toBe(splitReversed.credit);
        expect(split.debit).toBe(locked.debit);
        expect(
          (split.byCode["2199"]?.credit ?? 0) -
            (split.byCode["2199"]?.debit ?? 0),
        ).toBe(totals.customDeductionsIdr);
        expect(
          (split.byCode["6101"]?.debit ?? 0) -
            (split.byCode["6101"]?.credit ?? 0),
        ).toBe(owed("6101") + totals.customDeductionsIdr);
        const splitBoth = summarise([
          ...lockLines(totals, splitMap),
          ...reverseLines(totals, splitMap),
        ]);
        for (const row of Object.values(splitBoth.byCode))
          expect(row.debit).toBe(row.credit);
        if (totals.customDeductionsIdr > 0) seen.withCustom += 1;

        if (totals.pph21RefundIdr > 0) seen.withRefund += 1;
        if (totals.pph21ReceivableIdr > 0) seen.withReceivable += 1;
        if (totals.pph21EmployerBorneIdr > 0) seen.withBorne += 1;
        if (totals.pph21EmployerRefundIdr > 0) seen.withEmployerRefund += 1;
        if (totals.pph21Idr < 0) seen.negativePph21 += 1;
      } catch (error) {
        throw new Error(
          `payroll journal property failed, seed=${seed} (case ${i}, base seed ${FUZZ_SEED}): ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    // The generator really reaches the interesting branches.
    expect(seen.withRefund).toBeGreaterThan(0);
    expect(seen.withReceivable).toBeGreaterThan(0);
    expect(seen.withBorne).toBeGreaterThan(0);
    expect(seen.withEmployerRefund).toBeGreaterThan(0);
    expect(seen.withAllowanceRefund).toBeGreaterThan(0);
    expect(seen.negativePph21).toBeGreaterThan(0);
    expect(seen.withCustom).toBeGreaterThan(0);
  });
});
