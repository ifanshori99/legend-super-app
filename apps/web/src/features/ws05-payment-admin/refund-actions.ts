// What a supervisor may do with a refund, and how it reads on screen. Pure (no
// React, no `@/` alias) so the root tests can import it with plain Node ESM.
// The rules mirror the API guards (apps/api/src/services/payment-refund.service.ts:
// decideRefund, retryRefundPayout, actOnQuarantine): the server stays the
// source of truth and re-checks every action; this only decides which buttons
// are worth showing. Money rule: when the provider may already have paid, the
// only safe action is to look the payout up, never to send it again.
import type { MessageKey } from "@starter/shared/i18n";
import type { RefundView } from "@starter/shared/payment/admin";

export type RefundUiState =
  | "pending_approval"
  | "approved_processing"
  | "unknown_result"
  | "retryable"
  | "failed_final"
  | "rejected"
  | "quarantined"
  | "completed";

export type RefundActions = {
  approve: boolean;
  reject: boolean;
  retry: boolean;
  checkStatus: boolean;
  release: boolean;
  reopen: boolean;
};

/** `last_payout_error` markers the API sets (payment-refund.service.ts). */
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";
const PAYOUT_NOT_FOUND_MAYBE_SENT = "PAYOUT_NOT_FOUND_MAYBE_SENT";
const PAYOUT_IDENTITY_MISMATCH = "DOIT_REFUND_IDENTITY_MISMATCH";
const MANUAL_RECONCILIATION = "MANUAL_RECONCILIATION";
const EVIDENCE_MAPPING_REQUIRED = "EVIDENCE_MAPPING_REQUIRED";
/** The request provably never left (the provider was not reached). */
const PAYOUT_SEND_RIGHT_LOST = "PAYOUT_SEND_RIGHT_LOST";
const PAYOUT_SEND_WINDOW_MISSED = "PAYOUT_SEND_WINDOW_MISSED";

/** Sticky flags: money may have moved, so the refund is never re-sent. */
const MAYBE_SENT_FLAGS: ReadonlySet<string> = new Set([
  PAYOUT_NOT_FOUND_MAYBE_SENT,
  PAYOUT_IDENTITY_MISMATCH,
  MANUAL_RECONCILIATION,
]);

/**
 * Errors recorded before any request reached the provider. The API sets them
 * with payoutAttempts >= 1 (the claim counts the attempt), so in practice they
 * read as unknown_result; `retryable` stays reachable only for attempts = 0.
 */
const NEVER_SENT_ERRORS: ReadonlySet<string> = new Set([
  PAYOUT_SEND_RIGHT_LOST,
  PAYOUT_SEND_WINDOW_MISSED,
]);

/**
 * The fund has no source evidence of its own. Retry needs a `sourceEvidenceId`
 * this screen cannot pick (contract gap), so the API would always answer 409:
 * show it as waiting for mapping, with no retry button.
 */
export function needsEvidenceMapping(v: RefundView): boolean {
  return (
    v.status === "approved" && v.lastPayoutError === EVIDENCE_MAPPING_REQUIRED
  );
}

/**
 * An earlier attempt may have reached the provider (API `maybeSentOf`).
 * Contract gap: the API also counts `payoutPendingPolls > 0`, but RefundView
 * does not carry it, so a pending-poll-only refund reads as never sent here.
 * The server still answers 409 REFUND_PAYOUT_MAYBE_SENT and the dialog then
 * hides release/reopen.
 */
function maybeSent(v: RefundView): boolean {
  return (
    (v.payoutAttempts ?? 0) > 0 ||
    v.providerRef !== null ||
    (v.lastPayoutError != null && MAYBE_SENT_FLAGS.has(v.lastPayoutError))
  );
}

/**
 * Order the refund belongs to, for "Ajukan refund baru" and "Lihat pesanan".
 * Contract gap: RefundView carries only paymentReference/paymentIntentId, no
 * POS order id, so this is null until the API adds one; the links stay hidden.
 */
export function refundOrderId(): string | null {
  return null;
}

export function refundUiState(v: RefundView): RefundUiState {
  if (v.status === "pending") return "pending_approval";
  if (v.status === "completed") return "completed";
  if (v.status === "failed")
    return v.failureReason === "rejected" ? "rejected" : "failed_final";
  // approved: the payout is still open. Only an error code can say it stalled;
  // an attempt or provider ref without one is a payout in flight (claimed or
  // answered `pending`), which the sweep and the provider webhook finish.
  const error = v.lastPayoutError ?? null;
  if (error === PAYOUT_QUARANTINED) return "quarantined";
  // Evidence mapping holds the payout before any send: nothing to retry here.
  if (error === null || error === EVIDENCE_MAPPING_REQUIRED)
    return "approved_processing";
  // Any other error (timeout, dropped connection, sticky flag, send-right
  // lost) comes with an attempt: the provider may have paid, so it is unknown
  // until looked up. Only a never-sent code with no attempt, no provider ref
  // may be retried; once an attempt exists the API only looks the payout up.
  if (
    NEVER_SENT_ERRORS.has(error) &&
    (v.payoutAttempts ?? 0) === 0 &&
    v.providerRef === null
  )
    return "retryable";
  return "unknown_result";
}

