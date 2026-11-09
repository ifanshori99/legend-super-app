// Kasbon / employee loans (PRD v1.7 §3 D.31 "Kasbon: pengajuan pinjaman dengan
// batas maksimal, approval, dan cicilan otomatis dipotong dari payroll"; §6 H
// `employee_loans`: employee_id, principal_idr, installment_idr, status).
//
// Lifecycle:
//   pending  -> approved | rejected | cancelled
//   approved -> disbursed | cancelled
//   disbursed -> settled          (outstanding reaches 0 through payroll)
// Installments are deducted only when a payroll run is LOCKED (simulation has
// no side effect, PAYR-01); a reversed run restores the outstanding amount.
//
// Safety rule (brief + PRD silent on shortfalls): a deduction never exceeds
// the net pay available, nor the policy's share of net pay. An unpaid part of
// an installment is carried to the next period, never deducted into negative
// net pay.

import {
  z,
  tenantIdSchema,
  userIdSchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  clientInputSchema,
  idempotencyKeySchema,
  idr,
  divideRounded,
} from "../../core/index.ts";
import type { BasisPoints, Idr } from "../../core/index.ts";
import { employeeIdSchema } from "../ids.ts";
import { PayrollError } from "./errors.ts";
import { employeeLoanIdSchema } from "./ids.ts";

const positiveIdr = idrSchema.refine((v) => v > 0, "Must be positive");
const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Must not be negative");

export const EMPLOYEE_LOAN_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "disbursed",
  "settled",
] as const;
export const employeeLoanStatusSchema = z.enum(EMPLOYEE_LOAN_STATUSES);
export type EmployeeLoanStatus = z.infer<typeof employeeLoanStatusSchema>;

export type EmployeeLoanAction = "approve" | "reject" | "cancel" | "disburse";

const loanTransitions: Partial<
  Record<
    EmployeeLoanStatus,
    Partial<Record<EmployeeLoanAction, EmployeeLoanStatus>>
  >
> = {
  pending: { approve: "approved", reject: "rejected", cancel: "cancelled" },
  approved: { disburse: "disbursed", cancel: "cancelled" },
};

export function transitionEmployeeLoan(
  status: EmployeeLoanStatus,
  action: EmployeeLoanAction,
): EmployeeLoanStatus {
  const next = loanTransitions[status]?.[action];
  if (!next) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  return next;
}

const loanPolicyShape = {
  /** Absolute ceiling per loan; null = only the salary multiple applies. */
  maxPrincipalIdr: positiveIdr.nullable(),
  /** Ceiling as bp of the monthly base salary (10,000 = 1x); null = none. */
  maxPrincipalOfBaseSalaryBp: z.number().int().min(1).max(120_000).nullable(),
  maxInstallments: z.number().int().min(1).max(36),
  /**
   * Ceiling on one employee's open kasbon in total: the unpaid principal of
   * every loan that is not settled, pending and approved ones included, plus
   * the new request (founder decision 9 Nov).
   */
  maxTotalOpenIdr: positiveIdr,
  /** Max share of a period's net pay all installments may take. */
  maxDeductionOfNetPayBp: basisPointsSchema,
  /** One open loan at a time (PRD silent: safest default true). */
  singleOpenLoan: z.boolean(),
};

/**
 * The total open cap may not be below the per-loan ceiling: a smaller total
 * would quietly lower the per-loan limit (CTO decision 9 Nov). Without a
 * rupiah ceiling (only the salary multiple) any total is allowed. The stored
 * row has the same CHECK.
 */
const totalCoversCeiling = (policy: {
  maxPrincipalIdr: number | null;
  maxTotalOpenIdr: number;
}) =>
  policy.maxPrincipalIdr === null ||
  policy.maxTotalOpenIdr >= policy.maxPrincipalIdr;
const totalCoversCeilingIssue = {
  path: ["maxTotalOpenIdr"],
  message: "The total open cap may not be below the per-loan ceiling.",
};

