// Maps payout error codes to catalog text. The server stays the checker: the UI
// shows the refusal, never hides it. An unknown code falls back to the generic
// message (or the API's own message through `payoutErrorMessage`).
import type { MessageKey, Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

const CODE_KEYS: Record<string, MessageKey> = {
  PAYOUT_SELF_APPROVAL: "payrollPayout.error.selfApproval",
  PAYOUT_CONFIRM_SELF: "payrollPayout.error.confirmSelf",
  PAYOUT_SOURCE_ACCOUNT_INVALID: "payrollPayout.error.sourceAccountInvalid",
  PAYOUT_SOURCE_ACCOUNT_MISSING: "payrollPayout.error.sourceAccountMissing",
  PAYOUT_CHANNEL_NOT_AVAILABLE: "payrollPayout.error.channelNotAvailable",
  PAYOUT_CONFIG_DISABLED: "payrollPayout.error.configDisabled",
  MFA_REQUIRED: "payrollPayout.error.mfaRequired",
  REAUTH_REQUIRED: "payrollPayout.error.reauthRequired",
  REAUTH_PASSWORD_INVALID: "payrollPayout.error.reauthPasswordInvalid",
  REAUTH_PASSWORD_LOCKED: "payrollPayout.error.reauthPasswordLocked",
  PAYOUT_APPROVAL_EXPIRED: "payrollPayout.error.approvalExpired",
  PAYOUT_HASH_MISMATCH: "payrollPayout.error.hashMismatch",
  PAYOUT_BATCH_STATE: "payrollPayout.error.batchState",
  PAYOUT_BATCH_STATE_CHANGED: "payrollPayout.error.batchState",
  PAYOUT_EXPORT_ALREADY_DOWNLOADED:
    "payrollPayout.error.exportAlreadyDownloaded",
  PAYOUT_BATCH_EMPTY: "payrollPayout.error.batchEmpty",
  PAYOUT_NOTHING_TO_PAY: "payrollPayout.error.nothingToPay",
  PAYOUT_RUN_NOT_PAYABLE: "payrollPayout.error.runNotPayable",
  PAYOUT_RUN_ALREADY_PAID: "payrollPayout.error.runAlreadyPaid",
  PAYOUT_EXPORT_FILE_LOST: "payrollPayout.error.exportFileLost",
  PAYOUT_BATCH_ALREADY_OPEN: "payrollPayout.error.batchAlreadyOpen",
  PAYOUT_BATCH_FROZEN: "payrollPayout.error.batchFrozen",
  PAYOUT_UNFREEZE_REFUSED: "payrollPayout.error.unfreezeRefused",
  PAYOUT_SOURCE_MISMATCH: "payrollPayoutReview.error.sourceMismatch",
  PAYOUT_EVIDENCE_REJECTED: "payrollPayoutReview.error.evidenceRejected",
  PAYOUT_RESOLVE_SAME_PERSON: "payrollPayoutReview.error.resolveSamePerson",
  PAYOUT_RESOLVE_OUTCOME_MISMATCH:
    "payrollPayoutReview.error.resolveOutcomeMismatch",
  PAYOUT_RESOLVE_EVIDENCE_MISMATCH:
    "payrollPayoutReview.error.resolveEvidenceMismatch",
  PAYOUT_RETURN_EVIDENCE_MISMATCH:
    "payrollPayoutReview.error.returnEvidenceMismatch",
  PAYOUT_RETURN_SAME_PERSON: "payrollPayoutReview.error.returnSamePerson",
  PAYOUT_RETURN_BANK_REF_REQUIRED:
    "payrollPayoutReview.error.returnBankRefRequired",
  PAYOUT_RETURN_BANK_REF_MISMATCH:
    "payrollPayoutReview.error.returnBankRefMismatch",
  PAYOUT_RETURN_BANK_REF_REUSED:
    "payrollPayoutReview.error.returnBankRefReused",
  PAYOUT_RECON_CLEAR_REASON_INVALID:
    "payrollPayoutReview.error.reconClearReasonInvalid",
  PAYOUT_RECON_CLEAR_SELF_APPROVAL:
    "payrollPayoutReview.error.reconClearSelfApproval",
  PAYOUT_RECON_CLEAR_STATE: "payrollPayoutReview.error.reconClearState",
  PAYOUT_RECON_FLAG_CHANGED: "payrollPayoutReview.error.reconFlagChanged",
  PAYOUT_RECON_PROOF_UNREADABLE:
    "payrollPayoutReview.error.reconProofUnreadable",

  PAYOUT_RECON_FLAG_NOT_FOUND: "payrollPayoutReview.error.reconNotFound",
  PAYOUT_RECON_CLEARANCE_NOT_FOUND: "payrollPayoutReview.error.reconNotFound",
  PAYOUT_RETURN_WITHDRAW_REASON_INVALID:
    "payrollPayoutReview.error.returnWithdrawReasonInvalid",
  PAYOUT_RETURN_WITHDRAW_SELF_APPROVAL:
    "payrollPayoutReview.error.returnWithdrawSelfApproval",
  PAYOUT_RETURN_WITHDRAW_STATE: "payrollPayoutReview.error.returnWithdrawState",
  PAYOUT_RETURN_WITHDRAW_REFUSED:
    "payrollPayoutReview.error.returnWithdrawRefused",
  PAYOUT_RETURN_CLAIM_NOT_FOUND:
    "payrollPayoutReview.error.returnWithdrawNotFound",
  PAYOUT_RETURN_WITHDRAWAL_NOT_FOUND:
    "payrollPayoutReview.error.returnWithdrawNotFound",
  PAYOUT_PROPOSAL_NOT_WITHDRAWABLE:
    "payrollPayoutReview.error.proposalNotWithdrawable",
  PAYOUT_PROOF_SPENT_BY_WITHDRAWN:
    "payrollPayoutReview.error.proofSpentByWithdrawn",
  PAYOUT_REQUESTER_CANNOT_WITHDRAW:
    "payrollPayoutReview.error.requesterCannotWithdraw",
  NETWORK_ERROR: "payrollPayout.error.offline",
  FORBIDDEN: "payrollPayout.error.forbidden",
};

/** Catalog key for a refusal; unknown or non-API errors read as the generic one. */
export function payoutErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    const key = CODE_KEYS[error.code];
    if (key) return key;
  }
  return "payrollPayout.error.generic";
}

