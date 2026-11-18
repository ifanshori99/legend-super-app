// POS kasir mock engine, voucher, member points and EDC declined (brief 936,
// legend-5w6): the engine stands in for the server, so these tests pin the
// money rules the real API must keep. A voucher never takes more than the
// subtotal or what is still owed and is used once; points never pay more than
// the remaining bill and the balance drops by exactly what was spent; a
// declined EDC payment pays nothing and does not block the bill.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  DEMO_CODE_ORDER_ID,
  DEMO_ORDER_ID,
} from "../apps/web/src/features/ws04-pos-kasir/demo-seed.ts";
import {
  EDC_AUTO_CONFIRM_MS,
  EDC_DECLINING_TERMINAL_ID,
  createPosKasirEngine,
} from "../apps/web/src/features/ws04-pos-kasir/mock-engine.ts";
import * as wire from "../apps/web/src/features/ws04-pos-kasir/mock-wire.ts";
import * as pos from "../packages/shared/src/pos/index.ts";

function fresh(seed = null) {
  const time = { now: 1_700_000_000_000 };
  const engine = createPosKasirEngine({
    clock: () => time.now,
    readSeed: () => seed,
  });
  return { engine, time };
}

const code = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return error.code;
  }
  assert.fail("expected an ApiError");
};

test("a voucher discount is capped by the rule and the bill total follows the server", () => {
  const { engine } = fresh();
  const preview = engine.validateVoucher(DEMO_ORDER_ID, "HEMAT20");
  // 20% of Rp220.000 is Rp44.000, but the voucher caps at Rp30.000.
  assert.deepEqual(preview, {
    valid: true,
    code: "HEMAT20",
    discountPreviewIdr: 30_000,
  });
  const before = engine.session(DEMO_ORDER_ID).bill;
  assert.equal(before.remainingIdr, 148_000);
  const after = engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20").bill;
  assert.deepEqual(after.voucher, { code: "HEMAT20", discountIdr: 30_000 });
  assert.equal(after.totalIdr, 218_000);
  assert.equal(after.remainingIdr, 118_000);
});

test("a voucher never takes more than the subtotal or what is still owed", () => {
  const { engine } = fresh("split");
  // Rp100.000 is paid, Rp48.000 is left: the Rp50.000 voucher takes Rp48.000.
  const preview = engine.validateVoucher(DEMO_ORDER_ID, "LEGEND50K");
  assert.equal(preview.valid, true);
  assert.equal(preview.discountPreviewIdr, 48_000);
  const bill = engine.applyVoucher(DEMO_ORDER_ID, "LEGEND50K").bill;
  assert.equal(bill.voucher.discountIdr, 48_000);
  assert.ok(bill.voucher.discountIdr <= bill.subtotalIdr);
  assert.equal(bill.remainingIdr, 0);
  assert.equal(bill.paid, true);
  // Nobody is paid more than the bill: tenders plus discount stay within it.
  const paid = bill.allocations.reduce((sum, row) => sum + row.amountIdr, 0);
  assert.ok(paid + bill.voucher.discountIdr <= 248_000);
});

