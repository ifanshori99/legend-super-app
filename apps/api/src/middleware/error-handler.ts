import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { CoreError } from "@starter/shared/core";
import { PlatformError } from "@starter/shared/platform";
import { AccessError } from "@starter/shared/access";
import { HttpError } from "../lib/http-error";
import { AuditUnavailableError } from "../services/audit-writer";

function send(
  res: Parameters<RequestHandler>[1],
  status: number,
  error: Record<string, unknown>,
) {
  res.status(status).json({ error });
}

export const notFound: RequestHandler = () => {
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
};

// Body-parser errors carry `type` and `status`.
type ParserError = Error & { type?: string; status?: number };

// The single place errors become HTTP responses. Expected failures map to the
// shared envelope and are logged by the access log at warn. Anything else is
// attached to the response as `res.err`, so pino-http logs it once — with the
// stack, reqId, and request line — and the client gets a generic 500 that never
// includes database errors, connection strings, or private values.
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError)
    return send(res, error.status, {
      code: error.code,
      message: error.message,
    });

  // Domain contracts throw these with their own HTTP status (TEN-03
  // OUTLET_OUT_OF_SCOPE, TEN-05 FEATURE_DISABLED, TEN-04 SUPPORT_ACCESS_*).
  if (
    error instanceof CoreError ||
    error instanceof PlatformError ||
    error instanceof AccessError
  )
    return send(res, error.status, {
      code: error.code,
      message: error.message,
    });

  // The audit writer is a fail-closed port until bead legend-4sc lands: a
  // sensitive change without an audit trail is refused, not silently applied.
  if (error instanceof AuditUnavailableError)
    return send(res, 503, {
      code: "SERVICE_UNAVAILABLE",
      message:
        "The audit log is not configured, so this change was refused. Try again after the audit service is available.",
    });

  if (error instanceof ZodError)
    return send(res, 422, {
      code: "VALIDATION_ERROR",
      message: "Check the supplied fields.",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });

  const parserError = error as ParserError;
  if (parserError.type === "entity.parse.failed")
    return send(res, 400, {
      code: "INVALID_JSON",
      message: "Send valid JSON.",
    });
  if (parserError.type === "entity.too.large")
    return send(res, 413, {
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    });

  res.err = error instanceof Error ? error : new Error(String(error));
  send(res, 500, {
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Try again.",
  });
};
