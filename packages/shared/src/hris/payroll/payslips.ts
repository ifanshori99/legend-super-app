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
  idr,
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
    /**
     * Total PPh 21 owed for the period: withheld + borne + receivable -
     * refunds (the deposit).
     */
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
    /**
     * Part of `pph21EmployerRefundIdr` that returns an earlier gross-up tax
     * allowance (journal: 6101 salary expense); the rest returns borne tax
     * (6111). Absent = 0.
     */
    pph21EmployerAllowanceRefundIdr: nonNegativeIdr.optional(),
    /**
     * The employee's PPh 21 above the pay left (withholding cap): deposited by
     * the employer and owed back by the employee as an employee receivable,
     * collected from later pay (founder decision B8, bead legend-kn3n). Not a
     * taxable benefit, no gross-up. Absent = 0.
     */
    pph21ReceivableIdr: nonNegativeIdr.optional(),
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
  )
  .refine(
    (tax) =>
      (tax.pph21EmployerAllowanceRefundIdr ?? 0) <= tax.pph21EmployerRefundIdr,
    {
      message: "employer allowance refund cannot exceed the employer refund",
    },
  )
  .refine(
    (tax) => !((tax.pph21ReceivableIdr ?? 0) > 0 && tax.pph21RefundIdr > 0),
    {
      message:
        "an employee receivable and an employee refund cannot both be set",
    },
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
  /**
   * PPh 21 receivable of the employee still open after this payslip (raised
   * minus collected, 0 when paid off). Written on payslips sealed from
   * legend-2fk79 on; absent on older ones (the loader then reads the history).
   */
  pph21ReceivableOpenAfterIdr: nonNegativeIdr.optional(),
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
  // Withheld may exceed the period tax when the employer takes back its own
  // Jan-Nov lebih potong in the same slip (bead legend-u1xq): the split must
  // still add up to the tax owed.
  if (
    slip.tax.pph21WithheldIdr +
      slip.tax.pph21EmployerBorneIdr +
      (slip.tax.pph21ReceivableIdr ?? 0) -
      slip.tax.pph21RefundIdr -
      slip.tax.pph21EmployerRefundIdr !==
    slip.tax.pph21Idr
  )
    issues.push("withheld + borne + receivable - refunds != PPh 21 owed");
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

// ---- Payslip PIN lifecycle (bead legend-2ap3) ----------------------------

/** Same limits as the staff device pin (identity/limits.ts), kept separate. */
export const PAYSLIP_PIN_MAX_ATTEMPTS = 5;
export const PAYSLIP_PIN_LOCK_MINUTES = 15;
/**
 * @deprecated legend-ur82k removes with the new screen. The outbound WhatsApp
 * code is gone from the API (legend-9h2oj); reset runs through an inbound
 * WhatsApp message (`reset-wa`).
 */
export const PAYSLIP_PIN_OTP_LENGTH = 6;
export const PAYSLIP_PIN_OTP_TTL_MINUTES = 5;
export const PAYSLIP_PIN_OTP_MAX_ATTEMPTS = 5;

export const payslipPinStatusValueSchema = z.enum([
  "not_set",
  "active",
  "locked",
]);
export type PayslipPinStatusValue = z.infer<typeof payslipPinStatusValueSchema>;

/** Never carries the PIN, hash or attempt counter. */
export const payslipPinStatusSchema = z.strictObject({
  status: payslipPinStatusValueSchema,
  lockedUntil: isoDateTimeSchema.nullable(),
});
export type PayslipPinStatus = z.infer<typeof payslipPinStatusSchema>;

/**
 * First set: no `currentPin`. Change: `currentPin` is required, and a wrong one
 * counts as a failed attempt (same counter and lock as opening a payslip).
 */
export const setMyPayslipPinInputSchema = clientInputSchema({
  pin: payslipPinSchema,
  currentPin: payslipPinSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type SetMyPayslipPinInput = z.infer<typeof setMyPayslipPinInputSchema>;

/** HR clears the hash and the lock; HR never sees or sets the PIN itself. */
export const resetPayslipPinInputSchema = clientInputSchema({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: idempotencyKeySchema,
});
export type ResetPayslipPinInput = z.infer<typeof resetPayslipPinInputSchema>;

/** @deprecated legend-ur82k removes with the new screen. */
export const requestPayslipPinResetOtpInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});
export type RequestPayslipPinResetOtpInput = z.infer<
  typeof requestPayslipPinResetOtpInputSchema
>;

/** @deprecated legend-ur82k removes with the new screen. */
export const payslipPinResetOtpRequestedSchema = z.strictObject({
  expiresAt: isoDateTimeSchema,
});
export type PayslipPinResetOtpRequested = z.infer<
  typeof payslipPinResetOtpRequestedSchema
>;

/** @deprecated legend-ur82k removes with the new screen. */
export const verifyPayslipPinResetOtpInputSchema = clientInputSchema({
  code: z
    .string()
    .regex(
      new RegExp(`^\\d{${PAYSLIP_PIN_OTP_LENGTH}}$`),
      `The code is ${PAYSLIP_PIN_OTP_LENGTH} digits`,
    ),
  pin: payslipPinSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type VerifyPayslipPinResetOtpInput = z.infer<
  typeof verifyPayslipPinResetOtpInputSchema
>;

// ---- Payslip PIN reset by an inbound WhatsApp message (bead legend-9h2oj) --

/** POST reset-wa: no input; the proof is for the signed-in employee. */
export const requestPayslipPinResetWaInputSchema = clientInputSchema({});
export type RequestPayslipPinResetWaInput = z.infer<
  typeof requestPayslipPinResetWaInputSchema
>;

/** The code is shown once and never stored (design D-WA6). */
export const payslipPinResetWaIssuedSchema = z.strictObject({
  challengeId: z.string().uuid(),
  /** `K7Q4-M2XD`. */
  code: z.string(),
  /** `https://wa.me/<number>?text=RESET%20PIN%20K7Q4-M2XD`. */
  waLink: z.string(),
  /** Last four digits of the employee's own number. */
  senderHint: z.string().regex(/^\d{4}$/),
  expiresAt: isoDateTimeSchema,
});
export type PayslipPinResetWaIssued = z.infer<
  typeof payslipPinResetWaIssuedSchema
>;

export const payslipPinResetWaStatusSchema = z.strictObject({
  status: z.enum(["pending", "verified", "used", "expired", "cancelled"]),
  expiresAt: isoDateTimeSchema,
  grantExpiresAt: isoDateTimeSchema.nullable(),
});
export type PayslipPinResetWaStatus = z.infer<
  typeof payslipPinResetWaStatusSchema
>;

export const payslipPinResetWaParamsSchema = z.strictObject({
  challengeId: z.string().uuid(),
});

/** New PIN after the number was verified; the proof is used once. */
export const completePayslipPinResetWaInputSchema = clientInputSchema({
  pin: payslipPinSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CompletePayslipPinResetWaInput = z.infer<
  typeof completePayslipPinResetWaInputSchema
>;

export const cancelPayslipPinResetWaInputSchema = clientInputSchema({});

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
    /** PPh 21 borne by the employer (net scheme): no payslip line, not in gross. */
    pph21EmployerBorneIdr: nonNegativeIdr,
    /**
     * Lebih potong paid back to employees as a PPH21_REFUND earning line, so
     * it is inside gross.
     */
    pph21RefundIdr: nonNegativeIdr,
    /** Lebih potong that returns to the employer (tax it bore earlier). */
    pph21EmployerRefundIdr: nonNegativeIdr,
    /**
     * Part of `pph21EmployerRefundIdr` that returns an earlier gross-up tax
     * allowance. Journal: Cr salary_expense (the borne rest is Cr
     * pph21_borne_expense).
     */
    pph21EmployerAllowanceRefundIdr: nonNegativeIdr,
    loanRepaymentIdr: nonNegativeIdr,
    /**
     * PPh 21 the employees could not have withheld this run, raised as an
     * employee receivable (founder decision B8). Journal: Dr employee_receivable.
     */
    pph21ReceivableIdr: nonNegativeIdr,
    /**
     * Earlier receivable collected from this run's pay (`pph21_receivable`
     * deduction lines). Journal: Cr employee_receivable.
     */
    pph21ReceivableCollectedIdr: nonNegativeIdr,
    /** Late and custom deductions. */
    otherDeductionsIdr: nonNegativeIdr,
    /**
     * Part of otherDeductionsIdr from custom_deduction lines (koperasi dues
     * etc.). Journal: Cr payroll_custom_deduction. Default 0 keeps totals
     * written before this field: they posted all other deductions to
     * salary_expense.
     */
    customDeductionsIdr: nonNegativeIdr.default(idr(0)),
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
        t.pph21ReceivableCollectedIdr +
        t.otherDeductionsIdr
    )
      issue(
        "deductionsIdr",
        "deductions = BPJS employee + PPh 21 withheld + loans + receivable collected + other",
      );
    if (t.netIdr !== t.grossIdr - t.deductionsIdr)
      issue("netIdr", "net = gross - deductions");
    if (t.netIdr !== t.bankTransferIdr + t.cashIdr)
      issue("bankTransferIdr", "net = bank transfer + cash (PAYR-04)");
    // No withheld <= owed check here: a slip may withhold more than it owes
    // when the employer gets its own lebih potong back (bead legend-u1xq);
    // each slip's split is checked by payslipTotalsIssues.
    if (
      t.pph21Idr !==
      t.pph21WithheldIdr +
        t.pph21EmployerBorneIdr +
        t.pph21ReceivableIdr -
        t.pph21RefundIdr -
        t.pph21EmployerRefundIdr
    )
      issue(
        "pph21Idr",
        "PPh 21 = withheld + employer borne + receivable - refund - employer refund",
      );
    if (t.customDeductionsIdr > t.otherDeductionsIdr)
      issue(
        "customDeductionsIdr",
        "custom deductions cannot exceed other deductions",
      );
    if (t.pph21EmployerAllowanceRefundIdr > t.pph21EmployerRefundIdr)
      issue(
        "pph21EmployerAllowanceRefundIdr",
        "employer allowance refund cannot exceed the employer refund",
      );
    if (t.serviceChargeIdr + t.reimbursementIdr + t.pph21RefundIdr > t.grossIdr)
      issue(
        "serviceChargeIdr",
        "service charge + reimbursement + PPh 21 refund exceed gross",
      );
  });
export type PayrollRunTotals = z.infer<typeof payrollRunTotalsSchema>;
/** Totals before parsing: `customDeductionsIdr` may be absent (written before legend-75kr). */
export type PayrollRunTotalsInput = z.input<typeof payrollRunTotalsSchema>;

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
    pph21EmployerBorneIdr: total((s) => s.tax.pph21EmployerBorneIdr),
    pph21RefundIdr: total((s) => s.tax.pph21RefundIdr),
    pph21EmployerRefundIdr: total((s) => s.tax.pph21EmployerRefundIdr),
    pph21EmployerAllowanceRefundIdr: total((s) =>
      idr(s.tax.pph21EmployerAllowanceRefundIdr ?? 0),
    ),
    loanRepaymentIdr: lineTotal((l) => l.category === "loan_installment"),
    pph21ReceivableIdr: total((s) => idr(s.tax.pph21ReceivableIdr ?? 0)),
    pph21ReceivableCollectedIdr: lineTotal(
      (l) => l.category === "pph21_receivable",
    ),
    otherDeductionsIdr: lineTotal(
      (l) =>
        l.kind === "deduction" &&
        l.category !== "loan_installment" &&
        l.category !== "pph21_receivable" &&
        l.category !== "bpjs_employee" &&
        l.category !== "pph21",
    ),
    customDeductionsIdr: lineTotal(
      (l) => l.kind === "deduction" && l.category === "custom_deduction",
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

/**
 * A Coretax export that a lock or reversal left stale (legend 1229). `message`
 * tells the payroll admin to export again and file a pembetulan SPT.
 */
export const payrollTaxExportSupersededSchema = z.strictObject({
  id: payrollTaxExportIdSchema,
  kind: payrollTaxExportKindSchema,
  taxPeriod: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  supersededAt: isoDateTimeSchema,
  message: z.string().min(1).max(300),
});
export type PayrollTaxExportSuperseded = z.infer<
  typeof payrollTaxExportSupersededSchema
>;

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
  /**
   * Set when a run of this month (or year) was reversed or a new run was
   * locked after the export: the file no longer matches the payslips. A new
   * export is needed, and an SPT already filed needs a pembetulan.
   */
  supersededAt: isoDateTimeSchema.nullable(),
  /**
   * What the export holds and what it left out (counts only, no personal
   * data). Present on the response of the export call, absent when only the
   * stored row is known.
   */
  summary: z
    .strictObject({
      rowCount: z.number().int().min(0).max(100_000),
      /** Payslips left out, by reason. */
      excluded: z.strictObject({
        /** Daily or intern staff (not pegawai tetap): other bukti potong, out of scope. */
        nonPermanentEmployee: z.number().int().min(0),
        /** Last tax period (annual recalculation): belongs to the A1. */
        annualRecalculation: z.number().int().min(0),
        /** Combined monthly gross is zero: nothing to report. */
        zeroGross: z.number().int().min(0),
      }),
    })
    .optional(),
});
export type PayrollTaxExport = z.infer<typeof payrollTaxExportSchema>;