export function refundActions(v: RefundView): RefundActions {
  const state = refundUiState(v);
  const deciding = state === "pending_approval" && v.viewerCanApprove;
  const heldNeverSent = state === "quarantined" && !maybeSent(v);
  return {
    approve: deciding,
    reject: deciding,
    // Only an attempt that provably never left may be tried again.
    retry: state === "retryable",
    // A payout that may have been sent is only looked up (quarantined and
    // maybe-sent included: the API runs it lookup-only).
    checkStatus:
      state === "unknown_result" || (state === "quarantined" && maybeSent(v)),
    // Quarantine ops exist only for a refund that never reached the provider.
    release: heldNeverSent,
    reopen: heldNeverSent,
  };
}

/** True when any button applies, so a row can offer a single "Tinjau" entry. */
export function hasRefundAction(v: RefundView): boolean {
  const a = refundActions(v);
  return (
    a.approve || a.reject || a.retry || a.checkStatus || a.release || a.reopen
  );
}

export type RefundUiTone = "success" | "warning" | "danger" | "info";

const UI_TONES: Record<RefundUiState, RefundUiTone> = {
  pending_approval: "warning",
  approved_processing: "info",
  unknown_result: "warning",
  retryable: "warning",
  failed_final: "danger",
  rejected: "danger",
  quarantined: "warning",
  completed: "success",
};

export function refundUiTone(state: RefundUiState): RefundUiTone {
  return UI_TONES[state];
}

const UI_LABEL_KEYS: Record<RefundUiState, MessageKey> = {
  pending_approval: "paymentAdmin.refundFollowup.state.pending_approval",
  approved_processing: "paymentAdmin.refundFollowup.state.approved_processing",
  unknown_result: "paymentAdmin.refundFollowup.state.unknown_result",
  retryable: "paymentAdmin.refundFollowup.state.retryable",
  failed_final: "paymentAdmin.refundFollowup.state.failed_final",
  rejected: "paymentAdmin.refundFollowup.state.rejected",
  quarantined: "paymentAdmin.refundFollowup.state.quarantined",
  completed: "paymentAdmin.refundFollowup.state.completed",
};

export function refundUiLabelKey(state: RefundUiState): MessageKey {
  return UI_LABEL_KEYS[state];
}

const FAILURE_KEYS: Record<
  NonNullable<RefundView["failureReason"]>,
  MessageKey
> = {
  rejected: "paymentAdmin.refundFollowup.failure.rejected",
  approval_expired: "paymentAdmin.refundFollowup.failure.approval_expired",
  provider_declined: "paymentAdmin.refundFollowup.failure.provider_declined",
  cap_exceeded: "paymentAdmin.refundFollowup.failure.cap_exceeded",
  source_document: "paymentAdmin.refundFollowup.failure.source_document",
  approver_unauthorized:
    "paymentAdmin.refundFollowup.failure.approver_unauthorized",
};

/** Catalog key of the failure reason, or null when the server sent none. */
export function refundFailureKey(v: RefundView): MessageKey | null {
  return v.failureReason ? FAILURE_KEYS[v.failureReason] : null;
}

const PAYOUT_ERROR_KEYS: Record<string, MessageKey> = {
  [PAYOUT_QUARANTINED]: "paymentAdmin.refundFollowup.payoutError.quarantined",
  [PAYOUT_NOT_FOUND_MAYBE_SENT]:
    "paymentAdmin.refundFollowup.payoutError.not_found",
  [PAYOUT_IDENTITY_MISMATCH]:
    "paymentAdmin.refundFollowup.payoutError.identity_mismatch",
  [MANUAL_RECONCILIATION]:
    "paymentAdmin.refundFollowup.payoutError.manual_reconciliation",
  [EVIDENCE_MAPPING_REQUIRED]:
    "paymentAdmin.refundFollowup.payoutError.evidence_mapping",
  [PAYOUT_SEND_RIGHT_LOST]: "paymentAdmin.refundFollowup.payoutError.not_sent",
  [PAYOUT_SEND_WINDOW_MISSED]:
    "paymentAdmin.refundFollowup.payoutError.not_sent",
};

/** Catalog key for a known payout error code; unknown codes show as-is. */
export function payoutErrorKey(code: string): MessageKey | null {
  return PAYOUT_ERROR_KEYS[code] ?? null;
}

/**
 * Refusals the API gives when a finance refund is requested while the money is
 * still held by an order, a sale, or a deposit (payment-admin.service.ts
 * createRefund). The server text is English; the screen shows these instead.
 */
const REFUND_REFUSAL_KEYS: Record<string, MessageKey> = {
  REFUND_OVER_ORDER_ROOM: "paymentAdmin.refunds.refusal.overOrderRoom",
  REFUND_INTENT_IN_POS_SALE: "paymentAdmin.refunds.refusal.inPosSale",
  REFUND_INTENT_IN_QR_SALE: "paymentAdmin.refunds.refusal.inQrSale",
  REFUND_SOURCE_DOCUMENT: "paymentAdmin.refunds.refusal.sourceDocument",
  REFUND_DEPOSIT_FORFEITED: "paymentAdmin.refunds.refusal.depositForfeited",
  REFUND_DEPOSIT_IN_USE: "paymentAdmin.refunds.refusal.depositInUse",
};

/** Catalog key for a known create-refund refusal code; unknown codes: null. */
export function refundRefusalKey(code: string): MessageKey | null {
  return REFUND_REFUSAL_KEYS[code] ?? null;
}

/** Refund list filter: the usual statuses plus the quarantine queue. */
export type RefundListFilter = RefundView["status"] | "quarantined" | "all";

export function filterRefundList(
  rows: readonly RefundView[],
  filter: RefundListFilter,
): RefundView[] {
  if (filter === "all") return [...rows];
  if (filter === "quarantined")
    return rows.filter((row) => refundUiState(row) === "quarantined");
  return rows.filter((row) => row.status === filter);
}
