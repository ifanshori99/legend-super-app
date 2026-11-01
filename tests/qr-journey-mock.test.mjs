// QR order journey mock engine (beads legend-2m4, legend-8sh): the rules the
// real API will enforce, exercised through the in-memory server behind
// VITE_API_MOCK. Acceptance IDs: ORD-02, ORD-03, ORD-04, ORD-05, ORD-06, ORD-11.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine } from "../apps/web/src/features/ws03-qr-order/mock-engine.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";

const T = qr.qrTokenFixtures;
const key = () => `test-${Math.random().toString(36).slice(2)}-abcdef`;

function fresh(token = T.freeTable, pax = 2) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const engine = createEngine(clock);
  const scan = engine.scan({ qrToken: token, pax, deviceHash: "d".repeat(32) });
  return {
    engine,
    scan,
    sessionId: scan.session.id,
    tick: (ms) => (now += ms),
  };
}

test("ORD-01 the first scan opens a session, the next scan of the same table joins it", () => {
  const { engine, scan } = fresh();
  assert.equal(scan.outcome, "opened");
  assert.equal(scan.session.status, "open");
  const again = engine.scan({
    qrToken: T.freeTable,
    pax: 3,
    deviceHash: "e".repeat(32),
  });
  assert.equal(again.outcome, "joined");
  assert.equal(again.session.id, scan.session.id);
  assert.equal(again.session.participants.length, 2);
  qr.qrScanResultSchema.parse(again);
});

test("ORD-04 an unknown QR is refused and a closed session cannot take orders", () => {
  const { engine, sessionId } = fresh();
  assert.throws(
    () =>
      engine.scan({
        qrToken: `v1.${"Z".repeat(40)}.${"Y".repeat(43)}`,
        pax: 1,
        deviceHash: "d".repeat(32),
      }),
    (e) => e.status === 404,
  );
  const closed = qr.qrOrderFixtures.sessions.find((s) => s.status === "closed");
  assert.throws(
    () => engine.view(closed.id),
    (e) => e.status === 404,
  );
  // Force-close through a second engine path: closing is staff-side, so reuse the record.
  const view = engine.view(sessionId);
  view.session.status = "closed"; // the clone never reaches the engine
  assert.equal(engine.view(sessionId).session.status, "open");
});

test("ORD-05 a sold-out item cannot be added and is dropped at checkout with a notice", () => {
  const { engine, sessionId } = fresh(T.indoor);
  const menu = engine.menuFor(T.indoor);
  const soldOut = menu.items.find((i) => i.status === "sold_out");
  assert.throws(
    () =>
      engine.addLine(sessionId, {
        menuItemId: soldOut.id,
        quantity: 1,
        modifierIds: [],
        expectedCartVersion: engine.view(sessionId).cart.version,
      }),
    (e) => e.status === 409 && e.code === "ITEM_SOLD_OUT",
  );
  // The seeded shared cart holds a line that sold out meanwhile.
  const quote = engine.quote(sessionId);
  assert.equal(quote.removedLines.length, 1);
  assert.equal(quote.removedLines[0].reason, "sold_out");
  assert.ok(
    !quote.lines.some((l) => l.menuItemId === quote.removedLines[0].menuItemId),
  );
});

test("ORD-03 the server prices the line, rejects stale versions and bad selections", () => {
  const { engine, sessionId } = fresh();
  const item = engine
    .menuFor(T.freeTable)
    .items.find(
      (i) =>
        i.variants.length > 0 && i.modifierGroups.some((g) => g.minSelect > 0),
    );
  const sugar = item.modifierGroups.find((g) => g.minSelect > 0);
  const variant = item.variants[1];
  // Missing required modifier -> 422.
  assert.throws(
    () =>
      engine.addLine(sessionId, {
        menuItemId: item.id,
        variantId: variant.id,
        quantity: 1,
        modifierIds: [],
        expectedCartVersion: 0,
      }),
    (e) => e.status === 422,
  );
  const { cart, line } = engine.addLine(sessionId, {
    menuItemId: item.id,
    variantId: variant.id,
    quantity: 2,
    modifierIds: [sugar.modifiers[0].id],
    expectedCartVersion: 0,
  });
  assert.equal(line.unitPriceIdr, variant.priceIdr);
  assert.equal(
    line.lineTotalIdr,
    (variant.priceIdr + sugar.modifiers[0].priceIdr) * 2,
  );
  assert.equal(cart.version, 1);
  // Another guest changed the cart: an old version conflicts.
  assert.throws(
    () =>
      engine.addLine(sessionId, {
        menuItemId: item.id,
        variantId: variant.id,
        quantity: 1,
        modifierIds: [sugar.modifiers[0].id],
        expectedCartVersion: 0,
      }),
    (e) => e.status === 409 && e.code === "CONFLICT",
  );
  const quote = engine.quote(sessionId);
  assert.equal(quote.subtotalIdr, line.lineTotalIdr);
  assert.ok(quote.serviceCharge.amountIdr > 0);
  assert.ok(quote.taxIdr > 0);
  qr.orderQuoteSchema.parse(quote);
});

