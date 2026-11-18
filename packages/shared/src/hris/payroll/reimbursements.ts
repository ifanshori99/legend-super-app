// Reimbursement (PRD v1.7 §3 D.31 "Klaim dengan foto bukti, kategori, batas per
// jabatan, approval, dan pembayaran melalui payroll atau kas"; §6 H
// `reimbursements`: employee_id, category, amount_idr, receipt_key, status).
//
// Lifecycle:
//   submitted -> approved | rejected | cancelled
//   approved  -> paid   (cash payout, or the payroll run that carried it is
//                         locked; a reversed run puts it back to approved)
// The receipt is a private object: clients upload through a pre-signed
// reference and read back a short-lived signed URL, never a storage key.

import {
  z,
  tenantIdSchema,
  userIdSchema,
  idrSchema,
  businessDateSchema,
  isoDateTimeSchema,
  clientInputSchema,
  idempotencyKeySchema,
} from "../../core/index.ts";
import type { Idr } from "../../core/index.ts";
import { employeeIdSchema, positionIdSchema } from "../ids.ts";
import type { PositionId } from "../ids.ts";
import { PayrollError } from "./errors.ts";
import {
  payrollRunIdSchema,
  reimbursementCategoryIdSchema,
  reimbursementIdSchema,
} from "./ids.ts";

const positiveIdr = idrSchema.refine((v) => v > 0, "Must be positive");

/** Limit of one category for one position ("batas per jabatan"). */
/**
 * A claim may be dated at most this many calendar days before the day it is
 * submitted (founder decision 9 Nov). Checked at submission only; approving
 * later never re-checks it. The API enforces it; forms use it as the `min`
 * of the date input.
 */
export const REIMBURSEMENT_BACKDATE_DAYS = 30;

export const reimbursementLimitSchema = z.strictObject({
  /** null = default for positions without their own row. */
  positionId: positionIdSchema.nullable(),
  perClaimLimitIdr: positiveIdr,
  /** Sum of approved+paid claims per calendar month; null = no monthly cap. */
  perMonthLimitIdr: positiveIdr.nullable(),
});
export type ReimbursementLimit = z.infer<typeof reimbursementLimitSchema>;

const categoryFields = {
  name: z.string().trim().min(1).max(100),
  receiptRequired: z.boolean(),
  limits: z
    .array(reimbursementLimitSchema)
    .min(1)
    .max(200)
    .refine(
      (limits) =>
        new Set(limits.map((limit) => limit.positionId)).size === limits.length,
      "One limit per position",
    ),
};

export const reimbursementCategorySchema = z.strictObject({
  id: reimbursementCategoryIdSchema,
  tenantId: tenantIdSchema,
  ...categoryFields,
  isActive: z.boolean(),
});
export type ReimbursementCategory = z.infer<typeof reimbursementCategorySchema>;

export const createReimbursementCategoryInputSchema = clientInputSchema({
  ...categoryFields,
  idempotencyKey: idempotencyKeySchema,
});

export const REIMBURSEMENT_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "cancelled",
  "paid",
] as const;
export const reimbursementStatusSchema = z.enum(REIMBURSEMENT_STATUSES);
export type ReimbursementStatus = z.infer<typeof reimbursementStatusSchema>;

export const reimbursementPayoutSchema = z.enum(["payroll", "cash"]);
export type ReimbursementPayout = z.infer<typeof reimbursementPayoutSchema>;

