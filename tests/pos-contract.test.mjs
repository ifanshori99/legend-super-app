// POS contract tests (bead legend-4yp). Cites PRD v1.7 §3 F8 "POS Kasir &
// Captain Order" (Pesanan Langsung, Captain Order, Hold & Fire, Pembayaran,
// Diskon/Void/Refund, Shift Kasir, Tutup Hari, Struk & Kuitansi, Nomor Struk
// Berurutan, Customer Display), §4 E "Alur Kasir Membuka dan Menutup Shift",
// §5 "Model event untuk operasional", §6.C (`orders`, `order_items`,
// `order_events`, `receipt_sequences`, `pos_shifts`, `cash_movements`) and the
// acceptance criteria POS-02, POS-03, POS-04, POS-06, POS-07 (contract level).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as pos from "../packages/shared/src/pos/index.ts";
import * as menu from "../packages/shared/src/menu/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as api from "../packages/shared/src/api/index.ts";

const fixtures = pos.cafeLegendPosFixtures;
const parsed = pos.posFixtureSchema.parse(fixtures);
const P = pos.posFixtureIds;

const orderById = new Map(parsed.orders.map((order) => [order.id, order]));
const detailById = new Map(
  parsed.orderDetails.map((detail) => [detail.id, detail]),
);
const tendersOf = (orderId) =>
  parsed.tenders.filter((tender) => tender.orderId === orderId);

test("PRD §6 POS tables: Cafe Legend fixtures parse and reference each other", () => {
  pos.posFixtureSchema.parse(fixtures);
  assert.equal(parsed.orders.length, 6);
  assert.equal(parsed.orderDetails.length, parsed.orders.length);

  const menuItems = new Set(
    menu.cafeLegendMenuFixtures.items.map((item) => item.id),
  );
  const shiftIds = new Set(parsed.shifts.map((shift) => shift.id));
  const orderIds = new Set(parsed.orders.map((order) => order.id));

  for (const item of parsed.orderItems) {
    assert.ok(orderIds.has(item.orderId), "item belongs to an order");
    assert.ok(menuItems.has(item.menuItemId), "item references a menu item");
  }
  for (const order of parsed.orders) {
    if (order.shiftId !== null)
      assert.ok(shiftIds.has(order.shiftId), "order is billed to a shift");
    assert.ok(detailById.has(order.id), "order has a cashier-screen detail");
  }
  for (const receipt of parsed.receipts)
    assert.ok(orderIds.has(receipt.orderId), "receipt belongs to an order");
  for (const detail of parsed.orderDetails) {
    for (const item of detail.items)
      assert.equal(item.orderId, detail.id, "detail lines match the order");
    for (const tender of detail.tenders)
      assert.equal(tender.orderId, detail.id, "detail tenders match the order");
  }
  // Two terminals, two sequences, different prefixes (POS-06).
  assert.equal(
    new Set(parsed.receiptSequences.map((row) => row.prefix)).size,
    2,
  );
  // One open shift per terminal, the morning one closed with a variance.
  assert.equal(parsed.shifts.filter((row) => row.status === "open").length, 1);
  assert.ok(parsed.shifts.some((row) => (row.varianceIdr ?? 0) !== 0));
});

test("POS-06: receipt numbers are gapless per outlet and device, and a void keeps its number", () => {
  const sequence = parsed.receiptSequences[0];
  assert.equal(sequence.prefix, "CLB-P1");
  assert.equal(sequence.lastNumber, 3);

  // Every ordinal 1..lastNumber exists exactly once, voided included.
  pos.assertGaplessReceipts(
    sequence,
    parsed.receipts.filter((receipt) => receipt.deviceId === sequence.deviceId),
  );
  const voided = parsed.receipts.find((receipt) => receipt.status === "voided");
  assert.ok(voided, "a voided receipt stays on record");
  assert.equal(voided.number, "CLB-P1-000003");
  assert.equal(voided.sequenceNumber, 3);
  assert.ok(voided.voidedAt && voided.voidReason && voided.voidedBy);

  // Formatting and parsing round-trip, including the hyphenated prefix.
  assert.equal(pos.formatReceiptNumber("CLB-P1", 42), "CLB-P1-000042");
  assert.deepEqual(pos.parseReceiptNumber("CLB-P1-000042"), {
    prefix: "CLB-P1",
    sequenceNumber: 42,
  });
  assert.throws(() => pos.formatReceiptNumber("clb-p1", 1), Error);
  assert.throws(() => pos.formatReceiptNumber("CLB-P1", 0), RangeError);

  // A missing ordinal is a gap, not a printing problem.
  const withoutSecond = parsed.receipts.filter(
    (receipt) => receipt.sequenceNumber !== 2,
  );
  assert.deepEqual(pos.receiptGaps(sequence, withoutSecond), [2]);
  assert.throws(
    () => pos.assertGaplessReceipts(sequence, withoutSecond),
    (error) => error.code === "RECEIPT_SEQUENCE_GAP",
  );

  // A number that does not match the device prefix is rejected.
  assert.throws(
    () =>
      pos.assertReceiptMatchesSequence(sequence, {
        number: "CLB-P2-000001",
        sequenceNumber: 1,
      }),
    (error) => error.code === "RECEIPT_PREFIX_MISMATCH",
  );

  // The next sale takes the next ordinal; the sequence row moves with it.
  const next = pos.nextReceiptNumber(sequence);
  assert.equal(next.sequenceNumber, 4);
  assert.equal(next.number, "CLB-P1-000004");
  assert.equal(next.sequence.lastNumber, 4);
  assert.equal(sequence.lastNumber, 3, "the input row is not mutated");

  // A device may not rewrite or reuse a number already issued.
  assert.throws(
    () =>
      pos.mergeDeviceReceiptSequence(sequence, {
        ...sequence,
        lastNumber: 2,
      }),
    (error) => error.code === "RECEIPT_SEQUENCE_REGRESSION",
  );
  assert.equal(
    pos.mergeDeviceReceiptSequence(sequence, sequence).lastNumber,
    3,
    "an identical replay is idempotent",
  );
});

test("POS-06: an offline device continues its own gapless run without duplicates", () => {
  const afternoon = parsed.receiptSequences[1];
  assert.equal(afternoon.prefix, "CLB-P2");
  assert.equal(afternoon.lastNumber, 0);

  // Offline on terminal 2: two sales, then the link comes back.
  const first = pos.nextReceiptNumber(afternoon);
  const second = pos.nextReceiptNumber(first.sequence);
  assert.deepEqual(
    [first.number, second.number],
    ["CLB-P2-000001", "CLB-P2-000002"],
  );

  // The cloud row was behind; the device's run moves it forward in one step.
  const merged = pos.mergeDeviceReceiptSequence(afternoon, second.sequence);
  assert.equal(merged.lastNumber, 2);
  assert.notEqual(merged.prefix, parsed.receiptSequences[0].prefix);
  assert.throws(
    () =>
      pos.mergeDeviceReceiptSequence(merged, {
        ...afternoon,
        prefix: "CLB-P1",
        lastNumber: 2,
      }),
    (error) => error.code === "RECEIPT_PREFIX_MISMATCH",
  );

  // Each device's numbers are unique in the outlet because the prefix differs.
  assert.equal(new Set([first.number, second.number, "CLB-P1-000001"]).size, 3);
});