test("a voucher is used once and a refused one changes nothing", () => {
  const { engine } = fresh();
  engine.applyVoucher(DEMO_ORDER_ID, "hemat20 ");
  // Same code on the same bill, and on another bill: refused.
  assert.equal(
    code(() => engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20")),
    "VOUCHER_ALREADY_APPLIED",
  );
  assert.deepEqual(engine.validateVoucher(DEMO_CODE_ORDER_ID, "HEMAT20"), {
    valid: false,
    code: "HEMAT20",
    reason: "already_redeemed",
  });
  const other = engine.session(DEMO_CODE_ORDER_ID).bill;
  assert.equal(
    code(() => engine.applyVoucher(DEMO_CODE_ORDER_ID, "HEMAT20")),
    "VOUCHER_REJECTED",
  );
  assert.equal(
    engine.session(DEMO_CODE_ORDER_ID).bill.totalIdr,
    other.totalIdr,
  );
  // Removing it frees the code again.
  const removed = engine.removeVoucher(DEMO_ORDER_ID).bill;
  assert.equal(removed.voucher, undefined);
  assert.equal(removed.totalIdr, 248_000);
  assert.equal(
    engine.validateVoucher(DEMO_CODE_ORDER_ID, "HEMAT20").valid,
    true,
  );
});

test("a repeated apply with the same key discounts once", () => {
  const { engine } = fresh();
  engine.applyVoucher(DEMO_ORDER_ID, "LEGEND50K", "key-1");
  const again = engine.applyVoucher(DEMO_ORDER_ID, "LEGEND50K", "key-1");
  assert.equal(again.bill.voucher.discountIdr, 50_000);
  assert.equal(again.bill.totalIdr, 198_000);
});

test("voucher rejection reasons", () => {
  const { engine } = fresh();
  const reason = (value, order = DEMO_ORDER_ID) =>
    engine.validateVoucher(order, value).reason;
  assert.equal(reason("EXPIRED1"), "expired");
  assert.equal(reason("PAKAI001"), "already_redeemed");
  assert.equal(reason("TIDAKADA"), "not_found");
  // The code order's subtotal (Rp23.000) is below the Rp150.000 minimum.
  assert.equal(reason("LEGEND50K", DEMO_CODE_ORDER_ID), "min_spend_not_met");
  assert.equal(
    code(() => engine.applyVoucher(DEMO_ORDER_ID, "EXPIRED1")),
    "VOUCHER_REJECTED",
  );
});

test("points: the balance drops by exactly what was redeemed and pays the bill", () => {
  const { engine } = fresh();
  const account = engine.pointsAccount(DEMO_ORDER_ID);
  assert.equal(account.balancePoints, 12_500);
  assert.equal(account.minRedeemPoints, 1_000);
  assert.equal(account.maxRedeemPoints, 12_500);
  assert.deepEqual(engine.quotePoints(DEMO_ORDER_ID, 5_000), {
    points: 5_000,
    valueIdr: 5_000,
  });
  // A quote spends nothing.
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 12_500);
  const bill = engine.redeemPoints(DEMO_ORDER_ID, 5_000).bill;
  assert.equal(bill.remainingIdr, 143_000);
  assert.equal(bill.allocations.at(-1).method, "points");
  assert.equal(bill.allocations.at(-1).amountIdr, 5_000);
  const next = engine.pointsAccount(DEMO_ORDER_ID);
  assert.equal(next.balancePoints, 7_500);
  assert.equal(next.maxRedeemPoints, 7_500);
  assert.equal(
    code(() => engine.redeemPoints(DEMO_ORDER_ID, 8_000)),
    "INSUFFICIENT_POINTS",
  );
  assert.equal(
    code(() => engine.redeemPoints(DEMO_ORDER_ID, 500)),
    "VALIDATION_ERROR",
  );
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 7_500);
});

test("points never pay more than the remaining bill", () => {
  const { engine } = fresh("split");
  engine.confirmCash({
    orderId: DEMO_ORDER_ID,
    amountIdr: 40_000,
    receivedIdr: 40_000,
  });
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).maxRedeemPoints, 8_000);
  assert.equal(
    code(() => engine.redeemPoints(DEMO_ORDER_ID, 9_000)),
    "VALIDATION_ERROR",
  );
  assert.equal(
    code(() => engine.quotePoints(DEMO_ORDER_ID, 9_000)),
    "VALIDATION_ERROR",
  );
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 12_500);
  const paid = engine.redeemPoints(DEMO_ORDER_ID, 8_000);
  assert.equal(paid.bill.paid, true);
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 4_500);
});

test("a repeated redeem with the same key spends the points once", () => {
  const { engine } = fresh();
  engine.redeemPoints(DEMO_ORDER_ID, 2_000, "key-1");
  const again = engine.redeemPoints(DEMO_ORDER_ID, 2_000, "key-1");
  assert.equal(again.bill.remainingIdr, 146_000);
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 10_500);
});

test("an order without a member has no points account", () => {
  const { engine } = fresh();
  assert.equal(engine.pointsAccount(DEMO_CODE_ORDER_ID), null);
  assert.equal(
    code(() => engine.redeemPoints(DEMO_CODE_ORDER_ID, 1_000)),
    "NO_MEMBER",
  );
});