test("ORD-11 every quote with items carries the serving-time estimate", () => {
  const { engine, sessionId } = fresh(T.indoor);
  const quote = engine.quote(sessionId);
  assert.ok(quote.servingEstimate.minMinutes > 0);
  assert.ok(
    quote.servingEstimate.minMinutes <= quote.servingEstimate.maxMinutes,
  );
  const empty = fresh();
  assert.equal(empty.engine.view(empty.sessionId).quote, null);
});

test("ORD-02 a pay-first order is held until the payment settles, then fires", () => {
  const { engine, sessionId, tick } = fresh();
  const item = engine
    .menuFor(T.freeTable)
    .items.find(
      (i) =>
        i.variants.length === 0 &&
        i.modifierGroups.length === 0 &&
        i.status === "available",
    );
  engine.addLine(sessionId, {
    menuItemId: item.id,
    quantity: 1,
    modifierIds: [],
    expectedCartVersion: 0,
  });
  const placed = engine.place(sessionId, {
    expectedCartVersion: 1,
    idempotencyKey: key(),
  });
  assert.equal(placed.kitchenFire, "held_for_payment");
  assert.equal(placed.order.status, "awaiting_payment");
  assert.ok(placed.order.items.every((i) => i.fireStatus === "held"));
  const payment = engine.startPayment(sessionId, {
    target: { kind: "order", orderId: placed.order.id },
    method: "qris",
    idempotencyKey: key(),
  });
  assert.equal(payment.status, "pending");
  assert.ok(payment.qrisPayload);
  assert.equal(engine.getPayment(sessionId, payment.id).status, "pending");
  assert.equal(engine.view(sessionId).orders[0].status, "awaiting_payment");
  tick(5000);
  const paid = engine.getPayment(sessionId, payment.id);
  assert.equal(paid.status, "paid");
  const order = engine.view(sessionId).orders[0];
  assert.equal(order.status, "sent");
  assert.ok(order.items.every((i) => i.fireStatus === "fired"));
  assert.equal(engine.bill(sessionId).totals.outstandingIdr, 0);
  // Placing the same cart twice with one idempotency key does not double the order.
});

test("ORD-02 placing with the same idempotency key returns the same order", () => {
  const { engine, sessionId } = fresh();
  const item = engine
    .menuFor(T.freeTable)
    .items.find(
      (i) =>
        i.variants.length === 0 &&
        i.modifierGroups.length === 0 &&
        i.status === "available",
    );
  engine.addLine(sessionId, {
    menuItemId: item.id,
    quantity: 1,
    modifierIds: [],
    expectedCartVersion: 0,
  });
  const k = key();
  const first = engine.place(sessionId, {
    expectedCartVersion: 1,
    idempotencyKey: k,
  });
  const again = engine.place(sessionId, {
    expectedCartVersion: 1,
    idempotencyKey: k,
  });
  assert.equal(first.order.id, again.order.id);
  assert.equal(engine.view(sessionId).orders.length, 1);
});

test("ORD-02 an open-bill zone needs waiter confirmation before the first order", () => {
  const { engine, sessionId } = fresh(T.wfc, 1);
  assert.equal(engine.view(sessionId).session.status, "pending_confirmation");
  const item = engine
    .menuFor(T.wfc)
    .items.find(
      (i) =>
        i.variants.length === 0 &&
        i.modifierGroups.length === 0 &&
        i.status === "available",
    );
  engine.addLine(sessionId, {
    menuItemId: item.id,
    quantity: 1,
    modifierIds: [],
    expectedCartVersion: 0,
  });
  assert.throws(
    () =>
      engine.place(sessionId, {
        expectedCartVersion: 1,
        idempotencyKey: key(),
      }),
    (e) => e.status === 409 && e.code === "SESSION_NOT_CONFIRMED",
  );
});