test("POS-06: cloud receipt prefix is fixed and edge refusals have their own codes", () => {
  assert.equal(pos.CLOUD_RECEIPT_PREFIX, "C");
  assert.equal(
    pos.formatReceiptNumber(pos.CLOUD_RECEIPT_PREFIX, 1),
    "C-000001",
  );
  for (const code of [
    "RECEIPT_DEVICE_REQUIRED",
    "RECEIPT_SEQUENCE_NOT_PROVISIONED",
    "RECEIPT_VOID_UNMATCHED",
    "RECEIPT_DEVICE_ON_EDGE",
  ]) {
    assert.equal(pos.POS_ERROR_CODES.includes(code), true);
    assert.equal(new pos.PosError(code).code, code);
  }
});

test("POS-04: final orders are immutable and corrections are linked records", () => {
  // The explicit status machine has no path out of completed or voided.
  assert.equal(pos.transitionPosOrder("draft", "submit"), "awaiting_payment");
  assert.equal(pos.transitionPosOrder("awaiting_payment", "fire"), "sent");
  assert.equal(pos.transitionPosOrder("sent", "complete"), "completed");
  assert.equal(pos.transitionPosOrder("sent", "void"), "voided");
  assert.equal(pos.isFinalPosOrder("completed"), true);
  assert.equal(pos.isFinalPosOrder("voided"), true);
  for (const action of ["submit", "fire", "complete", "void"])
    assert.equal(pos.canTransitionPosOrder("completed", action), false);
  assert.throws(
    () => pos.transitionPosOrder("completed", "void"),
    (error) => error.code === "ORDER_TRANSITION_INVALID",
  );

  // Every mutating service checks this first: a final sale is history.
  assert.throws(
    () => pos.assertPosOrderMutable({ status: "completed" }),
    (error) => error.code === "ORDER_FINAL_IMMUTABLE",
  );
  assert.throws(
    () => pos.assertPosOrderMutable({ status: "voided" }),
    (error) => error.code === "ORDER_FINAL_IMMUTABLE",
  );
  pos.assertPosOrderMutable({ status: "sent" });

  // A correction only targets a completed sale, and only as a new record.
  pos.assertCorrectionTargetsFinalOrder({ status: "completed" });
  assert.throws(
    () => pos.assertCorrectionTargetsFinalOrder({ status: "sent" }),
    (error) => error.code === "CORRECTION_TARGET_NOT_FINAL",
  );
  const voidRecord = parsed.voids[0];
  pos.posVoidSchema.parse(voidRecord);
  assert.equal(voidRecord.orderId, P.orders.corrected);
  assert.equal(orderById.get(voidRecord.orderId).status, "completed");
  assert.equal(
    voidRecord.receiptNumber,
    "CLB-P1-000003",
    "the voided sale keeps its receipt number (POS-06)",
  );
  assert.equal(
    pos.posVoidSchema.safeParse({ ...voidRecord, receiptNumber: undefined })
      .success,
    false,
  );
  assert.equal(
    pos.posVoidSchema.safeParse({
      ...voidRecord,
      approvedBy: voidRecord.requestedBy,
    }).success,
    false,
    "the approver is a different actor from the requester (§3.7)",
  );

  // The refund is linked to the same sale it reduces, bounded by what was paid.
  const refund = parsed.refunds[0];
  pos.posRefundSchema.parse(refund);
  const sale = orderById.get(refund.orderId);
  assert.equal(
    pos.refundableIdr(sale.totalIdr, refund.amountIdr),
    Number(sale.totalIdr) - Number(refund.amountIdr),
  );
  assert.throws(
    () =>
      pos.assertRefundWithinPaid(
        sale.totalIdr,
        refund.amountIdr,
        sale.totalIdr,
      ),
    (error) => error.code === "REFUND_EXCEEDS_PAID",
  );
  assert.equal(
    pos.posRefundSchema.safeParse({
      ...refund,
      lines: [{ method: "qris", amountIdr: 1_000, reference: null }],
    }).success,
    false,
    "refund lines must sum to the refund amount",
  );

  // Voiding straight from the draft is allowed and has no submittedAt.
  const cancelledDraft = {
    ...orderById.get(P.orders.cancelled),
    status: "voided",
    submittedAt: null,
    firedAt: null,
    completedAt: null,
    voidedAt: "2026-11-01T11:30:00.000Z",
    voidReason: "customer_cancelled",
    voidReasonNote: "Tamu membatalkan sebelum pesanan dikirim",
    voidApprovedBy: P.staff.supervisor,
    voidApprovalRequestId: P.approvals.orderVoid,
  };
  pos.posOrderSchema.parse(cancelledDraft);

  // There is no delete operation for an order anywhere in the contract.
  const endpoints = Object.values(pos).filter(
    (value) => value && typeof value === "object" && "method" in value,
  );
  assert.equal(
    endpoints.some(
      (endpoint) =>
        endpoint.method === "DELETE" &&
        /\/orders\/:orderId$/.test(endpoint.path),
    ),
    false,
    "POS-04: an order is corrected, never deleted",
  );
});

