// Pure helpers of the customer display (PRD §3 F11 "Customer Display" and
// §3 F13 "QRIS Dinamis": the code is refreshed when it expires). No runtime
// imports, so tests load this file with Node type stripping.
import type {
  CustomerDisplayQris,
  CustomerDisplayState,
  PosTenderMethod,
} from "@starter/shared/pos";
import type { MessageKey } from "@starter/shared/i18n";

/** A paired second screen polls the terminal state this often. */
export const DISPLAY_POLL_MS = 5_000;
/** Never schedule a refetch faster than this (a QR about to expire). */
export const DISPLAY_MIN_REFETCH_MS = 1_000;

type DisplaySnapshot = {
  state: "idle" | "ordering" | "awaiting_payment" | "paid";
  qris: CustomerDisplayQris | null;
};

/**
 * When the display should read the terminal again: the normal poll interval,
 * or sooner when the dynamic QRIS is about to expire so the screen never shows
 * a dead code (PRD §3 F13). An expired code retries within a second.
 */
export function displayRefetchMs(
  snapshot: DisplaySnapshot | null,
  nowMs: number,
): number {
  if (
    snapshot === null ||
    snapshot.state !== "awaiting_payment" ||
    snapshot.qris === null
  )
    return DISPLAY_POLL_MS;
  const remaining = Date.parse(snapshot.qris.expiresAt) - nowMs;
  return Math.min(DISPLAY_POLL_MS, Math.max(DISPLAY_MIN_REFETCH_MS, remaining));
}

/** Whole seconds until the QR expires; negative once it has (floor). */
export function secondsUntilExpiry(expiresAt: string, nowMs: number): number {
  return Math.floor((Date.parse(expiresAt) - nowMs) / 1_000);
}

/** True while the screen must not present the code as payable. */
export function isQrisExpired(
  qris: CustomerDisplayQris,
  nowMs: number,
): boolean {
  return secondsUntilExpiry(qris.expiresAt, nowMs) <= 0;
}

/** 598 → "9:58": the countdown under the QR (minutes:seconds). */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Catalog label per POS tender method (PRD §3 F11 "Pembayaran"). */
export const TENDER_LABEL: Record<PosTenderMethod, MessageKey> = {
  cash: "posDisplay.tender.cash",
  qris: "posDisplay.tender.qris",
  va: "posDisplay.tender.va",
  ewallet: "posDisplay.tender.ewallet",
  card: "posDisplay.tender.card",
  edc_card: "posDisplay.tender.edcCard",
  edc_qris: "posDisplay.tender.edcQris",
  points: "posDisplay.tender.points",
};

/** Total quantity of the bill, e.g. 4 for 2× coffee + 1× rice + 1× pastry. */
export function totalQuantity(lines: readonly { quantity: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export type DisplayBalance = {
  /**
   * Reservation deposit (DP) applied to the bill. Always 0 here: the display
   * contract has no deposit field, so this helper never infers one. A DP order
   * is detected from the order itself and never shows a QRIS: see
   * `displayPayMode` (sub-539-u2).
   */
  depositIdr: number;
  /** Money already taken by tenders (amounts are already net of change). */
  capturedIdr: number;
  /**
   * What the customer still has to pay. `null` while it is not known (no code
   * yet, or the cashier is still adding items): the screen then shows only the
   * bill total and never guesses a smaller amount (money rule: no one pays
   * more or less than the terminal says).
   */
  remainingIdr: number | null;
};

/** Splits the bill into captured tenders and the amount left. */
export function displayBalance(
  state: Pick<CustomerDisplayState, "state" | "totalIdr" | "qris" | "tenders">,
): DisplayBalance {
  const capturedIdr = state.tenders.reduce(
    (sum, tender) => sum + Number(tender.amountIdr),
    0,
  );
  if (state.state === "paid")
    return { depositIdr: 0, capturedIdr, remainingIdr: 0 };
  if (state.state === "awaiting_payment" && state.qris !== null)
    return {
      depositIdr: 0,
      capturedIdr,
      // Clamped to 0..total: a bad QRIS amount never shows more than the bill
      // or a negative balance.
      remainingIdr: Math.max(
        0,
        Math.min(Number(state.totalIdr), Number(state.qris.amountIdr)),
      ),
    };
  return { depositIdr: 0, capturedIdr, remainingIdr: null };
}

/** Method shared by every tender, or null when mixed or none. */
export function singleTenderMethod(
  tenders: readonly { method: PosTenderMethod }[],
): PosTenderMethod | null {
  const first = tenders[0]?.method;
  return first !== undefined && tenders.every((t) => t.method === first)
    ? first
    : null;
}

/** The deposit of the order on screen, read from the order itself. */
export type DisplayDeposit =
  | { kind: "known"; depositAppliedIdr: number }
  | { kind: "loading" }
  | { kind: "unknown" };

export type DisplayPayMode =
  "not_paying" | "loading" | "qris" | "online_code" | "pay_at_cashier";

/**
 * What the payment pane shows. The display QRIS is always the full bill total
 * (the contract forces `qris.amountIdr === totalIdr`), so an order with a DP
 * never shows a code: the customer pays at the cashier, who knows the rest.
 * Money rule: when the deposit is unknown the screen asks for the cashier, it
 * never holds a code that could charge more than is due.
 */
export function displayPayMode(
  state: Pick<CustomerDisplayState, "state" | "qris" | "onlineCode">,
  deposit: DisplayDeposit,
): DisplayPayMode {
  if (state.state !== "awaiting_payment") return "not_paying";
  if (deposit.kind === "unknown") return "pay_at_cashier";
  if (deposit.kind === "loading") return "loading";
  if (
    !Number.isFinite(deposit.depositAppliedIdr) ||
    deposit.depositAppliedIdr > 0
  )
    return "pay_at_cashier";
  if (state.qris !== null) return "qris";
  // 1269 C3a / 1272 K4: a cashier VA / e-wallet code (bill + guest fee).
  return state.onlineCode ? "online_code" : "loading";
}