/** Kasbon limits (tenant data; PRD "batas maksimal"). */
export const loanPolicySchema = z
  .strictObject(loanPolicyShape)
  .refine(totalCoversCeiling, totalCoversCeilingIssue);
export type LoanPolicy = z.infer<typeof loanPolicySchema>;

/** A stored kasbon policy: the limits plus when they last changed. */
export const loanPolicyRecordSchema = z
  .strictObject({ ...loanPolicyShape, updatedAt: isoDateTimeSchema })
  .refine(totalCoversCeiling, totalCoversCeilingIssue);
export type LoanPolicyRecord = z.infer<typeof loanPolicyRecordSchema>;

/**
 * Replacing the tenant's kasbon limits. Same shape as `loanPolicySchema` plus
 * the idempotency key; at least one ceiling is required (the stored row has
 * the same rule, so a policy without any ceiling can never exist).
 */
export const setLoanPolicyInputSchema = clientInputSchema({
  ...loanPolicyShape,
  idempotencyKey: idempotencyKeySchema,
})
  .refine(totalCoversCeiling, totalCoversCeilingIssue)
  .refine(
    (policy) =>
      policy.maxPrincipalIdr !== null ||
      policy.maxPrincipalOfBaseSalaryBp !== null,
    {
      path: ["maxPrincipalIdr"],
      message: "Set at least one ceiling (rupiah or share of base salary).",
    },
  );
export type SetLoanPolicyInput = z.infer<typeof setLoanPolicyInputSchema>;

export const employeeLoanSchema = z
  .strictObject({
    id: employeeLoanIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    principalIdr: positiveIdr,
    installmentIdr: positiveIdr,
    installmentCount: z.number().int().min(1).max(36),
    outstandingIdr: nonNegativeIdr,
    /** First payroll period end date the installment applies to. */
    firstDeductionPeriod: businessDateSchema,
    reason: z.string().trim().min(1).max(500),
    status: employeeLoanStatusSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    disbursedAt: isoDateTimeSchema.nullable(),
    settledAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((loan, ctx) => {
    if (loan.outstandingIdr > loan.principalIdr)
      ctx.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message: "Outstanding cannot exceed the principal",
      });
    if (loan.installmentIdr > loan.principalIdr)
      ctx.addIssue({
        code: "custom",
        path: ["installmentIdr"],
        message: "Installment cannot exceed the principal",
      });
    if (loan.installmentIdr * loan.installmentCount < loan.principalIdr)
      ctx.addIssue({
        code: "custom",
        path: ["installmentCount"],
        message: "Installments must cover the principal",
      });
    const decided = loan.status !== "pending";
    if (
      (loan.decidedBy !== null) !== decided ||
      (loan.decidedAt !== null) !== decided
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "decidedBy/decidedAt are set exactly after a decision",
      });
    const disbursed = loan.status === "disbursed" || loan.status === "settled";
    if ((loan.disbursedAt !== null) !== disbursed)
      ctx.addIssue({
        code: "custom",
        path: ["disbursedAt"],
        message: "disbursedAt is set exactly for disbursed/settled loans",
      });
    if (!disbursed && loan.outstandingIdr !== loan.principalIdr)
      ctx.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message: "Before disbursement outstanding equals the principal",
      });
    if ((loan.status === "settled") !== (loan.settledAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["settledAt"],
        message: "settledAt is set exactly for settled loans",
      });
    if (loan.status === "settled" && loan.outstandingIdr !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message: "A settled loan has nothing outstanding",
      });
  });
export type EmployeeLoan = z.infer<typeof employeeLoanSchema>;

