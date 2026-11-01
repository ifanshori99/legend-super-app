// Settlement decisions for one payment intent (bead legend-gz3; PRD v1.7
// §3.13 "Siklus Pembayaran", PAY-01/PAY-02/PAY-04).
//
// Pure functions only: the service loads the intent and the provider's answer,
// asks this module what may happen, and then writes in one tenant transaction.
// Keeping the decision free of I/O makes every acceptance rule testable
// without a database.
//
// Rules:
// - PAY-02: only a verified source settles an intent. `canTransitionPayment`
//   (the contract's state machine) maps source + method, so a browser redirect
//   (`source: "browser_redirect"`) is never a settlement.
// - PRD "Siklus Pembayaran": an expired intent may still be paid; the payment
//   is accepted and flagged `late_payment` for follow-up.
// - PAY-04: a second payment for a settled intent, or a payment above the
//   amount due, becomes unallocated funds resolved by refund or credit with
//   approval. The intent status never double-counts the money.

import {
  canTransitionPayment,
  type PaymentConfirmationSource,
  type PaymentMethod,
  type PaymentStatus,
} from "@starter/shared/payment";

/** Flags the payment domain may set on an intent (PRD §6 D `flags`). */
export type PaymentFlag = "late_payment" | "double_payment";
export type UnallocatedReason = "overpayment" | "double_payment";

export type IntentSnapshot = {
  readonly status: PaymentStatus;
  readonly method: PaymentMethod;
  /** Server-priced amount, whole rupiah (PAY-01). */
  readonly amountIdr: number;
  readonly providerRef: string | null;
  readonly expiresAt: string;
  readonly flags: readonly PaymentFlag[];
};

export type PaymentConfirmation = {
  /** Evidence label; unknown labels settle nothing (fail closed). */
  readonly source: PaymentConfirmationSource | string;
  readonly method: PaymentMethod;
  /** Amount the provider or authorized officer says was collected. */
  readonly amountIdr: number;
  /** Provider transaction reference; identifies a duplicate webhook. */
  readonly providerRef: string;
  /** When the money was confirmed (ISO instant). */
  readonly at: string;
};

export type PaymentDecision =
  /** Same provider reference seen again: no state change, no second money row. */
  | { readonly kind: "duplicate"; readonly providerRef: string }
  /** A different payment for an already settled intent (PAY-04). */
  | {
      readonly kind: "double_payment";
      readonly amountIdr: number;
      readonly flags: readonly PaymentFlag[];
    }
  | {
      readonly kind: "settle";
      readonly status: "paid";
      readonly paidAt: string;
      readonly late: boolean;
      readonly flags: readonly PaymentFlag[];
      /** Part of the payment that belongs to no bill remainder, if any. */
      readonly unallocatedIdr: number;
      readonly unallocatedReason: "overpayment" | null;
    }
  | {
      readonly kind: "reject";
      readonly code:
        "UNTRUSTED_CONFIRMATION" | "AMOUNT_MISMATCH" | "INVALID_TRANSITION";
      readonly message: string;
    };

const settledStatuses: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
];

function addFlag(
  flags: readonly PaymentFlag[],
  flag: PaymentFlag,
): PaymentFlag[] {
  return flags.includes(flag) ? [...flags] : [...flags, flag];
}

/** What a confirmation by `source` is allowed to do to `intent`. */
export function decidePaymentConfirmation(
  intent: IntentSnapshot,
  confirmation: PaymentConfirmation,
): PaymentDecision {
  if (settledStatuses.includes(intent.status)) {
    // The same payment retried (webhook replay, a second status check): the
    // intent already holds this money, so nothing new is recorded.
    if (
      intent.providerRef !== null &&
      intent.providerRef === confirmation.providerRef
    )
      return { kind: "duplicate", providerRef: confirmation.providerRef };
    return {
      kind: "double_payment",
      amountIdr: confirmation.amountIdr,
      flags: addFlag(intent.flags, "double_payment"),
    };
  }

  if (
    !canTransitionPayment(
      intent.status,
      "paid",
      confirmation.source,
      confirmation.method,
    ) ||
    confirmation.method !== intent.method
  )
    return {
      kind: "reject",
      code: "UNTRUSTED_CONFIRMATION",
      message:
        "Only a verified gateway, EDC or authorized staff confirmation can mark a payment paid.",
    };

  if (confirmation.amountIdr < intent.amountIdr)
    return {
      kind: "reject",
      code: "AMOUNT_MISMATCH",
      message: "The confirmed amount is below the amount due.",
    };

  const late =
    intent.status === "expired" ||
    Date.parse(confirmation.at) > Date.parse(intent.expiresAt);
  const unallocatedIdr = confirmation.amountIdr - intent.amountIdr;
  return {
    kind: "settle",
    status: "paid",
    paidAt: confirmation.at,
    late,
    flags: late ? addFlag(intent.flags, "late_payment") : [...intent.flags],
    unallocatedIdr,
    unallocatedReason: unallocatedIdr > 0 ? "overpayment" : null,
  };
}
