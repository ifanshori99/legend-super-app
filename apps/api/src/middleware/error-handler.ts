import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import {
  apiErrorBody,
  CoreError,
  type ApiErrorDetail,
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
import { HttpError } from "../lib/http-error";
import { AuditUnavailableError } from "../services/audit-writer";
import { toLoggableError } from "../lib/safe-error";

export const notFound: RequestHandler = () => {
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
};

type ParserError = Error & { type?: string; status?: number };

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
      remainingAttempts?: number;
      lockedUntil?: string;
      acknowledgedBy?: { displayName: string };
      acknowledgedAt?: string;
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

  if (error instanceof PayrollError)
    return send(error.status, error.code, error.message, undefined, {
      ...(error.remainingAttempts !== undefined
        ? { remainingAttempts: error.remainingAttempts }
        : {}),
      ...(error.lockedUntil !== undefined
        ? { lockedUntil: error.lockedUntil }
        : {}),
    });

  if (error instanceof HttpError && error.context)
    return send(
      error.status,
      error.code,
      error.message,
      undefined,
      error.context,
    );

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
  res.err = toLoggableError(
    error instanceof Error ? error : new Error(String(error)),
  ) as Error;
  return send(500, "INTERNAL_ERROR", "Something went wrong. Try again.");
};
