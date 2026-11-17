// Offboarding, final settlement summary and work certificate (PRD v1.7 §3
// Kelompok D 26 "Offboarding", F24 flow M; §6 H `hris_offboardings`).
//
// - An offboarding is one exit case per employee: open → revoked (access cut)
//   → completed, or cancelled while still open.
// - The settlement summary is read-only. It lists what the company still owes
//   or is owed (running salary window, kasbon, reimbursement, leave) and which
//   amounts only the payroll engine can compute; it never computes THR, BPJS
//   or a net payout itself.
// - The work certificate is the render data of the "surat keterangan kerja".

import {
  z,
  clientInputSchema,
  tenantIdSchema,
  userIdSchema,
  idrSchema,
  idr,
  decimal4Schema,
  isoDateTimeSchema,
  businessDateSchema,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { roleAssignmentIdSchema } from "../access/ids.ts";
import {
  employeeIdSchema,
  leaveTypeIdSchema,
  offboardingIdSchema,
  shiftAssignmentIdSchema,
} from "./ids.ts";
import { employeeStatusSchema } from "./organization.ts";
import { employeeLoanIdSchema, payrollRunIdSchema } from "./payroll/ids.ts";
import type { EmployeeLoan } from "./payroll/loans.ts";
import type { Reimbursement } from "./payroll/reimbursements.ts";
import { payrollRunStatusSchema } from "./payroll/run.ts";

export const exitTypeSchema = z.enum([
  "resignation",
  "termination",
  "contract_end",
]);
export type ExitType = z.infer<typeof exitTypeSchema>;

export const offboardingStatusSchema = z.enum([
  "open",
  "revoked",
  "completed",
  "cancelled",
]);
export type OffboardingStatus = z.infer<typeof offboardingStatusSchema>;

const reason = z.string().trim().min(1).max(1000);

/** What the access revocation cut; stored so a repeat call returns it as is. */
export const offboardingRevocationResultSchema = z.strictObject({
  roleAssignmentIds: z.array(roleAssignmentIdSchema),
  sessionsRevoked: z.number().int().nonnegative(),
  pushSubscriptionsRemoved: z.number().int().nonnegative(),
  cancelledShiftIds: z.array(shiftAssignmentIdSchema),
  employeeStatus: employeeStatusSchema,
});
export type OffboardingRevocationResult = z.infer<
  typeof offboardingRevocationResultSchema
>;

export const offboardingSchema = z
  .strictObject({
    id: offboardingIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    exitType: exitTypeSchema,
    reason,
    noticeDate: businessDateSchema.nullable(),
    lastWorkingDate: businessDateSchema,
    status: offboardingStatusSchema,
    accessRevokedAt: isoDateTimeSchema.nullable(),
    accessRevokedBy: userIdSchema.nullable(),
    revocationResult: offboardingRevocationResultSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    completedBy: userIdSchema.nullable(),
    cancelledAt: isoDateTimeSchema.nullable(),
    cancelReason: z.string().min(1).max(500).nullable(),
    certificateNo: z.string().min(1).max(40).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((offboarding, ctx) => {
    if (
      (offboarding.status === "revoked" ||
        offboarding.status === "completed") &&
      offboarding.accessRevokedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["accessRevokedAt"],
        message: "A revoked or completed offboarding needs the revocation time",
      });
    if (offboarding.status === "completed" && offboarding.completedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A completed offboarding needs a completion time",
      });
    if (offboarding.status === "cancelled") {
      if (offboarding.accessRevokedAt !== null)
        ctx.addIssue({
          code: "custom",
          path: ["accessRevokedAt"],
          message: "Access was already revoked; the offboarding cannot cancel",
        });
      if (offboarding.cancelledAt === null || offboarding.cancelReason === null)
        ctx.addIssue({
          code: "custom",
          path: ["cancelReason"],
          message: "A cancelled offboarding needs a time and a reason",
        });
    }
  });
export type Offboarding = z.infer<typeof offboardingSchema>;

export const createOffboardingInputSchema = clientInputSchema({
  exitType: exitTypeSchema,
  reason,
  noticeDate: businessDateSchema.nullable().optional(),
  lastWorkingDate: businessDateSchema,
});
export type CreateOffboardingInput = z.infer<
  typeof createOffboardingInputSchema
>;

/** Only an open offboarding can be edited. */
export const updateOffboardingInputSchema = clientInputSchema({
  exitType: exitTypeSchema.optional(),
  reason: reason.optional(),
  noticeDate: businessDateSchema.nullable().optional(),
  lastWorkingDate: businessDateSchema.optional(),
}).refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  "Nothing to update",
);
export type UpdateOffboardingInput = z.infer<
  typeof updateOffboardingInputSchema
>;

export const cancelOffboardingInputSchema = clientInputSchema({
  reason: z.string().trim().min(1).max(500),
});
export type CancelOffboardingInput = z.infer<
  typeof cancelOffboardingInputSchema
>;

// ---- Final settlement summary ----------------------------------------------

