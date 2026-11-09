// Payslips, run totals, bank transfer file and tax export (PRD v1.7 §3 D.30
// "Slip Gaji" (PIN-protected PWA slip, history, PDF), "Pembayaran Gaji"
// (bulk transfer file in the tenant's bank format), "Dokumen Pajak" (bukti
// potong + monthly report for Coretax DJP); §6 H `payslips`: gross_idr,
// deductions_idr, net_idr, pph21_idr, bpjs_employee_idr, bpjs_company_idr,
// service_charge_idr, overtime_idr, lines, file_key, viewed_at; PAYR-04).
//
// Arithmetic invariants are enforced by the schemas, so a payslip or a run
// total that does not add up is rejected wherever it is parsed:
//   gross      = sum of earning lines
//   deductions = sum of deduction lines
//   net        = gross - deductions >= 0
//   net        = bank transfer + cash          (PAYR-04)
// Payslips and run totals are salary data (HR-03): payroll roles or the
// employee themself (after the PIN), never anyone else.

import {
  z,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  decimal4Schema,
  uuidSchema,
  clientInputSchema,
  idempotencyKeySchema,
  sumIdr,
} from "../../core/index.ts";
import type { Idr } from "../../core/index.ts";
import { legalEntityIdSchema } from "../../accounting/ids.ts";
import { employeeIdSchema } from "../ids.ts";
import type { EmployeeId } from "../ids.ts";
import { ptkpStatusSchema } from "../organization.ts";
import {
  payComponentCategorySchema,
  payComponentKindOf,
  payComponentKindSchema,
} from "./components.ts";
import { PayrollError } from "./errors.ts";
import {
  bankTransferFileIdSchema,
  payrollRunIdSchema,
  payrollTaxExportIdSchema,
  payslipIdSchema,
} from "./ids.ts";
import { BPJS_TABLE_TYPES, terCategorySchema } from "./statutory.ts";

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Must not be negative");

// ---- Lines and calculation --------------------------------------------

export const payslipLineSchema = z.strictObject({
  componentCode: z.string().min(2).max(30),
  name: z.string().trim().min(1).max(100),
  category: payComponentCategorySchema,
  kind: payComponentKindSchema,
  amountIdr: nonNegativeIdr,
  taxable: z.boolean(),
  /** Hours (overtime), days (daily wage), points (service charge); else null. */
  quantity: decimal4Schema.nullable(),
  /** Source document: loan, reimbursement, service-charge pool, overtime. */
  sourceId: uuidSchema.nullable(),
});
export type PayslipLine = z.infer<typeof payslipLineSchema>;

export const payslipBpjsLineSchema = z.strictObject({
  type: z.enum(BPJS_TABLE_TYPES),
  baseIdr: nonNegativeIdr,
  capped: z.boolean(),
  employerIdr: nonNegativeIdr,
  employeeIdr: nonNegativeIdr,
});
export type PayslipBpjsLine = z.infer<typeof payslipBpjsLineSchema>;

/** ter = monthly TER; annual_recalculation = last tax period (Pasal 17). */
export const pph21MethodSchema = z.enum(["ter", "annual_recalculation"]);

