// Guest order status, bill, split and recovery domain logic (beads legend-woz,
// legend-tz1). Acceptance IDs: ORD-06, ORD-07, ORD-08, ORD-10, ORD-11; PRD v1.7
// §3 "QR Order Pelanggan". Plain Node ESM, no bundler.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as sample from "../packages/shared/src/qr-order/sample.ts";
import * as domain from "../apps/web/src/features/ws03-qr-order/domain.ts";

const bill = qr.qrOrderFixtures.sessionBills[0];
const items = bill.orders.flatMap((order) => order.items);
const ids = items.map((entry) => entry.id);
const lines = items.map((entry) => ({
  orderItemId: entry.id,
  lineTotalIdr: entry.lineTotalIdr,
}));
const sum = (values) => values.reduce((total, value) => total + value, 0);

describe("order status per item (PRD Status Pesanan)", () => {
  test("ORD-07 item status maps to received, preparing, ready, delivered", () => {
    assert.equal(domain.itemStep("queued"), "received");
    assert.equal(domain.itemStep("in_progress"), "preparing");
    assert.equal(domain.itemStep("ready"), "ready");
    assert.equal(domain.itemStep("served"), "delivered");
    assert.equal(domain.itemStep("voided"), null);
  });

  test("ORD-07 an order is as far along as its least advanced live item", () => {
    const mixed = [
      { status: "served" },
      { status: "in_progress" },
      { status: "voided" },
    ];
    assert.equal(domain.orderProgress(mixed), "preparing");
    assert.equal(domain.orderProgress([{ status: "voided" }]), null);
  });

  test("ORD-02 a held pay-first order reads awaiting payment, not queued", () => {
    assert.equal(
      domain.orderPhase({ status: "awaiting_payment", items: [] }),
      "awaiting_payment",
    );
    assert.equal(
      domain.orderPhase({ status: "sent", items: [{ status: "ready" }] }),
      "ready",
    );
    assert.equal(
      domain.orderPhase({ status: "completed", items: [] }),
      "completed",
    );
  });
});

describe("split bill exactness (ORD-06)", () => {
  test("ORD-06 equal parts sum exactly to the total, remainder included", () => {
    for (const total of [bill.totals.totalIdr, 100_001, 99_999])
      for (const parts of [2, 3, 7]) {
        const shown = domain.previewEqualSplit(total, parts);
        assert.equal(shown.length, parts);
        assert.equal(sum(shown), total);
        assert.ok(Math.max(...shown) - Math.min(...shown) <= 1);
      }
  });

  test("ORD-06 per-item parts sum exactly to the total", () => {
    const half = Math.ceil(ids.length / 2);
    const assignments = [
      { orderItemIds: ids.slice(0, half) },
      { orderItemIds: ids.slice(half) },
    ];
    const shown = domain.previewItemSplit(
      bill.totals.totalIdr,
      lines,
      assignments,
    );
    assert.equal(shown.length, 2);
    assert.equal(sum(shown), bill.totals.totalIdr);
  });

  test("ORD-06 a by-item split needs every item exactly once", () => {
    assert.deepEqual(
      domain.unassignedItems(ids, [{ orderItemIds: ids.slice(0, 2) }]),
      ids.slice(2),
    );
    assert.deepEqual(domain.unassignedItems(ids, [{ orderItemIds: ids }]), []);
    assert.equal(
      domain.hasDuplicateAssignment([
        { orderItemIds: [ids[0]] },
        { orderItemIds: [ids[0], ids[1]] },
      ]),
      true,
    );
  });

  test("ORD-06 the draft error names the first problem", () => {
    const base = {
      parts: 3,
      participantCount: 3,
      itemIds: ids,
      assignments: [],
    };
    assert.equal(domain.splitDraftError({ ...base, mode: "equal" }), null);
    assert.equal(
      domain.splitDraftError({ ...base, mode: "equal", parts: 1 }),
      "TOO_FEW_PARTS",
    );
    assert.equal(
      domain.splitDraftError({ ...base, mode: "equal", parts: 51 }),
      "TOO_MANY_PARTS",
    );
    assert.equal(
      domain.splitDraftError({
        ...base,
        mode: "by_person",
        participantCount: 1,
      }),
      "TOO_FEW_PARTS",
    );
    assert.equal(
      domain.splitDraftError({
        ...base,
        mode: "by_item",
        assignments: [{ orderItemIds: ids.slice(0, 1) }, { orderItemIds: [] }],
      }),
      "ITEMS_UNASSIGNED",
    );
    assert.equal(
      domain.splitDraftError({
        ...base,
        mode: "by_item",
        assignments: [{ orderItemIds: ids }, { orderItemIds: [ids[0]] }],
      }),
      "ITEM_TWICE",
    );
    assert.equal(
      domain.splitDraftError({
        ...base,
        mode: "by_item",
        assignments: [
          { orderItemIds: ids.slice(0, 1) },
          { orderItemIds: ids.slice(1) },
        ],
      }),
      null,
    );
  });

  test("ORD-06 the guest's pending share excludes paid parts", () => {
    const [paid, pending] = bill.splits;
    assert.equal(
      domain.myPendingShare(bill.splits, pending.participantId)?.amountIdr,
      pending.amountIdr,
    );
    assert.equal(domain.myPendingShare(bill.splits, paid.participantId), null);
    assert.equal(domain.myPendingShare(bill.splits, null), null);
  });

  test("ORD-10 splitting needs an open session with something left to pay", () => {
    const open = { sessionStatus: "open", outstandingIdr: 1000 };
    assert.equal(domain.canSplitBill(open), true);
    assert.equal(domain.canSplitBill({ ...open, outstandingIdr: 0 }), false);
    for (const sessionStatus of ["closed", "voided", "pending_confirmation"])
      assert.equal(domain.canSplitBill({ ...open, sessionStatus }), false);
  });

  test("minimum spend shortfall is the gap to the zone minimum, never negative", () => {
    assert.equal(
      domain.minimumSpendShortfall(500_000, 300_000, 20_000),
      220_000,
    );
    assert.equal(domain.minimumSpendShortfall(500_000, 600_000, 0), 0);
    assert.equal(domain.minimumSpendShortfall(0, 0, 0), 0);
  });

  test("guests are numbered by join order", () => {
    assert.equal(domain.guestNumber(["a", "b", "c"], "b"), 2);
  });
});

