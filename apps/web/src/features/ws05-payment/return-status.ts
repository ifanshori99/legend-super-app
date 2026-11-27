// Pure rules of the single Duitku return page `/bayar/kembali` (C2b,
// legend-osqou.4; design/mockups/c2b-tamu-bayar).
//
// Duitku sends every guest back to the same URL (DUITKU_RETURN_URL carries no
// token, C2a) with `merchantOrderId` (our payment id), `resultCode` and
// `reference` appended. Before the guest leaves, the page that opened the
// payment stores a small record in this browser; the return page reads it to
// know which payment to ask the server about. `resultCode` is never read: the
// phase comes from the server's answer only (PAY-02), and without one the page
// stays "Memeriksa".
//
// No React and no `@/` aliases, so root tests load this file with Node's type
// stripping (docs/frontend.md "Tests").

import type { PaymentStatus } from "@starter/shared/payment";
import type { TenantThemeConfig } from "@starter/shared/theme";

/** After this long without a final answer the page says "masih diproses". */
export const LONG_WAIT_MS = 60_000;
/** A record older than this is ignored (a stale tab is not this payment). */
export const RETURN_RECORD_TTL_MS = 6 * 60 * 60_000;

const POLL_DELAYS_MS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 10_000];
const POLL_MAX_MS = 15_000;
/** Pace of the slow watch after a failed or expired answer. */
export const LATE_POLL_MS = 15_000;
/**
 * How long the page keeps watching after "failed" or "expired": the rules allow
 * failed -> paid and expired -> paid (a late payment from the gateway), and a
 * guest offered "Coba lagi" meanwhile could pay twice.
 */
export const LATE_WATCH_MS = 10 * 60_000;

/** Delay before poll number `attempt + 1`; grows, then holds at 15 s. */
export function nextPollDelayMs(
  attempt: number,
  status?: PaymentStatus,
): number {
  if (status === "failed" || status === "expired") return LATE_POLL_MS;
  return POLL_DELAYS_MS[attempt] ?? POLL_MAX_MS;
}

/** Statuses nothing can leave (a refund does not turn back into a payment). */
const TERMINAL: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
];
const LATE: readonly PaymentStatus[] = ["failed", "expired"];

/**
 * Keep asking until the server answers with a terminal status. After failed
 * or expired, keep a slow watch for LATE_WATCH_MS (`watchedMs` since the first
 * failed or expired answer, see `lateWatchedMs`).
 */
export function shouldPollReturn(
  status: PaymentStatus | undefined,
  watchedMs: number,
): boolean {
  if (status === undefined) return true;
  if (TERMINAL.includes(status)) return false;
  if (LATE.includes(status)) return watchedMs < LATE_WATCH_MS;
  return true;
}

/**
 * When the slow watch began: the moment of the first failed or expired answer
 * (not when the page opened). Keeps an earlier moment; null until then.
 */
export function lateWatchStart(
  first: number | null,
  status: PaymentStatus | undefined,
  now: number,
): number | null {
  if (first !== null) return first;
  return status !== undefined && LATE.includes(status) ? now : null;
}

/** Time spent in the slow watch so far; 0 before the first late answer. */
export function lateWatchedMs(first: number | null, now: number): number {
  return first === null ? 0 : Math.max(0, now - first);
}

/**
 * "Coba lagi" opens a new payment only when a fresh server answer says the
 * last one is failed or expired; anything else (paid, pending, no answer)
 * means the guest may already have paid.
 */
export function canStartNewPayment(status: PaymentStatus | undefined): boolean {
  return status === "failed" || status === "expired";
}

/**
 * Only Duitku's own pages are opened for a guest: `duitku.com` and its
 * subdomains (passport, sandbox, app-prod, app-sandbox), never a lookalike.
 */
export function isDuitkuPageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "duitku.com" || host.endsWith(".duitku.com");
}

/** The tenant theme of the table, kept so the return page looks the same. */
export type ReturnTheme = {
  tokens: TenantThemeConfig["colors"];
  fontFamily?: TenantThemeConfig["font"];
  corners?: TenantThemeConfig["corners"];
  logoUrl?: string | null;
};

type RecordBase = {
  v: 1;
  /** Payment intent id; Duitku echoes it back as `merchantOrderId`. */
  paymentId: string;
  method: "ewallet" | "card";
  channelCode: string | null;
  /** E-wallet name shown to the guest ("DANA"); null for a card. */
  channelName: string | null;
  amountIdr: number;
  /** Brand or outlet name for the top bar; null when unknown. */
  placeName: string | null;
  /** The outlet's IANA zone, for the time shown; null when unknown. */
  timeZone: string | null;
  /** The table's tenant theme (checked again where it is applied). */
  theme: ReturnTheme | null;
  savedAt: number;
};

/** A QR table order paid with an e-wallet or card. */
export type TableReturnRecord = RecordBase & {
  kind: "table";
  qrToken: string;
  sessionId: string;
  /** The order paid, so "Coba lagi" can open a new payment for it. */
  orderId: string | null;
  orderNumber: string | null;
  tableCode: string | null;
};

/** A payment link (`/bayar/$token`) paid with an e-wallet or card. */
export type LinkReturnRecord = RecordBase & {
  kind: "link";
  linkToken: string;
};

export type ReturnRecord = TableReturnRecord | LinkReturnRecord;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000;
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const THEME_MAX_CHARS = 6000;