test("POS-03: shift close is a blind count and the approved variance is locked", () => {
  // The client submits denominations only: no expected/counted/variance field
  // can be sent, because the object is strict.
  const counts = [{ denominationIdr: 100_000, quantity: 5 }];
  const validCount = { counts, idempotencyKey: "count-shift-eve-0001" };
  assert.equal(
    pos.submitPosShiftCountInputSchema.safeParse(validCount).success,
    true,
  );
  for (const forbidden of ["expectedIdr", "countedIdr", "varianceIdr"]) {
    assert.equal(
      pos.submitPosShiftCountInputSchema.safeParse({
        ...validCount,
        [forbidden]: 0,
      }).success,
      false,
      `${forbidden} is never client input (POS-03)`,
    );
  }
  assert.equal(
    pos.submitPosShiftCountInputSchema.safeParse({ ...validCount, counts: [] })
      .success,
    false,
  );

  // The close names a stored count; the numbers can no longer ride along.
  const validClose = {
    countId: P.shiftCounts.morningSecond,
    varianceNote: null,
    approvedBy: P.staff.supervisor,
    approvalRequestId: P.approvals.shiftClose,
    idempotencyKey: "close-shift-eve-0001",
  };
  assert.equal(
    pos.closePosShiftInputSchema.safeParse(validClose).success,
    true,
  );
  for (const forbidden of [
    "expectedIdr",
    "countedIdr",
    "varianceIdr",
    "counts",
  ]) {
    assert.equal(
      pos.closePosShiftInputSchema.safeParse({
        ...validClose,
        [forbidden]: forbidden === "counts" ? counts : 0,
      }).success,
      false,
      `${forbidden} is never close input (POS-03)`,
    );
  }
  assert.equal(
    pos.closePosShiftInputSchema.safeParse({ ...validClose, countId: "x" })
      .success,
    false,
  );

  // legend-6c0: the close names the PIN override by its ULID, or by a uuid in
  // any shape (the stored `ulidToUuid` form is not an RFC uuid).
  const pinOverrideUlid = "01JD5Z8X3K9Q2M7R4T6V8W0YAB";
  const nonRfcUuid = "019b3c5e-0000-0000-0000-00000000abcd";
  for (const id of [pinOverrideUlid, nonRfcUuid]) {
    assert.equal(
      pos.closePosShiftInputSchema.safeParse({
        ...validClose,
        approvalRequestId: id,
      }).success,
      true,
      `close accepts ${id}`,
    );
  }
  assert.equal(
    pos.closePosShiftInputSchema.safeParse({
      ...validClose,
      approvalRequestId: "abc",
    }).success,
    false,
  );

  // U9 force close, step two: it names the supervisor's forced count (step one
  // is the normal count submission); the numbers can no longer ride along.
  const validForce = {
    countId: P.shiftCounts.morningSecond,
    note: "Kasir gagal hitung 3 kali",
    approvedBy: P.staff.supervisor,
    approvalRequestId: P.approvals.shiftClose,
    idempotencyKey: "force-close-0001",
  };
  assert.equal(
    pos.forceClosePosShiftInputSchema.safeParse(validForce).success,
    true,
  );
  for (const id of [pinOverrideUlid, nonRfcUuid])
    assert.equal(
      pos.forceClosePosShiftInputSchema.safeParse({
        ...validForce,
        approvalRequestId: id,
      }).success,
      true,
      `force close accepts ${id}`,
    );
  assert.equal(
    pos.forceClosePosShiftInputSchema.safeParse({
      ...validForce,
      approvalRequestId: "abc",
    }).success,
    false,
  );
  for (const [label, patch] of [
    ["a short note", { note: "terlalu" }],
    ["no count", { countId: undefined }],
    ["no witness", { approvedBy: undefined }],
    ["no approval", { approvalRequestId: undefined }],
    ["a counted total", { countedIdr: 0 }],
    ["denominations", { counts }],
    ["a system variance", { varianceIdr: 0 }],
  ]) {
    assert.equal(
      pos.forceClosePosShiftInputSchema.safeParse({ ...validForce, ...patch })
        .success,
      false,
      `force close refuses ${label}`,
    );
  }
  assert.equal(pos.forceClosePosShift.method, "POST");
  assert.equal(
    pos.forceClosePosShift.path,
    "/api/outlets/:outletId/pos/shifts/:shiftId/force-close",
  );

  // The blind receipt carries no expected figure and no variance.
  const receipt = {
    id: P.shiftCounts.morningSecond,
    shiftId: P.shifts.morning,
    sequence: 2,
    countedIdr: 530_100,
    noteRequired: true,
    submittedAt: "2026-11-01T09:55:00.000Z",
  };
  assert.equal(pos.posShiftCountReceiptSchema.safeParse(receipt).success, true);
  for (const leak of ["expectedIdr", "varianceIdr"]) {
    assert.equal(
      pos.posShiftCountReceiptSchema.safeParse({ ...receipt, [leak]: 0 })
        .success,
      false,
      `${leak} never reaches the cashier`,
    );
  }
  // Supervisor view: variance is counted − expected.
  assert.equal(parsed.shiftCounts.length, 2);
  assert.equal(
    pos.posShiftCountSchema.safeParse({
      ...parsed.shiftCounts[1],
      varianceIdr: 0,
    }).success,
    true,
    "schema shape only; the DB check enforces variance = counted − expected",
  );
  assert.equal(
    pos.posShiftCountSchema.safeParse({
      ...parsed.shiftCounts[1],
      counts: [],
    }).success,
    false,
  );
  assert.equal(
    pos.posShiftCountSchema.safeParse({
      ...parsed.shiftCounts[1],
      counts: [
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 50_000, quantity: 2 },
      ],
    }).success,
    false,
  );
  assert.equal(parsed.shifts[0].countId, parsed.shiftCounts[1].id);
  assert.equal(parsed.shifts[1].countId, null);
  assert.equal(
    pos.posShiftSchema.safeParse({ ...parsed.shifts[0], countId: null })
      .success,
    false,
    "a closed shift names the count it used",
  );
  assert.equal(
    pos.posShiftSchema.safeParse({
      ...parsed.shifts[1],
      countId: P.shiftCounts.morningFirst,
    }).success,
    false,
    "an open shift has no count",
  );
  assert.equal(pos.posErrorHttpStatus.SHIFT_COUNT_STALE, 409);
  assert.equal(pos.posErrorHttpStatus.SHIFT_COUNT_SUPERSEDED, 409);
  assert.equal(pos.posErrorHttpStatus.SHIFT_COUNT_LIMIT, 409);

  assert.equal(
    pos.blindCountTotalIdr([
      { denominationIdr: 100_000, quantity: 4 },
      { denominationIdr: 50_000, quantity: 2 },
      { denominationIdr: 1_000, quantity: 3 },
    ]),
    503_000,
  );
  assert.throws(() => pos.blindCountTotalIdr([]), RangeError);

  // Q8: the count is per Rupiah denomination, each at most once.
  assert.equal(pos.IDR_CASH_DENOMINATIONS.length, 10);
  assert.equal(
    pos.submitPosShiftCountInputSchema.safeParse({
      ...validCount,
      counts: [{ denominationIdr: 75_000, quantity: 1 }],
    }).success,
    false,
    "75.000 is not a note",
  );
  assert.equal(
    pos.submitPosShiftCountInputSchema.safeParse({
      ...validCount,
      counts: [
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 50_000, quantity: 2 },
      ],
    }).success,
    false,
    "a denomination is counted once",
  );
  assert.throws(
    () => pos.blindCountTotalIdr([{ denominationIdr: 75_000, quantity: 1 }]),
    RangeError,
  );
  assert.throws(
    () =>
      pos.blindCountTotalIdr([
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 50_000, quantity: 2 },
      ]),
    RangeError,
  );

  // The closed morning shift: expected comes from the drawer maths, never from
  // the cashier, and the difference is explained and approved.
  const closed = parsed.shifts[0];
  assert.equal(
    pos.shiftExpectedCashIdr(closed),
    535_100,
    "500.000 float + 187.500 cash sales − 77.400 refunds + 50.000 in − 25.000 out − 100.000 drop",
  );
  assert.equal(closed.countedIdr, 530_100);
  assert.equal(closed.varianceIdr, -5_000);
  assert.ok(closed.varianceNote);
  assert.ok(closed.approvedBy);

  // Once approved, the variance is locked: no edit, no second close.
  const openShift = parsed.shifts[1];
  const closedNow = pos.closeShift(openShift, {
    counts,
    countId: P.shiftCounts.morningFirst,
    varianceNote: null,
    approvedBy: P.staff.supervisor,
    approvalRequestId: P.approvals.shiftClose,
    approvedAt: "2026-11-01T15:00:00.000Z",
    closedAt: "2026-11-01T15:00:00.000Z",
  });
  assert.equal(closedNow.status, "closed");
  assert.equal(closedNow.countedIdr, 500_000);
  assert.equal(closedNow.expectedIdr, 500_000);
  assert.equal(closedNow.varianceIdr, 0);
  // The transition produces a row the stored schema accepts.
  pos.posShiftSchema.parse(closedNow);
  assert.throws(
    () =>
      pos.closeShift(closedNow, {
        counts,
        countId: P.shiftCounts.morningFirst,
        varianceNote: null,
        approvedBy: P.staff.supervisor,
        approvalRequestId: P.approvals.shiftClose,
        approvedAt: "2026-11-01T15:05:00.000Z",
        closedAt: "2026-11-01T15:05:00.000Z",
      }),
    (error) => error.code === "SHIFT_ALREADY_CLOSED",
  );
  assert.throws(
    () => pos.assertShiftCountEditable(closedNow),
    (error) => error.code === "SHIFT_VARIANCE_LOCKED",
  );

  // A difference cannot be closed without an explanation (U9).
  assert.throws(
    () =>
      pos.closeShift(openShift, {
        counts: [{ denominationIdr: 100_000, quantity: 4 }],
        countId: P.shiftCounts.morningFirst,
        varianceNote: null,
        approvedBy: P.staff.supervisor,
        approvalRequestId: P.approvals.shiftClose,
        approvedAt: "2026-11-01T15:00:00.000Z",
        closedAt: "2026-11-01T15:00:00.000Z",
      }),
    (error) => error.code === "SHIFT_VARIANCE_NOTE_REQUIRED",
  );

  // The stored row cannot lie about its own figures.
  assert.equal(
    pos.posShiftSchema.safeParse({ ...closed, countedIdr: 500_000 }).success,
    false,
    "the variance must follow the count",
  );
  assert.equal(
    pos.posShiftSchema.safeParse({ ...closed, expectedIdr: 500_000 }).success,
    false,
    "the drawer expectation must follow the cash movements",
  );
  assert.equal(
    pos.posShiftSchema.safeParse({ ...closed, approvedBy: null }).success,
    false,
    "a closed shift always carries supervisor approval",
  );

  // Cash only moves during an open shift.
  pos.assertCashMovementAllowed(openShift);
  assert.throws(
    () => pos.assertCashMovementAllowed(closed),
    (error) => error.code === "SHIFT_NOT_OPEN",
  );
  assert.ok(
    parsed.cashMovements.every((row) => row.shiftId === closed.id),
    "the morning shift's cash movements",
  );
});

