// POS kasir mock engine (bead legend-mjmm): the arithmetic behind remaining,
// change and cash variance, the payment rules (unknown EDC locks the bill,
// expired QRIS is replaced), the blind count and override rules, and that every
// typed mock response passes its shared contract schema. Loaded with plain Node
// ESM and built-in type stripping like the other root suites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  DEMO_ORDER_ID,
  DEMO_ORDER_ULID,
  DEMO_SHIFT_ID,
} from "../apps/web/src/features/ws04-pos-kasir/demo-seed.ts";
import {
  cashChangeIdr,
  cashVarianceIdr,
  countedTotalIdr,
  createPosKasirEngine,
  depositSurplusIdr,
  expectedCashIdr,
  remainingIdr,
} from "../apps/web/src/features/ws04-pos-kasir/mock-engine.ts";
import {
  MOCK_SUPERVISOR_ID,
  MOCK_SUPERVISOR_PIN,
} from "../apps/web/src/features/ws04-pos-kasir/fixtures.ts";
import * as wire from "../apps/web/src/features/ws04-pos-kasir/mock-wire.ts";
import * as pos from "../packages/shared/src/pos/index.ts";
import * as override from "../packages/shared/src/access/override.ts";

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

test("remaining, deposit surplus, change and cash variance", () => {
  assert.equal(remainingIdr(248_000, 100_000, 0), 148_000);
  assert.equal(remainingIdr(248_000, 100_000, 100_000), 48_000);
  // A deposit above the bill is used up to the total; the rest is balance (Q7).
  assert.equal(remainingIdr(80_000, 100_000, 0), 0);
  assert.equal(depositSurplusIdr(80_000, 100_000), 20_000);
  assert.equal(cashChangeIdr(50_000, 48_000), 2_000);
  const shift = {
    openingFloatIdr: 500_000,
    cashSalesIdr: 1_850_000,
    cashRefundsIdr: 50_000,
    cashInIdr: 100_000,
    cashOutIdr: 150_000,
    cashDropIdr: 0,
  };
  assert.equal(expectedCashIdr(shift), 2_250_000);
  assert.equal(cashVarianceIdr(2_230_000, 2_250_000), -20_000);
  assert.equal(
    countedTotalIdr(
      [
        { denominationIdr: 100_000, quantity: 18 },
        { denominationIdr: 50_000, quantity: 6 },
        { denominationIdr: 20_000, quantity: 5 },
        { denominationIdr: 10_000, quantity: 2 },
        { denominationIdr: 5_000, quantity: 2 },
      ],
      0,
    ),
    2_230_000,
  );
});

test("split QRIS then cash Rp48.000 with Rp50.000 received pays the bill", () => {
  const { engine } = fresh("split");
  const before = engine.session(DEMO_ORDER_ID);
  assert.equal(before.bill.remainingIdr, 48_000);
  assert.equal(before.bill.allocations[0].method, "qris");
  assert.equal(
    code(() =>
      engine.confirmCash({
        orderId: DEMO_ORDER_ID,
        amountIdr: 48_000,
        receivedIdr: 40_000,
      }),
    ),
    "VALIDATION_ERROR",
  );
  const after = engine.confirmCash({
    orderId: DEMO_ORDER_ID,
    amountIdr: 48_000,
    receivedIdr: 50_000,
  });
  assert.equal(after.bill.paid, true);
  assert.deepEqual(after.cash, { receivedIdr: 50_000, changeIdr: 2_000 });
  assert.equal(after.receiptNo, "POS01-000048");
  assert.equal(
    code(() =>
      engine.confirmCash({
        orderId: DEMO_ORDER_ID,
        amountIdr: 1,
        receivedIdr: 1,
      }),
    ),
    "ALREADY_PAID",
  );
});

test("an unknown EDC result blocks every other payment until it is checked", () => {
  const { engine } = fresh("edc-tidak-pasti");
  const session = engine.session(DEMO_ORDER_ID);
  assert.equal(session.activeAttempt.status, "unknown");
  const attemptId = session.activeAttempt.id;
  const startEdc = () =>
    engine.startPayment({
      orderId: DEMO_ORDER_ID,
      method: "edc",
      amountIdr: 148_000,
      terminalId: "edc-01",
    });
  assert.equal(code(startEdc), "STATUS_UNKNOWN");
  assert.equal(
    code(() =>
      engine.confirmCash({
        orderId: DEMO_ORDER_ID,
        amountIdr: 148_000,
        receivedIdr: 150_000,
      }),
    ),
    "STATUS_UNKNOWN",
  );
  assert.equal(
    code(() => engine.cancelAttempt({ orderId: DEMO_ORDER_ID, attemptId })),
    "STATUS_UNKNOWN",
  );
  const paid = engine.checkStatus({ orderId: DEMO_ORDER_ID, attemptId });
  assert.equal(paid.bill.paid, true);
  assert.equal(paid.activeAttempt.bankRef, "736214805192");
});

