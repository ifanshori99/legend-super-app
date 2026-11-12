// legend-y5d2r: exercise the real POS money boundary, independently of the
// customer display schema. No display/DP mutation endpoint is invented here.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { confirmPayment } from "../services/payment.service.ts";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { owner } from "./floor-test-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  captainPaymentFixture,
  resetCaptainPaymentPorts,
  type CaptainPaymentFixture,
} from "./pos-captain-payment-test-helpers.ts";

let fixture: CaptainPaymentFixture;
beforeAll(async () => {
  fixture = await captainPaymentFixture("qris-dp-money");
});
afterEach(() => setQrOrderDepositCreditLookup(null));
afterAll(async () => {
  resetCaptainPaymentPorts();
  await owner.end();
});

async function submittedOrder(depositIdr: number) {
  setQrOrderDepositCreditLookup(async () => depositIdr);
  const guest = await fixture.newGuest();
  const draft = await fixture.createDraft(guest.sessionId);
  expect(draft.depositAppliedIdr).toBe(0);
  const submitted = await fixture.submit(draft.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.depositAppliedIdr).toBe(depositIdr);
  return submitted.body.data as {
    id: string;
    status: string;
    totalIdr: number;
    depositAppliedIdr: number;
  };
}

async function settleAndDeliver(intentId: string, amountIdr: number) {
  await confirmPayment(fixture.context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `DP-MONEY-${randomUUID()}`,
    at: new Date().toISOString(),
  });
  const events = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid'
       AND event->'payload'->>'intentId'=$2`,
    [fixture.tenant.tenantId, intentId],
  );
  for (const row of events.rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    await handlePosPaymentPaid(fixture.context, event);
    // Consumer replay must never capture or request a refund twice.
    await handlePosPaymentPaid(fixture.context, event);
  }
}

async function capturedIdr(orderId: string) {
  const result = await owner.query<{ amount: number }>(
    `SELECT coalesce(sum(amount_idr),0)::int AS amount
       FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2
       AND status='captured'`,
    [fixture.tenant.tenantId, ulidToUuid(orderId)],
  );
  return result.rows[0]!.amount;
}

describe("legend-y5d2r POS QRIS DP money boundaries", () => {
  it("QRIS-DP-MONEY-01 charges exactly the allocated remainder, never the draft DP or gross invoice", async () => {
    const order = await submittedOrder(20_000);
    const due = order.totalIdr - order.depositAppliedIdr;
    const opened = await fixture.tender(order.id, order.status, "qris");
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data.tender.amountIdr).toBe(due);
    expect(fixture.gateway.requests.at(-1)?.amountIdr).toBe(due);
    expect(opened.body.data.remainingIdr).toBe(due);
    await settleAndDeliver(opened.body.data.tender.paymentIntentId, due);
    expect(await capturedIdr(order.id)).toBe(due);
    expect((await capturedIdr(order.id)) + order.depositAppliedIdr).toBe(
      order.totalIdr,
    );
  });

  it("QRIS-DP-MONEY-02 refuses client-selected undercharges and overcharges before any gateway call", async () => {
    const order = await submittedOrder(20_000);
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
    const order = await submittedOrder(20_000);
    const before = await fixture.counts();
    const gatewayCalls = fixture.gateway.requests.length;
    const results = await Promise.all([
      fixture.tender(order.id, order.status, "qris").then((r) => r),
      fixture.tender(order.id, order.status, "qris").then((r) => r),
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
    await settleAndDeliver(opened.body.data.tender.paymentIntentId, due);
    expect((await capturedIdr(order.id)) + order.depositAppliedIdr).toBe(
      order.totalIdr,
    );
  });

  it("QRIS-DP-MONEY-04 prevents double capture after DP grows and requests one pending refund for the old QR", async () => {
    const order = await submittedOrder(0);
    const old = await fixture.tender(order.id, order.status, "qris");
    expect(old.status, JSON.stringify(old.body)).toBe(201);
    // The current public API has no operation to attach DP to a submitted
    // bill. Model that future/external allocation at the authoritative row,
    // like pos-order-qris-lifecycle.test.ts; this proves the capture safety
    // net, not a claim that the display replacement flow exists.
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr=10000 WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant.tenantId, ulidToUuid(order.id)],
      ),
    );
    await settleAndDeliver(
      old.body.data.tender.paymentIntentId,
      order.totalIdr,
    );
    expect(await capturedIdr(order.id)).toBe(0);
    const fresh = await fixture.get(`${fixture.base}/${order.id}`);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.data.tenders[0].status).toBe("voided");
    const replacement = await fixture.tender(
      order.id,
      fresh.body.data.status,
      "qris",
    );
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    const due = order.totalIdr - 10_000;
    expect(replacement.body.data.tender.amountIdr).toBe(due);
    await settleAndDeliver(replacement.body.data.tender.paymentIntentId, due);
    expect((await capturedIdr(order.id)) + 10_000).toBe(order.totalIdr);
    const refunds = await owner.query<{
      amount: number;
      status: string;
      requested_by: string;
    }>(
      `SELECT amount_idr::int AS amount, status, requested_by
         FROM payment_refunds WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fixture.tenant.tenantId, old.body.data.tender.paymentIntentId],
    );
    expect(refunds.rows).toEqual([
      {
        amount: order.totalIdr,
        status: "pending",
        requested_by: "system:pos",
      },
    ]);
    const active = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pos_order_tenders
         WHERE tenant_id=$1 AND order_id=$2 AND status='authorized'`,
      [fixture.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(active.rows[0]!.count).toBe(0);
  });
});
