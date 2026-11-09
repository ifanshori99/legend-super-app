// DOIT refund answers and webhooks as the sandbox really sends them (bead
// legend-0yd1, observed on https://pay.doit.id with a pb_test_ key on 9 Nov
// 2026). Pure: parser and matcher only, no database. The payloads below are
// copied from the sandbox, ids and amounts unchanged.
import { describe, expect, it } from "vitest";
import {
  doitRefundWebhookEventSchema,
  matchDoitRefundEvent,
  readDoitRefundFacts,
} from "../services/payment-doit-refund-webhook";
import {
  DoitRefundUnknownError,
  parseDoitRefundAnswer,
} from "../services/payment-doit-wire";

const PAYMENT_ID = "pay_3N-1K5igG03DWXKD";
const expected = {
  paymentProviderRef: PAYMENT_ID,
  paymentIntentId: "0b0f8f8e-6a3e-4c1e-9c55-2f1d1f0c1a01",
  amountIdr: 4000,
  // legend-r7g2: the key of the request; the replay answer must echo it.
  idempotencyKey: "refund:3875dc37-0d8e-4f4e-9a8e-5c2b1f6d7e90",
};

/** 201 answer of the first `POST /v1/payments/{id}/refunds`. */
const created = {
  id: "rf_xSwCLQjjw53PsuAT",
  payment_id: PAYMENT_ID,
  amount: 4000,
  status: "succeeded",
  reason: "Pengembalian sandbox",
};

/** 200 answer of a replay (same key, same body): amount is a string. */
const replayed = {
  id: "rf_xSwCLQjjw53PsuAT",
  payment_id: PAYMENT_ID,
  idempotency_key: "refund:3875dc37-0d8e-4f4e-9a8e-5c2b1f6d7e90",
  amount: "4000",
  reason: "Pengembalian sandbox",
  status: "succeeded",
  provider_ref: "MOCKRF-E9C54AD2A908",
  created_at: "2026-11-09T06:47:58.334Z",
};

/** Raw `refund.succeeded` webhook body: flat data, no refund object. */
const refundSucceeded = {
  id: "evt__kQPcmsFKlBexJDj",
  data: {
    amount: 500,
    refund_id: "rf_bAuCUEzQ19ZcgtbN",
    payment_id: PAYMENT_ID,
  },
  type: "refund.succeeded",
  created_at: "2026-11-09T06:49:05.541Z",
};

describe("legend-0yd1 PAY-04 the refund answer of POST …/refunds", () => {
  it("PAY-04 the 201 create answer (amount a number) is a success with the refund id", () => {
    expect(parseDoitRefundAnswer(created, expected)).toEqual({
      status: "succeeded",
      providerRef: "rf_xSwCLQjjw53PsuAT",
    });
  });

  it("PAY-04 the 200 replay answer (amount a string, extra fields) reads the same as the create answer", () => {
    expect(parseDoitRefundAnswer(replayed, expected)).toEqual(
      parseDoitRefundAnswer(created, expected),
    );
  });

  it("PAY-04 a replay naming another amount (DOIT returns the original refund on key reuse) is unknown, never a success", () => {
    expect(() =>
      parseDoitRefundAnswer(replayed, { ...expected, amountIdr: 3000 }),
    ).toThrow(DoitRefundUnknownError);
    expect(() =>
      parseDoitRefundAnswer(created, { ...expected, amountIdr: 3000 }),
    ).toThrow(DoitRefundUnknownError);
  });

  it.each(["4000.0", "04000", " 4000", "4000 ", "-4000", "+4000", "4e3", ""])(
    "PAY-04 a non-canonical amount string %j is unknown",
    (amount) => {
      expect(() =>
        parseDoitRefundAnswer({ ...replayed, amount }, expected),
      ).toThrow(DoitRefundUnknownError);
    },
  );

  it("PAY-04 a refund object naming another payment_id is unknown, never a success", () => {
    for (const answer of [created, replayed])
      expect(() =>
        parseDoitRefundAnswer(
          { ...answer, payment_id: "pay_someone_else" },
          expected,
        ),
      ).toThrow(DoitRefundUnknownError);
  });

  it("PAY-04 an amount of another type (null, boolean, object) is unknown", () => {
    for (const amount of [null, true, { value: 4000 }])
      expect(() =>
        parseDoitRefundAnswer({ ...created, amount }, expected),
      ).toThrow(DoitRefundUnknownError);
  });
});

describe("legend-0yd1 PAY-04 the flat refund.succeeded webhook", () => {
  it("PAY-04 the flat data gives the refund id, the refund amount and the payment id", () => {
    expect(readDoitRefundFacts(refundSucceeded.data)).toEqual({
      refundId: "rf_bAuCUEzQ19ZcgtbN",
      amountIdr: 500,
      paymentId: PAYMENT_ID,
    });
  });

  it("PAY-04 it matches by the provider refund id (path b)", () => {
    expect(
      matchDoitRefundEvent(
        refundSucceeded.type,
        readDoitRefundFacts(refundSucceeded.data),
      ),
    ).toEqual({ kind: "refund_id", providerRef: "rf_bAuCUEzQ19ZcgtbN" });
  });

  it("PAY-04 the stored event keeps the payment id and re-parses to the same facts", () => {
    const stored = doitRefundWebhookEventSchema.parse(refundSucceeded);
    expect(stored.data).toEqual({
      refund: { id: "rf_bAuCUEzQ19ZcgtbN", amount: 500 },
      payment_id: PAYMENT_ID,
    });
    expect(readDoitRefundFacts(stored.data)).toEqual(
      readDoitRefundFacts(refundSucceeded.data),
    );
    expect(doitRefundWebhookEventSchema.parse(stored)).toEqual(stored);
  });

  it("PAY-04 a webhook amount sent as a canonical integer string is read like a number", () => {
    const stringAmount = { ...refundSucceeded.data, amount: "500" };
    expect(readDoitRefundFacts(stringAmount)).toEqual(
      readDoitRefundFacts(refundSucceeded.data),
    );
    expect(
      readDoitRefundFacts({
        refund: { id: "rf_bAuCUEzQ19ZcgtbN", amount: "500" },
      }).amountIdr,
    ).toBe(500);
  });

  it.each([
    "500.0",
    "0500",
    " 500",
    "-500",
    "+500",
    "5e2",
    "",
    "99999999999999999",
  ])("PAY-04 a webhook amount string %j is dropped", (amount) => {
    const facts = readDoitRefundFacts({ ...refundSucceeded.data, amount });
    expect(facts.amountIdr).toBeUndefined();
    expect(facts.refundId).toBe("rf_bAuCUEzQ19ZcgtbN");
  });

  it("PAY-04 a payment-shaped data never reads payment_id / refund_id / amount as refund facts", () => {
    const facts = readDoitRefundFacts({
      id: PAYMENT_ID,
      reference: expected.paymentIntentId,
      status: "refunded",
      amount: 10_000,
      refund_id: "rf_bAuCUEzQ19ZcgtbN",
      payment_id: "pay_other",
    });
    expect(facts.refundId).toBeUndefined();
    expect(facts.paymentId).toBeUndefined();
    expect(facts.amountIdr).toBeUndefined();
    expect(facts.payment?.id).toBe(PAYMENT_ID);
  });
});