/** A stored theme, or null when it is missing or does not look like one. */
function readTheme(value: unknown): ReturnTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const theme = value as Record<string, unknown>;
  if (typeof theme.tokens !== "object" || theme.tokens === null) return null;
  try {
    if (JSON.stringify(value).length > THEME_MAX_CHARS) return null;
  } catch {
    return null;
  }
  return {
    tokens: theme.tokens as ReturnTheme["tokens"],
    ...(typeof theme.fontFamily === "string"
      ? { fontFamily: theme.fontFamily as ReturnTheme["fontFamily"] }
      : {}),
    ...(typeof theme.corners === "string"
      ? { corners: theme.corners as ReturnTheme["corners"] }
      : {}),
    logoUrl: typeof theme.logoUrl === "string" ? theme.logoUrl : null,
  };
}

export function serializeReturnRecord(record: ReturnRecord): string {
  return JSON.stringify(record);
}

/** The stored record, or null when it is missing, broken or too old. */
export function parseReturnRecord(
  raw: string | null,
  nowMs: number,
): ReturnRecord | null {
  if (!raw) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.v !== 1) return null;
  if (!isString(value.paymentId) || !UUID.test(value.paymentId)) return null;
  if (value.method !== "ewallet" && value.method !== "card") return null;
  if (!isNullableString(value.channelCode)) return null;
  if (!isNullableString(value.channelName)) return null;
  if (!isNullableString(value.placeName)) return null;
  if (
    typeof value.amountIdr !== "number" ||
    !Number.isSafeInteger(value.amountIdr) ||
    value.amountIdr <= 0
  )
    return null;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt))
    return null;
  if (nowMs - value.savedAt > RETURN_RECORD_TTL_MS) return null;
  const base: RecordBase = {
    v: 1,
    paymentId: value.paymentId,
    method: value.method,
    channelCode: value.channelCode,
    channelName: value.channelName,
    amountIdr: value.amountIdr,
    placeName: value.placeName,
    // Records saved before these two fields existed read as "unknown".
    timeZone: isString(value.timeZone) ? value.timeZone : null,
    theme: readTheme(value.theme),
    savedAt: value.savedAt,
  };
  if (value.kind === "table") {
    if (!isString(value.qrToken) || !isString(value.sessionId)) return null;
    if (!isNullableString(value.orderId)) return null;
    if (!isNullableString(value.orderNumber)) return null;
    if (!isNullableString(value.tableCode)) return null;
    return {
      ...base,
      kind: "table",
      qrToken: value.qrToken,
      sessionId: value.sessionId,
      orderId: value.orderId,
      orderNumber: value.orderNumber,
      tableCode: value.tableCode,
    };
  }
  if (value.kind === "link") {
    if (!isString(value.linkToken)) return null;
    return { ...base, kind: "link", linkToken: value.linkToken };
  }
  return null;
}

/**
 * The record of the payment this return is about: the one Duitku names with
 * `merchantOrderId`, else (no id on the URL) the last one this browser sent
 * away. An id this browser never stored is not guessed. Only
 * `merchantOrderId` is read from the URL; `resultCode` never is.
 */
export function pickReturnRecord(
  search: URLSearchParams,
  readById: (paymentId: string) => string | null,
  lastPaymentId: string | null,
  nowMs: number,
): ReturnRecord | null {
  const named = search.get("merchantOrderId");
  const id = named ?? lastPaymentId;
  if (!id || !UUID.test(id)) return null;
  const record = parseReturnRecord(readById(id), nowMs);
  return record && record.paymentId === id ? record : null;
}

export type ReturnPhase =
  | "invalid"
  | "orders"
  | "checking"
  | "unreachable"
  | "waiting"
  | "slow"
  | "paid"
  | "refunded"
  | "failed"
  | "expired";

/** The server does not know this payment (the link, not this guest's login). */
const UNKNOWN_ANSWERS = [400, 404, 422];
/**
 * A table guest's session credential lives in the tab (sessionStorage). An
 * e-wallet app often reopens the browser in a new tab, so 401 or 403 there
 * does not mean "unknown": the order may be paid.
 */
const NO_LOGIN_ANSWERS = [401, 403];

/**
 * What the return page shows.
 * - `hasRecord`: undefined while this browser's record is still being read.
 * - `recordKind`: the stored record's kind (a table order or a payment link).
 * - `status`: the server's last answer; it wins over a later failed poll.
 * - `errorStatus`: HTTP status of the last failed poll, null for a network
 *   failure, undefined when the last poll did not fail.
 * - `waitedMs`: time since the page started checking.
 */
export function returnPhase(input: {
  hasRecord: boolean | undefined;
  recordKind?: ReturnRecord["kind"];
  status: PaymentStatus | undefined;
  errorStatus: number | null | undefined;
  waitedMs: number;
}): ReturnPhase {
  if (input.hasRecord === false) return "invalid";
  if (input.hasRecord === undefined) return "checking";
  const { status } = input;
  if (status !== undefined) {
    if (status === "paid") return "paid";
    if (status === "refunded" || status === "partially_refunded")
      return "refunded";
    if (status === "failed") return "failed";
    if (status === "expired") return "expired";
    return input.waitedMs >= LONG_WAIT_MS ? "slow" : "waiting";
  }
  const { errorStatus } = input;
  if (typeof errorStatus === "number") {
    if (UNKNOWN_ANSWERS.includes(errorStatus)) return "invalid";
    if (NO_LOGIN_ANSWERS.includes(errorStatus))
      return input.recordKind === "table" ? "orders" : "invalid";
    // 5xx and anything else: the answer is out of reach, not "checking".
    return "unreachable";
  }
  if (errorStatus === null) return "unreachable";
  return input.waitedMs >= LONG_WAIT_MS ? "unreachable" : "checking";
}
