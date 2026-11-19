// legend-1095 card B (legend-aja6g, 1042 F3 / W3b): ONE refund lane per order. The ORD-09
// recovery refund is a `payment_refunds` row with `order_issue_id` set and status other
// than `failed` (a pending / manual-queued one counts too, Q45). It must never coexist
// with a cashier refund, a cloud void or an edge void (applied or parked) of the same
// order. Restrictive: when unsure, refuse. The guest never gets back more than paid.
//
// Written from docs/briefs/sub-1095.md and the recovery / 980 fixtures, never from the
// implementation. Every pair is checked in both orders and as a race, plus controls so a
// refusal never passes because of an unrelated failure.
//
// Assumptions (also reported):
// - ORD-09 then cashier refund / cloud void: the cashier refund / void is REFUSED (the
//   promise rejects or answers not-ok); no pos_order_refunds / pos_order_voids row.
//   The error shape is not pinned (the brief names no code), only that it is a refusal
//   and not a server error (status < 500 when a status is given).
// - Reverse direction (cashier refund / void / parked edge void first, then ORD-09):
//   the brief says "ditolak 409" without saying where. Accepted: the resolve route answers
//   409, OR it answers 200 and delivering the outbox event opens no refund (a thrown 409
//   counts). In both, no live payment_refunds row exists for the issue afterwards.
//   Note: an order that already has a pos_orders row is routed to the POS
//   (`refund_routed_pos`) by the consumer today, so most reverse cases are green on the
//   base; the parked edge void and the race are the red ones.
// - ORD-09 filed while the order is still a QR order, then the order becomes a POS cash
//   sale (written directly), as in 3f5c50aed. This is the only way one order meets both
//   lanes in a test.
// - The parked edge void cases live in refund-1095-ord09-parked.test.ts (an edge node in the
//   tenant makes QR ordering answer EDGE_LINK_DOWN, so that file orders first, then registers).
// - A `failed` ORD-09 refund frees the lane (brief: status <> failed).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-ord09-lane.test.ts" heavy pnpm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  KOPI_PAID,
  ORDER_PAID,
  ROTI_PAID,
  ROTI_PRICE,
  createPosWorld,
  errorText,
  sum,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let p: PosWorld;

beforeAll(async () => {
  p = await createPosWorld();
}, 120_000);

afterAll(async () => {
  await p.teardown();
});

/** A refusal is a client error, never a crash. */
function expectRefusal(outcome: { ok: boolean; error?: unknown }) {
  expect(outcome.ok, "must be refused").toBe(false);
  const status = (outcome.error as { status?: number } | undefined)?.status;
  if (typeof status === "number") expect(status).toBeLessThan(500);
}

