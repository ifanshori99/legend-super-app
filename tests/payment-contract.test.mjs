import assert from "node:assert/strict";
import { test } from "node:test";
import * as payment from "../packages/shared/src/payment/index.ts";

test("PAY-01 Cafe Legend payment fixtures satisfy all contracts", () => {
  for (const [schema, fixture] of payment.paymentFixtures)
    assert.ok(schema.parse(fixture));
  assert.equal(
    payment.paymentIntentSchema.safeParse({
      ...payment.intentFixture,
      amountIdr: 1.5,
    }).success,
    false,
  );
  assert.equal(
    payment.paymentIntentSchema.safeParse({
      ...payment.intentFixture,
      amountIdr: -1,
    }).success,
    false,
  );
  assert.equal(
    payment.paymentIntentSchema.safeParse({
      ...payment.intentFixture,
      tenantId: "invalid",
    }).success,
    false,
  );
});

test("PAY-02 only authorized evidence permits paid transitions", () => {
  for (const [source, method] of [
    ["verified_webhook", "qris"],
    ["gateway_status", "va"],
    ["edc_ecr", "edc_card"],
    ["authorized_cash", "cash"],
    ["authorized_edc_standalone", "edc_qris"],
  ])
    assert.equal(
      payment.canTransitionPayment("pending", "paid", source, method),
      true,
      source,
    );
  for (const source of ["browser_redirect", undefined])
    assert.equal(
      payment.canTransitionPayment("pending", "paid", source, "qris"),
      false,
    );
  assert.equal(payment.canTransitionPayment("paid", "pending"), false);
  assert.equal(
    payment.canTransitionPayment("paid", "partially_refunded"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("partially_refunded", "refunded"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("expired", "paid", "verified_webhook", "qris"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("refunded", "paid", "gateway_status"),
    false,
  );
});

test("PAY-01 payment records reject invalid scope and integer amounts", () => {
  for (const [schema, fixture] of payment.paymentFixtures) {
    assert.equal(
      schema.safeParse({ ...fixture, tenantId: "invalid" }).success,
      false,
    );
  }
  assert.equal(
    payment.refundSchema.safeParse({
      ...payment.refundFixture,
      amountIdr: 10.1,
    }).success,
    false,
  );
});

test("PAY-02 confirmation evidence must match the payment method", () => {
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "authorized_cash", "qris"),
    false,
  );
  assert.equal(
    payment.canTransitionPayment(
      "pending",
      "paid",
      "authorized_edc_standalone",
      "qris",
    ),
    false,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "verified_webhook", "cash"),
    false,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "edc_ecr", "cash"),
    false,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "gateway_status", "qris"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "authorized_cash", "cash"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "edc_ecr", "edc_card"),
    true,
  );
  assert.equal(
    payment.canTransitionPayment(
      "pending",
      "paid",
      "authorized_edc_standalone",
      "edc_qris",
    ),
    true,
  );
  assert.equal(
    payment.canTransitionPayment("pending", "paid", "verified_webhook"),
    false,
  );
});

test("PAY-01 settled intents record paidAt and unpaid intents do not", () => {
  const paidAt = "2026-11-01T05:13:00.000Z";
  const parse = (status, at) =>
    payment.paymentIntentSchema.safeParse({
      ...payment.intentFixture,
      status,
      paidAt: at,
    }).success;
  assert.equal(parse("paid", paidAt), true);
  assert.equal(parse("refunded", paidAt), true);
  assert.equal(parse("paid", null), false);
  assert.equal(parse("pending", paidAt), false);
  assert.equal(parse("expired", paidAt), false);
});

test("PAY-01 EDC records never carry a full card number or free-form IP", () => {
  const [, edcTx] = payment.paymentFixtures.find(
    ([schema]) => schema === payment.edcTransactionSchema,
  );
  const [, terminal] = payment.paymentFixtures.find(
    ([schema]) => schema === payment.edcTerminalSchema,
  );
  const pan = (maskedPan) =>
    payment.edcTransactionSchema.safeParse({ ...edcTx, maskedPan }).success;
  assert.equal(pan("****1234"), true);
  assert.equal(pan("411111******1111"), true);
  assert.equal(pan("4111111111111111"), false);
  assert.equal(pan("4111 1111 1111 1111"), false);
  const ip = (ipAddress) =>
    payment.edcTerminalSchema.safeParse({ ...terminal, ipAddress }).success;
  assert.equal(ip("192.168.1.20"), true);
  assert.equal(ip("not-an-ip"), false);
});

test("PAY-04 payment.funds_unallocated is catalogued for WS-05 with a strict payload", async () => {
  const { eventCatalogByName } = await import(
    "../packages/shared/src/events/index.ts"
  );
  assert.equal(
    eventCatalogByName.get("payment.funds_unallocated")?.workstream,
    "WS-05",
  );
  assert.ok(payment.paymentEventNames.includes("payment.funds_unallocated"));
  const payload = {
    unallocatedFundId: "8a32e00d-7e43-45b6-9d01-7a92e605c105",
    intentId: payment.intentFixture.id,
    method: "qris",
    provider: "doit",
    receivedIdr: 125000,
    receivedAt: "2026-11-01T05:30:00.000Z",
    reason: "double_payment",
  };
  const parse = (p) =>
    payment.paymentFundsUnallocatedEventPayloadSchema.safeParse(p).success;
  assert.equal(parse(payload), true);
  assert.equal(parse({ ...payload, receivedIdr: 0 }), false);
  assert.equal(parse({ ...payload, reason: "refund" }), false);
  assert.equal(parse({ ...payload, extra: 1 }), false);
});