/** Amounts that exist only after the payroll engine runs for the exit period. */
export const pendingPayrollEngineItemSchema = z.enum([
  "prorated_salary",
  "thr",
  "bpjs",
  "leave_cash_out",
  "net_payout",
]);
export type PendingPayrollEngineItem = z.infer<
  typeof pendingPayrollEngineItemSchema
>;

export const finalSettlementSummarySchema = z.strictObject({
  offboardingId: offboardingIdSchema,
  employeeId: employeeIdSchema,
  exitType: exitTypeSchema,
  joinDate: businessDateSchema,
  lastWorkingDate: businessDateSchema,
  runningSalary: z.strictObject({
    lastPayrollRun: z
      .strictObject({
        id: payrollRunIdSchema,
        periodStart: businessDateSchema,
        periodEnd: businessDateSchema,
        status: payrollRunStatusSchema,
      })
      .nullable(),
    /** First day after the last payroll period; null when no run exists. */
    unpaidFrom: businessDateSchema.nullable(),
    unpaidTo: businessDateSchema,
    unpaidCalendarDays: z.number().int().nonnegative(),
  }),
  outstandingLoans: z.strictObject({
    count: z.number().int().nonnegative(),
    amountIdr: idrSchema,
    loanIds: z.array(employeeLoanIdSchema),
  }),
  /**
   * Kasbon installments already reserved by a draft..approved payroll run.
   * They are subtracted from `outstandingLoans.amountIdr` so the same rupiah
   * is not counted twice. Frozen snapshots from before this field default to
   * none.
   */
  pendingPayrollDeductions: z
    .strictObject({
      count: z.number().int().nonnegative(),
      amountIdr: idrSchema,
      loanIds: z.array(employeeLoanIdSchema),
    })
    .default({ count: 0, amountIdr: idr(0), loanIds: [] }),
  unpaidReimbursements: z.strictObject({
    count: z.number().int().nonnegative(),
    amountIdr: idrSchema,
    pendingCount: z.number().int().nonnegative(),
  }),
  /** Day counts are decimal strings, like `leaveBalanceSchema`. */
  leave: z.array(
    z.strictObject({
      leaveTypeId: leaveTypeIdSchema,
      name: z.string().min(1).max(100),
      periodYear: z.number().int().min(2000).max(2100),
      entitledDays: decimal4Schema,
      carriedOverDays: decimal4Schema,
      usedDays: decimal4Schema,
      pendingDays: decimal4Schema,
      remainingDays: decimal4Schema,
    }),
  ),
  pendingPayrollEngine: z.array(pendingPayrollEngineItemSchema),
  computedAt: isoDateTimeSchema,
  /** True once the offboarding is completed: the snapshot no longer changes. */
  frozen: z.boolean(),
});
export type FinalSettlementSummary = z.infer<
  typeof finalSettlementSummarySchema
>;

/** Kasbon still owed by the employee (approved or disbursed, balance > 0). */
export function outstandingLoans(
  loans: readonly Pick<EmployeeLoan, "id" | "status" | "outstandingIdr">[],
): {
  count: number;
  amountIdr: Idr;
  loanIds: EmployeeLoan["id"][];
} {
  const open = loans.filter(
    (loan) =>
      (loan.status === "approved" || loan.status === "disbursed") &&
      loan.outstandingIdr > 0,
  );
  return {
    count: open.length,
    amountIdr: idr(open.reduce((sum, loan) => sum + loan.outstandingIdr, 0)),
    loanIds: open.map((loan) => loan.id),
  };
}

/** Approved reimbursements not paid out yet (owed to the employee). */
export function unpaidReimbursements(
  claims: readonly Pick<
    Reimbursement,
    "status" | "amountIdr" | "approvedAmountIdr"
  >[],
): {
  count: number;
  amountIdr: Idr;
  /** Claims still waiting for a decision: not money owed yet. */
  pendingCount: number;
} {
  const approved = claims.filter((claim) => claim.status === "approved");
  return {
    count: approved.length,
    amountIdr: idr(
      approved.reduce(
        (sum, claim) => sum + (claim.approvedAmountIdr ?? claim.amountIdr),
        0,
      ),
    ),
    pendingCount: claims.filter((claim) => claim.status === "submitted").length,
  };
}

// ---- Work certificate --------------------------------------------------------

/** Render data of the "surat keterangan kerja"; the PDF is drawn from this. */
export const workCertificateSchema = z.strictObject({
  offboardingId: offboardingIdSchema,
  certificateNo: z.string().min(1).max(40),
  issuedAt: isoDateTimeSchema,
  company: z.strictObject({ name: z.string().min(1).max(200) }),
  employee: z.strictObject({
    id: employeeIdSchema,
    fullName: z.string().min(1).max(200),
    employeeNo: z.string().min(1).max(30),
  }),
  positionName: z.string().min(1).max(150),
  outletName: z.string().min(1).max(200),
  joinDate: businessDateSchema,
  lastWorkingDate: businessDateSchema,
  exitType: exitTypeSchema,
  managerName: z.string().min(1).max(200).nullable(),
});
export type WorkCertificate = z.infer<typeof workCertificateSchema>;