export const payslipTaxSchema = z
  .strictObject({
    ptkpStatus: ptkpStatusSchema,
    method: pph21MethodSchema,
    /** TER category/rate; null for the annual recalculation. */
    terCategory: terCategorySchema.nullable(),
    terRateBp: basisPointsSchema.nullable(),
    taxableGrossIdr: nonNegativeIdr,
    /** Total PPh 21 owed for the period (withheld + borne by the employer). */
    pph21Idr: idrSchema,
    /** Part deducted from the employee (gross and gross-up schemes). */
    pph21WithheldIdr: nonNegativeIdr,
    /** Gross-up tunjangan pajak paid as an extra earning (also withheld). */
    taxAllowanceIdr: nonNegativeIdr,
    /** Borne by the employer (net scheme); a taxable benefit, not withheld. */
    pph21EmployerBorneIdr: nonNegativeIdr,
    /** Lebih potong paid back to the employee this period. */
    pph21RefundIdr: nonNegativeIdr,
    /** Lebih potong that returns to the employer (tax it bore earlier). */
    pph21EmployerRefundIdr: nonNegativeIdr,
    /** Employees without a tax id pay the table surcharge, if any. */
    noTaxIdSurchargeApplied: z.boolean(),
    /**
     * Scheme mix of taxableGrossIdr (sum = taxableGrossIdr): the employee's
     * (gross-scheme) part and the employer's (gross-up / net lines, their
     * benefit share, the covered tax). Read by `buildPph21Prior` so a later
     * last period splits the year's history by the schemes paid at the time.
     */
    grossSchemeBaseIdr: nonNegativeIdr,
    employerSchemeBaseIdr: nonNegativeIdr,
  })
  .refine(
    (tax) =>
      tax.grossSchemeBaseIdr + tax.employerSchemeBaseIdr ===
      tax.taxableGrossIdr,
    { message: "scheme bases must sum to taxableGrossIdr" },
  );
export type PayslipTax = z.infer<typeof payslipTaxSchema>;

export const payslipPaymentMethodSchema = z.enum(["bank_transfer", "cash"]);
export type PayslipPaymentMethod = z.infer<typeof payslipPaymentMethodSchema>;

/** Result of calculating one employee: simulation preview and payslip body. */
const calculationShape = {
  employeeId: employeeIdSchema,
  employeeNo: z.string().min(2).max(30),
  employeeName: z.string().trim().min(1).max(150),
  positionName: z.string().trim().min(1).max(150).nullable(),
  outletId: outletIdSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  payDate: businessDateSchema,
  grossIdr: nonNegativeIdr,
  deductionsIdr: nonNegativeIdr,
  netIdr: nonNegativeIdr,
  pph21Idr: idrSchema,
  bpjsEmployeeIdr: nonNegativeIdr,
  bpjsCompanyIdr: nonNegativeIdr,
  serviceChargeIdr: nonNegativeIdr,
  overtimeIdr: nonNegativeIdr,
  lines: z.array(payslipLineSchema).min(1).max(200),
  bpjs: z.array(payslipBpjsLineSchema).max(BPJS_TABLE_TYPES.length),
  tax: payslipTaxSchema,
  paymentMethod: payslipPaymentMethodSchema,
} as const;

type CalculationLike = {
  grossIdr: Idr;
  deductionsIdr: Idr;
  netIdr: Idr;
  pph21Idr: Idr;
  bpjsEmployeeIdr: Idr;
  bpjsCompanyIdr: Idr;
  serviceChargeIdr: Idr;
  overtimeIdr: Idr;
  lines: readonly PayslipLine[];
  bpjs: readonly PayslipBpjsLine[];
  tax: PayslipTax;
};

const sumWhere = (
  lines: readonly PayslipLine[],
  keep: (line: PayslipLine) => boolean,
) => sumIdr(lines.filter(keep).map((line) => line.amountIdr));