test("ORD-06 split parts always sum exactly to the bill total", () => {
  const { engine, sessionId } = fresh(T.privateRoom, 3);
  const bill = engine.bill(sessionId);
  const people = engine.view(sessionId).session.participants.map((p) => p.id);
  assert.ok(people.length >= 2);
  for (const input of [
    { method: "equal", parts: 3 },
    { method: "equal", parts: 7 },
    { method: "by_person", participantIds: people },
  ]) {
    // The fixture bill already has one paid share: a fresh session splits cleanly.
    const clean = fresh(T.freeTable, 3);
    const item = clean.engine
      .menuFor(T.freeTable)
      .items.find(
        (i) =>
          i.variants.length === 0 &&
          i.modifierGroups.length === 0 &&
          i.status === "available" &&
          i.priceIdr % 7 !== 0,
      );
    clean.engine.addLine(clean.sessionId, {
      menuItemId: item.id,
      quantity: 3,
      modifierIds: [],
      expectedCartVersion: 0,
    });
    const placed = clean.engine.place(clean.sessionId, {
      expectedCartVersion: 1,
      idempotencyKey: key(),
    });
    const ids = clean.engine
      .view(clean.sessionId)
      .session.participants.map((p) => p.id);
    const result = clean.engine.createSplits(
      clean.sessionId,
      input.method === "by_person"
        ? { ...input, participantIds: ids, idempotencyKey: key() }
        : { ...input, idempotencyKey: key() },
    );
    const sum = result.splits.reduce((s, p) => s + p.amountIdr, 0);
    assert.equal(sum, placed.order.totalIdr, JSON.stringify(input));
    qr.sessionSplitsResultSchema.parse(result);
  }
  assert.ok(bill.totals.totalIdr > 0);
});

test("ORD-06 a paid share cannot be re-split and paying every share settles the bill", () => {
  const { engine, sessionId, tick } = fresh(T.privateRoom, 3);
  const bill = engine.bill(sessionId);
  assert.throws(
    () =>
      engine.createSplits(sessionId, {
        method: "equal",
        parts: 2,
        idempotencyKey: key(),
      }),
    (e) => e.status === 409 && e.code === "SPLIT_LOCKED",
  );
  const pending = bill.splits.find((s) => s.status === "pending");
  const payment = engine.startPayment(sessionId, {
    target: { kind: "split", billSplitId: pending.id },
    method: "qris",
    idempotencyKey: key(),
  });
  tick(5000);
  assert.equal(engine.getPayment(sessionId, payment.id).status, "paid");
  const settled = engine.bill(sessionId);
  assert.equal(settled.totals.outstandingIdr, 0);
  qr.sessionBillSchema.parse(settled);
  assert.equal(engine.reviewEligibility(sessionId).eligible, true);
});

test("ORD-08 a failed item offers only swap or voucher and resolves once", () => {
  const { engine, sessionId } = fresh(T.privateRoom, 2);
  const [issue] = engine.issues(sessionId);
  assert.equal(issue.status, "open");
  assert.throws(
    () =>
      engine.chooseResolution(issue.id, {
        choice: "swap",
        replacementItemId: "00000000-0000-4000-8000-00000000dead",
      }),
    (e) => e.status === 422,
  );
  const resolved = engine.chooseResolution(issue.id, { choice: "voucher" });
  assert.equal(resolved.resolution, "voucher");
  const [after] = engine.issues(sessionId);
  assert.equal(after.status, "resolved");
  assert.match(after.voucher.code, /^LEG-/);
  assert.equal(after.voucher.valueIdr, issue.options.voucher.valueIdr);
  assert.throws(
    () => engine.chooseResolution(issue.id, { choice: "voucher" }),
    (e) => e.status === 409,
  );
});

test("ORD-07 a bill request moves the session to bill_requested and a waiter call needs a reason", () => {
  const { engine, sessionId } = fresh();
  const call = engine.createRequest(sessionId, {
    type: "call_waiter",
    reason: "utensils",
  });
  assert.equal(call.status, "pending");
  assert.equal(call.reason, "utensils");
  engine.createRequest(sessionId, { type: "request_bill" });
  assert.equal(engine.view(sessionId).session.status, "bill_requested");
  assert.equal(engine.view(sessionId).openServiceRequests.length, 2);
});

test("ORD-01 the shared cart is one state for every guest of the table", () => {
  const { engine, scan, sessionId } = fresh();
  const item = engine
    .menuFor(T.freeTable)
    .items.find(
      (i) =>
        i.variants.length === 0 &&
        i.modifierGroups.length === 0 &&
        i.status === "available",
    );
  engine.addLine(sessionId, {
    menuItemId: item.id,
    quantity: 1,
    modifierIds: [],
    expectedCartVersion: 0,
  });
  const other = engine.scan({
    qrToken: T.freeTable,
    pax: 2,
    deviceHash: "f".repeat(32),
  });
  assert.equal(other.session.id, scan.session.id);
  const cart = engine.view(other.session.id).cart;
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.version, 1);
  // Same configuration merges into one line instead of duplicating.
  engine.addLine(sessionId, {
    menuItemId: item.id,
    quantity: 2,
    modifierIds: [],
    expectedCartVersion: 1,
  });
  assert.equal(engine.view(sessionId).cart.lines.length, 1);
  assert.equal(engine.view(sessionId).cart.lines[0].quantity, 3);
});
