// (brief 1205 part A = legend-3tyl1, tier K "jangan sampai rugi"): red-first test from
// docs/qa/second-opinion-refund-hold-1200.md P3-1, on top of refund-1072-harness.
//
// Rule under test: the "transaction is closed by our own refunds" echo skip (1191) compares the echo
// with the amount the provider really charged, not with the bill (intent) amount. A customer who
// overpaid (provider transaction larger than the bill) and a dashboard refund of the surplus (no
// refund id) must NOT be skipped silently: it is an open hold, so Legend never refunds the surplus
// a second time.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1205-a-echo-overpay.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";

const h = createRefundHarness("1205a");

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const SURPLUS_IDR = 20_000;

/** Refund-shaped success, flat sandbox shape, no refund id, NEW event id. */
const dashboardRefund = (providerRef: string, amount: number) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: { payment_id: providerRef, amount, status: "succeeded" },
});

/** Known-intent path (the event carries the key of our refund but no payment id: no mapping by payment id). */
const keyedNoPayment = (refundId: string, amount: number) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: { idempotency_key: `refund:${refundId}`, amount, status: "succeeded" },
});

describe("legend-3tyl1 echo skip compares with what the provider charged", () => {
  it("1205-a-01 overpaid transaction (Rp120.000 on a Rp100.000 bill), own refund Rp100.000 completed: a dashboard refund of the surplus (no refund id) is an open hold, not skipped", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR + SURPLUS_IDR)).status).toBe(200);
    await h.ownCompletedRefund(code, BILL_IDR);
    const before = (await h.allHolds(code.id)).length;

    const echo = dashboardRefund(code.providerRef, SURPLUS_IDR);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    await h.runWorker();

    const open = await h.openOf(code.id);
    expect(
      open.length,
      `holds: ${JSON.stringify(await h.allHolds(code.id))} (before: ${before})`,
    ).toBe(1);
  });

  it("1205-a-03 same overpaid transaction, known-intent path (key of our refund, no payment id, Rp20.000): open hold, not skipped", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR + SURPLUS_IDR)).status).toBe(200);
    const own = await h.ownCompletedRefund(code, BILL_IDR);

    const echo = keyedNoPayment(own.refundId, SURPLUS_IDR);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    await h.runWorker();

    const open = await h.openOf(code.id);
    expect(open.length, JSON.stringify(await h.allHolds(code.id))).toBe(1);
  });

  it("1205-a-04 the evidence of the transaction is gone (deleted), own refund Rp100.000 completed: the provider's transaction size is unknown, so the echo of Rp20.000 is an open hold, not skipped", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR + SURPLUS_IDR)).status).toBe(200);
    await h.ownCompletedRefund(code, BILL_IDR);
    await h.owner.query(
      "DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [h.tenantId, code.id],
    );

    const echo = dashboardRefund(code.providerRef, SURPLUS_IDR);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    await h.runWorker();

    const open = await h.openOf(code.id);
    expect(open.length, JSON.stringify(await h.allHolds(code.id))).toBe(1);
  });

  it("1205-a-02 same bill paid exactly (Rp100.000), own refund Rp100.000 completed: the echo of that refund stays skipped (no hold)", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    await h.ownCompletedRefund(code, BILL_IDR);

    const echo = dashboardRefund(code.providerRef, BILL_IDR);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    await h.runWorker();

    expect(await h.openOf(code.id)).toEqual([]);
  });

  it("1205-a-06 overpaid transaction fully refunded by Legend (Rp100.000 on the intent + Rp20.000 surplus fund refunded): the dashboard echo is skipped, no hold", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR + SURPLUS_IDR)).status).toBe(200);
    await h.ownCompletedRefund(code, BILL_IDR);
    const funds = await h.owner.query<{ id: string }>(
      `SELECT id FROM payment_unallocated_funds
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [h.tenantId, code.id],
    );
    expect(funds.rows.length, "premise: the surplus is parked").toBe(1);
    const resolved = await h.resolveFund(funds.rows[0]!.id, "refund");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const surplusRefund = await h.owner.query<{ id: string }>(
      `SELECT id FROM payment_refunds
        WHERE tenant_id = $1 AND unallocated_fund_id = $2`,
      [h.tenantId, funds.rows[0]!.id],
    );
    const approved = await h.approveRefund(surplusRefund.rows[0]!.id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await h.refundRow(surplusRefund.rows[0]!.id)).status,
      "premise: the surplus refund completed",
    ).toBe("completed");

    const echo = dashboardRefund(code.providerRef, BILL_IDR + SURPLUS_IDR);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    await h.runWorker();

    expect(
      await h.openOf(code.id),
      "the echo of refunds of ours that closed the whole transaction files no hold",
    ).toEqual([]);
  });
});
