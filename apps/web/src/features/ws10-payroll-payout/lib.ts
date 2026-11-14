// Pure helpers of the payout screens: status vocabulary, batch money, run
// labels. No React and no fetching. Rule: the salary received (`amountIdr`) is
// never reduced by the fee; the PT fee (`feeIdr`) is its own amount and the
// funds to prepare are salary + fee.
import type { MessageKey } from "@starter/shared/i18n";
import type {
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
} from "@starter/shared/types";
import type {
  PayoutBankFormat,
  PayoutBatchStatus,
  PayoutExcludedReason,
  PayoutItemStatus,
} from "@starter/shared/validators/payroll-payout";

export { isMockScenarioRequest } from "../ws10-payroll-run/lib";

export type PayoutTone = "neutral" | "info" | "warning" | "success" | "danger";
export type PayoutStatusMeta = { labelKey: MessageKey; kind: PayoutTone };

/** Props every tab of the payout page receives. */
export type PayoutTabProps = {
  legalEntityId: string;
  batchId?: string;
  access: import("./guard").PayoutAccess;
  currentUserId: string;
  /** `status` lets the page open the tab that fits the batch. */
  onSelectBatch: (id: string, status?: PayoutBatchStatus) => void;
};

export const BATCH_STATUS_META: Record<PayoutBatchStatus, PayoutStatusMeta> = {
  draft: { labelKey: "payrollPayout.batchStatus.draft", kind: "neutral" },
  pending_approval: {
    labelKey: "payrollPayout.batchStatus.pendingApproval",
    kind: "warning",
  },
  approved: { labelKey: "payrollPayout.batchStatus.approved", kind: "info" },
  sending: { labelKey: "payrollPayout.batchStatus.sending", kind: "info" },
  exported: { labelKey: "payrollPayout.batchStatus.exported", kind: "warning" },
  completed: {
    labelKey: "payrollPayout.batchStatus.completed",
    kind: "success",
  },
  partially_failed: {
    labelKey: "payrollPayout.batchStatus.partiallyFailed",
    kind: "danger",
  },
  halted: { labelKey: "payrollPayout.batchStatus.halted", kind: "danger" },
  cancelled: {
    labelKey: "payrollPayout.batchStatus.cancelled",
    kind: "neutral",
  },
};

export function batchStatusMeta(status: PayoutBatchStatus): PayoutStatusMeta {
  return BATCH_STATUS_META[status];
}

const ITEM_STATUS_META: Record<PayoutItemStatus, PayoutStatusMeta> = {
  prepared: { labelKey: "payrollPayout.itemStatus.waiting", kind: "neutral" },
  blocked: { labelKey: "payrollPayout.itemStatus.blocked", kind: "danger" },
  approved: { labelKey: "payrollPayout.itemStatus.waiting", kind: "neutral" },
  sending: { labelKey: "payrollPayout.itemStatus.sending", kind: "info" },
  exported: {
    labelKey: "payrollPayout.itemStatus.waitingConfirm",
    kind: "warning",
  },
  unknown: { labelKey: "payrollPayout.itemStatus.unknown", kind: "warning" },
  succeeded: {
    labelKey: "payrollPayout.itemStatus.succeeded",
    kind: "success",
  },
  failed: { labelKey: "payrollPayout.itemStatus.failed", kind: "danger" },
  not_sent: { labelKey: "payrollPayout.itemStatus.notSent", kind: "danger" },
  cancelled: {
    labelKey: "payrollPayout.itemStatus.cancelled",
    kind: "neutral",
  },
  returned: { labelKey: "payrollPayout.itemStatus.returned", kind: "warning" },
  overpaid: { labelKey: "payrollPayout.itemStatus.overpaid", kind: "danger" },
};

/**
 * Label and tone of one item. Pass the item's channel to tell a transfer a
 * person confirmed by hand ("Dibayar manual") from one the provider settled.
 */
export function itemStatusMeta(
  status: PayoutItemStatus,
  channel?: PayrollDisbursementItemDto["channel"],
): PayoutStatusMeta {
  if (
    status === "succeeded" &&
    (channel === "manual_bank" || channel === "cash")
  )
    return { labelKey: "payrollPayout.itemStatus.paidManual", kind: "success" };
  return ITEM_STATUS_META[status];
}

