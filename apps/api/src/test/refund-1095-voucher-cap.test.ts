// legend-1095 card A (legend-5g9sn): the cashier refund (`refundPosOrder`) counts the
// vouchers of the same order. Founder rule: the guest never gets back more than the
// order took in, and the outlet never loses.
//
//   refund room = paid - earlier POS refunds - issued apology/swap vouchers of the order
//                 - live ORD-09 recovery refunds
//
// Port of 3f5c50aed (pos-refund-voucher-cap.test.ts) with the lane pairs of the 1095
// brief added: both orders, two concurrent refunds, other order / other tenant.
//
// Assumptions (also reported):
// - Over the room a refund is CUT to the room and paid (min(asked, room)), as the
//   promo partial refund does. Room 0 pays nothing and answers REFUND_NOTHING_DUE
//   (CTO decision 11 Nov). The 422 for an open top-up bill and the audit of the cut
//   are NOT covered here (they need a swap top-up bill fixture).
// - CONFLICT with 3f5c50aed section 3: the old file expected a cashier refund after an
//   ORD-09 refund to be CUT to the room. Card B (one refund lane per order) governs: a
//   cashier refund on an order with a live ORD-09 refund is REFUSED. Those cases moved
//   to refund-1095-ord09-lane.test.ts. Here the voucher cap is tested without ORD-09.
// - A voucher issued AFTER a refund (refund first, voucher second) is the apology
//   voucher cap of legend-eajpb, out of scope for 1095: left as it.todo, not asserted.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-voucher-cap.test.ts" heavy pnpm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  KOPI_PAID,
  ORDER_PAID,
  SWAP_VOUCHER,
  errorText,
  otherTenant,
  sum,
  createPosWorld,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let p: PosWorld;

beforeAll(async () => {
  p = await createPosWorld();
}, 120_000);

afterAll(async () => {
  await p.teardown();
});

describe("legend-5g9sn voucher then cashier refund: voucher + refund <= paid", () => {
  it("swap voucher 20.000, refund of the whole order (49.665): cut to 29.665", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("swap voucher 20.000, partial refund 10.000 (below the room): paid in full", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 10_000),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([10_000]);
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("two refunds in a row, 20.000 then 20.000: the second is cut to the room 9.665", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const first = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 20_000),
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const second = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 20_000),
    );
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([
      20_000,
      ORDER_PAID - SWAP_VOUCHER - 20_000,
    ]);
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("staff apology voucher 20.000 for the kopi, refund of the whole order: 29.665", async () => {
    const paid = await p.paidPlainOrder();
    const apology = await p.apologyVoucherFor(paid.kopiLine, 20_000);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID - 20_000]);
    await p.expectWithinPaid(paid.orderId, [apology]);
  });

  it("line refund of the kopi after a 20.000 apology voucher for the kopi: refund 8.875 (28.875 - 20.000)", async () => {
    const paid = await p.paidPlainOrder();
    const apology = await p.apologyVoucherFor(paid.kopiLine, 20_000);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, KOPI_PAID, [
        { itemId: paid.kopiLine, quantity: 1 },
      ]),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([KOPI_PAID - 20_000]);
    await p.expectWithinPaid(paid.orderId, [apology]);
  });

  it("vouchers that use up the whole paid amount: the refund pays nothing (REFUND_NOTHING_DUE)", async () => {
    const paid = await p.paidPlainOrder();
    const issues = [
      await p.apologyVoucherFor(paid.kopiLine, KOPI_PAID),
      await p.apologyVoucherFor(paid.rotiLine, 20_790),
    ];
    expect(await p.voucherTotal(issues)).toBe(ORDER_PAID);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    if (!outcome.ok)
      expect(errorText(outcome.error)).toMatch(/REFUND_NOTHING_DUE/);
    expect(sum(await p.posRefundRows(paid.orderId))).toBe(0);
    await p.expectWithinPaid(paid.orderId, issues);
  });
});

