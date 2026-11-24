// legend-17az7: error monitoring is opt-in and scrubbed. The API (@sentry/node)
// and the web app (@sentry/react) share this event filter so neither one ever
// ships cookies, auth headers, request bodies, query strings, one-time link
// tokens, emails, phone numbers, or ID numbers to the monitoring service. Pure
// data in, pure data out: no SDK import.

const REDACTED = "[redacted]";
const TOKEN = "[token]";

// Allow list: any other request header (cookie, authorization, the SSR auth
// and PIN proof headers, referer, device tokens, ...) is dropped.
const SAFE_HEADERS = new Set([
  "user-agent",
  "accept",
  "content-type",
  "x-request-id",
]);

// A path segment that follows one of these holds a bearer-style token or code.
const TOKEN_PREFIXES = new Set([
  "t",
  "bayar",
  "r",
  "links",
  "entry",
  "receipts",
  "purchase-orders",
  "apology-vouchers",
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Indonesian mobile numbers (+62 / 62 / 0 prefix, 8xx), separators allowed.
const PHONE = /(?<![\w])(?:\+?62|0)[\s-]?8\d(?:[\s-]?\d){7,11}(?![\w])/g;
// NIK: 16 digits. NPWP: 15 digits or 99.999.999.9-999.999 with separators.
const NIK = /(?<!\d)\d{16}(?!\d)/g;
const NPWP = /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}|\d{15})(?!\d)/g;

/** Blank or missing DSN means monitoring stays off. */
export function sentryDsn(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Masks emails, phone numbers, NIK and NPWP inside free text. */
export function scrubSentryText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(NPWP, REDACTED)
    .replace(NIK, REDACTED)
    .replace(PHONE, REDACTED);
}

/**
 * Drops the query and fragment, and replaces the segment after a token route
 * prefix (and any segment of 16+ characters) with `[token]`. Works on full
 * URLs and bare paths.
 */
export function scrubSentryUrl(url: string): string {
  const bare = url.split(/[?#]/, 1)[0] ?? "";
  const head = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(bare)?.[0] ?? "";
  const segments = bare.slice(head.length).split("/");
  let previous = "";
  const next = segments.map((segment) => {
    const out =
      segment && (TOKEN_PREFIXES.has(previous) || segment.length >= 16)
        ? TOKEN
        : segment;
    previous = segment.toLowerCase();
    return out;
  });
  return head + next.join("/");
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

function scrubUrlField(target: Loose, key: string): void {
  if (typeof target[key] === "string")
    target[key] = scrubSentryUrl(target[key]);
}

function scrubBreadcrumbData(data: Loose): Loose {
  const next = { ...data };
  for (const key of ["url", "from", "to"]) scrubUrlField(next, key);
  for (const key of ["http.query", "http.fragment", "request_body", "body"])
    delete next[key];
  return next;
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction` body. Drops request cookies,
 * non-allow-listed headers, body and query string; tokenizes URLs and the
 * transaction name; removes user identity; masks emails, phone numbers, NIK
 * and NPWP in remaining text.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  const next = { ...(event as Loose) };

  const request = next.request as Loose | undefined;
  if (request) {
    const scrubbed: Loose = { ...request };
    delete scrubbed.cookies;
    delete scrubbed.data;
    delete scrubbed.query_string;
    scrubUrlField(scrubbed, "url");
    const headers = scrubbed.headers as Record<string, unknown> | undefined;
    if (headers)
      scrubbed.headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) =>
          SAFE_HEADERS.has(name.toLowerCase()),
        ),
      );
    next.request = scrubbed;
  }

  // Identity never leaves the process (the SDK's own ip/email/username fields).
  delete next.user;
  delete next.server_name;
  scrubUrlField(next, "transaction");

  if (typeof next.message === "string")
    next.message = scrubSentryText(next.message);
  for (const key of [
    "logentry",
    "exception",
    "extra",
    "contexts",
    "tags",
  ] as const) {
    if (next[key] !== undefined) next[key] = scrubValue(next[key], 8);
  }
  if (Array.isArray(next.breadcrumbs))
    next.breadcrumbs = next.breadcrumbs.map((crumb) =>
      scrubSentryBreadcrumb(crumb as { data?: Loose }),
    );
  return next as T;
}

/** Breadcrumb filter: tokenizes URLs, drops queries, fragments, and bodies. */
export function scrubSentryBreadcrumb<
  T extends { data?: Record<string, unknown> },
>(breadcrumb: T): T {
  const scrubbed = scrubValue(breadcrumb, 6) as T;
  if (scrubbed.data) scrubbed.data = scrubBreadcrumbData(scrubbed.data);
  return scrubbed;
}
