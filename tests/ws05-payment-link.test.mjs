// Contract + pure-rule tests for the customer payment pages (bead legend-2w5).
// Imports the shared contract and the screen's pure module directly; Node's
// type stripping loads both (docs/frontend.md "Tests").
import assert from "node:assert/strict";
import { test } from "node:test";
import * as payment from "../packages/shared/src/payment/index.ts";
import {
  INTENT_POLL_MS,
  MAX_AUTO_REFRESHES,
  billHasAddedCharges,
  canSubmit,
  clockSkewMs,
  formatCountdown,
  isSettled,
  paymentPhase,
  pollIntervalMs,
  remainingMs,
  shouldAutoRefresh,
  shouldPoll,
} from "../apps/web/src/features/ws05-payment/status.ts";

const link = payment.paymentLinkViewFixture;
const paidAt = "2026-11-01T05:13:00.000Z";

test("PAY-01 customer payment link fixtures satisfy the contract", () => {
  for (const [schema, fixture] of payment.paymentLinkFixtures)
    assert.ok(schema.parse(fixture), fixture.token);
  for (const [schema, fixture] of payment.customerPaymentIntentFixtures)
    assert.ok(schema.parse(fixture), fixture.id);

  // Amount edits that break the bill arithmetic must be rejected, not shown.
  const totals = link.bill.totals;
  const parseTotals = (next) =>
    payment.paymentLinkViewSchema.safeParse({
      ...link,
      bill: { ...link.bill, totals: { ...totals, ...next } },
    }).success;
  assert.equal(parseTotals({ totalIdr: totals.totalIdr + 1 }), false);
  assert.equal(
    parseTotals({ outstandingIdr: totals.outstandingIdr - 1 }),
    false,
  );
  assert.equal(parseTotals({ paidIdr: totals.totalIdr + 1 }), false);
  assert.equal(parseTotals({ totalIdr: 144375.5 }), false);
  // Table context is either complete or absent.
  assert.equal(
    payment.paymentLinkViewSchema.safeParse({
      ...link,
      bill: { ...link.bill, pax: null },
    }).success,
    false,
  );
});

test("PAY-02 a browser redirect cannot settle the screen: only the intent status counts", () => {
  const pending = payment.qrisPendingIntentFixture;
  assert.equal(
    paymentPhase(payment.paymentLinkQrisPendingFixture, pending),
    "pending",
  );
  assert.equal(
    paymentPhase(payment.paymentLinkQrisPendingFixture, {
      ...pending,
      status: "paid",
      paidAt,
    }),
    "paid",
  );
  // Polling runs only while the API still reports pending.
  assert.equal(shouldPoll("pending"), true);
  assert.equal(pollIntervalMs("pending"), INTENT_POLL_MS);
  for (const status of ["paid", "expired", "failed", "refunded"])
    assert.equal(shouldPoll(status), false, status);
  for (const status of ["paid", "partially_refunded", "refunded"])
    assert.equal(isSettled(status), true, status);
  // The intent schema refuses a settled status without a paid time and an
  // unpaid status with one, so a paid-looking payload cannot be forged.
  assert.equal(
    payment.customerPaymentIntentSchema.safeParse({
      ...pending,
      status: "paid",
      paidAt: null,
    }).success,
    false,
  );
  assert.equal(
    payment.customerPaymentIntentSchema.safeParse({
      ...pending,
      status: "pending",
      paidAt,
    }).success,
    false,
  );
});

test("PAY-02 the phase follows the link and the polled intent", () => {
  const cases = [
    [payment.paymentLinkViewFixture, "choose"],
    [payment.paymentLinkQrisPendingFixture, "pending"],
    [payment.paymentLinkPaidFixture, "paid"],
    [payment.paymentLinkExpiredFixture, "expired"],
    [payment.paymentLinkFailedFixture, "failed"],
    [payment.paymentLinkGatewayDownFixture, "unavailable"],
    [payment.paymentLinkSettledFixture, "empty"],
  ];
  for (const [view, phase] of cases)
    assert.equal(paymentPhase(view), phase, view.token);
  // A method list without a single enabled method is unavailable, not empty.
  assert.equal(
    paymentPhase({
      ...payment.paymentLinkViewFixture,
      methods: payment.paymentLinkGatewayDownFixture.methods,
    }),
    "unavailable",
  );
});