/** Frees the ORD-09 lane the way a provider failure does. */
async function failOrd09(issueId: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = 'cap_exceeded'
      WHERE tenant_id = $1 AND order_issue_id = $2::uuid`,
    [p.w.tenant.tenantId, issueId],
  );
}

async function paidWithOrd09(): Promise<{ paid: PaidOrder; ord09: string }> {
  const paid = await p.paidPlainOrder();
  const ord09 = await p.recoveryRefundFor(paid.rotiLine, ROTI_PRICE, ROTI_PAID);
  return { paid, ord09 };
}

// ============================================================================
// ORD-09 first, then the cashier refund / the cloud void
// ============================================================================

describe("legend-aja6g ORD-09 refund first, then cashier refund", () => {
  it("the cashier refund is refused: no POS refund row, ORD-09 money intact, total <= paid", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 10_000),
    );
    expectRefusal(outcome);
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
    expect(await p.recoveryRefundTotal([ord09])).toBe(ROTI_PAID);
    await p.expectWithinPaid(paid.orderId, [ord09]);
  });

  it("a full-order cashier refund after ORD-09 is refused too (not cut to the room)", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await p.becomePosSale(paid);

    expectRefusal(
      await p.posRefund(
        paid.orderId,
        await p.refundInput(paid.orderId, ORDER_PAID),
      ),
    );
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [ord09]);
  });

  it("a line refund of ANOTHER line is refused as well (the lane is per order)", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await p.becomePosSale(paid);

    expectRefusal(
      await p.posRefund(
        paid.orderId,
        await p.refundInput(paid.orderId, KOPI_PAID, [
          { itemId: paid.kopiLine, quantity: 1 },
        ]),
      ),
    );
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [ord09]);
  });

  it("ORD-09 + a voucher on the same order: the cashier refund is still refused, total <= paid", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    const apology = await p.apologyVoucherFor(paid.kopiLine, 20_000);
    await p.becomePosSale(paid);

    expectRefusal(
      await p.posRefund(
        paid.orderId,
        await p.refundInput(paid.orderId, ORDER_PAID),
      ),
    );
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
    await p.expectWithinPaid(paid.orderId, [ord09, apology]);
  });

  it("control: an ORD-09 refund that FAILED frees the lane, the cashier refund goes through", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await failOrd09(ord09);
    await p.becomePosSale(paid);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);
    await p.expectWithinPaid(paid.orderId, [ord09]);
  });

  it("isolation: ORD-09 on order X does not block the cashier refund of order Y", async () => {
    const { paid: x } = await paidWithOrd09();
    const y = await p.paidPlainOrder();
    await p.becomePosSale(x);
    await p.becomePosSale(y);

    const outcome = await p.posRefund(
      y.orderId,
      await p.refundInput(y.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(y.orderId)).toEqual([ORDER_PAID]);
    expectRefusal(
      await p.posRefund(x.orderId, await p.refundInput(x.orderId, 5_000)),
    );
    expect(await p.posRefundRows(x.orderId)).toEqual([]);
  });
});

describe("legend-aja6g ORD-09 refund first, then cloud void", () => {
  it("the cloud void is refused: no void row, ORD-09 money intact, total <= paid", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await p.becomePosSale(paid);

    expectRefusal(await p.cloudVoid(paid.orderId));
    expect(await p.voidCount(paid.orderId)).toBe(0);
    expect(await p.recoveryRefundTotal([ord09])).toBe(ROTI_PAID);
    await p.expectWithinPaid(paid.orderId, [ord09]);
  });

  it("control: a lone cloud void of a plain POS sale is accepted", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid);
    const outcome = await p.cloudVoid(paid.orderId);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.voidCount(paid.orderId)).toBe(1);
  });

  it("control: a FAILED ORD-09 refund frees the lane, the cloud void goes through", async () => {
    const { paid, ord09 } = await paidWithOrd09();
    await failOrd09(ord09);
    await p.becomePosSale(paid);

    const outcome = await p.cloudVoid(paid.orderId);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.voidCount(paid.orderId)).toBe(1);
  });

  it("isolation: ORD-09 on order X does not block the cloud void of order Y", async () => {
    const { paid: x } = await paidWithOrd09();
    const y = await p.paidPlainOrder();
    await p.becomePosSale(x);
    await p.becomePosSale(y);

    const outcome = await p.cloudVoid(y.orderId);
    expect(outcome.ok, errorText((outcome as { error?: never }).error)).toBe(
      true,
    );
    expect(await p.voidCount(y.orderId)).toBe(1);
    expect(await p.voidCount(x.orderId)).toBe(0);
  });
});

// ============================================================================
// Cashier refund / cloud void first, then ORD-09
// ============================================================================

describe("legend-aja6g cashier refund first, then ORD-09", () => {
  it("ORD-09 is refused (409) or opens no refund; the cashier refund stays the only money out", async () => {
    const paid = await p.paidPlainOrder();
    const { issueId, approvalId } = await p.prepareOrd09(
      paid.rotiLine,
      ROTI_PRICE,
    );
    await p.becomePosSale(paid);
    const refund = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 10_000),
    );
    expect(refund.ok, JSON.stringify(refund)).toBe(true);

    await p.expectOrd09Refused(issueId, approvalId);
    expect(await p.posRefundRows(paid.orderId)).toEqual([10_000]);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});

describe("legend-aja6g cloud void first, then ORD-09", () => {
  it("ORD-09 is refused (409) or opens no refund; the void stays the only money out", async () => {
    const paid = await p.paidPlainOrder();
    const { issueId, approvalId } = await p.prepareOrd09(
      paid.rotiLine,
      ROTI_PRICE,
    );
    await p.becomePosSale(paid);
    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);

    await p.expectOrd09Refused(issueId, approvalId);
    expect(await p.voidCount(paid.orderId)).toBe(1);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});

// ============================================================================
// Races: exactly one lane wins
// ============================================================================

describe("legend-aja6g races: ORD-09 against the other lanes", () => {
  it("ORD-09 delivery racing the order's turn into a POS sale and its cashier refund: one lane only, total <= paid", async () => {
    for (let round = 0; round < 3; round += 1) {
      const paid = await p.paidPlainOrder();
      const { issueId, approvalId } = await p.prepareOrd09(
        paid.rotiLine,
        ROTI_PRICE,
      );
      const resolved = await p.resolveOrd09(issueId, approvalId);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const event = await p.ord09Event(issueId);
      expect(event).not.toBeNull();
      const input = await p.refundInput(paid.orderId, ROTI_PAID);

      await Promise.allSettled([
        p.deliverOrd09(event!),
        (async () => {
          await p.becomePosSale(paid);
          return p.posRefund(paid.orderId, input);
        })(),
      ]);

      const posMoney = sum(await p.posRefundRows(paid.orderId));
      const ord09Money = await p.recoveryRefundTotal([issueId]);
      expect(
        posMoney > 0 && ord09Money > 0,
        `round ${round}: cashier refund ${posMoney} and ORD-09 ${ord09Money} must not both exist`,
      ).toBe(false);
      await p.expectWithinPaid(paid.orderId, [issueId]);
    }
  });

  it("ORD-09 delivery racing the order's turn into a POS sale and its cloud void: one lane only, total <= paid", async () => {
    for (let round = 0; round < 3; round += 1) {
      const paid = await p.paidPlainOrder();
      const { issueId, approvalId } = await p.prepareOrd09(
        paid.rotiLine,
        ROTI_PRICE,
      );
      const resolved = await p.resolveOrd09(issueId, approvalId);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const event = await p.ord09Event(issueId);
      expect(event).not.toBeNull();

      await Promise.allSettled([
        p.deliverOrd09(event!),
        (async () => {
          await p.becomePosSale(paid);
          return p.cloudVoid(paid.orderId);
        })(),
      ]);

      const voided = await p.voidCount(paid.orderId);
      const ord09Money = await p.recoveryRefundTotal([issueId]);
      expect(
        voided > 0 && ord09Money > 0,
        `round ${round}: void ${voided} and ORD-09 ${ord09Money} must not both exist`,
      ).toBe(false);
      await p.expectWithinPaid(paid.orderId, [issueId]);
    }
  });
});