test("X1 manual EDC records from the slip alone, no supervisor override", () => {
  const { engine } = fresh();
  const input = {
    orderId: DEMO_ORDER_ID,
    terminalId: "edc-01",
    bankRef: "736214805192",
  };
  assert.equal(
    code(() => engine.recordEdcStandalone({ ...input, bankRef: "12" })),
    "VALIDATION_ERROR",
  );
  const session = engine.recordEdcStandalone(input);
  assert.equal(session.bill.paid, true);
  assert.equal(session.activeAttempt.standalone, true);
  assert.equal(
    code(() => engine.recordEdcStandalone(input)),
    "ALREADY_PAID",
  );
});

test("EDC standalone spends an override the till still sends", () => {
  const { engine } = fresh();
  const input = {
    orderId: DEMO_ORDER_ID,
    terminalId: "edc-01",
    bankRef: "736214805192",
    overrideId: "01JC0VER000000000000000099",
  };
  assert.equal(
    code(() => engine.recordEdcStandalone(input)),
    "OVERRIDE_INVALID",
  );
  const { overrideId } = engine.requestOverride({
    action: "edc_standalone",
    valueIdr: 148_000,
    reason: "Koneksi ECR terputus",
    objectType: "order",
    objectId: DEMO_ORDER_ID,
    approverUserId: MOCK_SUPERVISOR_ID,
    pin: MOCK_SUPERVISOR_PIN,
  });
  assert.equal(
    code(() =>
      engine.recordEdcStandalone({ ...input, overrideId, bankRef: "12" }),
    ),
    "VALIDATION_ERROR",
  );
  const session = engine.recordEdcStandalone({ ...input, overrideId });
  assert.equal(session.bill.paid, true);
  assert.equal(session.activeAttempt.standalone, true);
  // The override is single-use.
  assert.equal(
    code(() => engine.recordEdcStandalone({ ...input, overrideId })),
    "ALREADY_PAID",
  );
});

test("an expired QRIS is replaced by a new waiting one", () => {
  const { engine, time } = fresh();
  const started = engine.startPayment({
    orderId: DEMO_ORDER_ID,
    method: "qris",
    amountIdr: 148_000,
  });
  const attemptId = started.activeAttempt.id;
  assert.equal(started.activeAttempt.status, "waiting");
  assert.equal(
    code(() => engine.refreshQris({ orderId: DEMO_ORDER_ID, attemptId })),
    "QRIS_STILL_ACTIVE",
  );
  time.now += 11 * 60_000;
  const expired = engine.session(DEMO_ORDER_ID);
  assert.equal(expired.activeAttempt.status, "expired");
  const renewed = engine.refreshQris({ orderId: DEMO_ORDER_ID, attemptId });
  assert.equal(renewed.activeAttempt.status, "waiting");
  assert.notEqual(renewed.activeAttempt.id, attemptId);
  const confirmed = engine.checkStatus({
    orderId: DEMO_ORDER_ID,
    attemptId: renewed.activeAttempt.id,
  });
  assert.equal(confirmed.bill.paid, true);
});

test("blind count: the cashier gets no system figure; supervisor approves with an override", () => {
  const { engine } = fresh();
  engine.openShift({ openingFloatIdr: 500_000 });
  const shift = engine.activeShift();
  assert.equal(shift.id, DEMO_SHIFT_ID);
  assert.equal("expectedIdr" in shift, false);
  assert.equal("varianceIdr" in shift, false);
  assert.equal(
    code(() => engine.shiftReview(shift.id)),
    "COUNT_NOT_SUBMITTED",
  );
  assert.equal(
    code(() =>
      engine.recordCashMovement({
        shiftId: shift.id,
        type: "cash_out",
        amountIdr: 10_000,
        reasonNote: "ab",
      }),
    ),
    "VALIDATION_ERROR",
  );
  const receipt = engine.submitBlindCount({
    shiftId: shift.id,
    counts: [{ denominationIdr: 100_000, quantity: 4 }],
    otherAmountIdr: 80_000,
  });
  assert.deepEqual(Object.keys(receipt).sort(), [
    "shiftId",
    "status",
    "submittedAt",
  ]);
  const review = engine.shiftReview(shift.id);
  assert.equal(review.countedIdr, 480_000);
  assert.equal(review.expectedIdr, 500_000);
  assert.equal(review.varianceIdr, -20_000);
  const ask = (pin) =>
    engine.requestOverride({
      action: "cash_shift_close",
      valueIdr: 20_000,
      reason: "Tutup shift",
      objectType: "cash_shift",
      objectId: shift.id,
      approverUserId: MOCK_SUPERVISOR_ID,
      pin,
    });
  assert.equal(
    code(() => ask("000000")),
    "PIN_INVALID",
  );
  const { overrideId } = ask(MOCK_SUPERVISOR_PIN);
  assert.equal(
    code(() =>
      engine.approveShiftClose({ shiftId: shift.id, overrideId, reason: "" }),
    ),
    "VALIDATION_ERROR",
  );
  const closed = engine.approveShiftClose({
    shiftId: shift.id,
    overrideId,
    reason: "Uang kembalian berlebih",
  });
  assert.equal(closed.status, "closed");
  assert.equal(closed.varianceNote, "Uang kembalian berlebih");
  assert.equal(engine.activeShift(), null);
});