test("POS-02: manual discounts above the threshold and every void/refund need approval", () => {
  const thresholdBp = parsed.approvalPolicy.discountThresholdBp;
  assert.equal(thresholdBp, 1_000);
  assert.equal(
    pos.requiresDiscountApproval({
      source: "manual",
      amountIdr: 10_000,
      subtotalIdr: 49_000,
      thresholdBp,
    }),
    true,
    "Rp10.000 of Rp49.000 is above 10%",
  );
  assert.equal(
    pos.requiresDiscountApproval({
      source: "manual",
      amountIdr: 4_900,
      subtotalIdr: 49_000,
      thresholdBp,
    }),
    false,
    "exactly 10% is not above the threshold",
  );
  assert.equal(
    pos.requiresDiscountApproval({
      source: "promo",
      amountIdr: 20_000,
      subtotalIdr: 49_000,
      thresholdBp,
    }),
    false,
    "promo engine and member discounts are already configured",
  );
  assert.throws(
    () =>
      pos.assertDiscountApproved({
        source: "manual",
        amountIdr: 10_000,
        subtotalIdr: 49_000,
        thresholdBp,
        approvalRequestId: null,
      }),
    (error) => error.code === "DISCOUNT_APPROVAL_REQUIRED",
  );
  pos.assertDiscountApproved({
    source: "manual",
    amountIdr: 10_000,
    subtotalIdr: 49_000,
    thresholdBp,
    approvalRequestId: P.approvals.discount,
  });

  const discount = parsed.discounts[0];
  pos.posDiscountSchema.parse(discount);
  assert.ok(discount.approvedBy && discount.approvalRequestId);
  assert.ok(discount.reasonNote);
  assert.equal(
    pos.posDiscountSchema.safeParse({ ...discount, reasonNote: null }).success,
    false,
    "a manual discount records its written reason",
  );

  // Every void carries the verified supervisor approval, on the item and on the
  // order; a voided item without approval cannot be stored.
  const voidedItem = parsed.orderItems.find((item) => item.status === "voided");
  assert.ok(voidedItem.voidApprovedBy && voidedItem.voidApprovalRequestId);
  assert.throws(
    () => pos.assertVoidApproved({ approvalRequestId: null, approvedBy: null }),
    (error) => error.code === "VOID_APPROVAL_REQUIRED",
  );
  assert.equal(
    pos.posOrderItemSchema.safeParse({
      ...voidedItem,
      voidApprovedBy: null,
    }).success,
    false,
  );

  // Refunds need approval too, and a standard reason plus written note.
  assert.throws(
    () =>
      pos.assertRefundApproved({ approvalRequestId: null, approvedBy: null }),
    (error) => error.code === "REFUND_APPROVAL_REQUIRED",
  );
  assert.ok(parsed.refunds[0].reasonNote.length >= 4);

  // The request schema enforces the same rules before the API sees it.
  const manualDiscountBody = {
    source: "manual",
    kind: "percent",
    percentBp: 2_000,
    reason: "manager_goodwill",
    reasonNote: "Komplain pelanggan",
    idempotencyKey: "discount-body-0001",
  };
  assert.equal(
    pos.applyPosDiscount.body.safeParse(manualDiscountBody).success,
    true,
  );
  assert.equal(
    pos.applyPosDiscount.body.safeParse({
      ...manualDiscountBody,
      reasonNote: undefined,
    }).success,
    false,
  );
  assert.equal(
    pos.applyPosDiscount.body.safeParse({
      ...manualDiscountBody,
      approvedBy: P.staff.supervisor,
    }).success,
    false,
    "approval carries both the approver and the request id",
  );
});

test("F8 tenders: cash change, multi-tender coverage and refund allocation are server-computed", () => {
  // Cash: the client sends what it received; the amount applied is derived.
  assert.deepEqual(pos.planCashTender(110_100, 115_000), {
    amountIdr: 110_100,
    receivedIdr: 115_000,
    changeIdr: 4_900,
  });
  assert.deepEqual(pos.planCashTender(120_100, 120_100), {
    amountIdr: 120_100,
    receivedIdr: 120_100,
    changeIdr: 0,
  });
  assert.deepEqual(pos.planCashTender(120_100, 50_000), {
    amountIdr: 50_000,
    receivedIdr: 50_000,
    changeIdr: 0,
  });

  // Online money always points at the WS-05 intent that holds it.
  const qrisTender = parsed.tenders.find((row) => row.method === "qris");
  assert.ok(
    qrisTender.paymentIntentId,
    "a QRIS tender links its payment intent",
  );
  assert.equal(
    pos.posTenderSchema.safeParse({ ...qrisTender, paymentIntentId: null })
      .success,
    false,
  );

  const cashOrderTenders = tendersOf(P.orders.cashDineIn);
  const summary = pos.summarizeTenders(cashOrderTenders);
  assert.equal(summary.totalIdr, 120_100);
  assert.deepEqual(summary.byBucket, {
    cash: 110_100,
    gateway: 0,
    edc: 0,
    points: 10_000,
  });
  assert.equal(summary.changeIdr, 4_900);
  pos.assertTenderCoverage(120_100, cashOrderTenders);
  assert.throws(
    () => pos.assertTenderCoverage(120_100, cashOrderTenders.slice(1)),
    (error) => error.code === "TENDER_TOTAL_MISMATCH",
  );
  assert.equal(pos.remainingDueIdr(120_100, cashOrderTenders), 0);

  // A partial refund goes back over the original methods and sums exactly
  // (ORD-06 identity via core allocateIdr).
  const allocation = pos.refundAllocation(cashOrderTenders, 30_000);
  assert.equal(
    allocation.reduce((sum, line) => sum + line.amountIdr, 0),
    30_000,
  );
  assert.deepEqual(allocation.map((line) => line.method).sort(), [
    "cash",
    "points",
  ]);
  assert.throws(() => pos.refundAllocation([], 1_000), RangeError);

  // A split payment still in progress is valid; an overpaid or underpaid
  // completed sale is not.
  const partial = {
    ...parsed.orderDetails[3],
    tenders: [
      {
        ...parsed.tenders[1],
        orderId: parsed.orderDetails[3].id,
        amountIdr: 20_000,
        receivedIdr: 20_000,
        changeIdr: 0,
      },
    ],
  };
  pos.posOrderDetailSchema.parse(partial);
  assert.equal(
    pos.posOrderDetailSchema.safeParse({
      ...parsed.orderDetails[0],
      tenders: [],
    }).success,
    false,
    "a completed sale is paid in full",
  );
  assert.equal(
    pos.posOrderDetailSchema.safeParse({
      ...parsed.orderDetails[0],
      tenders: [
        ...parsed.orderDetails[0].tenders,
        {
          ...parsed.tenders[3],
          amountIdr: 200_000,
          receivedIdr: 200_000,
          changeIdr: 0,
        },
      ],
    }).success,
    false,
    "tenders never exceed the bill",
  );
  // legend-9pz9: the applied DP settles part of the bill. A completed sale
  // fully covered by the DP has no tender; DP plus full tenders overpays.
  const completed = parsed.orderDetails[0];
  assert.equal(pos.posOrderDetailSchema.parse(completed).depositAppliedIdr, 0);
  pos.posOrderDetailSchema.parse({
    ...completed,
    depositAppliedIdr: completed.totalIdr,
    tenders: [],
  });
  for (const [label, order] of [
    ["DP plus full tenders", { ...completed, depositAppliedIdr: 1_000 }],
    [
      "DP above the total",
      { ...completed, depositAppliedIdr: completed.totalIdr + 1, tenders: [] },
    ],
  ])
    assert.equal(
      pos.posOrderDetailSchema.safeParse(order).success,
      false,
      label,
    );

  // Every fixture tender is complete and captured once.
  for (const order of parsed.orders) {
    const tenders = tendersOf(order.id).filter(
      (row) => row.status === "captured",
    );
    if (order.status === "completed")
      pos.assertTenderCoverage(order.totalIdr, tenders);
  }

  // The payment panel never receives an amount: cash sends receivedIdr only.
  const tenderBody = {
    method: "cash",
    receivedIdr: 115_000,
    expectedStatus: "awaiting_payment",
    idempotencyKey: "tender-body-0001",
  };
  assert.equal(pos.addPosTender.body.safeParse(tenderBody).success, true);
  assert.equal(
    pos.addPosTender.body.safeParse({ ...tenderBody, amountIdr: 110_100 })
      .success,
    false,
    "the applied amount is server-computed",
  );
  assert.equal(
    pos.addPosTender.body.safeParse({
      method: "cash",
      ...tenderBody,
      receivedIdr: undefined,
    }).success,
    false,
  );
  assert.equal(
    pos.addPosTender.body.safeParse({
      ...tenderBody,
      method: "qris",
    }).success,
    false,
    "only a cash tender sends receivedIdr",
  );
});