/** The refusal in words; an unknown code keeps the API's own message. */
export function payoutErrorMessage(error: unknown, t: Translate): string {
  if (
    error instanceof ApiError &&
    CODE_KEYS[error.code] === undefined &&
    error.message
  )
    return error.message;
  return t(payoutErrorKey(error));
}

/** True when the failure is the network, not the request. */
export function isPayoutOffline(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NETWORK_ERROR";
}

/** A proof file the browser sees as a PDF (by type or by name). */
export function isPdfFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Refusal of a proof-file upload in words. A PDF that the server cannot scan
 * yet (503) asks for a photo instead; other 503s say the upload is not there.
 */
export function evidenceUploadMessage(
  error: unknown,
  file: Pick<File, "name" | "type"> | null,
  t: Translate,
): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 503 || error.code === "SERVICE_UNAVAILABLE")
    return t(
      file && isPdfFile(file)
        ? "payrollPayoutReview.error.evidencePhotoOnly"
        : "payrollPayoutReview.error.evidenceUnavailable",
    );
  if (error.status === 413)
    return t("payrollPayoutReview.error.evidenceTooLarge");
  if (error.status === 415 || error.code === "PAYOUT_EVIDENCE_REJECTED")
    return t("payrollPayoutReview.error.evidenceRejected");
  return null;
}

const RECON_CONFLICT_CODES = new Set([
  "PAYOUT_RECON_FLAG_CHANGED",
  "PAYOUT_RECON_CLEAR_STATE",
]);

const WITHDRAW_CONFLICT_CODES = new Set([
  "PAYOUT_RETURN_WITHDRAW_REFUSED",
  "PAYOUT_RETURN_WITHDRAW_STATE",
]);

/**
 * The flag or its clearance changed under the person (409 FLAG_CHANGED, or the
 * clearance was already approved). Reload the list and offer a new proposal.
 */
export function isReconConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    RECON_CONFLICT_CODES.has(error.code)
  );
}

/**
 * The return claim or its withdrawal changed (409: not withdrawable any more,
 * or the withdrawal was already approved). Reload the claims and look again.
 */
export function isWithdrawConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    WITHDRAW_CONFLICT_CODES.has(error.code)
  );
}
