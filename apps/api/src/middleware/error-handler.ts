import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import {
  apiErrorBody,
  CoreError,
  type ApiErrorDetail,
  type ApiErrorRow,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import { AccountingError } from "@starter/shared/accounting";
import { AiError } from "@starter/shared/ai";
import {
  DeliveryError,
  deliveryErrorHttpStatus,
} from "@starter/shared/delivery";
import { FacilityError } from "@starter/shared/facility";
import { PayrollError } from "@starter/shared/hris/payroll";
import { IdentityError } from "@starter/shared/identity";
import { NotificationError } from "@starter/shared/notification";
import { OperationsError } from "@starter/shared/operations";
import { PlatformError } from "@starter/shared/platform";
import { PosError } from "@starter/shared/pos";
import {
  ReservationError,
  reservationErrorHttpStatus,
} from "@starter/shared/reservation";
import { TaxError } from "@starter/shared/tax";
import { HttpError, RowErrorsHttpError } from "../lib/http-error";
import { AuditUnavailableError } from "../services/audit-writer";
import { toLoggableError } from "../lib/safe-error";
import { captureServerError } from "../lib/sentry";
import { FailoverOpenWorkError } from "../services/edge-failover-errors";

export const notFound: RequestHandler = () => {
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
};

type ParserError = Error & { type?: string; status?: number };

/**
 * legend-yhia9: the 0369 triggers refuse a change of a bill with a collectible
 * QRIS (SQLSTATE 23514, message "QRIS_HOLD_ACTIVE: ..."). The service guards
 * answer first; a path that reached the trigger is a 409, not a 500. The
 * message is matched only for that fixed prefix and never sent to the client.
 */
function isQrisHoldTriggerError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const { code } = current as { code?: unknown };
    if (code === "23514" && current.message.startsWith("QRIS_HOLD_ACTIVE:"))
      return true;
    current = current.cause;
  }
  return false;
}

// Only explicitly recognized error classes are client-visible. In particular,
// never trust an arbitrary exception's `status`, `code`, or message.
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const send = (
    status: number,
    code: string,
    message: string,
    details?: ApiErrorDetail[],
    extra: {
      rowErrors?: ApiErrorRow[];
      remainingAttempts?: number;
      lockedUntil?: string;
      acknowledgedBy?: { displayName: string };
      acknowledgedAt?: string;
      retryAfterSeconds?: number;
    } = {},
  ) =>
    res.status(status).json(
      apiErrorBody(code, message, {
        ...(details ? { details } : {}),
        ...extra,
        ...(typeof req.id === "string" ? { requestId: req.id } : {}),
      }),
    );

  // Machine-readable context of an accounting error (e.g. `supersededById` on
  // TAX_REPORT_SUPERSEDED) travels as `{ field, message }` details.
  if (error instanceof AccountingError && error.details) {
    const details: ApiErrorDetail[] = Object.entries(error.details)
      .filter(([, value]) => typeof value === "string")
      .map(([field, value]) => ({ field, message: value as string }));
    if (details.length > 0)
      return send(error.status, error.code, error.message, details);
  }

  // RATE_LIMITED with a known wait: body `retryAfterSeconds` plus the standard
  // `Retry-After` header.
  if (error instanceof CoreError && error.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    return send(error.status, error.code, error.message, undefined, {
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }

  if (error instanceof PayrollError)
    return send(
      error.status,
      error.code,
      error.message,
      error.details && error.details.length > 0
        ? [...error.details]
        : undefined,
      {
        ...(error.remainingAttempts !== undefined
          ? { remainingAttempts: error.remainingAttempts }
          : {}),
        ...(error.lockedUntil !== undefined
          ? { lockedUntil: error.lockedUntil }
          : {}),
      },
    );

  if (error instanceof RowErrorsHttpError)
    return send(error.status, error.code, error.message, undefined, {
      rowErrors: [...error.rowErrors],
    });

  if (error instanceof HttpError && error.context)
    return send(
      error.status,
      error.code,
      error.message,
      undefined,
      error.context,
    );

  // 1271 F3: what still blocks a failover return or cancel, one detail per
  // id (`orderIds`, `unpaidOrderIds`, `openShiftIds`, `qrisHoldOrderIds`,
  // `parkedOrderIds`).
  if (error instanceof FailoverOpenWorkError)
    return send(
      error.status,
      error.code,
      error.message,
      Object.entries(error.openWork).flatMap(([field, ids]) =>
        (ids as string[]).map((id) => ({ field, message: id })),
      ),
    );

  if (isQrisHoldTriggerError(error)) {
    const refused = new PosError("QRIS_HOLD_ACTIVE");
    return send(refused.status, refused.code, refused.message);
  }

  if (
    error instanceof HttpError ||
    error instanceof CoreError ||
    error instanceof AccessError ||
    error instanceof AccountingError ||
    error instanceof AiError ||
    error instanceof FacilityError ||
    error instanceof IdentityError ||
    error instanceof NotificationError ||
    error instanceof OperationsError ||
    error instanceof PlatformError ||
    error instanceof PosError ||
    error instanceof TaxError
  )
    return send(error.status, error.code, error.message);

  if (error instanceof DeliveryError)
    return send(deliveryErrorHttpStatus[error.code], error.code, error.message);
  if (error instanceof ReservationError)
    return send(
      reservationErrorHttpStatus[error.code],
      error.code,
      error.message,
    );

  // The audit writer is a fail-closed port until bead legend-4sc lands: a
  // sensitive change without an audit trail is refused, not silently applied.
  if (error instanceof AuditUnavailableError)
    return send(
      503,
      "SERVICE_UNAVAILABLE",
      "The audit log is not configured, so this change was refused. Try again after the audit service is available.",
    );

  if (error instanceof ZodError)
    return send(
      422,
      "VALIDATION_ERROR",
      "Check the supplied fields.",
      error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );

  // The router rejects a malformed percent-encoding in a route param with a
  // URIError whose message echoes the raw param (it can be a bearer token).
  // Answer a fixed message and keep the error out of the log. Only the
  // router's decode error matches: a URIError thrown by application code is a
  // server bug and still takes the logged 500 path below.
  if (
    error instanceof URIError &&
    (error as URIError & { status?: unknown }).status === 400 &&
    error.message.startsWith("Failed to decode param")
  )
    return send(400, "VALIDATION_ERROR", "The request URL is malformed.");

  const parserError = error as ParserError | null;
  if (parserError?.type === "entity.parse.failed")
    return send(400, "INVALID_JSON", "Send valid JSON.");
  if (parserError?.type === "entity.too.large")
    return send(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");

  // pino-http logs res.err with its own serializer: hand it a copy without
  // database row values (bound parameters, "Failing row contains ...").
  const safe = toLoggableError(
    error instanceof Error ? error : new Error(String(error)),
  ) as Error;
  res.err = safe;
  // Sentry gets the same row-free copy, never the raw driver error.
  captureServerError(safe);
  return send(500, "INTERNAL_ERROR", "Something went wrong. Try again.");
};
