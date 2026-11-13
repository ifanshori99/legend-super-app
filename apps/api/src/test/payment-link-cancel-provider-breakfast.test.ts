// legend-ukbq3, call site: cancelling a breakfast order closes its payment link
// (facility-breakfast-money). FAIL-FIRST: today the cancel closes the link and
// the pending intent LOCALLY without asking the provider.
//
// Written from docs/briefs/ukbq3-payment-link-cancel.md (founder Q93 rules) and
// the public HTTP contract (POST /api/facility/tickets/:ticketId/
// breakfast-orders/:orderId/cancel), not from the cancel implementation. Real
// Express app, Better Auth, WS-05 payment service and PostgreSQL; only the
// gateway is a scripted test double.
//
// Assumptions where the brief is silent:
// - "Provider already holds the money" = the status read answers raw "00".
//   The cancel may then (a) refuse / hold (order stays awaiting_payment and the
//   notice pays it), (b) apply the payment (order paid, nothing refunded) or
//   (c) cancel the order and park the money once in unallocated funds. All are
//   accepted, closing the intent locally as expired/failed is not.
// - "Unsure" = status read timeout, 5xx or an answer about another provider
//   reference (design): 409 PAYMENT_PROVIDER_UNCONFIRMED, the order stays
//   awaiting_payment, link and intent stay open, no refund, nothing parked.
// - Control: provider says expired (raw "02") and the QR is long past its life
//   -> the order cancels. An order with no link cancels with no provider call.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  createBreakfastWorld,
  deliver,
  dropBreakfastWorld,
  endPools,
  kitchenTicketCount,
  linkedOf,
  runSweep,
  memberApi,
  newMember,
  openIntent,
  payLink,
  placeOrder,
  seedTicket,
  setFireAt,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import {
  PROVIDER_UNSURE,
  backdateIntentExpiry,
  expectIntentOpen,
  expectLinkActive,
  expectLinkClosed,
  expectMoneyOnce,
  expectNoMoneyMoved,
  expectUnconfirmedResponse,
  installScriptedGateway,
  intentInfo,
  moneyOfIntent,
  paidEventsOf,
  providerWebhook,
  type ScriptedGateway,
} from "./payment-link-cancel-provider-helpers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";

let app: Express;
let world: BreakfastWorld;
let gateway: ScriptedGateway;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  world = await createBreakfastWorld(app);
  gateway = installScriptedGateway();
});

afterAll(async () => {
  setPaymentGateway(null);
  await dropBreakfastWorld(world);
  await endPools();
});

/** An awaiting_payment order whose guest holds a live QR. */
async function orderWithLiveCode() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const api = memberApi(world, member);
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const intent = await openIntent(world, token);
  expect(intent.amountIdr).toBe(order.totalIdr);
  return { member, ticketId, api, order, intentId: intent.id };
}

type Placed = Awaited<ReturnType<typeof orderWithLiveCode>>;

async function cancelRaw(placed: Placed) {
  return placed.api.cancel(placed.ticketId, placed.order.id);
}

async function cancel(placed: Placed) {
  const response = await placed.api.cancel(placed.ticketId, placed.order.id);
  // A held or refused cancel is fine; a crash is not.
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
  return response;
}

/** The provider's payment reaches the consumer, replayed. */
async function deliverNotices(placed: Placed) {
  await providerWebhook(
    world.context,
    world.tenant.tenantId,
    placed.intentId,
    placed.order.totalIdr,
  );
  for (const event of await paidEventsOf(
    world.tenant.tenantId,
    placed.intentId,
  ))
    for (let i = 0; i < 2; i += 1) await deliver(world, event);
}

async function expectMoneyOnceFor(placed: Placed, label: string) {
  const linked = await linkedOf(world, placed.order.id);
  const applied =
    ["paid", "fired"].includes(linked.status) &&
    linked.paidIntentId === placed.intentId;
  expectMoneyOnce(
    label,
    await moneyOfIntent(world.tenant.tenantId, placed.intentId),
    placed.order.totalIdr,
    applied,
  );
  return linked;
}

