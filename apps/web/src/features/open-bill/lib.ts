// Pure helpers for the open-bill screens: error mapping and the limit rule.
import type { MessageKey } from "@starter/shared/i18n";
import {
  OPEN_BILL_APPROVER_DENIED,
  OPEN_BILL_CONVERT_LIMIT,
  OPEN_BILL_NOT_ELIGIBLE,
  type OpenBillPolicy,
} from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";

/**
 * Values the outlet starts with while no policy row exists (PRD v1.7 F43).
 * The API service owns the real defaults; the mock mirrors them and the
 * policy page uses them for "Kembalikan ke default".
 */
export const OPEN_BILL_DEFAULTS = {
  maxBillValueIdr: 3_000_000,
  inactivityMinutes: 45,
  billRequestSloSeconds: 180,
} as const;

/** Catalog text for a failed conversion. Unknown failures read as generic. */
export function openBillErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    switch (error.code) {
      case OPEN_BILL_CONVERT_LIMIT:
        return "openBillConvert.error.limit";
      // The staff PIN codes come from the identity contract (the same ones
      // the device PIN screen answers).
      case "PIN_INVALID":
        return "openBillConvert.error.pin";
      case "PIN_LOCKED":
        return "openBillConvert.error.locked";
      case OPEN_BILL_APPROVER_DENIED:
        return "openBillConvert.error.approverDenied";
      case OPEN_BILL_NOT_ELIGIBLE:
        return "openBillConvert.error.notEligible";
    }
  }
  return "openBillConvert.error.generic";
}

/** At or over the limit means refused: the server answers 409 for it. */
export function isOverOpenBillLimit(
  outstandingIdr: number,
  policy: Pick<OpenBillPolicy, "maxBillValueIdr">,
): boolean {
  return outstandingIdr >= policy.maxBillValueIdr;
}
