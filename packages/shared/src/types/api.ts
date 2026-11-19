// The JSON contract between the API and the web app. Timestamps cross the wire
// as ISO strings, so these are the shapes the browser actually receives.

import type { FinanceExceptionKind } from "../validators/finance-exceptions";
import type {
  PayoutBankFormat,
  PayoutBatchStatus,
  PayoutChannel,
  PayoutExcludedReason,
  PayoutItemStatus,
  PayoutMethod,
} from "../validators/payroll-payout";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
    /** PAYSLIP_PIN_INVALID (403): attempts left before the PIN locks. */
    remainingAttempts?: number;
    /** PAYSLIP_PIN_LOCKED (423): ISO datetime the lock ends. */
    lockedUntil?: string;
  };
};

export type PageMeta = { limit: number; offset: number; hasMore: boolean };

export type Paginated<T> = { data: T[]; meta: PageMeta };

export type DataResponse<T> = { data: T };

/** Platform-only: the Kirimdev sender number a tenant or outlet sends from. */
export type KirimdevSenderMappingDto = {
  id: string;
  tenantId: string;
  /** null = tenant-wide sender. */
  outletId: string | null;
  phoneNumberId: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Per-legal-entity payroll payout settings. Amounts are whole rupiah. */
export type PayrollPayoutConfigDto = {
  id: string;
  legalEntityId: string;
  method: PayoutMethod;
  integrationId: string | null;
  manualSourceBankAccountId: string;
  manualBankFormat: PayoutBankFormat;
  maxPerTransferIdr: number;
  dailyCapIdr: number | null;
  feePerTransferIdr: number;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
  createdAt: string;
};

/** One payee line of a disbursement batch. Never carries a full account number. */
export type PayrollDisbursementItemDto = {
  id: string;
  batchId: string;
  payslipId: string;
  employeeId: string;
  channel: PayoutChannel;
  attemptNo: number;
  status: PayoutItemStatus;
  excludedReason: PayoutExcludedReason | null;
  amountIdr: number;
  feeIdr: number;
  bankCode: string | null;
  /** Payee name locked when the batch was created; null for cash or legacy items. */
  accountHolderName: string | null;
  /** `****1234`, locked when the batch was created; null for cash or legacy items. */
  maskedAccountNumber: string | null;
  nameMatch: boolean | null;
  providerRef: string | null;
  confirmedBy: string | null;
  confirmationRef: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Result of a resolve/return evidence upload: pass evidenceKey to resolve or return. */
export type PayrollPayoutEvidenceUploadDto = {
  evidenceKey: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  sizeBytes: number;
};

/** Short-lived link to a stored proof of one batch (read path, legend-t58lr). */
export type PayrollPayoutEvidenceReadDto = {
  evidenceKey: string;
  url: string;
  expiresAt: string;
};

/**
 * One manual step waiting for its second person (legend-t58lr): a resolve
 * (`failed` or `not_sent`), the return of a paid item, or an open correction or
 * overpaid proposal. `outcome` is null for all but a resolve. `proposedAt` is the item's last update, which the first step set.
 */
export type PayrollPayoutProposalDto = {
  itemId: string;
  employeeId: string;
  kind: "resolve" | "return" | "correction" | "overpaid";
  outcome: "failed" | "not_sent" | null;
  evidenceKey: string | null;
  note: string | null;
  proposedBy: string;
  /** user.name, only for a user with a role assignment in this tenant; else null. */
  proposedByName: string | null;
  proposedAt: string;
  /**
   * Only for `correction` and `overpaid` (legend-xatux): every item of the
   * proposal, sorted; `itemId` is the first. A withdraw names exactly this set.
   */
  groupItemIds?: string[];
};

/** One proof key the fingerprint backfill left stuck, with its closure if any (905 card 3). */
export type PayoutStuckProof = {
  evidenceKey: string;
  batchId: string;
  reason:
    | "unreadable"
    | "hash_conflict"
    | "legacy_duplicate"
    | "shared_key"
    | "bind_failed";
  attempts: number;
  firstSeenAt: string;
  closure: {
    id: string;
    stage: "proposed" | "closed";
    proposedAt: string;
    closedAt: string | null;
  } | null;
};

/** Result of proposing or approving the closure of a stuck proof key. */
export type PayoutProofClosureProposedDto = {
  closureId: string;
  stage: "proposed";
};
export type PayoutProofClosureClosedDto = {
  closureId: string;
  stage: "closed";
  /** True while some proof (this tenant or any other) still holds the global gate. */
  gatePending: boolean;
};

/**
 * One open "not me" claim on a batch (legend-l2zru). `reason` is the
 * disputant's own words; the claimant's identity is shown only to the claimant.
 */
export type PayoutBatchDisputeDto = {
  id: string;
  /**
   * The batch the claim was filed on. It is the batch to unfreeze; it differs
   * from the batch shown when this one is frozen through a sibling (a retry
   * batch of the same payslip).
   */
  batchId: string;
  logId: string;
  /** ISO datetime of the claim. */
  createdAt: string;
  /** Batch status when the batch was frozen. */
  batchStatusAt: string;
  reason: string | null;
  /** True when the caller filed this claim. */
  mine: boolean;
};

/** A batch is frozen while it has a dispute with no unfreeze row. */
export type PayoutBatchFreezeDto = {
  frozen: boolean;
  /** Open disputes only; empty when not frozen. */
  disputes: PayoutBatchDisputeDto[];
};

/**
 * One payout step logged on the login of the caller (GET
 * /payout-approval-log/:logId): the page the receipt notification links to.
 * No amount, name or account number.
 */
export type PayoutApprovalLogDto = {
  id: string;
  batchId: string;
  kind:
    | "correction"
    | "overpaid"
    | "return"
    | "posting_source"
    | "closure"
    | "resolve"
    | "bank_confirm"
    | "batch_approve"
    | "return_withdraw";
  step: "propose" | "approve" | "record" | "confirm" | "withdraw";
  itemCount: number;
  /** Payroll period label of the batch, as in the receipt notification. */
  period: string;
  /** ISO datetime the step was logged. */
  loggedAt: string;
  /** True once the caller has already said "not me" for this step. */
  disowned: boolean;
  /** The batch is frozen now (by this claim or another). */
  batchFrozen: boolean;
};

/**
 * One reconciliation flag and the state of its two-person clearance (GET
 * /payout-recon-flags). `clearance` is the clearance of the flag's current
 * fingerprint, null until someone proposes for it; the flag holds the payslip
 * back until `clearance.status` is `approved`. No amount, name or account
 * number.
 */
export type PayoutReconFlagDto = {
  id: string;
  kind: string;
  itemId: string;
  payslipId: string;
  batchId: string;
  reason: string;
  /** ISO datetime the reconciliation flagged it. */
  flaggedAt: string;
  /**
   * True when a clearance was approved for other flagged data (an earlier
   * fingerprint, legend-hklnq) and none is approved for the current one: the
   * flag holds the payslip again and needs a new clearance.
   */
  reopened: boolean;
  clearance: {
    id: string;
    status: "proposed" | "approved";
    reason: string;
    proposedBy: string;
    proposedAt: string;
    approvedBy: string | null;
    approvedAt: string | null;
  } | null;
};

/**
 * One return claim of a batch and its two-person withdrawal (legend-snwnn; GET
 * /disbursement-batches/:id/return-claims). `withdrawal` is the open (not yet
 * approved) proposal to withdraw an `open` claim, null when there is none.
 * `itemCount` counts the items still tied to the claim (0 once withdrawn). No
 * amount, name or account number.
 */
export type PayoutReturnClaimDto = {
  id: string;
  status: "open" | "consumed" | "withdrawn";
  bankRef: string | null;
  itemCount: number;
  createdBy: string;
  /** ISO datetime the claim was made. */
  createdAt: string;
  withdrawal: {
    id: string;
    reason: string;
    proposedBy: string;
    proposedAt: string;
  } | null;
};

/**
 * Answer of the two payout GL resolve actions (POST
 * /payout-gl-postings/:postingId/fee-opening-balance and /payable-hold-release).
 * `resolvedAt` is the ISO datetime the database stamped; no amount or name.
 */
export type PayoutGlResolveDto = {
  postingId: string;
  resolvedAt: string;
};

/** A disbursement batch for one payroll run. totalIdr is the sum of items. */
export type PayrollDisbursementBatchDto = {
  id: string;
  legalEntityId: string;
  payrollRunId: string;
  channel: PayoutChannel;
  status: PayoutBatchStatus;
  haltReason: string | null;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalExpiresAt: string | null;
  contentHash: string | null;
  /** Bank account frozen at approve (manual_bank); null before approve. */
  sourceBankAccountId: string | null;
  itemCount: number;
  totalIdr: number;
  bankFormat: PayoutBankFormat | null;
  exportChecksumSha256: string | null;
  exportedBy: string | null;
  exportedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  freeze: PayoutBatchFreezeDto;
  items: PayrollDisbursementItemDto[];
};

/** One row finance must look at (GET /api/accounting/finance-exceptions). */
export type FinanceExceptionItemDto = {
  kind: FinanceExceptionKind;
  outletId: string | null;
  /** ISO datetime of the source row. */
  occurredAt: string;
  refType: string;
  refId: string;
  /** Whole rupiah; null when the row has no amount or it is unreadable. */
  amountIdr: number | null;
  detail: string | null;
  /** Only on `receipt_pending_stale` (legend-z13t): what the sale waits for. */
  receiptPending?: FinanceExceptionReceiptPendingDto;
};

/** The order, its payment intent and the state of that intent's payment.paid. */
export type FinanceExceptionReceiptPendingDto = {
  orderId: string | null;
  intentId: string | null;
  /** `missing` = no payment.paid outbox row was found for the intent. */
  outboxState: "pending" | "dead_lettered" | "delivered" | "missing";
};

export type FinanceExceptionSummaryDto = {
  kind: FinanceExceptionKind;
  count: number;
  /** Rows with a known amount, including zero; counted before items are cut. */
  knownAmountCount: number;
  amountIdr: number;
};

/** `summary` counts every row; `items` is cut to the newest 500. */
export type FinanceExceptionsDto = {
  summary: FinanceExceptionSummaryDto[];
  items: FinanceExceptionItemDto[];
  truncated: boolean;
};