describe("legend-ukbq3 breakfast cancel follows the provider", () => {
  it("ukbq3-brk-paid: provider already got the money -> the QR is not closed locally and the money is applied or parked once", async () => {
    const placed = await orderWithLiveCode();
    gateway.script(placed.intentId, {
      rawStatus: "00",
      amountIdr: placed.order.totalIdr,
    });

    await cancel(placed);

    expect(
      gateway.readsOf(placed.intentId).length,
      "cancel never asked the provider",
    ).toBeGreaterThanOrEqual(1);
    await expectIntentOpen(
      world.tenant.tenantId,
      placed.intentId,
      "provider holds the money",
    );

    await deliverNotices(placed);
    const linked = await expectMoneyOnceFor(placed, "breakfast paid");
    // Whatever the order ended as, nothing reached the kitchen on its own.
    expect(linked.status === "fired").toBe(false);
    expect(await kitchenTicketCount(world, placed.order.id)).toBe(0);
  });

  it("ukbq3-brk-paid: cancel pressed again and the notice replayed -> still one disposal of the money", async () => {
    const placed = await orderWithLiveCode();
    gateway.script(placed.intentId, {
      rawStatus: "00",
      amountIdr: placed.order.totalIdr,
    });

    await cancel(placed);
    await deliverNotices(placed);
    await cancel(placed);
    await cancel(placed);
    await deliverNotices(placed);

    await expectMoneyOnceFor(placed, "breakfast paid, repeated cancel");
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`ukbq3-brk-unsure: provider answer ${JSON.stringify(answer)} -> 409 PAYMENT_PROVIDER_UNCONFIRMED: order stays awaiting_payment, link and QR stay open, no refund`, async () => {
      const placed = await orderWithLiveCode();
      await backdateIntentExpiry(world.tenant.tenantId, placed.intentId);
      gateway.script(placed.intentId, answer);

      expectUnconfirmedResponse(await cancelRaw(placed), "unsure provider");

      expect(
        gateway.readsOf(placed.intentId).length,
        "cancel never asked the provider",
      ).toBeGreaterThanOrEqual(1);
      await expectLinkActive(
        world.tenant.tenantId,
        placed.intentId,
        "unsure provider",
      );
      const linked = await linkedOf(world, placed.order.id);
      expect(linked.status).toBe("awaiting_payment");
      expect(linked.cancelledAt).toBeNull();
      expect(
        (await intentInfo(world.tenant.tenantId, placed.intentId)).status,
      ).toBe("pending");
      expectNoMoneyMoved(
        "unsure provider",
        await moneyOfIntent(world.tenant.tenantId, placed.intentId),
      );
    });
  }

  it("ukbq3-brk-expired: provider says expired and the QR is long past its life -> the order cancels, nothing is owed", async () => {
    const placed = await orderWithLiveCode();
    await backdateIntentExpiry(world.tenant.tenantId, placed.intentId);
    gateway.script(placed.intentId, { rawStatus: "02" });

    const response = await cancel(placed);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(
      gateway.readsOf(placed.intentId).length,
      "cancel never asked the provider",
    ).toBeGreaterThanOrEqual(1);
    expect((await linkedOf(world, placed.order.id)).status).toBe("cancelled");
    // The link is closed; the gateway code past its expiry stays `pending` on
    // purpose (the poller may still settle a late payment).
    await expectLinkClosed(
      world.tenant.tenantId,
      placed.intentId,
      "provider expired",
    );
    expect(
      (await intentInfo(world.tenant.tenantId, placed.intentId)).status,
    ).not.toBe("paid");
    expectNoMoneyMoved(
      "provider expired",
      await moneyOfIntent(world.tenant.tenantId, placed.intentId),
    );
  });

  it("ukbq3-brk-empty: no payment link was ever opened -> cancels at once without asking the provider", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const api = memberApi(world, member);
    const order = await placeOrder(world, member, ticketId);
    const readsBefore = gateway.statusReads.length;

    const response = await api.cancel(ticketId, order.id, randomUUID());

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await linkedOf(world, order.id)).status).toBe("cancelled");
    expect(gateway.statusReads).toHaveLength(readsBefore);
  });

  // Review 1 (finding 2): `payment.paid` is applied by the worker through the
  // outbox. While the intent is already paid but the order is still
  // awaiting_payment, closing it would let the consumer refund the whole
  // payment as "late". The close must wait (409), then the consumer pays it.
  describe("intent paid but the worker has not applied it yet", () => {
    async function paidNotConsumed() {
      const placed = await orderWithLiveCode();
      gateway.script(placed.intentId, {
        rawStatus: "00",
        amountIdr: placed.order.totalIdr,
      });
      await providerWebhook(
        world.context,
        world.tenant.tenantId,
        placed.intentId,
        placed.order.totalIdr,
      );
      expect(
        (await intentInfo(world.tenant.tenantId, placed.intentId)).status,
      ).toBe("paid");
      expect((await linkedOf(world, placed.order.id)).status).toBe(
        "awaiting_payment",
      );
      return placed;
    }

    async function expectWaiting(placed: Placed, label: string) {
      expect((await linkedOf(world, placed.order.id)).status, label).toBe(
        "awaiting_payment",
      );
      expectNoMoneyMoved(
        label,
        await moneyOfIntent(world.tenant.tenantId, placed.intentId),
      );
    }

    async function consumerRuns(placed: Placed) {
      for (const event of await paidEventsOf(
        world.tenant.tenantId,
        placed.intentId,
      ))
        for (let i = 0; i < 2; i += 1) await deliver(world, event);
      const linked = await linkedOf(world, placed.order.id);
      expect(linked.status).toBe("paid");
      expect(linked.paidIntentId).toBe(placed.intentId);
      expectMoneyOnce(
        "breakfast applied by the consumer",
        await moneyOfIntent(world.tenant.tenantId, placed.intentId),
        placed.order.totalIdr,
        true,
      );
    }

    it("ukbq3-brk-paid-unconsumed: member cancel -> 409, order stays awaiting_payment, no refund; the consumer then pays it once", async () => {
      const placed = await paidNotConsumed();

      const response = await cancelRaw(placed);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      await expectWaiting(placed, "cancel while paid but unconsumed");

      await consumerRuns(placed);
    });

    it("ukbq3-brk-paid-unconsumed: the sweep past the ticket end does not cancel it and refunds nothing", async () => {
      const placed = await paidNotConsumed();

      await setFireAt(
        world,
        placed.order.id,
        new Date(Date.now() - 5 * 60_000),
      );
      await runSweep(world, new Date(Date.now() + 120 * 60_000));

      await expectWaiting(placed, "sweep while paid but unconsumed");
      await consumerRuns(placed);
    });
  });
});
