// Expected HTTP failures. The error handler turns these into the shared JSON
// envelope: { error: { code, message } }.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public context?: {
      acknowledgedBy: { displayName: string };
      acknowledgedAt: string;
    },
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A 422 for an uploaded file with unreadable lines: the handler adds them to
 * the envelope as `rowErrors` (line number and reason code, never the content).
 */
export class RowErrorsHttpError extends HttpError {
  constructor(
    code: string,
    message: string,
    public rowErrors: readonly { row: number; reason: string }[],
  ) {
    super(422, code, message);
    this.name = "RowErrorsHttpError";
  }
}
