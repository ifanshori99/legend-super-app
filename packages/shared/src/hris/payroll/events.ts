// Payroll event payloads (PRD v1.7 §3 D.30 "Jurnal Payroll", D.31; PAYR-04,
// PAYR-05; naming `<aggregate>.<past_verb>`). Registered on the WS-10 line of
// `events/catalog.ts`; the aggregate type of `payroll.*` is the payroll run.
//
// Payloads carry run-level totals the accounting consumer needs for the
// journal (gaji, utang gaji, utang BPJS, utang PPh 21, piutang kasbon), never
// per-employee salary, bank account, NIK or NPWP (HR-03). Kasbon and
// reimbursement amounts are carried because their cash journals need them;
// the event store is internal and never served to clients.

import {
  z,
  userIdSchema,
  idrSchema,
  businessDateSchema,
  isoDateTimeSchema,
} from "../../core/index.ts";
import { legalEntityIdSchema } from "../../accounting/ids.ts";
import { defineDomainEvent } from "../../events/define.ts";
import { employeeIdSchema } from "../ids.ts";
import {
  bankTransferFileIdSchema,
  employeeLoanIdSchema,
  payoutApprovalLogIdSchema,
  payoutBatchDisputeIdSchema,
  payoutBatchUnfreezeIdSchema,
  payrollRunIdSchema,
  payslipIdSchema,
  reimbursementCategoryIdSchema,
  reimbursementIdSchema,
} from "./ids.ts";
import { payrollRunTotalsSchema } from "./payslips.ts";
import { reimbursementPayoutSchema } from "./reimbursements.ts";
import { payrollRunTypeSchema } from "./run.ts";

const runRef = {
  payrollRunId: payrollRunIdSchema,
  legalEntityId: legalEntityIdSchema,
  runType: payrollRunTypeSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  payDate: businessDateSchema,
};

/**
 * Run locked (Alur K step 4): journal, bank file and payslips follow. The
 * journal balances because totals satisfy gross = net + BPJS employee +
 * PPh 21 withheld + kasbon + other deductions (PAYR-04).
 */
export const payrollLocked = defineDomainEvent({
  name: "payroll.locked",
  payload: z.strictObject({
    ...runRef,
    totals: payrollRunTotalsSchema,
    lockedBy: userIdSchema,
    lockedAt: isoDateTimeSchema,
  }),
});

/**
 * HR approved the run and the final approval is now asked of a second, distinct
 * person (PAYROLL_RUN_SIDE_EFFECTS.approve_hr). Run-level totals only, never
 * per-employee amounts (HR-03); no journal follows.
 */
export const payrollApprovalRequested = defineDomainEvent({
  name: "payroll.approval_requested",
  payload: z.strictObject({
    ...runRef,
    totals: payrollRunTotalsSchema,
    approvedByHr: userIdSchema,
    approvedByHrAt: isoDateTimeSchema,
  }),
});

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Must not be negative");

/**
 * Finance marked the transfer done (Alur K step 5). The payout split is
 * carried for the journal: Dr salaries_payable net, Cr bank + petty_cash.
 */
export const payrollPaid = defineDomainEvent({
  name: "payroll.paid",
  payload: z
    .strictObject({
      ...runRef,
      netIdr: idrSchema,
      /** Paid by bank transfer (the run totals' `bankTransferIdr`). */
      bankTransferIdr: nonNegativeIdr,
      /** Paid in cash (the run totals' `cashIdr`). */
      cashIdr: nonNegativeIdr,
      bankTransferFileId: bankTransferFileIdSchema.nullable(),
      /** Null when the approver has no UUID identity (a system actor). */
      paidBy: userIdSchema.nullable(),
      paidAt: isoDateTimeSchema,
      /**
       * Every item was settled by its own payout journal (legend-658): the
       * consumer posts nothing at run level. Absent means false (a run paid
       * without disbursement batches, posted as before).
       */
      settledPerItem: z.boolean().optional(),
    })
    .refine((p) => p.netIdr === p.bankTransferIdr + p.cashIdr, {
      path: ["netIdr"],
      message: "net = bank transfer + cash (PAYR-04)",
    }),
});