test("PAY-01 the intent input requires the bank its method needs", () => {
  const parse = (input) =>
    payment.createPaymentIntentInputSchema.safeParse(input);
  const key = "checkout-A03-001";
  assert.equal(
    parse({ method: "qris", channelCode: null, idempotencyKey: key }).success,
    true,
  );
  assert.equal(
    parse({ method: "qris", channelCode: "bca", idempotencyKey: key }).success,
    false,
  );
  assert.equal(
    parse({ method: "va", channelCode: null, idempotencyKey: key }).success,
    false,
  );
  assert.equal(
    parse({ method: "va", channelCode: "bca", idempotencyKey: key }).success,
    true,
  );
  assert.equal(
    parse({ method: "bank_transfer", channelCode: "bca", idempotencyKey: key })
      .success,
    true,
  );
  assert.equal(parse({ method: "va", channelCode: "bca" }).success, false);
  assert.equal(
    parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: key,
      tenantId: "x",
    }).success,
    false,
  );
  // The screen offers the button only for a complete choice.
  assert.equal(canSubmit("qris", null), true);
  assert.equal(canSubmit("qris", "bca"), false);
  assert.equal(canSubmit("va", null), false);
  assert.equal(canSubmit("va", "bca"), true);
  assert.equal(canSubmit("bank_transfer", "bca"), true);
  assert.equal(canSubmit(null, null), false);
});

test("PAY-01 bank transfer amount is the bill plus the unique code", () => {
  const intent = payment.bankTransferPendingIntentFixture;
  assert.equal(
    intent.instructions.transferTotalIdr,
    intent.amountIdr + Number(intent.instructions.uniqueCode),
  );
  assert.equal(
    payment.customerPaymentIntentSchema.safeParse({
      ...intent,
      instructions: {
        ...intent.instructions,
        transferTotalIdr: intent.amountIdr,
      },
    }).success,
    false,
  );
  assert.equal(
    payment.customerPaymentIntentSchema.safeParse({
      ...intent,
      method: "va",
    }).success,
    false,
  );
});

test("PAY-02 the countdown trusts the server clock, not the device", () => {
  const serverTime = "2026-11-01T05:10:00.000Z";
  const receivedAt = Date.parse(serverTime) + 5_000; // device clock 5s fast
  const skew = clockSkewMs(serverTime, receivedAt);
  assert.equal(skew, 5_000);
  const expiresAt = "2026-11-01T05:20:00.000Z";
  assert.equal(remainingMs(expiresAt, receivedAt, skew), 10 * 60 * 1000);
  assert.equal(remainingMs(expiresAt, receivedAt + 1_000, skew), 599_000);
  assert.equal(remainingMs(expiresAt, receivedAt + 20 * 60 * 1000, skew), 0);
  assert.equal(remainingMs(null, receivedAt, skew), 0);
  assert.equal(remainingMs("not-a-date", receivedAt, skew), 0);
  assert.equal(formatCountdown(599_000), "09:59");
  assert.equal(formatCountdown(0), "00:00");
  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(formatCountdown(1), "00:01");
});

test("PAY-02 a live code refreshes itself once it runs out", () => {
  assert.equal(shouldAutoRefresh("pending", 0, 0), true);
  assert.equal(shouldAutoRefresh("pending", 1_000, 0), false);
  assert.equal(shouldAutoRefresh("pending", 0, MAX_AUTO_REFRESHES), false);
  // An expired link is not refreshed silently on first render.
  assert.equal(shouldAutoRefresh("expired", 0, 0), false);
  assert.equal(shouldAutoRefresh("paid", 0, 0), false);
  assert.equal(shouldAutoRefresh(undefined, 0, 0), false);
});

test("PAY-01 service charge and tax are shown as added at checkout", () => {
  assert.equal(
    billHasAddedCharges({ serviceChargeIdr: 6_250, taxIdr: 13_125 }),
    true,
  );
  assert.equal(
    billHasAddedCharges({ serviceChargeIdr: 0, taxIdr: 13_125 }),
    true,
  );
  assert.equal(billHasAddedCharges({ serviceChargeIdr: 0, taxIdr: 0 }), false);
});