/** The arithmetic every payslip must satisfy (see file header). */
export function payslipTotalsIssues(slip: CalculationLike): string[] {
  const issues: string[] = [];
  const earnings = sumWhere(slip.lines, (l) => l.kind === "earning");
  const deductions = sumWhere(slip.lines, (l) => l.kind === "deduction");
  if (slip.grossIdr !== earnings) issues.push("grossIdr != sum of earnings");
  if (slip.deductionsIdr !== deductions)
    issues.push("deductionsIdr != sum of deductions");
  if (slip.netIdr !== slip.grossIdr - slip.deductionsIdr)
    issues.push("netIdr != grossIdr - deductionsIdr");
  const withheld = sumWhere(slip.lines, (l) => l.category === "pph21");
  if (withheld !== slip.tax.pph21WithheldIdr)
    issues.push("pph21 lines != tax.pph21WithheldIdr");
  if (slip.pph21Idr !== slip.tax.pph21Idr)
    issues.push("pph21Idr != tax.pph21Idr");
  if (slip.tax.pph21WithheldIdr > Math.max(0, slip.tax.pph21Idr))
    issues.push("withheld PPh 21 exceeds PPh 21 owed");
  const bpjsEmployee = sumIdr(slip.bpjs.map((b) => b.employeeIdr));
  if (bpjsEmployee !== slip.bpjsEmployeeIdr)
    issues.push("bpjsEmployeeIdr != sum of BPJS employee shares");
  if (
    sumWhere(slip.lines, (l) => l.category === "bpjs_employee") !== bpjsEmployee
  )
    issues.push("bpjs_employee lines != BPJS employee shares");
  if (sumIdr(slip.bpjs.map((b) => b.employerIdr)) !== slip.bpjsCompanyIdr)
    issues.push("bpjsCompanyIdr != sum of BPJS employer shares");
  if (
    sumWhere(slip.lines, (l) => l.category === "service_charge") !==
    slip.serviceChargeIdr
  )
    issues.push("serviceChargeIdr != service charge lines");
  if (
    sumWhere(slip.lines, (l) => l.category === "overtime") !== slip.overtimeIdr
  )
    issues.push("overtimeIdr != overtime lines");
  for (const line of slip.lines) {
    // A line's kind must follow its category (the rule payComponentSchema
    // enforces), otherwise an earning could masquerade as a PPh 21/BPJS/kasbon
    // deduction (or a reimbursement as a deduction) and still add up.
    if (line.kind !== payComponentKindOf(line.category))
      issues.push(
        `line ${line.componentCode} kind does not match its category`,
      );
    if (line.kind === "deduction" && line.taxable)
      issues.push(`deduction line ${line.componentCode} marked taxable`);
  }
  if (new Set(slip.bpjs.map((b) => b.type)).size !== slip.bpjs.length)
    issues.push("duplicate BPJS programme");
  return issues;
}

function refineTotals(slip: CalculationLike, ctx: z.RefinementCtx) {
  for (const message of payslipTotalsIssues(slip))
    ctx.addIssue({ code: "custom", path: ["lines"], message });
}

export const payslipCalculationSchema = z
  .strictObject(calculationShape)
  .superRefine(refineTotals);
export type PayslipCalculation = z.infer<typeof payslipCalculationSchema>;

/**
 * Per-employee review row of a simulated run (PRD Alur K step 2: HR reviews
 * the change against the previous month).
 */
export const payrollRunEmployeeResultSchema = z
  .strictObject({
    ...calculationShape,
    previousNetIdr: nonNegativeIdr.nullable(),
    /** Net change vs. the previous locked run; null when there is none. */
    netChangeIdr: idrSchema.nullable(),
    /** Review flags, e.g. "net_change_over_threshold", "missing_bank_account". */
    flags: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,49}$/)).max(20),
  })
  .superRefine((row, ctx) => {
    refineTotals(row, ctx);
    const expected =
      row.previousNetIdr === null ? null : row.netIdr - row.previousNetIdr;
    if (row.netChangeIdr !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["netChangeIdr"],
        message: "netChangeIdr must equal netIdr - previousNetIdr",
      });
  });
export type PayrollRunEmployeeResult = z.infer<
  typeof payrollRunEmployeeResultSchema
>;