test("order item DTO: costSnapshotIdr is nullable (HPP not exposed) and never negative", () => {
  // HPP is finance data (inventory.cost.view): the POS order DTO sends null.
  const item = parsed.orderItems[0];
  const withCost = (costSnapshotIdr) =>
    pos.posOrderItemSchema.safeParse({ ...item, costSnapshotIdr });
  const ok = withCost(null);
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  assert.equal(withCost(-1).success, false, "negative HPP is rejected");
});

test("F8 hold & fire: items start held and are fired by item or course", () => {
  const draft = detailById.get(P.orders.heldDraft);
  assert.equal(draft.status, "draft");
  const held = draft.items.filter((item) => item.status !== "voided");
  assert.ok(held.length >= 2);
  for (const item of held) {
    assert.equal(item.fireStatus, "held");
    assert.equal(item.firedAt, null);
    assert.ok(item.course, "a held line belongs to a course");
  }

  // Fire status and timestamp always agree.
  const firedItem = detailById.get(P.orders.cashDineIn).items[0];
  assert.equal(firedItem.fireStatus, "fired");
  assert.ok(firedItem.firedAt);
  assert.equal(
    pos.posOrderItemSchema.safeParse({
      ...held[0],
      fireStatus: "fired",
      firedAt: null,
    }).success,
    false,
  );
  assert.equal(
    pos.posOrderItemSchema.safeParse({
      ...firedItem,
      firedAt: null,
    }).success,
    false,
  );

  // A completed order reached the kitchen: firedAt exists.
  const completed = orderById.get(P.orders.cashDineIn);
  assert.ok(completed.firedAt);
  assert.equal(
    pos.posOrderSchema.safeParse({
      ...completed,
      firedAt: null,
    }).success,
    false,
    "a completed order was fired",
  );

  // Fire request: explicit items or one course, never both and never neither.
  const base = {
    expectedStatus: "awaiting_payment",
    idempotencyKey: "fire-body-0001",
  };
  assert.equal(
    pos.firePosOrderItems.body.safeParse({
      ...base,
      itemIds: [held[0].id],
    }).success,
    true,
  );
  assert.equal(
    pos.firePosOrderItems.body.safeParse({ ...base, course: "main" }).success,
    true,
  );
  assert.equal(
    pos.firePosOrderItems.body.safeParse({
      ...base,
      itemIds: [held[0].id],
      course: "main",
    }).success,
    false,
  );
  assert.equal(pos.firePosOrderItems.body.safeParse(base).success, false);
});

test("POS-07: e-receipt and kuitansi carry outlet name, address, items, tax and method", () => {
  const receiptDoc = parsed.receiptDocuments[0];
  assert.equal(receiptDoc.outletName, "Cafe Legend Bandung");
  assert.ok(receiptDoc.outletAddress.length >= 10);
  assert.ok(receiptDoc.items.length >= 1);
  assert.ok(receiptDoc.taxLines.length >= 1);
  assert.ok(receiptDoc.tenders.length >= 1);
  assert.equal(receiptDoc.documentKind, "receipt");
  assert.equal(parsed.receiptDocuments[1].documentKind, "kuitansi");

  // The document totals are the order's amounts, not recomputed from nowhere.
  assert.equal(receiptDoc.totalIdr, 120_100);
  assert.equal(
    receiptDoc.subtotalIdr -
      receiptDoc.discountIdr +
      receiptDoc.serviceChargeIdr +
      receiptDoc.taxIdr +
      receiptDoc.roundingIdr,
    receiptDoc.totalIdr,
  );

  assert.equal(
    pos.receiptDocumentSchema.safeParse({
      ...receiptDoc,
      outletAddress: "",
    }).success,
    false,
    "the outlet address is printed (D40)",
  );
  assert.equal(
    pos.receiptDocumentSchema.safeParse({
      ...receiptDoc,
      tenders: [],
    }).success,
    false,
    "the payment method is printed (POS-07)",
  );
  assert.equal(
    pos.receiptDocumentSchema.safeParse({
      ...receiptDoc,
      taxLines: [],
    }).success,
    false,
    "a taxed order prints its tax line (POS-07)",
  );
  // Founder decision Q4 (legend-93a): a tax-free order prints with no tax row.
  assert.equal(
    pos.receiptDocumentSchema.safeParse({
      ...receiptDoc,
      taxLines: [],
      taxIdr: 0,
      totalIdr: 109_180,
      tenders: [
        receiptDoc.tenders[0],
        { ...receiptDoc.tenders[1], amountIdr: 99_180 },
      ],
    }).success,
    true,
    "a tax-free order prints without a tax row",
  );
  assert.equal(
    pos.receiptDocumentSchema.safeParse({
      ...receiptDoc,
      totalIdr: 120_000,
    }).success,
    false,
    "the printed total must match the parts",
  );

  // A voided receipt document keeps its number and status (POS-06).
  const voidedDoc = {
    ...receiptDoc,
    receiptNumber: "CLB-P1-000003",
    status: "voided",
  };
  assert.equal(pos.receiptDocumentSchema.safeParse(voidedDoc).success, true);

  // Corporate invoice: same amounts plus who is billed; NPWP stays optional.
  const invoice = parsed.invoices[0];
  pos.invoiceDocumentSchema.parse(invoice);
  assert.equal(invoice.paymentStatus, "paid");
  assert.equal(invoice.billedTo.npwp, null);
  assert.equal(
    pos.invoiceDocumentSchema.safeParse({
      ...invoice,
      billedTo: { ...invoice.billedTo, npwp: "123" },
    }).success,
    false,
  );

  // WhatsApp is not a default delivery channel (it costs money).
  assert.equal(pos.RECEIPT_DELIVERY_CHANNELS.includes("email"), true);
  assert.equal(pos.RECEIPT_DELIVERY_CHANNELS.includes("whatsapp"), false);
});