test("a supervisor PIN locks after five wrong tries", () => {
  const { engine } = fresh();
  const ask = (pin) =>
    engine.requestOverride({
      action: "discount",
      valueIdr: 1000,
      reason: "Diskon manajer",
      objectType: "order",
      objectId: DEMO_ORDER_ID,
      approverUserId: MOCK_SUPERVISOR_ID,
      pin,
    });
  for (let i = 0; i < 4; i += 1)
    assert.equal(
      code(() => ask("111111")),
      "PIN_INVALID",
    );
  assert.equal(
    code(() => ask("111111")),
    "PIN_LOCKED",
  );
  assert.equal(
    code(() => ask(MOCK_SUPERVISOR_PIN)),
    "PIN_LOCKED",
  );
});

test("day close saves the recap once; the accounting queue is separate", () => {
  const { engine } = fresh();
  const open = engine.dayRecap();
  assert.equal(open.status, "open");
  assert.equal(open.cutoffTime, "04:00");
  assert.equal(open.totalSalesIdr, 12_480_000);
  const closed = engine.closeDay({ inventoryDeduction: false });
  assert.equal(closed.status, "closed");
  assert.equal(closed.result.localRecapSaved, true);
  assert.equal(closed.result.accounting, "queued");
  assert.deepEqual(
    closed.result.batches.map((b) => b.bank),
    ["BCA", "Mandiri"],
  );
  assert.equal(
    code(() => engine.closeDay({ inventoryDeduction: false })),
    "DAY_ALREADY_CLOSED",
  );
  assert.equal(fresh("hari-ditutup").engine.dayRecap().status, "closed");
});

test("every typed mock response passes its contract schema", () => {
  const { engine } = fresh("lunas");
  const order = engine.rawOrder(DEMO_ORDER_ID);
  const remaining = engine.rawRemainingIdr(DEMO_ORDER_ID);
  assert.equal(order.id, DEMO_ORDER_ID);
  pos.getPosOrder.response.parse({
    data: wire.orderDetailWire(order, remaining),
  });
  const open = fresh("split").engine;
  pos.getPosOrder.response.parse({
    data: wire.orderDetailWire(
      open.rawOrder(DEMO_ORDER_ULID),
      open.rawRemainingIdr(DEMO_ORDER_ULID),
    ),
  });
  const cash = order.tenders.find((t) => t.method === "cash");
  pos.addPosTender.response.parse({
    data: wire.tenderResultWire(order, remaining, cash),
  });
  engine.printReceipt(DEMO_ORDER_ID);
  pos.issuePosReceipt.response.parse({
    data: wire.receiptIssueWire(engine.rawOrder(DEMO_ORDER_ID)),
  });
  pos.getPosApprovalPolicy.response.parse({ data: wire.approvalPolicyWire });

  const { engine: shiftEngine } = fresh("shift-aktif");
  const shift = shiftEngine.rawShift();
  pos.getPosShift.response.parse({
    data: {
      shift: wire.shiftWire(shift),
      movements: shiftEngine
        .rawMovements(shift.id)
        .map((m) => wire.movementWire(m, shift.id)),
      receiptGaps: [],
    },
  });
  // A closed shift carries count, expectation, variance and approver.
  const review = fresh();
  review.engine.shiftReview(DEMO_SHIFT_ID);
  const { overrideId } = review.engine.requestOverride({
    action: "cash_shift_close",
    valueIdr: 20_000,
    reason: "Tutup shift",
    objectType: "cash_shift",
    objectId: DEMO_SHIFT_ID,
    approverUserId: MOCK_SUPERVISOR_ID,
    pin: MOCK_SUPERVISOR_PIN,
  });
  review.engine.approveShiftClose({
    shiftId: DEMO_SHIFT_ID,
    overrideId,
    reason: "Uang kembalian diduga berlebih",
  });
  pos.openPosShift.response.parse({
    data: wire.shiftWire(review.engine.rawShift()),
  });

  pos.getEndOfDayRecap.response.parse({
    data: wire.recapWire(fresh().engine.dayRecap()),
  });
  pos.closePosDay.response.parse({
    data: wire.recapWire(fresh("hari-ditutup").engine.dayRecap()),
  });
  const view = wire.overrideViewWire(
    review.engine.override("01JC0VER000000000000000001"),
  );
  assert.equal(view, null); // cash_shift_close has no contract action yet
  const discount = fresh();
  const made = discount.engine.requestOverride({
    action: "discount",
    valueIdr: 1000,
    reason: "Diskon manajer",
    objectType: "order",
    objectId: DEMO_ORDER_ID,
    approverUserId: MOCK_SUPERVISOR_ID,
    pin: MOCK_SUPERVISOR_PIN,
  });
  override.createPosOverride.response.parse({
    data: wire.overrideViewWire(discount.engine.override(made.overrideId)),
  });
});
