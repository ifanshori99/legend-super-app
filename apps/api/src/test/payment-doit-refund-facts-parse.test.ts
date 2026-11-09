// legend-2ol8g follow-up: `payment_id` facts of a refund event. An unreadable
// payment object, and a `refund.payment_id` that is unreadable or disagrees
// with the flat `payment_id`, mark the event invalid. Pure: parser only.
import { describe, expect, it } from "vitest";
import {
  doitRefundWebhookEventSchema,
  readDoitRefundFacts,
} from "../services/payment-doit-refund-webhook";

const PAYMENT_ID = "pay_3N-1K5igG03DWXKD";
const OTHER_PAYMENT_ID = "pay_other-0000000001";

const flat = {
  amount: 500,
  refund_id: "rf_bAuCUEzQ19ZcgtbN",
  payment_id: PAYMENT_ID,
};

function envelope(data: unknown) {
  return {
    id: "evt_1",
    type: "refund.succeeded",
    created_at: "2026-11-09T06:49:05.541Z",
    data,
  };
}

/** Stored form must round-trip and re-parse to the same facts. */
function expectStableRoundTrip(data: unknown) {
  const stored = doitRefundWebhookEventSchema.parse(envelope(data));
  expect(doitRefundWebhookEventSchema.parse(stored)).toEqual(stored);
  expect(readDoitRefundFacts(stored.data)).toEqual(readDoitRefundFacts(data));
}

describe("legend-2ol8g an unreadable payment object", () => {
  it.each([
    ["null", null],
    ["a string", "pay_x"],
    ["an empty object", {}],
    ["missing reference", { id: PAYMENT_ID, status: "paid", amount: 500 }],
    [
      "an unknown status",
      { id: PAYMENT_ID, reference: "r", status: "weird", amount: 500 },
    ],
  ])("PAY-04 payment %s marks payment_id invalid", (_name, payment) => {
    const data = { ...flat, payment };
    expect(readDoitRefundFacts(data).invalid).toEqual(["payment_id"]);
    expect(readDoitRefundFacts(data).payment).toBeUndefined();
    expectStableRoundTrip(data);
  });

  it("PAY-04 a payment-shaped data that fails to read marks payment_id invalid", () => {
    const data = { id: PAYMENT_ID, reference: "r", status: "weird", amount: 5 };
    expect(readDoitRefundFacts(data).invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 a readable payment object stays valid", () => {
    const payment = {
      id: PAYMENT_ID,
      reference: "r",
      status: "refunded",
      amount: 500,
    };
    const data = { refund_id: "rf_1", amount: 500, payment };
    const facts = readDoitRefundFacts(data);
    expect(facts.payment).toEqual(payment);
    expect(facts.invalid).toBeUndefined();
    expectStableRoundTrip(data);
  });
});

describe("legend-2ol8g refund.payment_id", () => {
  const refund = { id: "rf_1", amount: 500 };

  it("PAY-04 a readable refund.payment_id is the payment id", () => {
    const data = { refund: { ...refund, payment_id: PAYMENT_ID } };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBe(PAYMENT_ID);
    expect(facts.invalid).toBeUndefined();
    expectStableRoundTrip(data);
  });

  it("PAY-04 the same id flat and in the refund is valid", () => {
    const data = {
      refund: { ...refund, payment_id: PAYMENT_ID },
      payment_id: PAYMENT_ID,
    };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBe(PAYMENT_ID);
    expect(facts.invalid).toBeUndefined();
    expectStableRoundTrip(data);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["an empty string", ""],
    ["an object", {}],
  ])("PAY-04 refund.payment_id %s is invalid", (_name, bad) => {
    const data = { refund: { ...refund, payment_id: bad } };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBeUndefined();
    expect(facts.invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 an unreadable refund.payment_id beside a good flat one is invalid", () => {
    const data = {
      refund: { ...refund, payment_id: null },
      payment_id: PAYMENT_ID,
    };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBeUndefined();
    expect(facts.invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 an unreadable flat payment_id beside a good refund one is invalid", () => {
    const data = {
      refund: { ...refund, payment_id: PAYMENT_ID },
      payment_id: null,
    };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBeUndefined();
    expect(facts.invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 different ids flat and in the refund are invalid, never a pick", () => {
    const data = {
      refund: { ...refund, payment_id: OTHER_PAYMENT_ID },
      payment_id: PAYMENT_ID,
    };
    const facts = readDoitRefundFacts(data);
    expect(facts.paymentId).toBeUndefined();
    expect(facts.invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });
});

describe("legend-2ol8g a keyed or refund-id event requires amount and a payment id", () => {
  const key = "refund:3875dc37-0d8e-4f4e-9a8e-5c2b1f6d7e90";
  const payment = {
    id: PAYMENT_ID,
    reference: "r",
    status: "refunded",
    amount: 500,
  };

  it.each([
    [
      "keyed refund object",
      { object: "refund", id: "rf_1", idempotency_key: key },
    ],
    [
      "nested refund with key",
      { refund: { id: "rf_1", idempotency_key: key } },
    ],
    ["key only", { idempotency_key: key }],
    ["nested refund id only", { refund: { id: "rf_1" } }],
  ])("PAY-04 a %s without amount or payment id is invalid", (_name, data) => {
    expect(readDoitRefundFacts(data).invalid).toEqual(["amount", "payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 a keyed refund object without an amount is invalid amount only", () => {
    const data = {
      object: "refund",
      id: "rf_1",
      idempotency_key: key,
      payment_id: PAYMENT_ID,
    };
    expect(readDoitRefundFacts(data).invalid).toEqual(["amount"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 a keyed refund object with an amount but no payment id is invalid payment_id only", () => {
    const data = {
      object: "refund",
      id: "rf_1",
      idempotency_key: key,
      amount: 500,
    };
    expect(readDoitRefundFacts(data).invalid).toEqual(["payment_id"]);
    expectStableRoundTrip(data);
  });

  it("PAY-04 amount and a payment id (flat, refund-level or the payment object's) are valid", () => {
    for (const data of [
      { object: "refund", id: "rf_1", amount: 500, payment_id: PAYMENT_ID },
      { refund: { id: "rf_1", amount: 500, payment_id: PAYMENT_ID } },
      { refund: { id: "rf_1", amount: 500 }, payment },
    ]) {
      expect(readDoitRefundFacts(data).invalid).toBeUndefined();
      expectStableRoundTrip(data);
    }
  });

  it("PAY-04 a pure payment-object event (no key, no refund id) stays valid", () => {
    const data = {
      id: PAYMENT_ID,
      reference: "r",
      status: "refunded",
      amount: 500,
    };
    expect(readDoitRefundFacts(data).invalid).toBeUndefined();
    expectStableRoundTrip(data);
  });
});
