// legend-tlm3h (brief 1013, tier K "jangan sampai rugi"), breakfast side. A
// breakfast order is paid with ONE code that must cover the whole order. When
// the payment provider (DOIT) has already given part of that code back on its
// own (payment_provider_refunds, brief 967) before the `payment.paid` event is
// consumed, the money still in the code is the NET (paid - provider refunds).
// Net below the total must NOT quietly pass as a "split" bill or as paid: the
// order is voided, nothing reaches the kitchen, and the guest gets back only
// the net (the provider already returned the rest). Same rule as brief 1009 for
// POS and QR orders. Written from the brief and the 519/1009 fixtures, failing
// first; not from the implementation. Fixtures: facility-breakfast-helpers.ts.
//
// Ids:
//  BRK-1013-01 net below the total: order voided, no kitchen, refund = net
//  BRK-1013-02 the same paid event delivered again changes nothing
//  BRK-1013-03 the provider returned everything (net 0): voided, nothing to refund
//  BRK-1013-04 a fully paid breakfast of the same tenant is not touched
//  BRK-1013-05 two full codes, one partly refunded: the intact one pays, no double refund
//  BRK-1013-06 two full codes, both partly refunded: voided, each gets its net
//
// Assumptions (the brief does not fix them):
//  - The provider refund is seeded straight into payment_provider_refunds (as
//    the 967/980/1009 tests do) after the code settled and before its paid
//    event is consumed ("refund first, paid event later").
//  - "Void" = facility_linked_orders.status "cancelled" (the order the guest
//    sees as cancelled), paid_intent_id and fired_at empty, no kitchen ticket,
//    staff "Kirim sekarang" refused (409 BREAKFAST_ORDER_CANCELLED).
//  - "Guest gets back the net": non-failed payment_refunds of OUR side for the
//    intent add up to exactly total - provider refund (never more: the outlet
//    must not pay twice; never less: the guest is not short-changed). Whether
//    it is pending approval or completed is not pinned. Requested by
//    'system:facility' with a reason text that does not mention QR (BRK-PAY-02).
//  - "No voucher / access": the order never becomes paid or fired, so no
//    kitchen ticket and no item fire status "fired" exist for it.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/facility-breakfast-provider-refund-net-1013.test.ts" heavy pnpm test

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import {
  MINUTE,
  asOwnerTenant,
  createBreakfastWorld,
  deliver,
  dropBreakfastWorld,
  endPools,
  installGateway,
  kitchenTicketCount,
  linkedOf,
  memberApi,
  newMember,
  openIntent,
  openSecondIntent,
  orderItemFireStatuses,
  paidEvent,
  payLink,
  placeOrder,
  refundDetailsOf,
  refundedSum,
  refundsOf,
  removeGateway,
  runSweep,
  seedTicket,
  setFireAt,
  settle,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let app: Express;
let world: BreakfastWorld;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
});

afterAll(async () => {
  removeGateway();
  await dropBreakfastWorld(world);
  await endPools();
});

