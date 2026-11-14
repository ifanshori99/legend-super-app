// Refusal text for the review tabs. Adds the proof-key refusal that the
// shared payout error map does not know yet; everything else defers to it.
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { payoutErrorMessage } from "../errors";

export function reviewErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError && error.code === "PAYOUT_EVIDENCE_INVALID")
    return t("payrollPayoutReview.error.evidenceInvalid");
  return payoutErrorMessage(error, t);
}