describe("point claim window (PRD Klaim Poin per Orang, 24 h)", () => {
  const deadline = "2026-11-02T05:10:00.000Z";
  test("an available claim past its deadline reads as expired", () => {
    const claim = { status: "available", claimableUntil: deadline };
    assert.equal(
      domain.effectiveClaimStatus(claim, Date.parse(deadline) - 1),
      "available",
    );
    assert.equal(
      domain.effectiveClaimStatus(claim, Date.parse(deadline)),
      "expired",
    );
  });

  test("claimed and unavailable stay as the server says", () => {
    for (const status of ["claimed", "unavailable"])
      assert.equal(
        domain.effectiveClaimStatus(
          { status, claimableUntil: deadline },
          Date.parse(deadline) + 1,
        ),
        status,
      );
  });
});

describe("failed-item recovery and review (ORD-08)", () => {
  test("ORD-08 only an open issue is actionable, only swap or voucher are offered", () => {
    const [open, resolved] = qr.qrOrderFixtures.orderIssues;
    assert.equal(domain.isIssueActionable(open), true);
    assert.equal(domain.isIssueActionable(resolved), false);
    assert.deepEqual(domain.CUSTOMER_CHOICES, ["swap", "voucher"]);
  });

  test("ORD-08 the guest issue view carries no cost and no refund option", () => {
    const issue = sample.guestOrderIssueFixtures[0];
    assert.equal("costIdr" in issue, false);
    assert.deepEqual(Object.keys(issue.options).sort(), ["swap", "voucher"]);
  });

  test("ORD-08 the swap price difference reads as pay, credit or even", () => {
    assert.deepEqual(domain.priceDifference(35_000, 25_000), {
      kind: "credit",
      amountIdr: 10_000,
    });
    assert.deepEqual(domain.priceDifference(25_000, 35_000), {
      kind: "pay",
      amountIdr: 10_000,
    });
    assert.deepEqual(domain.priceDifference(25_000, 25_000), {
      kind: "even",
      amountIdr: 0,
    });
  });

  test("a Google review is prompted from 4 stars", () => {
    assert.equal(domain.promptsGoogleReview(3), false);
    assert.equal(domain.promptsGoogleReview(4), true);
    assert.equal(domain.promptsGoogleReview(5), true);
  });
});