const EXCLUDED_KEYS: Record<PayoutExcludedReason, MessageKey> = {
  inquiry_failed: "payrollPayout.excluded.inquiryFailed",
  name_mismatch: "payrollPayout.excluded.nameMismatch",
  bank_code_missing: "payrollPayout.excluded.bankCodeMissing",
  bank_format_unsupported: "payrollPayout.excluded.bankFormatUnsupported",
  over_cap: "payrollPayout.excluded.overCap",
};

/** Why an item was left out of the batch, in catalog words. */
export function excludedReasonKey(
  reason: PayoutExcludedReason | null,
): MessageKey {
  return reason === null
    ? "payrollPayout.excluded.unknown"
    : EXCLUDED_KEYS[reason];
}

/**
 * An item that is (or will be) paid: not left out, not blocked, not cancelled.
 * The server seals the fee of blocked items and then cancels them, so only
 * payable items count towards the PT's fee.
 */
export function isPayableItem(
  item: Pick<PayrollDisbursementItemDto, "excludedReason" | "status">,
): boolean {
  return (
    item.excludedReason === null &&
    item.status !== "blocked" &&
    item.status !== "cancelled"
  );
}

/** The PT's fee: sum of the payable item fees (never taken out of the salary). */
export function batchFeeTotal(
  batch: Pick<PayrollDisbursementBatchDto, "items">,
): number {
  return batch.items
    .filter(isPayableItem)
    .reduce((sum, item) => sum + item.feeIdr, 0);
}

/** Funds the PT must prepare: salary total + fee total. */
export function batchFundsNeeded(
  batch: Pick<PayrollDisbursementBatchDto, "items" | "totalIdr">,
): number {
  return batch.totalIdr + batchFeeTotal(batch);
}

/** Statuses the API treats as final: a new batch may start for the run. */
const FINAL_BATCH_STATUSES: readonly PayoutBatchStatus[] = [
  "completed",
  "partially_failed",
  "cancelled",
];

export function isFinalBatch(status: PayoutBatchStatus): boolean {
  return FINAL_BATCH_STATUSES.includes(status);
}

/**
 * A batch that still blocks a new one for the same run (mirrors the API's
 * PAYOUT_BATCH_ALREADY_OPEN rule: draft to halted, not completed, partially
 * failed or cancelled).
 */
export function isOpenBatch(status: PayoutBatchStatus): boolean {
  return !isFinalBatch(status);
}

/** Bank names of the BI codes the HR contract accepts. */
const BANK_NAMES: Record<string, string> = {
  "002": "BRI",
  "008": "Mandiri",
  "009": "BNI",
  "011": "Danamon",
  "013": "Permata",
  "014": "BCA",
  "016": "Maybank",
  "019": "Panin",
  "022": "CIMB Niaga",
  "023": "UOB",
  "028": "OCBC NISP",
  "031": "Citibank",
  "037": "Artha Graha",
  "046": "DBS",
  "050": "Standard Chartered",
  "087": "HSBC",
  "110": "BJB",
  "111": "Bank DKI",
  "114": "Bank Jatim",
  "147": "Muamalat",
  "153": "Sinarmas",
  "200": "BTN",
  "213": "BTPN",
  "426": "Mega",
  "451": "BSI",
  "490": "Bank Neo Commerce",
  "501": "Blu by BCA Digital",
  "535": "SeaBank",
  "542": "Jago",
};

/** "014" → "BCA"; an unknown code reads "Bank 999"; null stays null. */
export function bankCodeLabel(code: string | null): string | null {
  if (code === null) return null;
  return BANK_NAMES[code] ?? `Bank ${code}`;
}

/** "2026-11-30" → "November 2026" (UTC, so SSR and the browser agree). */
export function periodMonthLabel(periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** "****4821" → "•••• 4821". */
export function maskedAccountDisplay(masked: string): string {
  const tail = masked.replace(/^[*•●\s]+/, "");
  return tail === masked ? masked : `•••• ${tail}`;
}

/** Fallback name of the bank file when the response headers are not readable. */
export function bankFileFallbackName(
  batchId: string,
  bankFormat: PayoutBankFormat | null,
): string {
  // Every format the API writes today is a CSV (apps/api payroll-export).
  const extension = bankFormat === null ? "csv" : "csv";
  return `payroll-bank-${batchId.slice(0, 8)}.${extension}`;
}
