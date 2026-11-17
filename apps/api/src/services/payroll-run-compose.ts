// Pure composition of one payslip of a simulated payroll run (bead
// legend-c2yca; design docs/briefs/sub-payroll-followups-design.md §2 step 5).
// No database. Mirrors the mock payslip builder (`fixtures.ts calculate`) for
// line order and categories:
//
//   earnings of the gross engine (RAPEL and overtime included), then
//   TAX_ALLOWANCE and PPH21_REFUND from the tax step, then
//   BPJS_EMP, PPH21, then the gross engine's own deductions.
//
// Money guards (never pay more): the employee BPJS share is already capped
// at the gross engine's net (`calculatePayrollRunStatutory`), and the PPh 21
// withheld is capped by `payslipWithholdingCap` over the same pay, so net is
// never below zero. `payslipCalculationSchema` re-checks every total.
//
// An open PPh 21 receivable of earlier payslips is collected on a PPH21_RECEIVABLE
// line after the gross engine's deductions (fixtures.ts order: BPJS_EMP, PPH21,
// gross deductions, PPH21_RECEIVABLE): min(open, max(0, room)), room = gross - BPJS
// - PPh 21 - gross deductions, so net is never negative and the collection never
// exceeds the open balance (`planPph21ReceivableCollection`, founder B8).
//
// Overtime correction (legend-72nod): LEMBUR_KOREKSI_POTONGAN instalments come
// right after the receivable, capped by the same room (`overtimeCorrectionDeductions`).
//
// Kasbon (legend-8tfvr, D4): after the receivable, `planLoanDeductions` plans
// the installments over the pay left (gross - every deduction so far), capped
// by the policy's share of that pay. One LOAN line per loan that takes money:
// category `loan_installment`, kind `deduction`, not taxable, `sourceId` = the
// loan id. The simulate service writes one `payroll_loan_deductions` row per
// line, so the rows and the lines bind 1:1. The simulate service still refuses
// runs with reimbursements or service charge (422
// PAYROLL_RUN_SIMULATE_UNSUPPORTED).

import {
  idr,
  sumIdr,
  type BasisPoints,
  type Idr,
  type OutletId,
} from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import {
  payslipBpjsLineSchema,
  payslipCalculationSchema,
  payslipLineSchema,
  payslipWithholdingCap,
  planLoanDeductions,
  planPph21ReceivableCollection,
  type BpjsContribution,
  type PayComponentCategory,
  type PayslipBpjsLine,
  type PayslipCalculation,
  type PayslipLine,
  type PayslipPaymentMethod,
  type PayslipTax,
  type PayslipTaxEarning,
  type TaxScheme,
} from "@starter/shared/hris/payroll";

/** System lines the tax and BPJS steps add (same codes as the fixtures). */
const SYSTEM_LINES = {
  TAX_ALLOWANCE: { name: "Tunjangan PPh 21", category: "tax_allowance" },
  PPH21_REFUND: { name: "Pengembalian PPh 21", category: "custom_earning" },
  BPJS_EMP: { name: "Iuran BPJS Karyawan", category: "bpjs_employee" },
  PPH21: { name: "PPh 21", category: "pph21" },
  PPH21_RECEIVABLE: {
    name: "Penagihan Kekurangan PPh 21",
    category: "pph21_receivable",
  },
  LOAN: { name: "Cicilan Kasbon", category: "loan_installment" },
} as const satisfies Record<
  string,
  { name: string; category: PayComponentCategory }
>;

function systemLine(
  code: keyof typeof SYSTEM_LINES,
  amountIdr: number,
  sourceId: string | null = null,
): PayslipLine {
  const { name, category } = SYSTEM_LINES[code];
  return payslipLineSchema.parse({
    componentCode: code,
    name,
    category,
    kind:
      category === "bpjs_employee" ||
      category === "pph21" ||
      category === "pph21_receivable" ||
      category === "loan_installment"
        ? "deduction"
        : "earning",
    amountIdr,
    taxable: false,
    quantity: null,
    sourceId,
  });
}