test("F8 events: POS event names are registered on the WS-04 catalog line", () => {
  const catalog = new Map(
    events.eventCatalog.map((entry) => [entry.name, entry]),
  );
  for (const name of pos.posEventNames) {
    const entry = catalog.get(name);
    assert.ok(entry, `${name} is registered in the WS-00 catalog`);
    assert.equal(entry.workstream, "WS-04");
    assert.equal(entry.aggregateType, name.split(".")[0]);
    assert.equal(entry.payloadSchemaRef, `${name}.v1`);
  }
  // The two names this bead added to the WS-04 line.
  assert.ok(catalog.has("day.closed"));
  assert.ok(catalog.has("cash_movement.recorded"));
  assert.deepEqual(
    pos.posEventCatalog.map((entry) => entry.name),
    [...pos.posEventNames],
  );

  const order = orderById.get(P.orders.cashDineIn);
  const envelope = {
    id: "01JBQ9D0A1B2C3D4E5F6G7H8K0",
    tenantId: order.tenantId,
    outletId: order.outletId,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: order.id,
    sequence: 1,
    occurredAt: "2026-11-01T03:39:00.000Z",
    actor: { type: "user", id: P.staff.cashierMorning },
    idempotencyKey: "pos-paid-0001",
    payloadSchemaRef: "order.paid.v1",
    payload: {
      orderId: order.id,
      outletId: order.outletId,
      businessDate: "2026-11-01",
      channel: "pos",
      serviceType: "dine_in",
      grossSalesIdr: 104_000,
      discountIdr: 0,
      serviceChargeIdr: 5_200,
      pbjtIdr: 10_920,
      roundingIdr: -20,
      totalIdr: 120_100,
      paidCashIdr: 110_100,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 10_000,
      tenders: [
        { method: "points", amountIdr: 10_000 },
        { method: "cash", amountIdr: 110_100 },
      ],
      shiftId: P.shifts.morning,
      cashierId: P.staff.cashierMorning,
      deviceId: P.devices.pos1,
      paidAt: "2026-11-01T03:39:00.000Z",
    },
  };
  pos.posEventSchema.parse(envelope);
  // WS-07 posts from these keys: a bucket that disagrees with the tenders is
  // rejected so a sale can never post an unbalanced journal.
  assert.equal(
    pos.posEventSchema.safeParse({
      ...envelope,
      payload: { ...envelope.payload, paidCashIdr: 0 },
    }).success,
    false,
  );
  // legend-9pz9: the reservation DP applied to the sale is its own amount,
  // not a tender. Absent means 0 (an older payload), so tenders = totalIdr.
  assert.equal(
    pos.posEvents["order.paid"].envelopeSchema.parse(envelope).payload
      .paidDepositIdr,
    0,
  );
  // Part-paid by DP: the tenders settle totalIdr - paidDepositIdr.
  const partDp = {
    ...envelope.payload,
    paidDepositIdr: 50_000,
    paidCashIdr: 60_100,
    tenders: [
      { method: "points", amountIdr: 10_000 },
      { method: "cash", amountIdr: 60_100 },
    ],
  };
  pos.posEventSchema.parse({ ...envelope, payload: partDp });
  // A DP that covers the whole total leaves no tender and still parses.
  pos.posEventSchema.parse({
    ...envelope,
    payload: {
      ...envelope.payload,
      paidDepositIdr: 120_100,
      paidCashIdr: 0,
      paidPointsIdr: 0,
      tenders: [],
    },
  });
  for (const [label, payload] of [
    // DP is not counted on top of tenders that already cover the total.
    [
      "DP on top of full tenders",
      { ...envelope.payload, paidDepositIdr: 50_000 },
    ],
    ["DP above the total", { ...envelope.payload, paidDepositIdr: 120_101 }],
    ["negative DP", { ...partDp, paidDepositIdr: -1 }],
    [
      "no tender and no DP",
      {
        ...envelope.payload,
        paidCashIdr: 0,
        paidPointsIdr: 0,
        tenders: [],
      },
    ],
  ])
    assert.equal(
      pos.posEventSchema.safeParse({ ...envelope, payload }).success,
      false,
      label,
    );
  assert.equal(
    pos.posEventSchema.safeParse({ ...envelope, name: "kitchen_ticket.bumped" })
      .success,
    false,
    "not a POS event",
  );

  pos.posEventSchema.parse({
    ...envelope,
    name: "cashier_shift.closed",
    aggregateType: "cashier_shift",
    aggregateId: parsed.shifts[0].id,
    payloadSchemaRef: "cashier_shift.closed.v1",
    payload: {
      shiftId: parsed.shifts[0].id,
      outletId: parsed.shifts[0].outletId,
      deviceId: parsed.shifts[0].deviceId,
      cashierId: parsed.shifts[0].cashierId,
      businessDate: "2026-11-01",
      openingFloatIdr: 500_000,
      cashSalesIdr: 187_500,
      cashRefundsIdr: 77_400,
      cashInIdr: 50_000,
      cashOutIdr: 25_000,
      cashDropIdr: 100_000,
      expectedIdr: 535_100,
      countedIdr: 530_100,
      differenceIdr: -5_000,
      varianceNote: parsed.shifts[0].varianceNote,
      approvedBy: P.staff.supervisor,
      approvalRequestId: P.approvals.shiftClose,
      closedAt: "2026-11-01T10:00:00.000Z",
    },
  });
  assert.equal(
    pos.posEventSchema.safeParse({
      ...envelope,
      name: "cashier_shift.closed",
      payloadSchemaRef: "cashier_shift.closed.v1",
      aggregateType: "cashier_shift",
      aggregateId: parsed.shifts[0].id,
      payload: {
        shiftId: parsed.shifts[0].id,
        outletId: parsed.shifts[0].outletId,
        deviceId: parsed.shifts[0].deviceId,
        cashierId: parsed.shifts[0].cashierId,
        businessDate: "2026-11-01",
        openingFloatIdr: 500_000,
        cashSalesIdr: 187_500,
        cashRefundsIdr: 77_400,
        cashInIdr: 50_000,
        cashOutIdr: 25_000,
        cashDropIdr: 100_000,
        expectedIdr: 535_100,
        countedIdr: 530_100,
        differenceIdr: -5_000,
        varianceNote: null,
        approvedBy: P.staff.supervisor,
        approvalRequestId: P.approvals.shiftClose,
        closedAt: "2026-11-01T10:00:00.000Z",
      },
    }).success,
    false,
    "a difference without an explanation cannot be published (U9)",
  );
});