/** The provider refunded `amountIdr` of the intent on its own (brief 967). */
async function providerRefunded(
  intentId: string,
  amountIdr: number,
  evidenceId: string | null = null,
): Promise<void> {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $7, 'doit', $4, $5, $6, 'payment_webhook')`,
      [
        world.tenant.tenantId,
        world.tenant.outletId,
        intentId,
        `rf_${randomUUID().slice(0, 12)}`,
        `pay_${intentId.slice(0, 12)}`,
        amountIdr,
        evidenceId,
      ],
    ),
  );
}

/**
 * The provider transaction evidence of the intent (recorded when it settled);
 * when the settlement left none, one is recorded here like brief 967 does.
 */
async function evidenceOf(intentId: string): Promise<string> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM payment_evidence
        WHERE tenant_id = $1 AND payment_intent_id = $2
        ORDER BY received_at LIMIT 1`,
      [world.tenant.tenantId, intentId],
    );
    if (found.rows[0]) return found.rows[0].id;
    const created = await client.query<{ id: string }>(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 1, now()) RETURNING id`,
      [
        world.tenant.tenantId,
        world.tenant.outletId,
        intentId,
        `pay_${intentId.slice(0, 12)}`,
      ],
    );
    return created.rows[0]!.id;
  });
}

async function providerRefundCount(): Promise<number> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM payment_provider_refunds WHERE tenant_id = $1",
      [world.tenant.tenantId],
    );
    return rows[0]!.n;
  });
}

/**
 * A breakfast order whose code settled for the full total, with the provider
 * refund recorded before the paid event is consumed. Returns the undelivered
 * event.
 */
async function settledThenProviderRefunded(providerRefundIdr: number) {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const api = memberApi(world, member);
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const intent = await openIntent(world, token);
  await settle(world, intent.id, order.totalIdr);
  const event = await paidEvent(world, intent.id);
  await providerRefunded(intent.id, providerRefundIdr);
  return { member, ticketId, api, order, intentId: intent.id, event };
}

/** The order never became paid, fired or a kitchen ticket. */
async function expectVoided(
  order: { id: string },
  ticket: { ticketId: string; api: ReturnType<typeof memberApi> },
) {
  const linked = await linkedOf(world, order.id);
  expect(linked.status).toBe("cancelled");
  expect(linked.paidIntentId).toBeNull();
  expect(linked.firedAt).toBeNull();
  expect(await kitchenTicketCount(world, order.id)).toBe(0);
  for (const status of await orderItemFireStatuses(world, order.id))
    expect(status).not.toBe("fired");

  // The guest sees a cancelled order, not a paid one.
  const menu = await ticket.api.menu(ticket.ticketId);
  expect(menu.status, JSON.stringify(menu.body)).toBe(200);
  expect(menu.body.data.order?.status ?? "cancelled").toBe("cancelled");

  // Staff cannot send it, and the sweep does not either.
  const fired = await staffFire(world, order.id);
  expect(fired.status, JSON.stringify(fired.body)).toBe(409);
  await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
  await runSweep(world);
  expect(await kitchenTicketCount(world, order.id)).toBe(0);
}

describe("1013 breakfast paid with a code the provider already partly refunded", () => {
  it.each([
    ["a small partial refund", () => 1_000],
    ["about half of the order", (total: number) => Math.floor(total / 2)],
  ] as const)(
    "BRK-1013-01 %s: the order is voided, nothing reaches the kitchen, the guest gets back only the net",
    async (_label, pick) => {
      // The total is only known once the order exists; place it first.
      const member = await newMember(world);
      const ticketId = await seedTicket(world, member);
      const api = memberApi(world, member);
      const order = await placeOrder(world, member, ticketId);
      const token = await payLink(world, member, ticketId, order.id);
      const intent = await openIntent(world, token);
      await settle(world, intent.id, order.totalIdr);
      const event = await paidEvent(world, intent.id);
      const providerShare = pick(order.totalIdr);
      expect(providerShare).toBeGreaterThan(0);
      expect(providerShare).toBeLessThan(order.totalIdr);
      await providerRefunded(intent.id, providerShare);
      const net = order.totalIdr - providerShare;

      await deliver(world, event);

      await expectVoided(order, { ticketId, api });
      // Never paid out twice: ours + the provider's == what the guest paid.
      const refunds = await refundsOf(world, intent.id);
      expect(refundedSum(refunds)).toBe(net);
      expect(refundedSum(refunds) + providerShare).toBe(order.totalIdr);
      for (const refund of await refundDetailsOf(world, intent.id)) {
        expect(refund.requestedBy).toBe("system:facility");
        expect(refund.reason).not.toMatch(/qr/i);
        expect(refund.amount).toBeLessThanOrEqual(net);
      }
    },
  );

  it("BRK-1013-02 the same paid event delivered again, many times, adds no refund and does not revive the order", async () => {
    const { ticketId, api, order, intentId, event } =
      await settledThenProviderRefunded(1_000);
    const net = order.totalIdr - 1_000;

    await deliver(world, event);
    const first = await refundsOf(world, intentId);
    expect(refundedSum(first)).toBe(net);

    for (let replay = 0; replay < 3; replay += 1) await deliver(world, event);

    expect(await refundsOf(world, intentId)).toEqual(first);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(net);
    await expectVoided(order, { ticketId, api });
  });

  it("BRK-1013-03 the provider gave everything back (net 0): the order is voided and we refund nothing", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const api = memberApi(world, member);
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    await settle(world, intent.id, order.totalIdr);
    const event = await paidEvent(world, intent.id);
    await providerRefunded(intent.id, order.totalIdr);

    await deliver(world, event);

    await expectVoided(order, { ticketId, api });
    // Nothing is left in the code: a refund of ours would pay the guest twice.
    expect(refundedSum(await refundsOf(world, intent.id))).toBe(0);
  });

  it("BRK-1013-05 two codes settle in full, one partly refunded by the provider: the second code is a double payment fund, the order is voided, the refunded code gets its net, the intact one a full refund; nobody is paid more than they paid", async () => {
    // Settling order decides: the refunded code settles first and pays the link
    // (but its net is below the total); the intact code settles second, which
    // books it as a `double_payment` fund (net to the bill 0), so it can never
    // be the payer, whichever paid event the worker consumes first.
    for (const first of ["refunded", "intact"] as const) {
      const member = await newMember(world);
      const ticketId = await seedTicket(world, member);
      const api = memberApi(world, member);
      const order = await placeOrder(world, member, ticketId);
      const token = await payLink(world, member, ticketId, order.id);
      const refundedCode = await openIntent(world, token);
      const intactCode = await openSecondIntent(world, token);
      await settle(world, refundedCode.id, order.totalIdr);
      await settle(world, intactCode.id, order.totalIdr);
      const events = {
        refunded: await paidEvent(world, refundedCode.id),
        intact: await paidEvent(world, intactCode.id),
      };
      await providerRefunded(refundedCode.id, 1_000);

      for (const key of first === "refunded"
        ? (["refunded", "intact"] as const)
        : (["intact", "refunded"] as const))
        await deliver(world, events[key]);

      await expectVoided(order, { ticketId, api });
      // The refunded code is paid back only what is left in it (the provider
      // already returned Rp1.000); the intact code is paid back in full.
      const refundedBack = refundedSum(await refundsOf(world, refundedCode.id));
      const intactBack = refundedSum(await refundsOf(world, intactCode.id));
      expect(refundedBack, `first=${first}`).toBe(order.totalIdr - 1_000);
      expect(intactBack, `first=${first}`).toBe(order.totalIdr);
      // Money out: 2 x total - Rp1.000 from us plus Rp1.000 from the provider is
      // exactly what the guest paid, never more.
      expect(refundedBack + intactBack).toBe(2 * order.totalIdr - 1_000);
      expect(refundedBack + intactBack + 1_000).toBe(2 * order.totalIdr);

      // Replays change nothing.
      for (const key of ["refunded", "intact"] as const)
        await deliver(world, events[key]);
      expect(refundedSum(await refundsOf(world, refundedCode.id))).toBe(
        refundedBack,
      );
      expect(refundedSum(await refundsOf(world, intactCode.id))).toBe(
        intactBack,
      );
      const linked = await linkedOf(world, order.id);
      expect(linked.status).toBe("cancelled");
      expect(linked.paidIntentId).toBeNull();
    }
  });

  it("BRK-1013-06 two codes settle in full and BOTH were partly refunded by the provider: voided; code one gets its net, the fund refund of code two cannot be approved or paid beyond its net (blocked)", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const api = memberApi(world, member);
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const one = await openIntent(world, token);
    const two = await openSecondIntent(world, token);
    await settle(world, one.id, order.totalIdr);
    await settle(world, two.id, order.totalIdr);
    const events = [
      await paidEvent(world, one.id),
      await paidEvent(world, two.id),
    ];
    await providerRefunded(one.id, 1_000);
    // As in production, the provider refund of the second code names the
    // transaction evidence that the double-payment fund of that code rests on.
    await providerRefunded(two.id, 2_000, await evidenceOf(two.id));

    for (const event of events) await deliver(world, event);

    await expectVoided(order, { ticketId, api });
    // Code one (the payer of the link) is paid back its net.
    expect(refundedSum(await refundsOf(world, one.id))).toBe(
      order.totalIdr - 1_000,
    );
    // Code two is a fund: a fund cannot be refunded in part, so the provider
    // refund blocks it. No refund of it may be approved, in progress or paid
    // (money out), and nothing in any state may be above the amount paid.
    const netTwo = order.totalIdr - 2_000;
    const twoRefunds = await refundsOf(world, two.id);
    const MONEY_OUT = ["approved", "processing", "completed", "paid", "sent"];
    expect(
      refundedSum(twoRefunds.filter((r) => MONEY_OUT.includes(r.status))),
      "money out for code two stays within its net",
    ).toBeLessThanOrEqual(netTwo);
    for (const refund of twoRefunds)
      if (refund.amount > netTwo)
        expect(MONEY_OUT, `refund ${refund.id} above net`).not.toContain(
          refund.status,
        );
  });

  it("BRK-1013-04 a fully paid breakfast of the same tenant is not touched by another order's provider refund", async () => {
    const refunded = await settledThenProviderRefunded(1_000);

    // A second guest pays in full, no provider refund.
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    await settle(world, intent.id, order.totalIdr);
    const event = await paidEvent(world, intent.id);
    const providerRowsBefore = await providerRefundCount();

    await deliver(world, refunded.event);
    await deliver(world, event);

    // The refunded order is voided (control that the rule fired)...
    expect((await linkedOf(world, refunded.order.id)).status).toBe("cancelled");
    // ...and the untouched one is paid in full with no refund at all.
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("paid");
    expect(linked.paid).toBe(order.totalIdr);
    expect(linked.paidIntentId).toBe(intent.id);
    expect(await refundsOf(world, intent.id)).toHaveLength(0);
    expect(await providerRefundCount()).toBe(providerRowsBefore);
  });
});
