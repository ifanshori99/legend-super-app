// Pure rules for the customer payment screen (bead legend-2w5, PAY-02).
//
// The screen's phase is derived from the payment link view and the polled
// intent only. A gateway redirect back with `?status=success` is deliberately
// not an input: only a paid intent the API reports can settle the screen.
//
// No React and no `@/` aliases, so root tests load this file with Node's type
// stripping (docs/frontend.md "Tests").

import type {
  CustomerPaymentIntent,
  CustomerPaymentMethodCode,
  PaymentLinkView,
  PaymentStatus,
} from "@starter/shared/payment";

/** How often the screen asks the API for the gateway's status (PAY-02). */
export const INTENT_POLL_MS = 5_000;
/**
 * A refresh per expiring code is enough; the cap only guards against a server
 * that keeps handing out an already-expired code.
 */
export const MAX_AUTO_REFRESHES = 3;

const SETTLED: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
];

export function isSettled(status: PaymentStatus): boolean {
  return SETTLED.includes(status);
}

export function shouldPoll(status: PaymentStatus | undefined): boolean {
  return status === "pending";
}

export function pollIntervalMs(
  status: PaymentStatus | undefined,
): number | false {
  return shouldPoll(status) ? INTENT_POLL_MS : false;
}

export type PaymentPhase =
  | "empty"
  | "unavailable"
  | "choose"
  | "pending"
  | "paid"
  | "expired"
  | "failed";

/**
 * What the page shows. `intent` is the polled intent when there is one; it
 * wins over the view's snapshot so a status change appears immediately.
 */
export function paymentPhase(
  view: PaymentLinkView,
  intent: CustomerPaymentIntent | null = view.activeIntent,
): PaymentPhase {
  if (intent) {
    if (isSettled(intent.status)) return "paid";
    if (intent.status === "expired") return "expired";
    if (intent.status === "failed") return "failed";
    return "pending";
  }
  if (view.bill.totals.outstandingIdr === 0) return "empty";
  if (view.gateway.status === "down") return "unavailable";
  if (!view.methods.some((method) => method.enabled)) return "unavailable";
  return "choose";
}

export function isRefunded(intent: CustomerPaymentIntent): boolean {
  return intent.status === "refunded" || intent.status === "partially_refunded";
}

/** Local clock minus server clock, so a device with the wrong time still counts down right. */
export function clockSkewMs(serverTime: string, receivedAtMs: number): number {
  const server = Date.parse(serverTime);
  return Number.isNaN(server) ? 0 : receivedAtMs - server;
}

/** Milliseconds left on a code, corrected by the server clock and clamped at 0. */
export function remainingMs(
  expiresAt: string | null,
  nowMs: number,
  skewMs = 0,
): number {
  if (!expiresAt) return 0;
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, expires - (nowMs - skewMs));
}

/** "09:58" for a countdown at 390px; minutes may pass 60 on a long-lived code. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * PRD §3.13 "QRIS Dinamis": the code is refreshed automatically when it
 * expires while the guest is looking at it. An already-expired link on first
 * render is not refreshed silently — the guest chooses "Buat kode baru".
 */
export function shouldAutoRefresh(
  status: PaymentStatus | undefined,
  remaining: number,
  refreshes: number,
): boolean {
  return (
    status === "pending" && remaining === 0 && refreshes < MAX_AUTO_REFRESHES
  );
}

/**
 * Consecutive auto-refreshes that returned no live code. A live code resets
 * the count; switching intent id does not, so MAX_AUTO_REFRESHES still caps a
 * server that keeps minting already-expired intents.
 */
export function nextRefreshCount(count: number, remaining: number): number {
  return remaining > 0 ? 0 : count;
}

/** The method can be sent: QRIS stands alone, VA and transfer need a bank. */
export function canSubmit(
  method: CustomerPaymentMethodCode | null,
  channelCode: string | null,
): boolean {
  if (!method) return false;
  // QRIS and card take no channel (C2b); VA, transfer and e-wallet need one.
  return method === "qris" || method === "card"
    ? channelCode === null
    : Boolean(channelCode);
}

/** Whether the bill already carries service charge or tax (owner decision 12: exclusive prices). */
export function billHasAddedCharges(totals: {
  serviceChargeIdr: number;
  taxIdr: number;
}): boolean {
  return totals.serviceChargeIdr > 0 || totals.taxIdr > 0;
}

/** Paid time in the outlet's business time zone; the contract carries the zone. */
export function formatTimeInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}