test("F8 endpoints: paths, params and responses stay in step with the fixtures", () => {
  const endpoints = Object.values(pos).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      "method" in value &&
      "path" in value,
  );
  assert.ok(endpoints.length >= 20);
  const ids = new Set();
  for (const endpoint of endpoints) {
    assert.equal(endpoint.id, `${endpoint.method} ${endpoint.path}`);
    assert.equal(
      ids.has(endpoint.id),
      false,
      `${endpoint.id} is declared once`,
    );
    ids.add(endpoint.id);
    if (endpoint.params) {
      assert.deepEqual(
        api.pathParamNames(endpoint.path).sort(),
        Object.keys(endpoint.params.shape).sort(),
        endpoint.id,
      );
    }
    assert.equal(api.pathParamNames(endpoint.path).includes("tenantId"), false);
  }

  const respond = (endpoint, data) => endpoint.response.parse({ data });
  const summary = (detail) => {
    const items = detail.items.filter((item) => item.status !== "voided");
    return {
      id: detail.id,
      tenantId: detail.tenantId,
      outletId: detail.outletId,
      number: detail.number,
      channel: detail.channel,
      serviceType: detail.serviceType,
      tableSessionId: detail.tableSessionId,
      status: detail.status,
      shiftId: detail.shiftId,
      totalIdr: detail.totalIdr,
      itemCount: items.length,
      heldItemCount: items.filter((item) => item.fireStatus === "held").length,
      createdAt: detail.createdAt,
    };
  };

  pos.listPosOrders.response.parse({
    data: parsed.orderDetails.map(summary),
    meta: { limit: 25, nextCursor: null },
  });
  respond(pos.getPosOrder, parsed.orderDetails[0]);
  respond(pos.submitPosOrder, parsed.orderDetails[3]);
  respond(pos.completePosOrder, parsed.orderDetails[0]);
  respond(pos.firePosOrderItems, parsed.orderDetails[2]);
  respond(pos.voidPosOrder, parsed.orderDetails[4]);
  respond(pos.voidPosOrderItem, parsed.orderDetails[2]);
  pos.listPosOrderEvents.response.parse({
    data: parsed.orderEvents,
    meta: { limit: 25, nextCursor: null },
  });
  respond(pos.addPosTender, {
    order: parsed.orderDetails[5],
    tender: parsed.tenders[3],
    remainingIdr: 0,
  });
  respond(pos.applyPosDiscount, parsed.orderDetails[3]);
  respond(pos.getPosApprovalPolicy, parsed.approvalPolicy);
  respond(pos.openPosShift, parsed.shifts[1]);
  pos.listPosShifts.response.parse({
    data: parsed.shifts,
    meta: { limit: 25, nextCursor: null },
  });
  respond(pos.getPosShift, {
    shift: parsed.shifts[0],
    movements: parsed.cashMovements,
    receiptGaps: [],
  });
  respond(pos.submitPosShiftCount, {
    id: parsed.shiftCounts[1].id,
    shiftId: parsed.shiftCounts[1].shiftId,
    sequence: parsed.shiftCounts[1].sequence,
    countedIdr: parsed.shiftCounts[1].countedIdr,
    noteRequired: true,
    submittedAt: parsed.shiftCounts[1].submittedAt,
  });
  respond(pos.listPosShiftCounts, parsed.shiftCounts);
  respond(pos.closePosShift, parsed.shifts[0]);
  respond(pos.forceClosePosShift, parsed.shifts[0]);
  respond(pos.recordPosCashMovement, parsed.cashMovements[0]);
  pos.listPosCashMovements.response.parse({
    data: parsed.cashMovements,
    meta: { limit: 25, nextCursor: null },
  });
  respond(pos.getEndOfDayRecap, parsed.endOfDay);
  respond(pos.closePosDay, parsed.endOfDay);
  respond(pos.getPosReceiptDocument, parsed.receiptDocuments[0]);
  respond(pos.getPosReceiptByNumber, {
    receipt: parsed.receipts[0],
    document: parsed.receiptDocuments[0],
    deliveries: [parsed.deliveries[0]],
    link: null,
  });
  respond(pos.createPosReceiptLink, {
    receiptId: parsed.receipts[1].id,
    url: "https://app.example.com/r/8f3c1d",
    expiresAt: "2026-11-02T04:35:00.000Z",
  });
  respond(pos.createPosInvoice, parsed.invoices[0]);
  respond(pos.getCustomerDisplayState, parsed.customerDisplayState);
  respond(pos.pairCustomerDisplay, parsed.customerDisplayPairings[0]);
  respond(pos.getPosOrderActionAvailability, {
    allowed: ["fire", "complete"],
    canSettle: true,
    canCorrect: false,
  });
  respond(pos.voidPosOrderCorrection, parsed.voids[0]);
  respond(pos.refundPosOrder, parsed.refunds[0]);

  // Client input never carries the tenant, a price or a total (TEN-02, ORD-03).
  const createBody = {
    channel: "pos",
    serviceType: "dine_in",
    items: [
      {
        menuItemId: menu.cafeLegendMenuFixtures.items[0].id,
        modifierIds: [],
        quantity: 2,
      },
    ],
    idempotencyKey: "create-order-0001",
  };
  assert.equal(pos.createPosOrder.body.safeParse(createBody).success, true);
  assert.equal(
    pos.createPosOrder.body.safeParse({
      ...createBody,
      tenantId: parsed.orders[0].tenantId,
    }).success,
    false,
  );
  assert.equal(
    pos.createPosOrder.body.safeParse({
      ...createBody,
      items: [{ ...createBody.items[0], unitPriceIdr: 32_000 }],
    }).success,
    false,
    "a price is server-computed, never client input",
  );
  assert.equal(
    pos.createPosOrder.body.safeParse({
      ...createBody,
      totalIdr: 120_100,
    }).success,
    false,
  );
  assert.equal(
    pos.createPosOrder.body.safeParse({ ...createBody, items: [] }).success,
    false,
  );

  // Every write endpoint that moves an order states the status the screen
  // believes it has, so a stale tab cannot act on a newer state.
  for (const endpoint of [
    pos.submitPosOrder,
    pos.firePosOrderItems,
    pos.completePosOrder,
    pos.voidPosOrder,
    pos.addPosTender,
  ]) {
    assert.ok("expectedStatus" in endpoint.body.shape, endpoint.id);
    assert.ok("idempotencyKey" in endpoint.body.shape, endpoint.id);
  }

  // Receipts: issue defaults to print; the e-receipt adds a link.
  assert.equal(
    pos.issuePosReceipt.body.safeParse({
      idempotencyKey: "receipt-issue-0001",
    }).success,
    true,
  );
  assert.equal(
    pos.issuePosReceipt.body.safeParse({
      deliveries: ["print", "email"],
      email: "tamu@example.com",
      idempotencyKey: "receipt-issue-0002",
    }).success,
    true,
  );
  assert.equal(
    pos.getEndOfDayRecap.query.safeParse({ businessDate: "2026-11-01" })
      .success,
    true,
  );
});

