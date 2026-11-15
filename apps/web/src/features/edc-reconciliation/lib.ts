// Pure rules for the EDC reconciliation screen. No React and no `@/` alias, so
// tests can import this file with plain Node ESM. It mirrors
// apps/api/src/services/edc-reconciliation.service.ts (the API stays the
// authority); the screen only uses it to disable what the API would refuse.
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";

/** The ID shown for a sale: the EDC invoice number, else the bill reference. */
export function displayId(tx: {
  invoiceNo?: string | null;
  reference: string;
}): string {
  return tx.invoiceNo ?? tx.reference;
}

/** Same window as the API's EDC_LATE_RESPONSE_WINDOW_MS (late-response.ts). */
export const EDC_RECON_WAIT_MS = 10 * 60 * 1000;

export type ReconciliationOutcome = "approved" | "declined";

export type ReconciliationGate =
  /** The terminal is still processing this sale: nothing can be resolved. */
  | { kind: "wire-open" }
  /** An `unknown` sale may still get a late answer; try again at this time. */
  | { kind: "too-early"; eligibleAtMs: number }
  | { kind: "not-eligible" }
  | { kind: "open"; outcomes: ReconciliationOutcome[] };

/**
 * Checks in the service's order: eligibility, open terminal call, then the
 * late-response window. Outcomes follow the row status: an `unknown` sale can
 * go either way, an `approved` one is only cleared, and a final
 * declined/cancelled/failed one can only be declared declined (never flipped
 * to approved).
 */
export function reconciliationGate(
  item: EdcReconciliationQueueItem,
  nowMs: number,
): ReconciliationGate {
  const { transaction } = item;
  if (!(transaction.needsReconciliation || transaction.status === "unknown"))
    return { kind: "not-eligible" };
  if (item.saleWireOpenAt !== null) return { kind: "wire-open" };
  if (transaction.status === "unknown" && transaction.dispatchedAt !== null) {
    const eligibleAtMs =
      new Date(transaction.dispatchedAt).getTime() + EDC_RECON_WAIT_MS;
    if (nowMs < eligibleAtMs) return { kind: "too-early", eligibleAtMs };
  }
  switch (transaction.status) {
    case "unknown":
      return { kind: "open", outcomes: ["approved", "declined"] };
    case "approved":
      return { kind: "open", outcomes: ["approved"] };
    case "declined":
    case "cancelled":
    case "failed":
      return { kind: "open", outcomes: ["declined"] };
    default:
      return { kind: "not-eligible" };
  }
}

/** Whole minutes since the sale row was created (never negative). */
export function ageMinutes(
  item: EdcReconciliationQueueItem,
  nowMs: number,
): number {
  const created = new Date(item.transaction.createdAt).getTime();
  return Math.max(0, Math.floor((nowMs - created) / 60_000));
}
