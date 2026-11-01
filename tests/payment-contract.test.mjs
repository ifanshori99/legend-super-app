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
  for (const source of [
    "verified_webhook",
    "gateway_status",
    "edc_ecr",
    "authorized_cash",
    "authorized_edc_standalone",
  ])
    assert.equal(
      payment.canTransitionPayment("pending", "paid", source),
      true,
      source,
    );
  for (const source of ["browser_redirect", undefined])
    assert.equal(
      payment.canTransitionPayment("pending", "paid", source),
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
    payment.canTransitionPayment("expired", "paid", "verified_webhook"),
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