/** Approved cancellation of a locked run: reversing journal (PAYR-05). */
export const payrollReversed = defineDomainEvent({
  name: "payroll.reversed",
  payload: z
    .strictObject({
      ...runRef,
      /** The totals being reversed (the locked run's totals). */
      totals: payrollRunTotalsSchema,
      requestedBy: userIdSchema,
      approvedBy: userIdSchema,
      reversedAt: isoDateTimeSchema,
    })
    .refine((p) => p.requestedBy !== p.approvedBy, {
      path: ["approvedBy"],
      message: "Reversal approver differs from the requester",
    }),
});

/** One per payslip at lock; the employee is notified (no amounts here). */
export const payslipCreated = defineDomainEvent({
  name: "payslip.created",
  payload: z.strictObject({
    payslipId: payslipIdSchema,
    payrollRunId: payrollRunIdSchema,
    employeeId: employeeIdSchema,
    payDate: businessDateSchema,
  }),
});

/** How a kasbon was paid out: petty cash or a bank transfer. */
export const employeeLoanDisbursedViaSchema = z.enum(["cash", "bank"]);
export type EmployeeLoanDisbursedVia = z.infer<
  typeof employeeLoanDisbursedViaSchema
>;

/** Kasbon paid out to the employee: cash/bank journal (piutang karyawan). */
export const employeeLoanDisbursed = defineDomainEvent({
  name: "employee_loan.disbursed",
  payload: z.strictObject({
    employeeLoanId: employeeLoanIdSchema,
    employeeId: employeeIdSchema,
    legalEntityId: legalEntityIdSchema,
    principalIdr: idrSchema,
    /**
     * Absent on events emitted before legend-1coh: posts as before, petty
     * cash.
     */
    disbursedVia: employeeLoanDisbursedViaSchema.optional(),
    disbursedBy: userIdSchema,
    disbursedAt: isoDateTimeSchema,
  }),
});

/** Reimbursement paid; cash payouts need their own journal. */
export const reimbursementPaid = defineDomainEvent({
  name: "reimbursement.paid",
  payload: z
    .strictObject({
      reimbursementId: reimbursementIdSchema,
      employeeId: employeeIdSchema,
      categoryId: reimbursementCategoryIdSchema,
      amountIdr: idrSchema,
      payout: reimbursementPayoutSchema,
      payrollRunId: payrollRunIdSchema.nullable(),
      paidAt: isoDateTimeSchema,
    })
    .refine((p) => (p.payout === "payroll") === (p.payrollRunId !== null), {
      path: ["payrollRunId"],
      message: "A payroll payout names its run; a cash payout does not",
    }),
});

/**
 * A payout step was attested under a one-time grant (legend-7gghu): the person
 * behind the step hears about it outside the session that made it. The payload
 * is the log row id ONLY: the recipient, the kind, the step, the batch and the
 * item count are re-read from the append-only log, so a forged event cannot
 * name another recipient. No amount, name or account (the batch total is
 * sealed). `aggregateId` is the log row.
 */
export const payoutStepAttested = defineDomainEvent({
  name: "payout.step_attested",
  payload: z.strictObject({ logId: payoutApprovalLogIdSchema }),
});

/**
 * Someone said "not me" about a payout step and froze the batch
 * (legend-l2zru). The payload is the dispute row id ONLY: the batch, the
 * disputant and the status at that moment are re-read from the append-only
 * dispute table, so a forged event cannot name a recipient. No amount, name or
 * account. `aggregateId` is the dispute row.
 */
export const payoutBatchDisputed = defineDomainEvent({
  name: "payout.batch_disputed",
  payload: z.strictObject({ disputeId: payoutBatchDisputeIdSchema }),
});

/**
 * An owner or finance user lifted a batch freeze (legend-l2zru). The payload
 * is the unfreeze row id ONLY, same rule as `payout.batch_disputed`.
 * `aggregateId` is the unfreeze row.
 */
export const payoutBatchUnfrozen = defineDomainEvent({
  name: "payout.batch_unfrozen",
  payload: z.strictObject({ unfreezeId: payoutBatchUnfreezeIdSchema }),
});

export const payrollDomainEvents = [
  payrollLocked,
  payrollApprovalRequested,
  payrollPaid,
  payrollReversed,
  payslipCreated,
  employeeLoanDisbursed,
  reimbursementPaid,
  payoutStepAttested,
  payoutBatchDisputed,
  payoutBatchUnfrozen,
] as const;

export const payrollEventNames = payrollDomainEvents.map((event) => event.name);
export type PayrollEventName = (typeof payrollEventNames)[number];
