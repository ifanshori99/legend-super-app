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

/** After this long without a final answer the page says "masih diproses". */
export const LONG_WAIT_MS = 60_000;
/** A record older than this is ignored (a stale tab is not this payment). */
export const RETURN_RECORD_TTL_MS = 6 * 60 * 60_000;

const POLL_DELAYS_MS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 10_000];
const POLL_MAX_MS = 15_000;

/** Delay before poll number `attempt + 1`; grows, then holds at 15 s. */
export function nextPollDelayMs(attempt: number): number {
  return POLL_DELAYS_MS[attempt] ?? POLL_MAX_MS;
}

const FINAL: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
  "expired",
];

/** Keep asking until the server answers with a final status. */
export function shouldPollReturn(status: PaymentStatus | undefined): boolean {
  return status === undefined || !FINAL.includes(status);
}

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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000;
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

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
  | "checking"
  | "waiting"
  | "slow"
  | "paid"
  | "failed"
  | "expired";

const SETTLED: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
];
/** The server does not know this payment for this guest (or this browser). */
const UNKNOWN_ANSWERS = [400, 401, 403, 404, 422];

/**
 * What the return page shows.
 * - `hasRecord`: undefined while this browser's record is still being read.
 * - `status`: the server's last answer; it wins over a later failed poll.
 * - `errorStatus`: HTTP status of the last failed poll, null for a network
 *   failure, undefined when the last poll did not fail.
 * - `waitedMs`: time since the page started checking.
 */
export function returnPhase(input: {
  hasRecord: boolean | undefined;
  status: PaymentStatus | undefined;
  errorStatus: number | null | undefined;
  waitedMs: number;
}): ReturnPhase {
  if (input.hasRecord === false) return "invalid";
  if (input.hasRecord === undefined) return "checking";
  const { status } = input;
  if (status !== undefined) {
    if (SETTLED.includes(status)) return "paid";
    if (status === "failed") return "failed";
    if (status === "expired") return "expired";
    return input.waitedMs >= LONG_WAIT_MS ? "slow" : "waiting";
  }
  if (
    typeof input.errorStatus === "number" &&
    UNKNOWN_ANSWERS.includes(input.errorStatus)
  )
    return "invalid";
  return "checking";
}
