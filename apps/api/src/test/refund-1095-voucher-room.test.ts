// legend-1095 round legend-eajpb: an apology / swap voucher tied to a failed-item report
// must never make the money handed back for an order exceed what the guest paid.
//
//   voucher room = min(order room, line room)
//   order room   = paid - what was already given (cashier refunds, vouchers, live ORD-09)
//   room 0 (also: order voided)  -> 422 APOLOGY_VOUCHER_NOTHING_DUE
//   staff voucher above the room -> 422 APOLOGY_VOUCHER_OVER_ROOM (refused, never cut)
//   guest / system voucher       -> cut to the remaining room
//
// Written from docs/briefs/sub-1095.md (section "Ronde eajpb"), not from the services.
//
// Assumptions (also reported):
// - Exact room numbers are asserted only where the brief makes them certain: a whole
//   line refunded by items (28.875 for the kopi) leaves the roti line 20.790 and the
//   order 20.790. After an amount-only (no items) cashier refund the split of the
//   refund over lines is not specified, so those cases assert "a positive value that
//   never exceeds the order room" instead of an exact figure.
// - The message of OVER_ROOM carries the room ("maks Rp20.790"); matched without
//   pinning the thousands separator.
// - Staff voucher on a voided order: room 0, so NOTHING_DUE (void lane = 0). The edge
//   void / parked void variants of the same lane have their own fixtures and are not
//   repeated here.
// - Concurrency: a third connection holds `orders ... FOR UPDATE`; the two requests
//   are started one after the other (so the start order is deterministic), the lock
//   is released once both wait (or once one of them already finished, which can only
//   happen when the code under test does not take the order lock yet), then both are
//   awaited. The sum is asserted in both start orders and may not depend on who wins.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-voucher-room.test.ts" heavy pnpm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner } from "./floor-test-helpers.ts";
import {
  KOPI_PAID,
  ORDER_PAID,
  PROMO_PAID,
  ROTI_PAID,
  createPosWorld,
  sum,
  toUuid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let p: PosWorld;
/** A second tenant with its own identical orders (created first: see beforeAll). */
let other: PosWorld;

beforeAll(async () => {
  // createPosWorld installs process-wide ports (device resolver, receipts) for its own
  // tenant. The main world is created last so the cashier work of `p` keeps working;
  // `other` is only used through HTTP (paid order + staff voucher), never for the till.
  other = await createPosWorld();
  p = await createPosWorld();
}, 240_000);

afterAll(async () => {
  // One teardown only: it ends the process-wide test pools, shared by both worlds.
  await p.teardown();
});

type Answer = {
  status: number;
  body: { error?: { code?: string; message?: string } };
};

function expectRefused(answer: Answer, code: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(code);
}

const NOTHING_DUE = "APOLOGY_VOUCHER_NOTHING_DUE";
const OVER_ROOM = "APOLOGY_VOUCHER_OVER_ROOM";

/** Cashier refund of the kopi line only (a whole line, by items): leaves 20.790. */
async function refundKopiLine(world: PosWorld, paid: PaidOrder) {
  const outcome = await world.posRefund(
    paid.orderId,
    await world.refundInput(paid.orderId, KOPI_PAID, [
      { itemId: paid.kopiLine, quantity: 1 },
    ]),
  );
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  expect(await world.posRefundRows(paid.orderId)).toEqual([KOPI_PAID]);
}

async function refundWholeOrder(
  world: PosWorld,
  paid: PaidOrder,
  amount = ORDER_PAID,
) {
  const outcome = await world.posRefund(
    paid.orderId,
    await world.refundInput(paid.orderId, amount),
  );
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

describe("legend-eajpb cashier refund first, then a staff voucher", () => {
  it("full cashier refund: the staff voucher is refused with NOTHING_DUE and no voucher exists", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundWholeOrder(p, paid);

    const { issueId, issued } = await p.apologyVoucherRequest(
      paid.rotiLine,
      10_000,
    );
    expectRefused(issued, NOTHING_DUE);
    expect(await p.voucherValues(issueId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("partial refund: a voucher above the remaining room is refused (OVER_ROOM, not cut); exactly the room is accepted", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundKopiLine(p, paid); // room left: 49.665 - 28.875 = 20.790

    const issueId = await p.reportLine(paid.rotiLine);
    const over = await p.staffVoucher(issueId, ROTI_PAID + 1);
    expectRefused(over, OVER_ROOM);
    expect(String(over.body.error?.message)).toMatch(/20[.,]?790/);
    expect(await p.voucherValues(issueId), "refused, not cut").toEqual([]);

    const exact = await p.staffVoucher(issueId, ROTI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await p.voucherValues(issueId)).toEqual([ROTI_PAID]);
    expect(await p.returnedTotal(paid.orderId, [issueId])).toBe(ORDER_PAID);

    // Nothing is left after that: another refund pays nothing.
    const next = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 1_000),
    );
    expect(next.ok, JSON.stringify(next)).toBe(false);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("a line that is already refunded in full has no room for a voucher on that line", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundKopiLine(p, paid);

    const { issueId, issued } = await p.apologyVoucherRequest(
      paid.kopiLine,
      1_000,
    );
    expectRefused(issued, NOTHING_DUE);
    expect(await p.voucherValues(issueId)).toEqual([]);
  });

  it("amount-only partial refund of 40.000: a voucher above the 9.665 left is refused and nothing is issued", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundWholeOrder(p, paid, 40_000);

    const issueId = await p.reportLine(paid.rotiLine);
    const over = await p.staffVoucher(issueId, ORDER_PAID - 40_000 + 1);
    // Which of the two codes depends on how the amount-only refund is spread over the
    // lines (not specified): either way it is refused with 422 and nothing is issued.
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect([OVER_ROOM, NOTHING_DUE]).toContain(over.body.error?.code);
    expect(await p.voucherValues(issueId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("cloud void of the sale: the staff voucher is refused (nothing due) and no voucher exists", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const issueId = await p.reportLine(paid.rotiLine);
    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);

    const issued = await p.staffVoucher(issueId, 10_000);
    expectRefused(issued, NOTHING_DUE);
    expect(await p.voucherValues(issueId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});

describe("legend-eajpb staff voucher first, then a cashier refund", () => {
  it("voucher 20.000 for the kopi, then a refund of the whole order: refund is cut so voucher + refund <= paid", async () => {
    const paid = await p.paidPlainOrder();
    const issue = await p.apologyVoucherFor(paid.kopiLine, 20_000);
    await p.becomePosSale(paid);

    await refundWholeOrder(p, paid);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID - 20_000]);
    expect(await p.returnedTotal(paid.orderId, [issue])).toBe(ORDER_PAID);
  });

  it("voucher up to the room, then the refund of the rest: the last refund pays nothing", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundKopiLine(p, paid);
    const issueId = await p.reportLine(paid.rotiLine);
    const accepted = await p.staffVoucher(issueId, ROTI_PAID);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const rest = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ROTI_PAID, [
        { itemId: paid.rotiLine, quantity: 1 },
      ]),
    );
    expect(rest.ok, JSON.stringify(rest)).toBe(false);
    expect(await p.posRefundRows(paid.orderId)).toEqual([KOPI_PAID]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});

describe("legend-eajpb guest voucher choice", () => {
  it("after a full cashier refund the guest's voucher choice is refused with NOTHING_DUE; no voucher is issued", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundWholeOrder(p, paid);
    const issueId = await p.reportLine(paid.rotiLine);

    const chosen = await p.guestChoose(paid, issueId, { choice: "voucher" });
    expectRefused(chosen, NOTHING_DUE);
    expect(await p.voucherValues(issueId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("after a partial cashier refund the guest's voucher is cut to what is left (never refused, never above the room)", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const room = 5_000;
    await refundWholeOrder(p, paid, ORDER_PAID - room);
    const issueId = await p.reportLine(paid.rotiLine); // the voucher would be 18.000

    const chosen = await p.guestChoose(paid, issueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const [value] = await p.voucherValues(issueId);
    expect(value, "a voucher was issued").toBeGreaterThan(0);
    expect(value, "cut to the remaining room").toBeLessThanOrEqual(room);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("kopi refunded (20.790 left): the roti voucher of 18.000 fits and is issued in full", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundKopiLine(p, paid);
    const issueId = await p.reportLine(paid.rotiLine);

    const chosen = await p.guestChoose(paid, issueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(await p.voucherValues(issueId)).toEqual([18_000]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("guest swap to a cheaper item (credit voucher) after a full refund is refused with NOTHING_DUE", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundWholeOrder(p, paid);
    const issueId = await p.reportLine(paid.kopiLine);

    const chosen = await p.guestChoose(paid, issueId, {
      choice: "swap",
      replacementItemId: p.airItem,
    });
    expectRefused(chosen, NOTHING_DUE);
    expect(await p.voucherValues(issueId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("guest swap credit after a partial refund is cut to what is left", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const room = 5_000;
    await refundWholeOrder(p, paid, ORDER_PAID - room);
    const issueId = await p.reportLine(paid.kopiLine); // the credit would be 20.000

    const chosen = await p.guestChoose(paid, issueId, {
      choice: "swap",
      replacementItemId: p.airItem,
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const [value] = await p.voucherValues(issueId);
    expect(value, "a credit voucher was issued").toBeGreaterThan(0);
    expect(value, "cut to the remaining room").toBeLessThanOrEqual(room);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});

describe("legend-eajpb CRM voucher filed with the report (resolution voucher + voucherId)", () => {
  it("after a full cashier refund the report is refused (NOTHING_DUE) and no issue is stored", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundWholeOrder(p, paid);

    const voucherId = await p.crmVoucher(10_000);
    const answer = await p.reportWithVoucher(paid, paid.rotiLine, voucherId);
    expectRefused(answer, NOTHING_DUE);
    expect(await p.issueRowCount(paid.rotiLine)).toBe(0);
  });

  it("a CRM voucher above the remaining room is refused (OVER_ROOM, nothing stored); exactly the room is accepted", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    await refundKopiLine(p, paid); // room left: 20.790

    const over = await p.reportWithVoucher(
      paid,
      paid.rotiLine,
      await p.crmVoucher(ROTI_PAID + 1),
    );
    expectRefused(over, OVER_ROOM);
    expect(String(over.body.error?.message)).toMatch(/20[.,]?790/);
    expect(await p.issueRowCount(paid.rotiLine)).toBe(0);

    const exact = await p.reportWithVoucher(
      paid,
      paid.rotiLine,
      await p.crmVoucher(ROTI_PAID),
    );
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await p.issueRowCount(paid.rotiLine)).toBe(1);
  });

  it("report with a CRM voucher of 20.000 first, then a full cashier refund: refund is cut, refund + voucher <= paid", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const reported = await p.reportWithVoucher(
      paid,
      paid.kopiLine,
      await p.crmVoucher(20_000),
    );
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);

    await refundWholeOrder(p, paid);
    const refunded = sum(await p.posRefundRows(paid.orderId));
    expect(refunded + 20_000).toBeLessThanOrEqual(ORDER_PAID);
    expect(refunded).toBe(ORDER_PAID - 20_000);
  });
});

describe("legend-eajpb promo order: staff voucher then full cashier refund", () => {
  it("voucher 10.000 on the kopi, refund of the whole order without items: voucher + refunds <= paid", async () => {
    const paid = await p.paidPromoOrder();
    const issue = await p.apologyVoucherFor(paid.kopiLine, 10_000);
    await p.becomePosSale(paid, PROMO_PAID);

    // A refusal is acceptable for a promo order; paying out above the paid amount is not.
    await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, PROMO_PAID),
    );
    await p.expectWithinPaid(paid.orderId, [issue], PROMO_PAID);
  });

  it("voucher 10.000 on the kopi, refund of every line by items: voucher + refunds <= paid", async () => {
    const paid = await p.paidPromoOrder();
    const issue = await p.apologyVoucherFor(paid.kopiLine, 10_000);
    await p.becomePosSale(paid, PROMO_PAID);

    await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, PROMO_PAID, [
        { itemId: paid.kopiLine, quantity: 1 },
        { itemId: paid.tehLine, quantity: 1 },
        { itemId: paid.rotiLine, quantity: 1 },
      ]),
    );
    await p.expectWithinPaid(paid.orderId, [issue], PROMO_PAID);
  });
});

// ---- concurrency ------------------------------------------------------------------

async function lockWaiters(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
}

/**
 * Holds `orders ... FOR UPDATE` on its own connection, starts the requests one after
 * the other, waits until each one is blocked on the lock (or has already finished),
 * then releases the lock and returns both answers in start order.
 */
async function raceOnOrderLock(
  world: PosWorld,
  orderId: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[unknown, unknown]> {
  const holder = await owner.connect();
  const settled = [false, false];
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [world.w.tenant.tenantId, toUuid(orderId)],
    );
    const baseline = await lockWaiters();
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await lockWaiters()) >= baseline + count) return;
        if (settled.some(Boolean)) return; // finished without waiting: nothing to wait for
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const a = first().finally(() => (settled[0] = true));
    await waitFor(1);
    const b = second().finally(() => (settled[1] = true));
    await waitFor(2);
    await holder.query("COMMIT");
    return await Promise.all([a, b]);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

describe("legend-eajpb concurrent cashier refund and voucher: together never more than paid", () => {
  for (const [label, voucherFirst] of [
    ["voucher request starts first", true],
    ["refund starts first", false],
  ] as const) {
    it(`staff voucher 20.000 and refund of the whole order, ${label}`, async () => {
      const paid = await p.paidPlainOrder();
      await p.becomePosSale(paid);
      const issueId = await p.reportLine(paid.kopiLine);
      const refundInput = await p.refundInput(paid.orderId, ORDER_PAID);
      const voucher = async () => p.staffVoucher(issueId, 20_000);
      const refund = async () => p.posRefund(paid.orderId, refundInput);

      const answers = await raceOnOrderLock(
        p,
        paid.orderId,
        voucherFirst ? voucher : refund,
        voucherFirst ? refund : voucher,
      );
      const voucherAnswer = (voucherFirst ? answers[0] : answers[1]) as Answer;
      const refundAnswer = (voucherFirst ? answers[1] : answers[0]) as {
        ok: boolean;
      };

      const vouchers = await p.voucherValues(issueId);
      const refunded = (await p.posRefundRows(paid.orderId)).reduce(
        (a, b) => a + b,
        0,
      );
      await p.expectWithinPaid(paid.orderId, [issueId]);
      // Whoever won, the room is used exactly once: nothing lost for the guest either.
      expect(vouchers.reduce((a, b) => a + b, 0) + refunded).toBe(ORDER_PAID);
      if (vouchers.length === 0) {
        // The refund won the lock: the staff voucher is refused, not cut.
        expectRefused(voucherAnswer, NOTHING_DUE);
        expect(refunded).toBe(ORDER_PAID);
      } else {
        expect(voucherAnswer.status).toBe(201);
        expect(refundAnswer.ok, JSON.stringify(refundAnswer)).toBe(true);
        expect(refunded).toBe(ORDER_PAID - 20_000);
      }
    });
  }

  for (const [label, voucherFirst] of [
    ["guest voucher starts first", true],
    ["refund starts first", false],
  ] as const) {
    it(`guest voucher choice and refund of the whole order, ${label}`, async () => {
      const paid = await p.paidPlainOrder();
      await p.becomePosSale(paid);
      const issueId = await p.reportLine(paid.rotiLine); // voucher 18.000
      const refundInput = await p.refundInput(paid.orderId, ORDER_PAID);
      const voucher = async () =>
        p.guestChoose(paid, issueId, { choice: "voucher" });
      const refund = async () => p.posRefund(paid.orderId, refundInput);

      await raceOnOrderLock(
        p,
        paid.orderId,
        voucherFirst ? voucher : refund,
        voucherFirst ? refund : voucher,
      );

      await p.expectWithinPaid(paid.orderId, [issueId]);
      const vouchers = await p.voucherValues(issueId);
      const refunded = (await p.posRefundRows(paid.orderId)).reduce(
        (a, b) => a + b,
        0,
      );
      // Voucher won: 18.000 + refund cut to 31.665. Refund won: 49.665 and no voucher.
      expect(vouchers.reduce((a, b) => a + b, 0) + refunded).toBe(ORDER_PAID);
    });
  }
});

describe("legend-eajpb other tenants and orders are untouched", () => {
  it("another tenant's identical order still takes the full staff voucher while ours (fully refunded) is refused", async () => {
    const mine = await p.paidPlainOrder();
    await p.becomePosSale(mine);
    await refundWholeOrder(p, mine);
    const theirs = await other.paidPlainOrder();

    const refused = await p.apologyVoucherRequest(mine.rotiLine, 10_000);
    expectRefused(refused.issued, NOTHING_DUE);

    const theirIssue = await other.reportLine(theirs.rotiLine);
    const accepted = await other.staffVoucher(theirIssue, 10_000);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(await other.voucherValues(theirIssue)).toEqual([10_000]);

    // The guest of the other tenant is untouched too: the voucher is theirs in full.
    const theirGuestIssue = await other.reportLine(theirs.kopiLine);
    const chosen = await other.guestChoose(theirs, theirGuestIssue, {
      choice: "voucher",
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(await other.voucherValues(theirGuestIssue)).toEqual([25_000]);
  });

  it("a voucher on another order of the same tenant does not use up this order's room", async () => {
    const a = await p.paidPlainOrder();
    const b = await p.paidPlainOrder();
    const issueA = await p.apologyVoucherFor(a.kopiLine, KOPI_PAID);
    await p.becomePosSale(b);
    await refundKopiLine(p, b); // room of b: 20.790

    const issueB = await p.reportLine(b.rotiLine);
    const accepted = await p.staffVoucher(issueB, ROTI_PAID);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    await p.expectWithinPaid(a.orderId, [issueA]);
    await p.expectWithinPaid(b.orderId, [issueB]);
  });
});
