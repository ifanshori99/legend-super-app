import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import {
  apiErrorBody,
  CoreError,
  type ApiErrorDetail,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import { AccountingError } from "@starter/shared/accounting";
import {
  DeliveryError,
  deliveryErrorHttpStatus,
} from "@starter/shared/delivery";
import { FacilityError } from "@starter/shared/facility";
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
  ) =>
    res.status(status).json(
      apiErrorBody(code, message, {
        ...(details ? { details } : {}),
        ...(typeof req.id === "string" ? { requestId: req.id } : {}),
      }),
    );

  if (
    error instanceof HttpError ||
    error instanceof CoreError ||
    error instanceof AccessError ||
    error instanceof AccountingError ||
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

  const parserError = error as ParserError | null;
  if (parserError?.type === "entity.parse.failed")
    return send(400, "INVALID_JSON", "Send valid JSON.");
  if (parserError?.type === "entity.too.large")
    return send(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");

  res.err = error instanceof Error ? error : new Error(String(error));
  return send(500, "INTERNAL_ERROR", "Something went wrong. Try again.");
};