test("F8 end-of-day: the recap totals reconcile with the day's orders and tenders", () => {
  const recap = parsed.endOfDay;
  assert.equal(recap.businessDate, "2026-11-01");
  assert.equal(recap.status, "open");
  assert.equal(recap.inventoryDeductionApplied, false);

  // Sales come from the completed orders that stand, by device.
  const completed = parsed.orders.filter(
    (order) => order.status === "completed",
  );
  const sales = completed.reduce(
    (sum, order) => sum + Number(order.totalIdr),
    0,
  );
  assert.equal(sales, 306_400);
  assert.equal(recap.totalSalesIdr, sales);

  const deviceOne = recap.devices.find(
    (row) => row.deviceId === P.devices.pos1,
  );
  assert.equal(deviceOne.orderCount, completed.length);
  assert.equal(deviceOne.grossSalesIdr, 270_000);
  assert.equal(deviceOne.serviceChargeIdr, 8_550);
  assert.equal(deviceOne.taxIdr, 27_855);
  assert.equal(deviceOne.roundingIdr, -5);
  assert.equal(deviceOne.totalIdr, sales);
  assert.equal(deviceOne.closed, true);
  assert.equal(deviceOne.cashVarianceIdr, parsed.shifts[0].varianceIdr);

  // Refunds and linked voids are money out, and the tender net proves it.
  const refundTotal = parsed.refunds.reduce(
    (sum, row) => sum + Number(row.amountIdr),
    0,
  );
  const voidTotal = parsed.voids.reduce(
    (sum, row) => sum + Number(row.amountIdr),
    0,
  );
  assert.equal(recap.totalRefundsIdr, refundTotal);
  assert.equal(recap.totalVoidsIdr, voidTotal);
  const tenderNet = recap.tenders.reduce(
    (sum, row) => sum + Number(row.netIdr),
    0,
  );
  assert.equal(tenderNet, sales - refundTotal - voidTotal);
  assert.equal(tenderNet, 197_100);

  // The cash drawer agrees with the recap's cash row.
  const cashRow = recap.tenders.find((row) => row.method === "cash");
  const cashTenders = parsed.tenders
    .filter(
      (tender) => tender.method === "cash" && tender.status === "captured",
    )
    .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
  assert.equal(cashTenders, 187_500);
  assert.equal(cashRow.capturedIdr, cashTenders);
  assert.equal(cashRow.refundedIdr, voidTotal);

  // A recap cannot be published with lazy maths.
  assert.equal(
    pos.endOfDayRecapSchema.safeParse({
      ...recap,
      totalSalesIdr: 300_000,
    }).success,
    false,
  );
  assert.equal(
    pos.endOfDayRecapSchema.safeParse({
      ...recap,
      status: "closed",
    }).success,
    false,
    "a closed day records who closed it and when",
  );
  const closedDay = {
    ...recap,
    status: "closed",
    closedAt: "2026-11-01T15:05:00.000Z",
    closedBy: P.staff.supervisor,
    accountingSync: {
      status: "posted",
      journalCount: 3,
      postedAt: "2026-11-01T15:06:00.000Z",
    },
  };
  pos.endOfDayRecapSchema.parse(closedDay);
  assert.equal(
    pos.endOfDayRecapSchema.safeParse({
      ...closedDay,
      accountingSync: { status: "posted", journalCount: 3, postedAt: null },
    }).success,
    false,
  );
});

test("F8 customer display: items, total and dynamic QRIS only while paying", () => {
  const state = parsed.customerDisplayState;
  assert.equal(state.state, "paid");
  assert.equal(state.totalIdr, 120_100);
  assert.equal(state.changeIdr, 4_900);
  assert.equal(state.qris, null);

  const awaiting = {
    ...state,
    state: "awaiting_payment",
    qris: {
      provider: "doit",
      amountIdr: state.totalIdr,
      payload: "00020101021226670016COM.DOIT.WWW0118",
      expiresAt: "2026-11-01T03:50:00.000Z",
    },
    tenders: [],
    // This fixture changes the paid snapshot into an unpaid invoice.
    remainingIdr: state.totalIdr,
    changeIdr: null,
  };
  pos.customerDisplayStateSchema.parse(awaiting);
  assert.equal(
    pos.customerDisplayStateSchema.safeParse({
      ...awaiting,
      qris: { ...awaiting.qris, amountIdr: 1 },
    }).success,
    false,
    "the QRIS amount is the bill total",
  );
  assert.equal(
    pos.customerDisplayStateSchema.safeParse({
      ...state,
      state: "idle",
    }).success,
    false,
    "the idle screen has no order",
  );
  assert.equal(
    pos.customerDisplayStateSchema.safeParse({
      ...state,
      tenders: [],
    }).success,
    false,
    "a paid screen shows how it was paid",
  );
  assert.equal(
    pos.pairCustomerDisplay.body.safeParse({
      code: "482913",
      idempotencyKey: "display-pair-0001",
    }).success,
    true,
  );
  assert.equal(
    pos.pairCustomerDisplay.body.safeParse({
      code: "48291",
      idempotencyKey: "display-pair-0002",
    }).success,
    false,
  );
});

// Review (legend-cyu.10): order.paid / order.refunded must always post a
// balanced WS-07 journal, points included (POS-05, ORD-09, §3.19, §3.20).
test("POS-04 order.paid and order.refunded payloads post balanced WS-07 journals (points included)", async () => {
  const accounting = await import("../packages/shared/src/accounting/index.ts");
  const journalFor = (eventName, payload) => {
    const rule = accounting.resolvePostingRule(accounting.defaultPostingRules, {
      eventName,
    });
    const map = new Map(
      rule.lines.map((line, index) => [
        line.role,
        `0190a000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      ]),
    );
    const amounts = Object.fromEntries(
      accounting.postingRuleAmountKeys(rule).map((key) => [key, payload[key]]),
    );
    return accounting.buildJournalLinesFromRule(rule, amounts, map, {
      outletId: null,
    });
  };

  const paid = {
    grossSalesIdr: 104_000,
    discountIdr: 0,
    serviceChargeIdr: 5_200,
    pbjtIdr: 10_920,
    roundingIdr: -20,
    paidCashIdr: 110_100,
    paidGatewayIntentIdr: 0,
    paidDepositIdr: 0,
    paidGatewayIdr: 0,
    paidEdcIdr: 0,
    paidPointsIdr: 10_000,
  };
  assert.ok(journalFor("order.paid", paid).length > 0);

  const refund = {
    grossSalesIdr: 52_000,
    discountIdr: 0,
    serviceChargeIdr: 2_600,
    pbjtIdr: 5_460,
    refundCashIdr: 50_060,
    refundGatewayIdr: 0,
    refundGatewayClearingIdr: 0,
    refundEdcIdr: 0,
    refundPointsIdr: 10_000,
  };
  const lines = journalFor("order.refunded", refund);
  assert.ok(lines.some((line) => line.creditIdr === 10_000));
});

test("POS-04 order.refunded rejects a revenue split that does not equal the refund amount", () => {
  const fixtureRefund = parsed.refunds[0];
  const base = {
    orderId: fixtureRefund.orderId,
    outletId: fixtureRefund.outletId,
    businessDate: "2026-11-01",
    refundId: fixtureRefund.id,
    amountIdr: 60_060,
    reason: fixtureRefund.reason,
    reasonNote: "Pelanggan komplain",
    approvedBy: fixtureRefund.approvedBy,
    approvalRequestId: fixtureRefund.approvalRequestId,
    overrideId: fixtureRefund.overrideId,
    grossSalesIdr: 52_000,
    discountIdr: 0,
    serviceChargeIdr: 2_600,
    pbjtIdr: 5_460,
    refundCashIdr: 50_060,
    refundGatewayIdr: 0,
    refundEdcIdr: 0,
    refundPointsIdr: 10_000,
    lines: [
      { method: "cash", amountIdr: 50_060 },
      { method: "points", amountIdr: 10_000 },
    ],
    refundedAt: "2026-11-01T05:00:00.000Z",
  };
  const schema = pos.orderRefundedPayloadSchema;
  const ok = schema.safeParse(base);
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  assert.equal(
    schema.safeParse({ ...base, grossSalesIdr: 40_000 }).success,
    false,
  );
});

// Founder decision (2026-11-11): the cashier discount approval threshold is
// 1..5000 bp. 0 is refused everywhere, and so is anything above 50%.
test("POS-02: posApprovalPolicySchema accepts a threshold of 1..5000 bp and refuses 0 and 5001", () => {
  const policy = (discountThresholdBp) => ({
    ...fixtures.approvalPolicy,
    discountThresholdBp,
  });
  for (const bp of [1, 5000]) {
    assert.equal(
      pos.posApprovalPolicySchema.safeParse(policy(bp)).success,
      true,
      `${bp} bp accepted`,
    );
  }
  for (const bp of [0, 5001, 10000]) {
    assert.equal(
      pos.posApprovalPolicySchema.safeParse(policy(bp)).success,
      false,
      `${bp} bp refused`,
    );
  }
});
