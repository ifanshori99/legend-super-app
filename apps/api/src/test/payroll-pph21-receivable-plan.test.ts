// PPh 21 employee receivable: balance, collection planner and the deduction
// order of the mock payslip builder (beads legend-xzid, legend-kn3n part 2;
// brief docs/briefs/sub-pph21-receivable.md; founder decision B8).
import { describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import { cafeLegendHrisFixtures } from "@starter/shared/hris";
import {
  calculateFixturePayslip,
  cafeLegendPayrollFixtures,
  payslipWithholdingCap,
  pph21ReceivableBalance,
  planPph21ReceivableCollection,
  type FixturePayslipInput,
} from "@starter/shared/hris/payroll";

const slip = (receivable: number | undefined, collected: number[] = []) => ({
  tax: receivable === undefined ? {} : { pph21ReceivableIdr: receivable },
  lines: [
    { category: "pph21", amountIdr: 100 },
    ...collected.map((amountIdr) => ({
      category: "pph21_receivable",
      amountIdr,
    })),
  ],
});

describe("pph21ReceivableBalance", () => {
  it("is 0 without payslips and treats an absent receivable as 0", () => {
    expect(pph21ReceivableBalance([])).toBe(0);
    expect(pph21ReceivableBalance([slip(undefined), slip(0)])).toBe(0);
  });

  it("sums receivables and subtracts pph21_receivable lines across slips", () => {
    expect(
      pph21ReceivableBalance([
        slip(300_000),
        slip(undefined, [100_000]),
        slip(50_000, [30_000]),
      ]),
    ).toBe(220_000);
  });

  it("ignores other deduction categories", () => {
    expect(
      pph21ReceivableBalance([
        {
          tax: { pph21ReceivableIdr: 10 },
          lines: [{ category: "loan_installment", amountIdr: 10 }],
        },
      ]),
    ).toBe(10);
  });

  it("refuses collections above the receivables raised and bad amounts", () => {
    expect(() => pph21ReceivableBalance([slip(10, [11])])).toThrow(RangeError);
    expect(() => pph21ReceivableBalance([slip(-1)])).toThrow(RangeError);
    expect(() => pph21ReceivableBalance([slip(1.5)])).toThrow(RangeError);
  });
});

describe("planPph21ReceivableCollection", () => {
  it("collects min(open, room)", () => {
    expect(
      planPph21ReceivableCollection({ openIdr: 500_000, roomIdr: 200_000 }),
    ).toEqual({ collectedIdr: 200_000, openAfterIdr: 300_000 });
    expect(
      planPph21ReceivableCollection({ openIdr: 150_000, roomIdr: 200_000 }),
    ).toEqual({ collectedIdr: 150_000, openAfterIdr: 0 });
  });

  it("collects nothing without room or without a balance", () => {
    expect(planPph21ReceivableCollection({ openIdr: 100, roomIdr: 0 })).toEqual(
      { collectedIdr: 0, openAfterIdr: 100 },
    );
    expect(
      planPph21ReceivableCollection({ openIdr: 100, roomIdr: -50 }),
    ).toEqual({ collectedIdr: 0, openAfterIdr: 100 });
    expect(planPph21ReceivableCollection({ openIdr: 0, roomIdr: 100 })).toEqual(
      { collectedIdr: 0, openAfterIdr: 0 },
    );
  });

  it("refuses a negative open balance and fractional amounts", () => {
    expect(() =>
      planPph21ReceivableCollection({ openIdr: -1, roomIdr: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      planPph21ReceivableCollection({ openIdr: 1.5, roomIdr: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      planPph21ReceivableCollection({ openIdr: 1, roomIdr: 0.5 }),
    ).toThrow(RangeError);
  });
});

// ---- calculate() in the mock payslip builder ----------------------------------

const october = cafeLegendPayrollFixtures.payslips;
const employeeOf = (employeeNo: string) => {
  const employee = cafeLegendHrisFixtures.employees.find(
    (e) => e.employeeNo === employeeNo,
  );
  if (employee === undefined) throw new Error(`no employee ${employeeNo}`);
  return employee;
};
const octoberSlipOf = (employeeNo: string) => {
  const found = october.find((s) => s.employeeNo === employeeNo);
  if (found === undefined) throw new Error(`no payslip ${employeeNo}`);
  return found;
};

// CL-1006 has the October loan: rebuild its October input from the stored
// payslip so the receivable is the only change.
const EMPLOYEE_NO = "CL-1006";
const baseInput = (): FixturePayslipInput => {
  const stored = octoberSlipOf(EMPLOYEE_NO);
  const lineOf = (category: string) =>
    stored.lines.find((l) => l.category === category);
  const serviceCharge = lineOf("service_charge");
  const reimbursement = lineOf("reimbursement");
  const loan = cafeLegendPayrollFixtures.employeeLoans.find(
    (l) => l.employeeId === stored.employeeId && l.status === "disbursed",
  );
  if (serviceCharge === undefined || loan === undefined)
    throw new Error("fixture drifted");
  return {
    employee: employeeOf(EMPLOYEE_NO),
    period: {
      periodStart: stored.periodStart,
      periodEnd: stored.periodEnd,
      payDate: stored.payDate,
    },
    overtimeHours: lineOf("overtime")?.quantity ?? null,
    serviceCharge: {
      amountIdr: serviceCharge.amountIdr,
      points: serviceCharge.quantity as never,
      poolId: serviceCharge.sourceId ?? "",
    },
    reimbursement:
      reimbursement === undefined
        ? null
        : {
            amountIdr: reimbursement.amountIdr,
            id: reimbursement.sourceId ?? "",
          },
    // Loan balance before October (installment still full).
    loan: {
      ...loan,
      outstandingIdr: idr(loan.outstandingIdr + loan.installmentIdr),
    },
    lateIdr: lineOf("late_deduction")?.amountIdr ?? 0,
    paymentMethod: stored.paymentMethod,
  };
};
const amountOf = (
  lines: readonly { componentCode: string; amountIdr: number }[],
  code: string,
) => lines.find((l) => l.componentCode === code)?.amountIdr ?? 0;
const deductionCodes = (
  lines: readonly { componentCode: string; kind: string }[],
) => lines.filter((l) => l.kind === "deduction").map((l) => l.componentCode);

describe("calculate(): receivable collection in the deduction order", () => {
  it("without a receivable, matches the stored October payslip", () => {
    const { calculation } = calculateFixturePayslip(baseInput());
    const stored = octoberSlipOf(EMPLOYEE_NO);
    expect(calculation.netIdr).toBe(stored.netIdr);
    expect(calculation.lines).toEqual(stored.lines);
    expect(calculation.tax).toEqual(stored.tax);
    expect(amountOf(calculation.lines, "PPH21_RECEIVABLE")).toBe(0);
  });

  it("collects before the loan and orders BPJS, PPh 21, LATE, receivable, LOAN", () => {
    const withLate = { ...baseInput(), lateIdr: 40_000 };
    const without = calculateFixturePayslip(withLate).calculation;
    const { calculation, loanPlan } = calculateFixturePayslip({
      ...withLate,
      pph21ReceivableOpenIdr: 100_000,
    });
    expect(deductionCodes(calculation.lines)).toEqual([
      "BPJS_EMP",
      "PPH21",
      "LATE",
      "PPH21_RECEIVABLE",
      "LOAN",
    ]);
    expect(amountOf(calculation.lines, "PPH21_RECEIVABLE")).toBe(100_000);
    // Same loan installment (room is plentiful) and net lower by the collection.
    expect(amountOf(calculation.lines, "LOAN")).toBe(
      amountOf(without.lines, "LOAN"),
    );
    expect(calculation.netIdr).toBe(without.netIdr - 100_000);
    expect(loanPlan[0]?.carriedIdr).toBe(0);
  });

  it("takes all the room, leaves the open rest, and carries the loan", () => {
    const stored = octoberSlipOf(EMPLOYEE_NO);
    const netBeforeLoans = stored.netIdr + amountOf(stored.lines, "LOAN");
    const { calculation, loanPlan } = calculateFixturePayslip({
      ...baseInput(),
      pph21ReceivableOpenIdr: netBeforeLoans + 5_000_000,
    });
    expect(amountOf(calculation.lines, "PPH21_RECEIVABLE")).toBe(
      netBeforeLoans,
    );
    expect(amountOf(calculation.lines, "LOAN")).toBe(0);
    expect(calculation.netIdr).toBe(0);
    expect(loanPlan[0]?.deductedIdr).toBe(0);
    expect(loanPlan[0]?.carriedIdr).toBe(loanPlan[0]?.scheduledIdr);
  });

  it("fills employeeWithholdingCapIdr from the cash pay left after BPJS and LATE", () => {
    const input = baseInput();
    const { calculation } = calculateFixturePayslip(input);
    const cash = calculation.lines
      .filter((l) => l.kind === "earning")
      .reduce((sum, l) => sum + l.amountIdr, 0);
    const cap = payslipWithholdingCap({
      cashEarningsIdr: cash,
      bpjsEmployeeIdr: calculation.bpjsEmployeeIdr,
      preNetDeductionsIdr: input.lateIdr,
    });
    // PPh 21 withheld never exceeds the cap, and the slip is not capped here.
    expect(calculation.tax.pph21WithheldIdr).toBeLessThanOrEqual(cap);
    expect(calculation.tax.pph21ReceivableIdr ?? 0).toBe(0);
  });
});