/** BPJS lines of a payslip from the capped statutory contributions. */
export function bpjsLinesOf(
  contributions: readonly BpjsContribution[],
): PayslipBpjsLine[] {
  return contributions.map((c) =>
    payslipBpjsLineSchema.parse({
      type: c.type,
      baseIdr: c.baseIdr,
      capped: c.capped,
      employerIdr: c.employerIdr,
      employeeIdr: c.employeeIdr,
    }),
  );
}

export type PayslipTaxFacts = {
  earnings: PayslipTaxEarning[];
  employerBenefitIdr: Idr;
  employeeDeductibleIdr: Idr;
  employeeWithholdingCapIdr: Idr;
};

/**
 * The engine facts of one payslip (fixtures.ts `calculate`): every earning
 * with its tax scheme; the employer's JKK, JKM and BPJS Kesehatan shares as a
 * benefit in kind; the employee's JHT + JP as deductible; and the withholding
 * cap over the cash pay left after BPJS and the gross engine's deductions.
 * `taxSchemeOf` answers the scheme of a line's component.
 */
export function payslipTaxFactsOf(input: {
  earnings: readonly PayslipLine[];
  grossDeductions: readonly PayslipLine[];
  bpjs: readonly PayslipBpjsLine[];
  taxSchemeOf: (line: PayslipLine) => TaxScheme;
}): PayslipTaxFacts {
  const bpjsEmployeeIdr = sumIdr(input.bpjs.map((b) => b.employeeIdr));
  return {
    earnings: input.earnings.map((line) => ({
      amountIdr: line.amountIdr,
      taxable: line.taxable,
      taxScheme: input.taxSchemeOf(line),
    })),
    employerBenefitIdr: sumIdr(
      input.bpjs
        .filter(
          (b) => b.type === "jkk" || b.type === "jkm" || b.type === "bpjs_kes",
        )
        .map((b) => b.employerIdr),
    ),
    employeeDeductibleIdr: sumIdr(
      input.bpjs
        .filter((b) => b.type === "jht" || b.type === "jp")
        .map((b) => b.employeeIdr),
    ),
    employeeWithholdingCapIdr: payslipWithholdingCap({
      cashEarningsIdr: sumIdr(input.earnings.map((l) => l.amountIdr)),
      bpjsEmployeeIdr,
      preNetDeductionsIdr: sumIdr(
        input.grossDeductions.map((l) => l.amountIdr),
      ),
    }),
  };
}

export type ComposePayslipInput = {
  employee: {
    employeeId: EmployeeId;
    employeeNo: string;
    employeeName: string;
    positionName: string | null;
    outletId: OutletId;
  };
  period: { periodStart: string; periodEnd: string; payDate: string };
  /** Earning lines of the gross engine (before the tax step's lines). */
  earnings: readonly PayslipLine[];
  /** Deduction lines of the gross engine (already capped at its gross). */
  grossDeductions: readonly PayslipLine[];
  bpjs: readonly PayslipBpjsLine[];
  tax: PayslipTax;
  paymentMethod: PayslipPaymentMethod;
  /**
   * Open PPh 21 receivable from earlier payslips (0 or absent = none). Only the
   * balance of earlier payslips: a receivable raised on this payslip is never
   * collected on it.
   */
  openReceivableIdr?: Idr | number;
  /**
   * Whole open receivable of the employee before this payslip, whatever the
   * pay date (the carry written on the payslip). At least `openReceivableIdr`
   * (which only counts what this payslip may collect); absent = the same.
   */
  totalOpenReceivableIdr?: Idr | number;
  /**
   * Loans this payslip may deduct from (already locked and reduced by what
   * other live runs reserve). Absent = none. See `loanMaxDeductionOfNetPayBp`.
   */
  loans?: readonly PlannableLoan[];
  /** Policy share of the pay left that all installments may take (absent = 0). */
  loanMaxDeductionOfNetPayBp?: BasisPoints;
  /**
   * Overtime correction deductions (legend-72nod): given the pay left after
   * the receivable collection, the LEMBUR_KOREKSI_POTONGAN lines to take. The
   * caller caps them at that room; the composer re-checks it (never pays more).
   */
  overtimeCorrectionDeductions?: (roomIdr: number) => readonly PayslipLine[];
};

