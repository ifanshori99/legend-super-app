import type { ApiErrorBody } from "@starter/shared/types";

// A failed API call, carrying the API's error envelope. Kept free of framework
// imports and of TypeScript-only syntax (no parameter properties), so the mock
// runtime and the unit tests load it directly with native Node type stripping.
export class ApiError extends Error {
  status: number;
  code: string;
  details?: ApiErrorBody["error"]["details"];
  /** PAYSLIP_PIN_INVALID (403): attempts left before the lock. */
  remainingAttempts?: number;
  /** PAYSLIP_PIN_LOCKED (423): ISO datetime the lock ends. */
  lockedUntil?: string;
  /** PANIC_ALREADY_ACKNOWLEDGED (409): the colleague who answered first. */
  acknowledgedBy?: { displayName: string };
  /** PANIC_ALREADY_ACKNOWLEDGED (409): ISO datetime of that answer. */
  acknowledgedAt?: string;
  /** RATE_LIMITED (429): whole seconds until a new request may succeed. */
  retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: ApiErrorBody["error"]["details"],
    extra?: {
      remainingAttempts?: number;
      lockedUntil?: string;
      acknowledgedBy?: { displayName: string };
      acknowledgedAt?: string;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    if (extra?.remainingAttempts !== undefined)
      this.remainingAttempts = extra.remainingAttempts;
    if (extra?.lockedUntil !== undefined) this.lockedUntil = extra.lockedUntil;
    if (extra?.acknowledgedBy !== undefined)
      this.acknowledgedBy = extra.acknowledgedBy;
    if (extra?.acknowledgedAt !== undefined)
      this.acknowledgedAt = extra.acknowledgedAt;
    if (extra?.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";
