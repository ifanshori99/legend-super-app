// legend-17az7: error monitoring is opt-in and scrubbed. The API (@sentry/node)
// and the web app (@sentry/react) share this event filter so neither one ever
// ships cookies, auth headers, request bodies, query strings, emails, or phone
// numbers to the monitoring service. Pure data in, pure data out: no SDK import.

const REDACTED = "[redacted]";

const SENSITIVE_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-csrf-token|x-device-token)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Indonesian numbers (+62 / 62 / 0 prefix) and generic 9+ digit runs with
// optional separators.
const PHONE = /(?<![\w])(?:\+?62|0)[\s-]?8\d(?:[\s-]?\d){7,11}(?![\w])/g;

/** Blank or missing DSN means monitoring stays off. */
export function sentryDsn(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Masks emails and phone numbers inside free text (messages, breadcrumbs). */
export function scrubSentryText(text: string): string {
  return text.replace(EMAIL, REDACTED).replace(PHONE, REDACTED);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubSentryText(value);
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => scrubValue(item, depth - 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      scrubValue(item, depth - 1),
    ]),
  );
}

type Loose = Record<string, unknown>;

/**
 * Sentry `beforeSend` / `beforeSendTransaction` body. Drops request cookies,
 * sensitive headers, body and query string; strips the query from the URL;
 * removes user identity; masks emails and phone numbers in remaining text.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  const next = { ...(event as Loose) };

  const request = next.request as Loose | undefined;
  if (request) {
    const scrubbed: Loose = { ...request };
    delete scrubbed.cookies;
    delete scrubbed.data;
    delete scrubbed.query_string;
    if (typeof scrubbed.url === "string")
      scrubbed.url = scrubbed.url.split(/[?#]/, 1)[0];
    const headers = scrubbed.headers as Record<string, unknown> | undefined;
    if (headers)
      scrubbed.headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) => !SENSITIVE_HEADER.test(name),
        ),
      );
    next.request = scrubbed;
  }

  // Identity never leaves the process (the SDK's own ip/email/username fields).
  delete next.user;
  if (next.server_name !== undefined) delete next.server_name;

  if (typeof next.message === "string")
    next.message = scrubSentryText(next.message);
  for (const key of [
    "exception",
    "breadcrumbs",
    "extra",
    "contexts",
    "tags",
  ] as const) {
    if (next[key] !== undefined) next[key] = scrubValue(next[key], 8);
  }
  return next as T;
}

/** Breadcrumb filter: drops fetch/xhr URLs' query strings and request data. */
export function scrubSentryBreadcrumb<
  T extends { data?: Record<string, unknown> },
>(breadcrumb: T): T {
  const scrubbed = scrubValue(breadcrumb, 6) as T;
  if (scrubbed.data) {
    const data = { ...scrubbed.data };
    if (typeof data.url === "string") data.url = data.url.split(/[?#]/, 1)[0];
    delete data.request_body;
    delete data.body;
    scrubbed.data = data;
  }
  return scrubbed;
}