export const reimbursementSchema = z
  .strictObject({
    id: reimbursementIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    categoryId: reimbursementCategoryIdSchema,
    expenseDate: businessDateSchema,
    amountIdr: positiveIdr,
    /** May be lowered by the approver, never raised. */
    approvedAmountIdr: positiveIdr.nullable(),
    description: z.string().trim().min(1).max(500),
    /** Signed, short-lived URL of the private receipt photo. */
    receiptUrl: z.url().nullable(),
    payout: reimbursementPayoutSchema,
    status: reimbursementStatusSchema,
    /** Run that paid it when payout = payroll. */
    payrollRunId: payrollRunIdSchema.nullable(),
    submittedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    paidAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((claim, ctx) => {
    const decided = claim.status !== "submitted";
    if (
      (claim.decidedBy !== null) !== decided ||
      (claim.decidedAt !== null) !== decided
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "decidedBy/decidedAt are set exactly after a decision",
      });
    const approved = claim.status === "approved" || claim.status === "paid";
    if ((claim.approvedAmountIdr !== null) !== approved)
      ctx.addIssue({
        code: "custom",
        path: ["approvedAmountIdr"],
        message: "approvedAmountIdr is set exactly for approved/paid claims",
      });
    if (
      claim.approvedAmountIdr !== null &&
      claim.approvedAmountIdr > claim.amountIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["approvedAmountIdr"],
        message: "Approved amount cannot exceed the claimed amount",
      });
    if ((claim.status === "paid") !== (claim.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt is set exactly for paid claims",
      });
    if (
      claim.status === "paid" &&
      claim.payout === "payroll" &&
      claim.payrollRunId === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["payrollRunId"],
        message: "A claim paid through payroll names its run",
      });
    if (claim.payout === "cash" && claim.payrollRunId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["payrollRunId"],
        message: "A cash claim has no payroll run",
      });
  });
export type Reimbursement = z.infer<typeof reimbursementSchema>;

/** Employee self-service claim (PRD §3 D.33: reimbursement with photo). */
export const createReimbursementInputSchema = clientInputSchema({
  categoryId: reimbursementCategoryIdSchema,
  expenseDate: businessDateSchema,
  amountIdr: positiveIdr,
  description: z.string().trim().min(1).max(500),
  /** Pre-signed upload reference for the receipt (private bucket). */
  receiptUploadRef: z.string().min(1).max(200).nullable(),
  payout: reimbursementPayoutSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CreateReimbursementInput = z.infer<
  typeof createReimbursementInputSchema
>;

export type ReimbursementAction = "approve" | "reject" | "cancel" | "pay";

const reimbursementTransitions: Partial<
  Record<
    ReimbursementStatus,
    Partial<Record<ReimbursementAction, ReimbursementStatus>>
  >
> = {
  submitted: { approve: "approved", reject: "rejected", cancel: "cancelled" },
  // An approved claim that was not paid yet can still be cancelled; the
  // service allows it for cash claims only (legend-d5n4j).
  approved: { pay: "paid", cancel: "cancelled" },
};

export function transitionReimbursement(
  status: ReimbursementStatus,
  action: ReimbursementAction,
): ReimbursementStatus {
  const next = reimbursementTransitions[status]?.[action];
  if (!next) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  return next;
}

/** The limit row for a position, falling back to the default (null) row. */
export function reimbursementLimitFor(
  category: Pick<ReimbursementCategory, "limits">,
  positionId: PositionId | null,
): ReimbursementLimit {
  const own = category.limits.find(
    (limit) => positionId !== null && limit.positionId === positionId,
  );
  const fallback = category.limits.find((limit) => limit.positionId === null);
  const limit = own ?? fallback;
  // Fail closed: a position without its own or a default limit cannot claim.
  if (!limit) throw new PayrollError("PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED");
  return limit;
}

/** Throws when a claim breaks the per-claim or monthly limit. */
export function assertReimbursementWithinLimit(
  limit: ReimbursementLimit,
  claimIdr: Idr,
  alreadyApprovedThisMonthIdr: Idr,
): void {
  if (claimIdr > limit.perClaimLimitIdr)
    throw new PayrollError("PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED");
  if (
    limit.perMonthLimitIdr !== null &&
    alreadyApprovedThisMonthIdr + claimIdr > limit.perMonthLimitIdr
  )
    throw new PayrollError("PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED");
}
