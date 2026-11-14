// Error envelope shared by every API response that is not 2xx:
//   { "error": { "code": "OUTLET_OUT_OF_SCOPE", "message": "...", "details"?: [...], "requestId"?: "..." } }
// Same shape as the starter's ApiErrorBody (packages/shared/src/types/api.ts),
// so existing handlers and apiFetch keep working. `code` is the stable,
// machine-readable key (UI maps it to catalog text); `message` is a safe
// human-readable fallback (Bahasa Indonesia) that never leaks internals.
// Domain contracts add their own UPPER_SNAKE codes (e.g. PERIOD_CLOSED) next
// to their schemas; core only lists codes every module can raise.

import { z } from "zod";

export const coreErrorHttpStatus = {
  // Starter codes (kept for compatibility with apps/api middleware).
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  LENGTH_REQUIRED: 411,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
  // Legend core codes.
  /** No tenant could be resolved from the domain or token (TEN-02). */
  TENANT_CONTEXT_REQUIRED: 400,
  /** The caller's role does not cover this outlet (TEN-03). */
  OUTLET_OUT_OF_SCOPE: 403,
  /** Module switched off by a feature flag (TEN-05). */
  FEATURE_DISABLED: 403,
  /** State conflict, e.g. duplicate unique value or invalid status transition. */
  CONFLICT: 409,
  /** A bill request must be acknowledged before it can be resolved. */
  CALL_NOT_ACKNOWLEDGED: 409,
  /** Same idempotency key reused with a different payload. */
  IDEMPOTENCY_KEY_REUSED: 409,
  /** Optimistic concurrency: the record changed since the client read it. */
  PRECONDITION_FAILED: 412,
  /** Edge sales held: critical catalog streams unsynced for over 24h and no owner override. */
  CATALOG_STALE_BLOCKED: 423,
  RATE_LIMITED: 429,
  /** A dependency (gateway, WhatsApp, edge link) is unavailable. */
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;

export type CoreErrorCode = keyof typeof coreErrorHttpStatus;
export const CORE_ERROR_CODES = Object.keys(
  coreErrorHttpStatus,
) as CoreErrorCode[];

/** Any error code: core or domain. UPPER_SNAKE_CASE, stable once shipped. */
export const errorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, "Error codes are UPPER_SNAKE_CASE");

export const apiErrorDetailSchema = z.object({
  /** Dotted path of the offending input field, e.g. "items.0.quantity". */
  field: z.string(),
  message: z.string(),
});

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.array(apiErrorDetailSchema).optional(),
    /** PAYSLIP_PIN_INVALID (403): attempts left before the PIN locks. */
    remainingAttempts: z.number().int().nonnegative().optional(),
    /** PAYSLIP_PIN_LOCKED (423): ISO datetime the lock ends. */
    lockedUntil: z.string().datetime().optional(),
    acknowledgedBy: z.object({ displayName: z.string() }).optional(),
    acknowledgedAt: z.string().datetime().optional(),
    requestId: z.string().optional(),
  }),
});

export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
export type ApiErrorEnvelope = z.infer<typeof apiErrorBodySchema>;

export function apiErrorBody(
  code: string,
  message: string,
  options: {
    details?: ApiErrorDetail[];
    remainingAttempts?: number;
    lockedUntil?: string;
    acknowledgedBy?: { displayName: string };
    acknowledgedAt?: string;
    requestId?: string;
  } = {},
): ApiErrorEnvelope {
  return { error: { code, message, ...options } };
}

export function isApiErrorBody(value: unknown): value is ApiErrorEnvelope {
  return apiErrorBodySchema.safeParse(value).success;
}

/**
 * Throwable carrying a core code and its HTTP status. The API error handler
 * turns it into apiErrorBody(code, message); shared helpers throw it for
 * expected denials such as OUTLET_OUT_OF_SCOPE.
 */
export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly status: number;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.status = coreErrorHttpStatus[code];
  }
}