/** PRD §6 H `payslips` (created when the run is locked, Alur K step 4). */
export const payslipSchema = z
  .strictObject({
    id: payslipIdSchema,
    tenantId: tenantIdSchema,
    payrollRunId: payrollRunIdSchema,
    ...calculationShape,
    /** Signed, short-lived URL of the PDF; null until it is rendered. */
    fileUrl: z.url().nullable(),
    viewedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine(refineTotals);
export type Payslip = z.infer<typeof payslipSchema>;

/** Payslip history row for the employee PWA: no amounts before the PIN. */
export const myPayslipSummarySchema = z.strictObject({
  id: payslipIdSchema,
  payrollRunId: payrollRunIdSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  payDate: businessDateSchema,
  viewedAt: isoDateTimeSchema.nullable(),
});
export type MyPayslipSummary = z.infer<typeof myPayslipSummarySchema>;

/**
 * Opening a payslip needs the employee's payslip PIN (PRD §3 D.30 "dilindungi
 * PIN"). PRD silent on length: 6 digits. The PIN travels in a POST body, never
 * in a URL; wrong PINs are rate limited (PAYSLIP_PIN_LOCKED).
 */
export const payslipPinSchema = z
  .string()
  .regex(/^\d{6}$/, "The payslip PIN is 6 digits");

export const viewMyPayslipInputSchema = clientInputSchema({
  pin: payslipPinSchema,
  // A write (sets viewedAt, counts PIN attempts): retried with the same key,
  // a network retry does not burn a second PIN attempt.
  idempotencyKey: idempotencyKeySchema,
});

// ---- Run totals -----------------------------------------------------------

/** PRD §6 H `payroll_runs.totals` (gross, deductions, BPJS, PPh 21, net). */
export const payrollRunTotalsSchema = z
  .strictObject({
    employeeCount: z.number().int().min(0).max(100_000),
    grossIdr: nonNegativeIdr,
    deductionsIdr: nonNegativeIdr,
    netIdr: nonNegativeIdr,
    bpjsEmployeeIdr: nonNegativeIdr,
    bpjsCompanyIdr: nonNegativeIdr,
    pph21Idr: idrSchema,
    pph21WithheldIdr: nonNegativeIdr,
    loanRepaymentIdr: nonNegativeIdr,
    /** Late and custom deductions. */
    otherDeductionsIdr: nonNegativeIdr,
    /** Parts of gross the journal books differently (liability / expense). */
    serviceChargeIdr: nonNegativeIdr,
    reimbursementIdr: nonNegativeIdr,
    bankTransferIdr: nonNegativeIdr,
    cashIdr: nonNegativeIdr,
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (
      t.deductionsIdr !==
      t.bpjsEmployeeIdr +
        t.pph21WithheldIdr +
        t.loanRepaymentIdr +
        t.otherDeductionsIdr
    )
      issue(
        "deductionsIdr",
        "deductions = BPJS employee + PPh 21 withheld + loans + other",
      );
    if (t.netIdr !== t.grossIdr - t.deductionsIdr)
      issue("netIdr", "net = gross - deductions");
    if (t.netIdr !== t.bankTransferIdr + t.cashIdr)
      issue("bankTransferIdr", "net = bank transfer + cash (PAYR-04)");
    if (t.pph21WithheldIdr > Math.max(0, t.pph21Idr))
      issue("pph21WithheldIdr", "withheld PPh 21 exceeds PPh 21 owed");
    if (t.serviceChargeIdr + t.reimbursementIdr > t.grossIdr)
      issue("serviceChargeIdr", "service charge + reimbursement exceed gross");
  });
export type PayrollRunTotals = z.infer<typeof payrollRunTotalsSchema>;

/** Run totals from its employee results (simulation or lock). */
export function sumPayrollRunTotals(
  slips: readonly PayslipCalculation[],
): PayrollRunTotals {
  const total = (pick: (slip: PayslipCalculation) => Idr) =>
    sumIdr(slips.map(pick));
  const lineTotal = (keep: (line: PayslipLine) => boolean) =>
    sumIdr(
      slips.flatMap((slip) => slip.lines.filter(keep).map((l) => l.amountIdr)),
    );
  const net = (method: PayslipPaymentMethod) =>
    sumIdr(
      slips.filter((s) => s.paymentMethod === method).map((s) => s.netIdr),
    );
  return payrollRunTotalsSchema.parse({
    employeeCount: slips.length,
    grossIdr: total((s) => s.grossIdr),
    deductionsIdr: total((s) => s.deductionsIdr),
    netIdr: total((s) => s.netIdr),
    bpjsEmployeeIdr: total((s) => s.bpjsEmployeeIdr),
    bpjsCompanyIdr: total((s) => s.bpjsCompanyIdr),
    pph21Idr: total((s) => s.pph21Idr),
    pph21WithheldIdr: total((s) => s.tax.pph21WithheldIdr),
    loanRepaymentIdr: lineTotal((l) => l.category === "loan_installment"),
    otherDeductionsIdr: lineTotal(
      (l) =>
        l.kind === "deduction" &&
        l.category !== "loan_installment" &&
        l.category !== "bpjs_employee" &&
        l.category !== "pph21",
    ),
    serviceChargeIdr: total((s) => s.serviceChargeIdr),
    reimbursementIdr: lineTotal((l) => l.category === "reimbursement"),
    bankTransferIdr: net("bank_transfer"),
    cashIdr: net("cash"),
  });
}

// ---- Bank transfer file -------------------------------------------------

/**
 * Bank file layouts. The tenant's payroll bank is not decided yet (owner
 * note 7 lists EDC banks only); `generic_csv` always exists, bank layouts are
 * implemented by the BE bead against each bank's specification.
 */
export const BANK_TRANSFER_FORMATS = [
  "generic_csv",
  "bca",
  "mandiri",
  "bni",
  "bjb",
] as const;
export const bankTransferFormatSchema = z.enum(BANK_TRANSFER_FORMATS);
export type BankTransferFormat = z.infer<typeof bankTransferFormatSchema>;

export const bankTransferFileSchema = z.strictObject({
  id: bankTransferFileIdSchema,
  tenantId: tenantIdSchema,
  payrollRunId: payrollRunIdSchema,
  format: bankTransferFormatSchema,
  rowCount: z.number().int().min(0).max(100_000),
  totalIdr: nonNegativeIdr,
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Signed, short-lived download URL. */
  fileUrl: z.url(),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type BankTransferFile = z.infer<typeof bankTransferFileSchema>;

/**
 * PAYR-04: the file holds exactly the bank-transfer payslips of the run and
 * its total equals their net pay (= run net - cash). Throws on mismatch.
 */
export function assertBankFileMatchesRun(
  rows: readonly { employeeId: EmployeeId; amountIdr: Idr }[],
  slips: readonly Pick<
    PayslipCalculation,
    "employeeId" | "netIdr" | "paymentMethod"
  >[],
  totals: Pick<PayrollRunTotals, "bankTransferIdr">,
): void {
  const expected = new Map(
    slips
      .filter(
        (slip) => slip.paymentMethod === "bank_transfer" && slip.netIdr > 0,
      )
      .map((slip) => [slip.employeeId, slip.netIdr]),
  );
  const fileTotal = sumIdr(rows.map((row) => row.amountIdr));
  const sameRows =
    rows.length === expected.size &&
    rows.every((row) => expected.get(row.employeeId) === row.amountIdr);
  if (!sameRows || fileTotal !== totals.bankTransferIdr)
    throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");
}

// ---- Tax documents ------------------------------------------------------

export const payrollTaxExportKindSchema = z.enum([
  /** Monthly PPh 21 withholding report + bukti potong per employee. */
  "monthly_withholding",
  /** Annual bukti potong (1721-A1 equivalent) after the last tax period. */
  "annual_statement",
]);

export const payrollTaxExportSchema = z.strictObject({
  id: payrollTaxExportIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  kind: payrollTaxExportKindSchema,
  /** YYYY-MM for monthly, YYYY for annual. */
  taxPeriod: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  status: z.enum(["pending", "ready", "failed"]),
  /** Signed URL when ready (format per Coretax import spec, BE bead). */
  fileUrl: z.url().nullable(),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type PayrollTaxExport = z.infer<typeof payrollTaxExportSchema>;
