// legend-y5d2r / legend-yhia9: exercise the real POS money boundary,
// independently of the customer display schema. Ported from
// 54682a08 (ws/qris-dp-due). MONEY-04 changed per design qris.md §8: a DP can
// no longer grow under a collectible QR (D-01); the old "QR paid after DP grew
// -> one pending refund" expectation moved to QH-14.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { owner } from "./floor-test-helpers.ts";
import {
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  rawSetDeposit,
  readBill,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

let fixture: HoldFixture;
beforeAll(async () => {
  fixture = await holdFixture("qris-dp-money");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

describe("legend-y5d2r POS QRIS DP money boundaries", () => {
  it("QRIS-DP-MONEY-01 charges exactly the allocated remainder, never the draft DP or gross invoice", async () => {
    const order = await newSubmittedOrder(fixture, 20_000);
    const due = order.totalIdr - order.depositAppliedIdr;
    const opened = await fixture.tender(order.id, order.status, "qris");
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data.tender.amountIdr).toBe(due);
    expect(fixture.gateway.requests.at(-1)?.amountIdr).toBe(due);
    expect(opened.body.data.remainingIdr).toBe(due);
    await payNotice(fixture, opened.body.data.tender.paymentIntentId, due);
    expect(await capturedIdr(fixture, order.id)).toBe(due);
    expect(
      (await capturedIdr(fixture, order.id)) + order.depositAppliedIdr,
    ).toBe(order.totalIdr);
  });

  it("QRIS-DP-MONEY-02 refuses client-selected undercharges and overcharges before any gateway call", async () => {
    const order = await newSubmittedOrder(fixture, 20_000);
    const before = await fixture.counts();
    const gatewayCalls = fixture.gateway.requests.length;
    for (const amountIdr of [1, order.totalIdr]) {
      const refused = await fixture.post(
        `${fixture.base}/${order.id}/tenders`,
        {
          method: "qris",
          expectedStatus: order.status,
          amountIdr,
          idempotencyKey: randomUUID(),
        },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    }
    expect(await fixture.counts()).toEqual(before);
    expect(fixture.gateway.requests).toHaveLength(gatewayCalls);
  });

  it("QRIS-DP-MONEY-03 concurrent QRIS requests create only one collectible intent for the remainder", async () => {
    const order = await newSubmittedOrder(fixture, 20_000);
    const before = await fixture.counts();
    const gatewayCalls = fixture.gateway.requests.length;
    const results = await Promise.all([
      fixture.tender(order.id, order.status, "qris"),
      fixture.tender(order.id, order.status, "qris"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const after = await fixture.counts();
    expect(after.links - before.links).toBe(1);
    expect(after.intents - before.intents).toBe(1);
    const opened = results.find((r) => r.status === 201)!;
    const due = order.totalIdr - order.depositAppliedIdr;
    expect(fixture.gateway.requests).toHaveLength(gatewayCalls + 1);
    expect(fixture.gateway.requests[gatewayCalls]?.amountIdr).toBe(due);
    expect(opened.body.data.tender.amountIdr).toBe(due);
    await payNotice(fixture, opened.body.data.tender.paymentIntentId, due);
    expect(
      (await capturedIdr(fixture, order.id)) + order.depositAppliedIdr,
    ).toBe(order.totalIdr);
  });

  it("QRIS-DP-MONEY-04 refuses a DP that grows under an authorized QR (QRIS_HOLD_ACTIVE) so the QR amount stays the bill remainder", async () => {
    const order = await newSubmittedOrder(fixture, 0);
    const qr = await issueQris(fixture, order.id);
    expect(qr.amountIdr).toBe(order.totalIdr);

    // No public API attaches a DP to a submitted bill; the authoritative row
    // is written directly, as another path or a background job could.
    const write = await rawSetDeposit(fixture, order.id, 10_000);
    expect(
      write,
      "raw UPDATE orders SET deposit_applied_idr must be refused while the QR is authorized",
    ).toMatchObject({ ok: false });
    if (write.ok === false) expect(write.message).toContain("QRIS_HOLD_ACTIVE");

    // Nothing moved: bill, tender, hold and money are exactly as issued.
    expect(await readBill(fixture, order.id)).toEqual({
      totalIdr: order.totalIdr,
      depositIdr: 0,
      status: order.status,
    });
    expect(
      (await tenderStatuses(fixture, order.id)).map((t) => t.status),
    ).toEqual(["authorized"]);
    expect((await readHold(fixture, order.id))?.state).toBe("open");
    expect(await capturedIdr(fixture, order.id)).toBe(0);
    // No refund and no parked money was needed: the customer was not charged
    // for a stale amount, and the outlet owes nothing.
    expect(await refundsOfIntent(fixture, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fixture, qr.intentId)).toEqual([]);
    await assertInvariants(fixture, order.id);
  });
});