test("a declined EDC payment pays nothing and does not block the bill", () => {
  const { engine, time } = fresh();
  engine.startPayment({
    orderId: DEMO_ORDER_ID,
    method: "edc",
    amountIdr: 148_000,
    terminalId: EDC_DECLINING_TERMINAL_ID,
  });
  time.now += EDC_AUTO_CONFIRM_MS + 500;
  const session = engine.session(DEMO_ORDER_ID);
  assert.equal(session.activeAttempt.status, "declined");
  assert.equal(session.activeAttempt.edc.declineReason, "Saldo tidak cukup");
  assert.equal(session.activeAttempt.edc.responseCode, "51");
  assert.equal(session.bill.paid, false);
  assert.equal(session.bill.remainingIdr, 148_000);
  assert.equal(session.bill.allocations.length, 0);
  // The cashier can pay again, here on the other terminal.
  engine.startPayment({
    orderId: DEMO_ORDER_ID,
    method: "edc",
    amountIdr: 148_000,
    terminalId: "edc-01",
  });
  time.now += EDC_AUTO_CONFIRM_MS + 500;
  assert.equal(engine.session(DEMO_ORDER_ID).bill.paid, true);
});

test("a bill with a voucher and points passes the wire contract", () => {
  const { engine } = fresh();
  engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20");
  engine.redeemPoints(DEMO_ORDER_ID, 5_000);
  const remaining = engine.rawRemainingIdr(DEMO_ORDER_ID);
  assert.equal(remaining, 113_000);
  engine.confirmCash({
    orderId: DEMO_ORDER_ID,
    amountIdr: remaining,
    receivedIdr: 120_000,
  });
  engine.printReceipt(DEMO_ORDER_ID);
  const order = engine.rawOrder(DEMO_ORDER_ID);
  const detail = pos.getPosOrder.response.parse({
    data: wire.orderDetailWire(order, engine.rawRemainingIdr(DEMO_ORDER_ID)),
  }).data;
  assert.equal(Number(detail.discountIdr), 30_000);
  assert.equal(Number(detail.totalIdr), 218_000);
  pos.issuePosReceipt.response.parse({ data: wire.receiptIssueWire(order) });
});

test("a failed apply or redeem can retry with the same key and then applies", () => {
  const { engine } = fresh();
  // A waiting EDC payment blocks the bill: the first tries are refused.
  engine.startPayment({
    orderId: DEMO_ORDER_ID,
    method: "edc",
    amountIdr: 148_000,
    terminalId: "edc-01",
  });
  assert.equal(
    code(() => engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20", "key-v")),
    "PAYMENT_IN_PROGRESS",
  );
  assert.equal(
    code(() => engine.redeemPoints(DEMO_ORDER_ID, 2_000, "key-p")),
    "PAYMENT_IN_PROGRESS",
  );
  engine.cancelAttempt({
    orderId: DEMO_ORDER_ID,
    attemptId: engine.session(DEMO_ORDER_ID).activeAttempt.id,
  });
  const voucher = engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20", "key-v");
  assert.equal(voucher.bill.voucher.discountIdr, 30_000);
  const points = engine.redeemPoints(DEMO_ORDER_ID, 2_000, "key-p");
  assert.equal(points.bill.remainingIdr, 116_000);
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 10_500);
});

test("a refused redeem for too many points does not burn its key", () => {
  const { engine } = fresh();
  assert.equal(
    code(() => engine.redeemPoints(DEMO_ORDER_ID, 20_000, "key-1")),
    "INSUFFICIENT_POINTS",
  );
  // Same key, now a valid amount: it must really spend the points.
  const session = engine.redeemPoints(DEMO_ORDER_ID, 2_000, "key-1");
  assert.equal(session.bill.remainingIdr, 146_000);
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 10_500);
});

test("a new demo seed restarts the bill with a fresh voucher and points state", () => {
  let seed = null;
  const engine = createPosKasirEngine({
    clock: () => 1_700_000_000_000,
    readSeed: () => seed,
  });
  engine.applyVoucher(DEMO_ORDER_ID, "HEMAT20", "key-1");
  engine.redeemPoints(DEMO_ORDER_ID, 5_000, "key-2");
  seed = "split";
  const bill = engine.session(DEMO_ORDER_ID).bill;
  assert.equal(bill.voucher, undefined);
  assert.equal(bill.remainingIdr, 48_000);
  assert.equal(engine.pointsAccount(DEMO_ORDER_ID).balancePoints, 12_500);
  assert.equal(engine.validateVoucher(DEMO_ORDER_ID, "HEMAT20").valid, true);
  // The old keys are forgotten too: the same key applies again.
  const again = engine.redeemPoints(DEMO_ORDER_ID, 5_000, "key-2");
  assert.equal(again.bill.remainingIdr, 43_000);
});