describe("legend-5g9sn cashier refund then voucher", () => {
  it("refund first: a voucher issued AFTER a partial refund keeps refund + voucher <= paid", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const refund = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 10_000),
    );
    expect(refund.ok, JSON.stringify(refund)).toBe(true);

    const apology = await p.apologyVoucherFor(paid.kopiLine, 20_000);
    // 10.000 + 20.000 is inside 49.665 whatever the order of events.
    await p.expectWithinPaid(paid.orderId, [apology]);
    // The voucher counts for the next refund: room is 49.665 - 10.000 - 20.000.
    const next = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(sum(await p.posRefundRows(paid.orderId))).toBe(
      ORDER_PAID - 20_000,
    );
    await p.expectWithinPaid(paid.orderId, [apology]);
  });

  // legend-eajpb (apology voucher capped by the paid value) is out of scope for 1095.
  // A full refund followed by a voucher, or a voucher racing a full refund, would pay
  // out more than was paid until eajpb lands; reported, not asserted here.
  it.todo(
    "legend-eajpb (out of scope): full refund first, then an apology voucher is refused",
  );
  it.todo(
    "legend-eajpb (out of scope): voucher and full refund racing never exceed paid",
  );
});

describe("legend-5g9sn concurrent cashier refunds", () => {
  it("two refunds of the whole order with different keys at the same time: together at most paid - voucher", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const [a, b] = await Promise.all([
      p.posRefund(paid.orderId, await p.refundInput(paid.orderId, ORDER_PAID)),
      p.posRefund(paid.orderId, await p.refundInput(paid.orderId, ORDER_PAID)),
    ]);
    expect([a.ok, b.ok].some(Boolean), "at least one refund goes through").toBe(
      true,
    );
    expect(sum(await p.posRefundRows(paid.orderId))).toBe(
      ORDER_PAID - SWAP_VOUCHER,
    );
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("the same refund (same key) sent twice at the same time: one refund row", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const input = await p.refundInput(paid.orderId, ORDER_PAID);
    await Promise.all([
      p.posRefund(paid.orderId, input),
      p.posRefund(paid.orderId, input),
    ]);
    expect(sum(await p.posRefundRows(paid.orderId))).toBe(
      ORDER_PAID - SWAP_VOUCHER,
    );
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("the same refund sent again later is not paid twice", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);

    const input = await p.refundInput(paid.orderId, ORDER_PAID);
    expect((await p.posRefund(paid.orderId, input)).ok).toBe(true);
    expect((await p.posRefund(paid.orderId, input)).ok).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });
});

describe("legend-5g9sn no voucher, nothing changes; other orders and tenants are untouched", () => {
  it("no voucher: the whole order is refunded in full (49.665)", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);
  });

  it("a voucher on ANOTHER order does not reduce the room of this order", async () => {
    const other = await p.paidPlainOrder();
    await p.apologyVoucherFor(other.kopiLine, 20_000);
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);
  });

  it("a refund of order B does not use up the room of order A (both have a voucher)", async () => {
    const a = await p.paidPlainOrder();
    const b = await p.paidPlainOrder();
    const issueA = await p.apologyVoucherFor(a.kopiLine, 20_000);
    const issueB = await p.apologyVoucherFor(b.kopiLine, 10_000);
    await p.becomePosSale(a);
    await p.becomePosSale(b);

    expect(
      (await p.posRefund(b.orderId, await p.refundInput(b.orderId, ORDER_PAID)))
        .ok,
    ).toBe(true);
    expect(
      (await p.posRefund(a.orderId, await p.refundInput(a.orderId, ORDER_PAID)))
        .ok,
    ).toBe(true);
    expect(await p.posRefundRows(b.orderId)).toEqual([ORDER_PAID - 10_000]);
    expect(await p.posRefundRows(a.orderId)).toEqual([ORDER_PAID - 20_000]);
    await p.expectWithinPaid(a.orderId, [issueA]);
    await p.expectWithinPaid(b.orderId, [issueB]);
  });

  it("another tenant cannot refund our order: no refund row, our room is intact", async () => {
    const paid = await p.paidPlainOrder();
    const swapIssue = await p.swapKopiToAir(paid);
    await p.becomePosSale(paid);
    const other = await otherTenant();

    const foreign = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 10_000),
      other.tenantId,
    );
    expect(foreign.ok, "another tenant cannot refund our order").toBe(false);
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);

    const own = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(own.ok, JSON.stringify(own)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await p.expectWithinPaid(paid.orderId, [swapIssue]);
  });
});