/** Employee self-service request (PRD §3 D.33 Fitur: kasbon). */
export const createEmployeeLoanInputSchema = clientInputSchema({
  principalIdr: positiveIdr,
  installmentCount: z.number().int().min(1).max(36),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateEmployeeLoanInput = z.infer<
  typeof createEmployeeLoanInputSchema
>;

/** Equal installments rounded up, so `count` installments cover the loan. */
export function loanInstallmentFor(principalIdr: Idr, count: number): Idr {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new RangeError("Installment count must be a positive integer");
  return idr(
    Number(divideRounded(BigInt(principalIdr), BigInt(count), "ceil")),
  );
}

/** Checks a request against the policy; throws PAYROLL_LOAN_LIMIT_EXCEEDED. */
export function assertLoanWithinPolicy(
  policy: LoanPolicy,
  request: {
    principalIdr: Idr;
    installmentCount: number;
    monthlyBaseSalaryIdr: Idr;
    openLoanCount: number;
    /** Unpaid principal of the employee's other open loans (not settled). */
    openOutstandingIdr: Idr;
  },
): void {
  if (request.installmentCount > policy.maxInstallments)
    throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  if (policy.singleOpenLoan && request.openLoanCount > 0)
    throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  if (
    BigInt(request.openOutstandingIdr) + BigInt(request.principalIdr) >
    BigInt(policy.maxTotalOpenIdr)
  )
    throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  if (
    policy.maxPrincipalIdr !== null &&
    request.principalIdr > policy.maxPrincipalIdr
  )
    throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  if (policy.maxPrincipalOfBaseSalaryBp !== null) {
    const cap = divideRounded(
      BigInt(request.monthlyBaseSalaryIdr) *
        BigInt(policy.maxPrincipalOfBaseSalaryBp),
      10_000n,
      "floor",
    );
    if (BigInt(request.principalIdr) > cap)
      throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  }
  if (
    policy.maxPrincipalIdr === null &&
    policy.maxPrincipalOfBaseSalaryBp === null
  )
    // Fail closed: a policy without any ceiling is a configuration error.
    throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
}

export type LoanDeductionPlan = {
  loanId: EmployeeLoan["id"];
  scheduledIdr: Idr;
  deductedIdr: Idr;
  /** Part of the installment carried to the next period. */
  carriedIdr: Idr;
  outstandingAfterIdr: Idr;
};

/**
 * Installment deductions for one payslip. Loans are served oldest disbursal
 * first; each takes min(installment, outstanding, remaining room). Room =
 * min(net pay before loans, maxDeductionOfNetPayBp x net pay), so the total
 * never exceeds net pay and net pay never goes negative.
 */
export function planLoanDeductions(
  loans: readonly Pick<
    EmployeeLoan,
    "id" | "status" | "installmentIdr" | "outstandingIdr" | "disbursedAt"
  >[],
  netPayBeforeLoansIdr: Idr,
  maxDeductionOfNetPayBp: BasisPoints,
): LoanDeductionPlan[] {
  const available = netPayBeforeLoansIdr > 0 ? netPayBeforeLoansIdr : 0;
  let room = Number(
    divideRounded(
      BigInt(available) * BigInt(maxDeductionOfNetPayBp),
      10_000n,
      "floor",
    ),
  );
  const active = loans
    .filter((loan) => loan.status === "disbursed" && loan.outstandingIdr > 0)
    .slice()
    .sort((a, b) =>
      (a.disbursedAt ?? "") === (b.disbursedAt ?? "")
        ? a.id < b.id
          ? -1
          : 1
        : (a.disbursedAt ?? "") < (b.disbursedAt ?? "")
          ? -1
          : 1,
    );
  return active.map((loan) => {
    const scheduled = Math.min(loan.installmentIdr, loan.outstandingIdr);
    const deducted = Math.max(0, Math.min(scheduled, room));
    room -= deducted;
    return {
      loanId: loan.id,
      scheduledIdr: idr(scheduled),
      deductedIdr: idr(deducted),
      carriedIdr: idr(scheduled - deducted),
      outstandingAfterIdr: idr(loan.outstandingIdr - deducted),
    };
  });
}