/** A loan the composer may plan an installment for (`planLoanDeductions`). */
export type PlannableLoan = Parameters<typeof planLoanDeductions>[0][number] & {
  employeeId: EmployeeId;
};

/** The full payslip body of one employee (see the header). */
export function composePayslipCalculation(
  input: ComposePayslipInput,
): PayslipCalculation {
  const { tax } = input;
  const earnings: PayslipLine[] = [...input.earnings];
  if (tax.taxAllowanceIdr > 0)
    earnings.push(systemLine("TAX_ALLOWANCE", tax.taxAllowanceIdr));
  if (tax.pph21RefundIdr > 0)
    earnings.push(systemLine("PPH21_REFUND", tax.pph21RefundIdr));

  const bpjsEmployeeIdr = sumIdr(input.bpjs.map((b) => b.employeeIdr));
  const bpjsCompanyIdr = sumIdr(input.bpjs.map((b) => b.employerIdr));
  const deductions: PayslipLine[] = [
    systemLine("BPJS_EMP", bpjsEmployeeIdr),
    systemLine("PPH21", tax.pph21WithheldIdr),
    ...input.grossDeductions,
  ];
  const grossIdr = sumIdr(earnings.map((l) => l.amountIdr));
  // Room = pay left after BPJS, PPh 21 and the other deductions; never negative
  // net, never more than the open receivable.
  const receivableCollection = planPph21ReceivableCollection({
    openIdr: input.openReceivableIdr ?? 0,
    roomIdr: grossIdr - sumIdr(deductions.map((l) => l.amountIdr)),
  });
  if (receivableCollection.collectedIdr > 0)
    deductions.push(
      systemLine("PPH21_RECEIVABLE", receivableCollection.collectedIdr),
    );
  // Overtime correction (legend-72nod): an instalment of what the outlet paid
  // too much in a frozen period, over the pay left; the rest stays outstanding.
  if (input.overtimeCorrectionDeductions) {
    const room = grossIdr - sumIdr(deductions.map((l) => l.amountIdr));
    const taken = input.overtimeCorrectionDeductions(room);
    if (sumIdr(taken.map((l) => l.amountIdr)) > Math.max(0, room))
      throw new RangeError("Overtime correction exceeds the pay left");
    deductions.push(...taken);
  }
  // Kasbon: whatever the deductions above leave, up to the policy share.
  const loanPlan = planLoanDeductions(
    input.loans ?? [],
    idr(grossIdr - sumIdr(deductions.map((l) => l.amountIdr))),
    input.loanMaxDeductionOfNetPayBp ?? 0,
  );
  for (const plan of loanPlan)
    if (plan.deductedIdr > 0)
      deductions.push(systemLine("LOAN", plan.deductedIdr, plan.loanId));

  const lines = [...earnings, ...deductions];
  const deductionsIdr = sumIdr(deductions.map((l) => l.amountIdr));
  const sumOf = (category: PayslipLine["category"]) =>
    sumIdr(
      lines.filter((l) => l.category === category).map((l) => l.amountIdr),
    );
  // Never echo the parse error: it may carry payroll values.
  const parsed = payslipCalculationSchema.safeParse({
    ...input.employee,
    ...input.period,
    grossIdr,
    deductionsIdr,
    netIdr: idr(grossIdr - deductionsIdr),
    pph21Idr: tax.pph21Idr,
    bpjsEmployeeIdr,
    bpjsCompanyIdr,
    serviceChargeIdr: sumOf("service_charge"),
    overtimeIdr: sumOf("overtime"),
    lines,
    bpjs: [...input.bpjs],
    tax,
    paymentMethod: input.paymentMethod,
    // Receivable still open after this payslip: the whole earlier balance
    // minus what this payslip collects plus what it raises itself.
    pph21ReceivableOpenAfterIdr:
      (input.totalOpenReceivableIdr ?? input.openReceivableIdr ?? 0) -
      receivableCollection.collectedIdr +
      (tax.pph21ReceivableIdr ?? 0),
  });
  if (!parsed.success) throw new RangeError("Composed payslip does not add up");
  return parsed.data;
}
