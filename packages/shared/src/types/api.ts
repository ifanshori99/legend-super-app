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
 * (`failed` or `not_sent`) or the return of a paid item. `outcome` is null for
 * a return. `proposedAt` is the item's last update, which the first step set.
 */
export type PayrollPayoutProposalDto = {
  itemId: string;
  employeeId: string;
  kind: "resolve" | "return";
  outcome: "failed" | "not_sent" | null;
  evidenceKey: string | null;
  note: string | null;
  proposedBy: string;
  /** user.name, only for a user with a role assignment in this tenant; else null. */
  proposedByName: string | null;
  proposedAt: string;
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
