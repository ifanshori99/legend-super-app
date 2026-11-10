import { DatabaseError } from "pg";

// Database errors carry row values: drizzle's DrizzleQueryError puts the bound
// parameters in its message ("Failed query: ...\nparams: ..."), and the pg
// error's message, detail ("Failing row contains (...)", "Key (x)=(...)") and
// where can echo column values, card fields included (legend-8gsj). Before an
// error reaches a log it is rebuilt from fields that never hold row data: the
// SQLSTATE code, constraint, table, column, schema, data type and routine, plus
// drizzle's SQL text, which only has $n placeholders.

type DrizzleQueryErrorLike = Error & { query: string; params: unknown };

const SAFE_DATABASE_FIELDS = [
  "code",
  "severity",
  "constraint",
  "table",
  "column",
  "schema",
  "dataType",
  "routine",
] as const;

const SQLSTATE = /^[0-9A-Z]{5}$/;

function isDrizzleQueryError(error: Error): error is DrizzleQueryErrorLike {
  const candidate = error as Partial<DrizzleQueryErrorLike>;
  return (
    error.name === "DrizzleQueryError" ||
    (typeof candidate.query === "string" && "params" in error)
  );
}

function isDatabaseError(error: Error): error is DatabaseError {
  if (error instanceof DatabaseError) return true;
  const candidate = error as Partial<DatabaseError>;
  return (
    typeof candidate.code === "string" &&
    SQLSTATE.test(candidate.code) &&
    typeof candidate.severity === "string"
  );
}

// The first stack lines repeat the message (multi-line for drizzle): keep only
// the frames, under a header built from the safe message.
function safeStack(original: string | undefined, header: string): string {
  const frames = (original ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  return [header, ...frames].join("\n");
}

function scrubDatabaseError(error: DatabaseError): Error {
  const safe = new Error(
    `Database error ${error.code ?? "unknown"}` +
      (error.table ? ` on ${error.table}` : "") +
      (error.constraint ? ` (${error.constraint})` : ""),
  );
  safe.name = "DatabaseError";
  const target = safe as Error & Record<string, unknown>;
  for (const field of SAFE_DATABASE_FIELDS) {
    const value = (error as unknown as Record<string, unknown>)[field];
    if (typeof value === "string") target[field] = value;
  }
  safe.stack = safeStack(error.stack, `${safe.name}: ${safe.message}`);
  return safe;
}

function scrubQueryError(error: DrizzleQueryErrorLike, depth: number): Error {
  const safe = new Error("Failed query (parameters not logged)");
  safe.name = "DrizzleQueryError";
  (safe as Error & { query: string }).query = error.query;
  safe.stack = safeStack(error.stack, `${safe.name}: ${safe.message}`);
  if (error.cause !== undefined)
    safe.cause = toLoggableError(error.cause, depth + 1);
  return safe;
}

/** Copy of `error` that is safe to log: database errors anywhere in the cause
 * chain or among an AggregateError's `errors` (pino serializes both) are
 * rebuilt without row values; other errors keep their fields. */
export function toLoggableError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 8) return error;
  if (isDrizzleQueryError(error)) return scrubQueryError(error, depth);
  if (isDatabaseError(error)) return scrubDatabaseError(error);
  const cause =
    error.cause === undefined
      ? undefined
      : toLoggableError(error.cause, depth + 1);
  const members = (error as Error & { errors?: unknown }).errors;
  const errors = Array.isArray(members)
    ? members.map((member) => toLoggableError(member, depth + 1))
    : undefined;
  const causeChanged = cause !== error.cause;
  const errorsChanged =
    errors !== undefined &&
    errors.some((member, index) => member !== (members as unknown[])[index]);
  if (!causeChanged && !errorsChanged) return error;
  // Keep the original's type, message, stack and own fields; swap the
  // scrubbed parts.
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(error) as object) as Error,
    error,
  );
  // `message`, `stack`, `cause` and AggregateError's `errors` are own but not
  // enumerable, so Object.assign skips them: set each one explicitly.
  copy.message = error.message;
  copy.stack = error.stack;
  if (error.cause !== undefined) copy.cause = cause;
  if (errors !== undefined)
    (copy as Error & { errors: unknown[] }).errors = errors;
  return copy;
}
