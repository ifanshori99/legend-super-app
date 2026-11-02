// Acceptance rules for one payment intent, without a database (bead
// legend-gz3; PRD v1.7 §3.13, PAY-01/PAY-02/PAY-04).
import { describe, expect, it } from "vitest";
import {
  decidePaymentConfirmation,
  type IntentSnapshot,
  type PaymentConfirmation,
} from "./payment-lifecycle";

const due = "2026-11-01T05:22:00.000Z";
const beforeExpiry = "2026-11-01T05:13:00.000Z";
const afterExpiry = "2026-11-01T05:30:00.000Z";

function intent(overrides: Partial<IntentSnapshot> = {}): IntentSnapshot {
  return {
    status: "pending",
    method: "qris",
    amountIdr: 144_375,
    providerRef: "DOIT-1",
    expiresAt: due,
    flags: [],
    ...overrides,
  };
}

function confirmation(
  overrides: Partial<PaymentConfirmation> = {},
): PaymentConfirmation {
  return {
    source: "verified_webhook",
    method: "qris",
    amountIdr: 144_375,
    providerRef: "DOIT-1",
    at: beforeExpiry,
    ...overrides,
  };
}

describe("PAY-02 only verified evidence settles a payment", () => {
  it("PAY-02 a verified webhook settles a pending online intent at the server amount", () => {
    const decision = decidePaymentConfirmation(intent(), confirmation());
    expect(decision).toEqual({
      kind: "settle",
      status: "paid",
      paidAt: beforeExpiry,
      late: false,
      flags: [],
      unallocatedIdr: 0,
      unallocatedReason: null,
    });
  });

  it("PAY-02 a browser redirect never settles an intent", () => {
    const decision = decidePaymentConfirmation(
      intent(),
      confirmation({ source: "browser_redirect" }),
    );
    expect(decision).toMatchObject({
      kind: "reject",
      code: "UNTRUSTED_CONFIRMATION",
    });
  });

  it("PAY-02 an authorized cash confirmation settles a cash intent, and nothing else", () => {
    expect(
      decidePaymentConfirmation(
        intent({ method: "cash", providerRef: null }),
        confirmation({ source: "authorized_cash", method: "cash" }),
      ),
    ).toMatchObject({ kind: "settle", status: "paid" });

    expect(
      decidePaymentConfirmation(
        intent({ method: "qris" }),
        confirmation({ source: "authorized_cash", method: "cash" }),
      ),
    ).toMatchObject({ kind: "reject", code: "UNTRUSTED_CONFIRMATION" });
  });

  it("PAY-02 an EDC ECR result settles an EDC tender and a gateway status cannot", () => {
    expect(
      decidePaymentConfirmation(
        intent({ method: "edc_card" }),
        confirmation({ source: "edc_ecr", method: "edc_card" }),
      ),
    ).toMatchObject({ kind: "settle" });

    expect(
      decidePaymentConfirmation(
        intent({ method: "edc_card" }),
        confirmation({ source: "verified_webhook", method: "edc_card" }),
      ),
    ).toMatchObject({ kind: "reject", code: "UNTRUSTED_CONFIRMATION" });
  });

  it("PAY-02 a paid intent is never settled twice by the same provider reference", () => {
    expect(
      decidePaymentConfirmation(
        intent({ status: "paid", providerRef: "DOIT-1" }),
        confirmation({ at: beforeExpiry }),
      ),
    ).toEqual({ kind: "duplicate", providerRef: "DOIT-1" });
  });

  it("PAY-02 a failed intent cannot be revived by a later confirmation", () => {
    expect(
      decidePaymentConfirmation(intent({ status: "failed" }), confirmation()),
    ).toMatchObject({ kind: "reject", code: "UNTRUSTED_CONFIRMATION" });
  });
});

describe("PAY-04 late, double and over-payment handling", () => {
  it("PAY-04 a payment that lands after expiry is accepted and flagged late_payment", () => {
    const decision = decidePaymentConfirmation(
      intent({ status: "expired" }),
      confirmation({ at: afterExpiry }),
    );
    expect(decision).toEqual({
      kind: "settle",
      status: "paid",
      paidAt: afterExpiry,
      late: true,
      flags: ["late_payment"],
      unallocatedIdr: 0,
      unallocatedReason: null,
    });
  });

  it("PAY-04 a second payment for the same intent becomes unallocated double funds", () => {
    const decision = decidePaymentConfirmation(
      intent({ status: "paid", providerRef: "DOIT-1" }),
      confirmation({ providerRef: "DOIT-2", amountIdr: 144_375 }),
    );
    expect(decision).toEqual({
      kind: "double_payment",
      amountIdr: 144_375,
      flags: ["double_payment"],
    });
  });

  it("PAY-04 rejects untrusted or mismatched evidence even after settlement", () => {
    for (const evidence of [
      confirmation({ source: "browser_redirect", providerRef: "DOIT-2" }),
      confirmation({
        source: "authorized_cash",
        method: "cash",
        providerRef: "DOIT-2",
      }),
    ]) {
      expect(
        decidePaymentConfirmation(intent({ status: "paid" }), evidence),
      ).toMatchObject({
        kind: "reject",
        code: "UNTRUSTED_CONFIRMATION",
      });
    }
  });

  it("PAY-04 an overpaid intent records the excess as unallocated funds", () => {
    const decision = decidePaymentConfirmation(
      intent({ amountIdr: 100_000 }),
      confirmation({ amountIdr: 144_375 }),
    );
    expect(decision).toMatchObject({
      kind: "settle",
      status: "paid",
      unallocatedIdr: 44_375,
      unallocatedReason: "overpayment",
    });
  });

  it("PAY-04 an underpayment never settles and records no unallocated money", () => {
    expect(
      decidePaymentConfirmation(
        intent({ amountIdr: 144_375 }),
        confirmation({ amountIdr: 100_000 }),
      ),
    ).toMatchObject({ kind: "reject", code: "AMOUNT_MISMATCH" });
  });
});

describe("PAY-01 amounts are the server's, never the confirmation's", () => {
  it("PAY-01 the intent amount decides what was due; the extra is not silently absorbed", () => {
    const decision = decidePaymentConfirmation(
      intent({ amountIdr: 1 }),
      confirmation({ amountIdr: 2 }),
    );
    expect(decision).toMatchObject({
      kind: "settle",
      unallocatedIdr: 1,
      unallocatedReason: "overpayment",
    });
  });
});
