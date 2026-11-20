// Card 1259 (legend-xd2q): "Catat refund manual" button logic, form checks,
// refusal texts and the endpoint wiring. Plain Node ESM, no browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as admin from "../packages/shared/src/payment/admin.ts";
import { id as messages } from "../packages/shared/src/i18n/messages/id.ts";
import {
  MANUAL_SETTLE_CHANNELS,
  canSettleManually,
  checkManualSettlement,
  manualSettlementRefusalKey,
} from "../apps/web/src/features/ws05-payment-admin/manual-settlement.ts";

const base = admin.cafeLegendPaymentAdminFixtures.refunds[0];
const approved = {
  ...base,
  status: "approved",
  providerRef: null,
  amountIdr: 25_000,
  createdAt: "2026-11-01T03:00:00.000Z",
};
const NOW = new Date("2026-11-02T03:00:00.000Z");
const good = {
  paidAtLocal: "2026-11-01T12:00",
  channel: "bank_transfer",
  externalReference: "TRF-0042",
  amountIdr: "25.000",
  note: "Transfer manual atas persetujuan manajer",
};
const text = (path) =>
  path.split(".").reduce((node, part) => node?.[part], messages);

test("button shows only for payment.reconcile on an approved refund the provider does not hold", () => {
  assert.equal(canSettleManually(approved, ["payment.reconcile"]), true);
  assert.equal(
    canSettleManually(approved, ["payment.transaction.view"]),
    false,
  );
  assert.equal(canSettleManually(approved, []), false);
  for (const status of ["pending", "completed", "failed"])
    assert.equal(
      canSettleManually({ ...approved, status }, ["payment.reconcile"]),
      false,
    );
  // Money rule: a provider reference means the provider holds it.
  assert.equal(
    canSettleManually({ ...approved, providerRef: "RF-1" }, [
      "payment.reconcile",
    ]),
    false,
  );
});

test("the amount must equal the refund; a different amount is never sent", () => {
  assert.equal(checkManualSettlement(approved, good, NOW).ok, true);
  for (const amountIdr of ["24.000", "25001", "0", "", "abc", "-25000"]) {
    const check = checkManualSettlement(approved, { ...good, amountIdr }, NOW);
    assert.equal(check.ok, false, amountIdr);
    assert.equal(check.field, "amountIdr");
  }
  const mismatch = checkManualSettlement(
    approved,
    { ...good, amountIdr: "24000" },
    NOW,
  );
  assert.equal(
    mismatch.messageKey,
    "paymentAdmin.manualSettle.error.amountMismatch",
  );
});

test("the body matches manualRefundSettlementInputSchema", () => {
  const check = checkManualSettlement(approved, good, NOW);
  assert.ok(check.ok);
  assert.equal(check.body.amountIdr, 25_000);
  assert.equal(check.body.channel, "bank_transfer");
  assert.equal(check.body.externalReference, "TRF-0042");
  assert.ok(
    admin.manualRefundSettlementInputSchema.safeParse({
      ...check.body,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }).success,
  );
});

test("date, channel, reference and note are required and bounded", () => {
  const field = (patch) =>
    checkManualSettlement(approved, { ...good, ...patch }, NOW).field;
  assert.equal(field({ paidAtLocal: "" }), "paidAt");
  assert.equal(field({ paidAtLocal: "2026-10-31T12:00" }), "paidAt");
  assert.equal(field({ paidAtLocal: "2026-11-03T12:00" }), "paidAt");
  assert.equal(field({ channel: "" }), "channel");
  assert.equal(field({ externalReference: "ab" }), "externalReference");
  assert.equal(
    field({ externalReference: "x".repeat(101) }),
    "externalReference",
  );
  assert.equal(field({ note: "ab" }), "note");
  assert.equal(field({ note: "x".repeat(501) }), "note");
});

test("every server refusal has Indonesian text; 422 is the date window", () => {
  const codes = [
    "REFUND_NOT_SETTLEABLE",
    "REFUND_AT_PROVIDER",
    "REFUND_PAYOUT_IN_FLIGHT",
    "SETTLEMENT_AMOUNT_MISMATCH",
    "REFUND_PROVIDER_PAID",
    "REFUND_PROVIDER_PENDING",
    "PROVIDER_REFUND_STATUS_UNKNOWN",
    "REFUND_LOOKUP_STALE",
    "REFUND_CAP_EXCEEDED",
    "APPROVER_IS_REQUESTER",
    "MFA_REQUIRED",
  ];
  for (const code of codes) {
    const key = manualSettlementRefusalKey(409, code);
    assert.ok(key, code);
    assert.equal(typeof text(key), "string", key);
  }
  const window = manualSettlementRefusalKey(422, "VALIDATION_ERROR");
  assert.equal(window, "paymentAdmin.manualSettle.refusal.paidAtWindow");
  assert.equal(manualSettlementRefusalKey(500, "SOMETHING_ELSE"), null);
});

test("every catalog key the screen uses exists", () => {
  for (const channel of MANUAL_SETTLE_CHANNELS)
    assert.equal(
      typeof text(`paymentAdmin.manualSettle.channels.${channel}`),
      "string",
    );
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/ws05-payment-admin/components/refund-followup-dialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  for (const [, key] of source.matchAll(
    /"(paymentAdmin\.manualSettle\.[A-Za-z.]+)"/g,
  ))
    assert.equal(typeof text(key), "string", key);
});

test("the dialog and hook post to settle-manually with one attempt key", () => {
  const dir = new URL(
    "../apps/web/src/features/ws05-payment-admin/",
    import.meta.url,
  );
  const dialog = readFileSync(
    new URL("components/refund-followup-dialog.tsx", dir),
    "utf8",
  );
  const hooks = readFileSync(new URL("hooks.ts", dir), "utf8");
  const api = readFileSync(new URL("api.ts", dir), "utf8");
  assert.match(api, /settleRefundManually as settleRefundManuallyEndpoint/);
  assert.match(hooks, /export function useSettleRefundManually/);
  assert.match(dialog, /canSettleManually\(/);
  assert.match(dialog, /attempt\.keyFor\(/);
  assert.match(dialog, /loading=\{settle\.isPending\}/);
  assert.equal(
    admin.settleRefundManually.path,
    "/api/payments/admin/refunds/:refundId/settle-manually",
  );
});
