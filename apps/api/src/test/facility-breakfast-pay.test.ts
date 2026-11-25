// Breakfast from the access ticket must be paid before the kitchen (bead oa0qk;
// founder decision Q43; PRD §3 F22 "Sarapan Siap Saat Keluar Shower", FAC-10;
// money rules "jangan sampai rugi"). Real Express app, Better Auth, the WS-05
// payment service and PostgreSQL with RLS in one isolated tenant. Written from
// docs/briefs/sub-oa0qk-breakfast-pay.md and the shared contract, not from the
// implementation. Concurrency lives in facility-breakfast-concurrency.test.ts.
//
// Ids: BRK-PAY-01 unpaid never reaches the KDS, BRK-PAY-02 double payment,
// BRK-PAY-03 cancel and refund, BRK-PAY-04 create idempotency and ticket rules,
// BRK-PAY-05 dead order or ended session cannot be paid (link closed),
// BRK-PAY-06 fire writes order.paid exactly once.
//
// Assumptions (see facility-breakfast-helpers.ts for the adapters):
// - Order states: awaiting_payment -> paid -> fired, or cancelled. "paid" means
//   settled and waiting for fireAt.
// - A cancel refund is a refund request on the paid intent; the refund is
//   created at request time (pending approval), so the sum of refund requests
//   of the intent is what "refunded" means.
// - When two intents settle, the one whose event is consumed first pays the
//   order; the other is refunded in full. The tests assert the invariant (one
//   payer, the other fully refunded, nothing else) in both delivery orders.
// - A different member cannot see or change someone else's order: 403 or 404.
// - BRK-PAY-07 (brief sub-oa0qk-endsat.md): a breakfast fired at or after the
//   access ticket's ends_at is cancelled with a full refund requested by
//   'system:facility' (reason text without "QR"); the DB trigger agrees.
// - Raw inserts into kitchen_tickets for an unpaid facility order fail with
//   SQLSTATE 23514 and constraint kitchen_tickets_breakfast_paid.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader } from "./helpers.ts";
import { routeFiredItemsToKitchen } from "../services/kds.service.ts";
import { idempotentPaymentAdminWrite } from "../services/payment-admin-idempotency.ts";
import {
  MINUTE,
  asOwnerTenant,
  breakfastBody,
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
  payIntent,
  payLink,
  placeOrder,
  placePaidOrder,
  refundDetailsOf,
  refundedSum,
  refundsOf,
  owner,
  removeGateway,
  runSweep,
  seedTicket,
  setFireAt,
  settle,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";

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

/** The error a promise rejects with (fails when it resolves). */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; code?: string; message?: string };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

/** A raw kitchen_tickets insert as the migration owner; returns the pg error or null. */
async function rawKitchenTicket(orderId: string) {
  try {
    await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no, status, priority, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), 'new', 0, now())`,
        [
          randomUUID(),
          world.tenant.tenantId,
          world.tenant.outletId,
          ulidToUuid(orderId),
          world.ids.station,
          randomUUID(),
        ],
      ),
    );
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
}

async function orderItemUlids(orderId: string): Promise<string[]> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows.map((row) => uuidToUlid(row.id));
  });
}

/**
 * Breakfast refunds come from the facility, never from the QR channel: the
 * requester is 'system:facility' and the reason text does not mention "QR".
 */
function expectFacilityRefunds(
  refunds: { requestedBy: string; reason: string }[],
) {
  expect(refunds.length).toBeGreaterThan(0);
  for (const refund of refunds) {
    expect(refund.requestedBy).toBe("system:facility");
    expect(refund.reason).not.toMatch(/qr/i);
  }
}

async function newTicket(options: { endsInMinutes?: number } = {}) {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member, options);
  return { member, ticketId, api: memberApi(world, member) };
}

describe("BRK-PAY-01 an unpaid breakfast never reaches the kitchen", () => {
  it("BRK-PAY-01 the staff fire endpoint refuses an unpaid order with BREAKFAST_NOT_PAID and nothing reaches the KDS", async () => {
    const { member, ticketId } = await newTicket();
    const order = await placeOrder(world, member, ticketId);

    const fired = await staffFire(world, order.id);
    expect(fired.status, JSON.stringify(fired.body)).toBe(409);
    expect(fired.body.error.code).toBe("BREAKFAST_NOT_PAID");

    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("awaiting_payment");
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status === "held",
      ),
    ).toBe(true);
  });

  it("BRK-PAY-01 only staff with the facility permission can fire; anonymous gets 401", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);

    const asMember = await api.fire(order.id);
    expect(asMember.status).toBe(403);
    const anonymous = await agent(app)
      .post(`/api/facility/breakfast-orders/${order.id}/fire`)
      .set(world.headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID() });
    expect(anonymous.status).toBe(401);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("paid");
  });

  it("BRK-PAY-01 the worker sweep keeps an unpaid order awaiting payment after its fire time while the ticket is still running", async () => {
    // Brief "Keputusan sweep unpaid": the guest may still pay until the ticket
    // session ends (access_tickets.ends_at), so the sweep neither fires nor cancels.
    const { member, ticketId } = await newTicket({ endsInMinutes: 60 });
    const order = await placeOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - 5 * MINUTE));

    await runSweep(world);
    await runSweep(world, new Date(Date.now() + 30 * MINUTE));

    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("awaiting_payment");
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status === "held",
      ),
    ).toBe(true);
  });

  it("BRK-PAY-01 once the ticket has ended the sweep cancels an unpaid order: no kitchen ticket, refund 0", async () => {
    const { member, ticketId } = await newTicket({ endsInMinutes: 60 });
    const order = await placeOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - 5 * MINUTE));

    // "now" is past the ticket's ends_at (60 min).
    await runSweep(world, new Date(Date.now() + 90 * MINUTE));

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.cancelledAt).not.toBeNull();
    expect(linked.paid).toBe(0);
    expect(linked.refunded).toBe(0);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-01 a cancelled unpaid order is not fired by the sweep either", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    expect((await api.cancel(ticketId, order.id)).status).toBeLessThan(300);
    await setFireAt(world, order.id, new Date(Date.now() - 5 * MINUTE));

    await runSweep(world);

    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("cancelled");
  });

  it("BRK-PAY-01 routeFiredItemsToKitchen refuses a facility order that is not paid (BREAKFAST_NOT_PAID, 409)", async () => {
    const { member, ticketId } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const itemIds = await orderItemUlids(order.id);
    expect(itemIds.length).toBeGreaterThan(0);

    const context = world.context;
    const error = await rejection(
      withTenant(db, context, (tx) =>
        routeFiredItemsToKitchen(tx, context, {
          outletId: world.tenant.outletId as never,
          orderId: order.id as never,
          itemIds: itemIds as never,
          actor: null,
          now: new Date(),
          onUnresolved: "skip",
        } as never),
      ),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe("BREAKFAST_NOT_PAID");
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-01 the database itself refuses a kitchen ticket for an unpaid or cancelled facility order (trigger backstop)", async () => {
    const { member, ticketId, api } = await newTicket();
    const unpaid = await placeOrder(world, member, ticketId);
    const unpaidError = await rawKitchenTicket(unpaid.id);
    expect(unpaidError).toMatchObject({
      code: "23514",
      constraint: "kitchen_tickets_breakfast_paid",
    });

    await api.cancel(ticketId, unpaid.id);
    const cancelledError = await rawKitchenTicket(unpaid.id);
    expect(cancelledError).toMatchObject({
      code: "23514",
      constraint: "kitchen_tickets_breakfast_paid",
    });
    expect(await kitchenTicketCount(world, unpaid.id)).toBe(0);
  });

  it("BRK-PAY-01 the trigger also refuses a paid order that has not been fired yet (only 'fired' passes)", async () => {
    // Paid money alone is not enough: the order must be released by the fire
    // step (staff "Kirim sekarang" or the sweep), so no other path can feed the KDS.
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    expect((await linkedOf(world, order.id)).status).toBe("paid");

    expect(await rawKitchenTicket(order.id)).toMatchObject({
      code: "23514",
      constraint: "kitchen_tickets_breakfast_paid",
    });
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-01 control: once fired, the order's kitchen ticket exists (the guard is about the fire state, not the channel)", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    expect((await staffFire(world, order.id)).status).toBe(200);

    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
  });

  it("BRK-PAY-01 a paid order waits for its fire time, then the sweep fires it exactly once", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);

    // Not due yet (fire time is ~45 minutes away): still held.
    await runSweep(world);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("paid");

    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);
    await runSweep(world);

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("fired");
    expect(linked.firedAt).not.toBeNull();
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status === "fired",
      ),
    ).toBe(true);
  });

  it("BRK-PAY-01 staff 'Kirim sekarang' fires a paid order once; pressing it again is idempotent", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);

    const first = await staffFire(world, order.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.status).toBe("fired");
    const second = await staffFire(world, order.id);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.status).toBe("fired");

    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
  });

  it("BRK-PAY-01 a cancelled order cannot be fired: BREAKFAST_ORDER_CANCELLED, no ticket", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    expect((await api.cancel(ticketId, order.id)).status).toBeLessThan(300);

    const fired = await staffFire(world, order.id);
    expect(fired.status, JSON.stringify(fired.body)).toBe(409);
    expect(fired.body.error.code).toBe("BREAKFAST_ORDER_CANCELLED");
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });
});

describe("BRK-PAY-02 double payment never marks paid twice", () => {
  it("BRK-PAY-02 the intent charges exactly the server total and the client cannot set a price", async () => {
    const { member, ticketId, api } = await newTicket();
    const injected = await api.create(
      ticketId,
      breakfastBody(world, {
        lines: [
          {
            menuItemId: world.ids.nasi,
            quantity: 1,
            unitPriceIdr: 1,
          },
        ],
      }),
    );
    expect(injected.status).toBe(422);
    const injectedTotal = await api.create(
      ticketId,
      breakfastBody(world, { totalIdr: 1 }),
    );
    expect(injectedTotal.status).toBe(422);

    const order = await placeOrder(world, member, ticketId);
    // 2 x Nasi + 1 x Kopi from the outlet price list.
    expect(order.subtotalIdr).toBe(2 * world.prices.nasi + world.prices.kopi);
    expect(order.totalIdr).toBeGreaterThanOrEqual(order.subtotalIdr);
    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    expect(intent.amountIdr).toBe(order.totalIdr);
  });

  it("BRK-PAY-02 the pay link is made once and reused; after payment there is no token to pay again", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const first = await payLink(world, member, ticketId, order.id);
    const second = await payLink(world, member, ticketId, order.id);
    expect(second).toBe(first);

    const { intentId, event } = await payIntent(world, first);
    await deliver(world, event);

    const again = await api.pay(ticketId, order.id);
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.paymentToken).toBeNull();
    expect(again.body.data.order.status).toBe("paid");
    expect((await linkedOf(world, order.id)).paidIntentId).toBe(intentId);
  });

  it("BRK-PAY-02 the same payment.paid event delivered twice marks the order paid once and refunds nothing", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const { intentId, event } = await payIntent(world, token);

    await deliver(world, event);
    const afterFirst = await linkedOf(world, order.id);
    await deliver(world, event);
    const afterSecond = await linkedOf(world, order.id);

    expect(afterFirst.status).toBe("paid");
    expect(afterFirst.paid).toBe(order.totalIdr);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.paidIntentId).toBe(intentId);
    expect(await refundsOf(world, intentId)).toHaveLength(0);

    const menu = await api.menu(ticketId);
    expect(menu.status).toBe(200);
    expect(menu.body.data.order.status).toBe("paid");
    expect(menu.body.data.order.totalIdr).toBe(order.totalIdr);
  });

  for (const first of ["A", "B"] as const) {
    it(`BRK-PAY-02 a second intent that also settles (event of ${first} consumed first): one payer, the extra intent is refunded in full`, async () => {
      const { member, ticketId } = await newTicket();
      const order = await placeOrder(world, member, ticketId);
      const token = await payLink(world, member, ticketId, order.id);
      // The guest opens a second code on the same link and pays both.
      const a = await openIntent(world, token);
      const b = await openSecondIntent(world, token);
      expect(b.id).not.toBe(a.id);
      await settle(world, a.id, order.totalIdr);
      await settle(world, b.id, order.totalIdr);
      const events = {
        A: await paidEvent(world, a.id),
        B: await paidEvent(world, b.id),
      };

      for (const key of first === "A"
        ? (["A", "B"] as const)
        : (["B", "A"] as const))
        await deliver(world, events[key]);

      const linked = await linkedOf(world, order.id);
      expect(linked.status).toBe("paid");
      expect(linked.paid).toBe(order.totalIdr);
      const payer = linked.paidIntentId;
      expect([a.id, b.id]).toContain(payer);
      const extra = payer === a.id ? b.id : a.id;

      // The payer is never refunded; the extra intent is refunded in full, once.
      expect(await refundsOf(world, payer!)).toHaveLength(0);
      const extraRefunds = await refundsOf(world, extra);
      expect(extraRefunds).toHaveLength(1);
      expect(refundedSum(extraRefunds)).toBe(order.totalIdr);
      // Guest paid 2x, the outlet keeps exactly one total.
      expect(2 * order.totalIdr - refundedSum(extraRefunds)).toBe(linked.paid);
      expectFacilityRefunds(await refundDetailsOf(world, extra));
      expect(await kitchenTicketCount(world, order.id)).toBe(0);

      // Redelivering both events changes nothing.
      for (const key of ["A", "B"] as const) await deliver(world, events[key]);
      expect(await linkedOf(world, order.id)).toEqual(linked);
      expect(refundedSum(await refundsOf(world, extra))).toBe(order.totalIdr);
      expect(await refundsOf(world, payer!)).toHaveLength(0);
    });
  }

  it("BRK-PAY-02 a payment that lands after the order was fired is refunded in full and fires nothing more", async () => {
    const { member, ticketId } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    // The guest opened two codes before paying; both intents exist before the
    // link is paid (opening one after payment is refused with 409).
    const first = await openIntent(world, token);
    const late = await openSecondIntent(world, token);
    await settle(world, first.id, order.totalIdr);
    await deliver(world, await paidEvent(world, first.id));
    expect((await staffFire(world, order.id)).status).toBe(200);
    expect(await kitchenTicketCount(world, order.id)).toBe(1);

    await settle(world, late.id, order.totalIdr);
    await deliver(world, await paidEvent(world, late.id));

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("fired");
    expect(linked.paidIntentId).not.toBe(late.id);
    expect(refundedSum(await refundsOf(world, late.id))).toBe(order.totalIdr);
    expectFacilityRefunds(await refundDetailsOf(world, late.id));
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
  });

  it("BRK-PAY-02 a payment that lands after the guest cancelled is refunded in full and the order stays cancelled", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    const cancelled = await api.cancel(ticketId, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.refundIdr).toBe(0);

    await settle(world, intent.id, order.totalIdr);
    await deliver(world, await paidEvent(world, intent.id));

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.paidIntentId).toBeNull();
    expect(refundedSum(await refundsOf(world, intent.id))).toBe(order.totalIdr);
    expectFacilityRefunds(await refundDetailsOf(world, intent.id));
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });
});

describe("BRK-PAY-03 cancel refunds at most what was paid", () => {
  it("BRK-PAY-03 cancelling before payment voids the order and refunds nothing; a new order can be placed", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);

    const cancelled = await api.cancel(ticketId, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.order.status).toBe("cancelled");
    expect(cancelled.body.data.refundIdr).toBe(0);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.cancelledAt).not.toBeNull();
    expect(linked.paid).toBe(0);
    expect(linked.refunded).toBe(0);

    // The ticket is free for a new order once the old one is cancelled.
    const next = await api.create(ticketId, breakfastBody(world));
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data.id).not.toBe(order.id);
  });

  it("BRK-PAY-03 cancelling after payment refunds exactly what was paid, once; repeating it refunds 0", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const paid = (await linkedOf(world, order.id)).paid;
    expect(paid).toBe(order.totalIdr);

    const first = await api.cancel(ticketId, order.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.order.status).toBe("cancelled");
    expect(first.body.data.refundIdr).toBeLessThanOrEqual(paid);
    expect(first.body.data.refundIdr).toBe(paid);
    const refunds = await refundsOf(world, intentId);
    expect(refundedSum(refunds)).toBeLessThanOrEqual(paid);
    expect(refundedSum(refunds)).toBe(first.body.data.refundIdr);
    expectFacilityRefunds(await refundDetailsOf(world, intentId));
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
    expect(linked.refunded).toBe(first.body.data.refundIdr);

    const again = await api.cancel(ticketId, order.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.order.status).toBe("cancelled");
    expect(again.body.data.refundIdr).toBe(0);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(paid);
    expect((await linkedOf(world, order.id)).refunded).toBe(paid);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-03 cancelling after the kitchen got it is refused with BREAKFAST_ALREADY_FIRED and refunds nothing", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    expect((await staffFire(world, order.id)).status).toBe(200);

    const cancelled = await api.cancel(ticketId, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(409);
    expect(cancelled.body.error.code).toBe("BREAKFAST_ALREADY_FIRED");

    expect(await refundsOf(world, intentId)).toHaveLength(0);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("fired");
    expect(linked.refunded).toBe(0);
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
  });

  it("BRK-PAY-03 another member cannot cancel (or pay) someone else's order", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const stranger = await newMember(world);
    const strangerApi = memberApi(world, stranger);

    const cancelled = await strangerApi.cancel(ticketId, order.id);
    expect([403, 404]).toContain(cancelled.status);
    const paid = await strangerApi.pay(ticketId, order.id);
    expect([403, 404]).toContain(paid.status);

    expect((await linkedOf(world, order.id)).status).toBe("paid");
    expect(await refundsOf(world, intentId)).toHaveLength(0);
  });
});

describe("BRK-PAY-04 create idempotency and ticket rules", () => {
  it("BRK-PAY-04 the same key and payload returns the same order; the same key with another payload is refused", async () => {
    const { ticketId, api } = await newTicket();
    const body = breakfastBody(world);
    const first = await api.create(ticketId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await api.create(ticketId, body);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const reused = await api.create(
      ticketId,
      breakfastBody(world, {
        idempotencyKey: body.idempotencyKey,
        lines: [{ menuItemId: world.ids.kopi, quantity: 1 }],
      }),
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const count = await asOwnerTenant(world.tenant.tenantId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM facility_linked_orders
          WHERE tenant_id = $1 AND access_ticket_id = $2::uuid`,
        [world.tenant.tenantId, ulidToUuid(ticketId)],
      );
      return rows[0]!.n;
    });
    expect(count).toBe(1);
  });

  it("BRK-PAY-04 a ticket holds one live breakfast order: a second order with a new key is BREAKFAST_ORDER_EXISTS", async () => {
    const { ticketId, api } = await newTicket();
    const first = await api.create(ticketId, breakfastBody(world));
    expect(first.status).toBe(201);
    const second = await api.create(ticketId, breakfastBody(world));
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("BREAKFAST_ORDER_EXISTS");
  });

  it("BRK-PAY-04 a ticket whose fire time has passed cannot take a new order: BREAKFAST_UNAVAILABLE (422)", async () => {
    // Ends in 10 minutes, so fireAt = endsAt - 15 minutes is already past.
    const { ticketId, api } = await newTicket({ endsInMinutes: 10 });
    const response = await api.create(ticketId, breakfastBody(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("BREAKFAST_UNAVAILABLE");
  });

  it("BRK-PAY-04 strict input: no lines, a quantity above the limit and unknown fields are rejected", async () => {
    const { ticketId, api } = await newTicket();
    expect(
      (await api.create(ticketId, breakfastBody(world, { lines: [] }))).status,
    ).toBe(422);
    expect(
      (
        await api.create(
          ticketId,
          breakfastBody(world, {
            lines: [{ menuItemId: world.ids.nasi, quantity: 21 }],
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await api.create(ticketId, breakfastBody(world, { status: "paid" })))
        .status,
    ).toBe(422);
  });
});

/** Public pay link: true while the guest can still open a payment on it. */
async function linkAcceptsPayment(token: string) {
  const response = await agent(app)
    .post(`/api/payments/links/${token}/intents`)
    .set(world.headers)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `brk-${randomUUID()}`,
    });
  return response.status === 201;
}

/** Every order.paid event written for the order (the sale reaching the books). */
async function orderPaidEvents(orderId: string) {
  const { rows } = await owner.query<{
    event: { payload: Record<string, unknown> };
  }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2
      ORDER BY created_at, id`,
    [world.tenant.tenantId, orderId],
  );
  return rows.map((row) => row.event);
}

async function updateTicket(ticketId: string, sql: string) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE access_tickets SET ${sql} WHERE tenant_id = $1 AND id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
}

describe("BRK-PAY-05 a dead order or ended session cannot be paid, and the link closes", () => {
  it("BRK-PAY-05 paying a cancelled order gives no pay link; the link made earlier no longer takes a payment", async () => {
    // Assumption: the brief says 422 BREAKFAST_UNAVAILABLE; the contract also
    // has BREAKFAST_ORDER_CANCELLED (409). Either is accepted; what matters is
    // that no token comes back and the old link is dead.
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    expect((await api.cancel(ticketId, order.id)).status).toBe(200);

    const again = await api.pay(ticketId, order.id);
    expect([409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(["BREAKFAST_UNAVAILABLE", "BREAKFAST_ORDER_CANCELLED"]).toContain(
      again.body.error.code,
    );
    expect(again.body.data?.paymentToken ?? null).toBeNull();
    expect(await linkAcceptsPayment(token)).toBe(false);
    expect((await linkedOf(world, order.id)).status).toBe("cancelled");
  });

  it("BRK-PAY-05 cancelling a paid order also closes its pay link", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order, token } = await placePaidOrder(world, member, ticketId);
    expect((await api.cancel(ticketId, order.id)).status).toBe(200);
    expect(await linkAcceptsPayment(token)).toBe(false);
  });

  it("BRK-PAY-05 once the ticket session has ended, pay is refused with BREAKFAST_UNAVAILABLE (422) and the link is closed", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    // The session ended a minute ago (the cleaning window keeps its order).
    await updateTicket(
      ticketId,
      `ends_at = now() - interval '1 minute', cleaning_ends_at = now() + interval '9 minutes'`,
    );

    const response = await api.pay(ticketId, order.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("BREAKFAST_UNAVAILABLE");
    expect(await linkAcceptsPayment(token)).toBe(false);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-05 a dead ticket (cancelled) refuses pay with BREAKFAST_UNAVAILABLE (422)", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    await updateTicket(ticketId, `status = 'cancelled'`);

    const response = await api.pay(ticketId, order.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("BREAKFAST_UNAVAILABLE");
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });
});

describe("BRK-PAY-06 firing books the sale exactly once", () => {
  it("BRK-PAY-06 staff fire writes one order.paid for the paid total; pressing again adds none", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    // Paying alone books nothing: the sale is recognised when the kitchen gets it.
    expect(await orderPaidEvents(order.id)).toHaveLength(0);

    expect((await staffFire(world, order.id)).status).toBe(200);
    expect((await staffFire(world, order.id)).status).toBe(200);

    const events = await orderPaidEvents(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      orderId: order.id,
      outletId: world.tenant.outletId,
      channel: "facility",
      totalIdr: order.totalIdr,
      paidGatewayIdr: order.totalIdr,
    });
  });

  it("BRK-PAY-06 the sweep also writes one order.paid, even when it runs twice", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));

    await runSweep(world);
    await runSweep(world);

    expect((await linkedOf(world, order.id)).status).toBe("fired");
    const events = await orderPaidEvents(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ totalIdr: order.totalIdr });
  });

  it("BRK-PAY-06 an unpaid, cancelled or refunded order never writes order.paid", async () => {
    const unpaid = await newTicket();
    const unpaidOrder = await placeOrder(world, unpaid.member, unpaid.ticketId);
    await staffFire(world, unpaidOrder.id);

    const cancelled = await newTicket();
    const { order: paidThenCancelled } = await placePaidOrder(
      world,
      cancelled.member,
      cancelled.ticketId,
    );
    expect(
      (await cancelled.api.cancel(cancelled.ticketId, paidThenCancelled.id))
        .status,
    ).toBe(200);
    await setFireAt(world, paidThenCancelled.id, new Date(Date.now() - MINUTE));
    await runSweep(world);

    expect(await orderPaidEvents(unpaidOrder.id)).toHaveLength(0);
    expect(await orderPaidEvents(paidThenCancelled.id)).toHaveLength(0);
  });
});

// ---- BRK-PAY-07: nothing is sent to the kitchen at or after ends_at -----------
// Decision (brief sub-oa0qk-endsat.md): a breakfast fired on or after the access
// ticket's ends_at is refused in the API and in the database trigger, even if the
// worker was down. The order is cancelled and refunded in full, as for late money.

/** The session already ended a minute ago (the cleaning window keeps its order). */
async function endSession(ticketId: string) {
  await updateTicket(
    ticketId,
    `ends_at = now() - interval '1 minute', cleaning_ends_at = now() + interval '9 minutes'`,
  );
}

/** Refund requests for the order's paid intent, with requester and reason. */
async function expectFullFacilityRefundOnce(intentId: string, paid: number) {
  const refunds = await refundDetailsOf(world, intentId);
  expect(refunds).toHaveLength(1);
  expect(refundedSum(refunds)).toBe(paid);
  expectFacilityRefunds(refunds);
}

/**
 * Marks the linked row 'fired' with fired_at = ends_at + offset (SQL interval),
 * as the owner. Paid fields stay as the payment left them.
 */
async function markFiredAt(orderId: string, offset: string) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE facility_linked_orders f
          SET status = 'fired', fired_at = a.ends_at + $3::interval
         FROM access_tickets a
        WHERE f.tenant_id = $1 AND f.order_id = $2::uuid
          AND a.tenant_id = f.tenant_id AND a.id = f.access_ticket_id`,
      [world.tenant.tenantId, ulidToUuid(orderId), offset],
    ),
  );
}

/** Raw kitchen ticket insert as the owner; resolves to the ticket id or the pg error. */
async function rawTicket(
  orderId: string,
): Promise<
  | { id: string; error: null }
  | { id: null; error: { code?: string; constraint?: string } }
> {
  const id = randomUUID();
  try {
    await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no, status, priority, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), 'new', 0, now())`,
        [
          id,
          world.tenant.tenantId,
          world.tenant.outletId,
          ulidToUuid(orderId),
          world.ids.station,
          randomUUID(),
        ],
      ),
    );
    return { id, error: null };
  } catch (error) {
    return {
      id: null,
      error: error as { code?: string; constraint?: string },
    };
  }
}

/** Raw kitchen_ticket_items insert (one line copied from the order); the pg error or null. */
async function rawTicketItem(orderId: string, ticketId: string) {
  try {
    await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO kitchen_ticket_items
           (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id, variant_id, name, quantity, status, fired_at)
         SELECT $1, i.tenant_id, i.outlet_id, $2, i.order_id, i.id, i.menu_item_id, NULL, i.name, i.quantity, 'queued', now()
           FROM order_items i
          WHERE i.tenant_id = $3 AND i.order_id = $4::uuid
          LIMIT 1`,
        [randomUUID(), ticketId, world.tenant.tenantId, ulidToUuid(orderId)],
      ),
    );
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
}

describe("BRK-PAY-07 a breakfast is never sent to the kitchen at or after the ticket's ends_at", () => {
  it("BRK-PAY-07 the sweep after ends_at (worker was down) cancels a paid order and requests one full refund from the facility", async () => {
    const { member, ticketId } = await newTicket({ endsInMinutes: 60 });
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - 5 * MINUTE));

    // The worker only wakes up 90 minutes later: past the ticket's ends_at (60 min).
    await runSweep(world, new Date(Date.now() + 90 * MINUTE));

    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.cancelledAt).not.toBeNull();
    expect(linked.firedAt).toBeNull();
    expect(linked.paid).toBe(order.totalIdr);
    await expectFullFacilityRefundOnce(intentId, order.totalIdr);
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status !== "fired",
      ),
    ).toBe(true);

    // Running the sweep again: no second refund, no sale booked.
    await runSweep(world, new Date(Date.now() + 95 * MINUTE));
    expect((await linkedOf(world, order.id)).status).toBe("cancelled");
    await expectFullFacilityRefundOnce(intentId, order.totalIdr);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect(await orderPaidEvents(order.id)).toHaveLength(0);
  });

  it("BRK-PAY-07 control: a sweep before ends_at still fires the paid order (and requests no refund)", async () => {
    const { member, ticketId } = await newTicket({ endsInMinutes: 60 });
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));

    await runSweep(world, new Date(Date.now() + 30 * MINUTE));

    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    expect(await refundsOf(world, intentId)).toHaveLength(0);
  });

  it("BRK-PAY-07 staff 'Kirim sekarang' after ends_at gets 422 BREAKFAST_UNAVAILABLE, yet the cancel and full refund are kept", async () => {
    const { member, ticketId } = await newTicket({ endsInMinutes: 60 });
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    await endSession(ticketId);

    const fired = await staffFire(world, order.id);
    expect(fired.status, JSON.stringify(fired.body)).toBe(422);
    expect(fired.body.error.code).toBe("BREAKFAST_UNAVAILABLE");

    // The error does not roll back the cancel and the refund request.
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.firedAt).toBeNull();
    await expectFullFacilityRefundOnce(intentId, order.totalIdr);

    // Pressing it again never refunds a second time and never feeds the kitchen.
    const again = await staffFire(world, order.id);
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    await expectFullFacilityRefundOnce(intentId, order.totalIdr);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect(await orderPaidEvents(order.id)).toHaveLength(0);
  });

  it("BRK-PAY-07 the database trigger refuses kitchen rows for an order fired at or after ends_at, and lets one fired before it through", async () => {
    // Refused: fired exactly at ends_at (the boundary counts as ended) and later.
    for (const offset of ["0 seconds", "5 minutes"]) {
      const { member, ticketId } = await newTicket();
      const { order } = await placePaidOrder(world, member, ticketId);
      await markFiredAt(order.id, offset);

      const attempt = await rawTicket(order.id);
      expect(attempt.error, `offset ${offset}`).toMatchObject({
        code: "23514",
        constraint: "kitchen_tickets_breakfast_paid",
      });
      expect(await kitchenTicketCount(world, order.id)).toBe(0);
    }

    // The items table has the same guard: a ticket made while the order was
    // still inside the window cannot take lines once fired_at is past ends_at.
    const late = await newTicket();
    const { order: lateOrder } = await placePaidOrder(
      world,
      late.member,
      late.ticketId,
    );
    await markFiredAt(lateOrder.id, "-1 minute");
    const ticket = await rawTicket(lateOrder.id);
    expect(ticket.error).toBeNull();
    await markFiredAt(lateOrder.id, "1 minute");
    expect(await rawTicketItem(lateOrder.id, ticket.id!)).toMatchObject({
      code: "23514",
      constraint: "kitchen_tickets_breakfast_paid",
    });

    // Control: fired one second before ends_at passes both inserts.
    const ok = await newTicket();
    const { order: okOrder } = await placePaidOrder(
      world,
      ok.member,
      ok.ticketId,
    );
    await markFiredAt(okOrder.id, "-1 second");
    const okTicket = await rawTicket(okOrder.id);
    expect(okTicket.error).toBeNull();
    expect(await rawTicketItem(okOrder.id, okTicket.id!)).toBeNull();
    expect(await kitchenTicketCount(world, okOrder.id)).toBe(1);
  });
});

describe("BRK-PAY-08 the breakfast refund key is reserved for the system", () => {
  it("BRK-PAY-08 a staff user cannot pre-claim facility-breakfast-refund:* (422 IDEMPOTENCY_KEY_RESERVED), so the system refund can still be filed", async () => {
    let ran = false;
    await expect(
      withTenant(db, world.context, (tx) =>
        idempotentPaymentAdminWrite(
          tx,
          world.context,
          world.staff.userId,
          `facility-breakfast-refund:cancel:${randomUUID()}`,
          "refund.create",
          { paymentIntentId: randomUUID(), reason: "Pre-claim kunci sistem" },
          async () => {
            ran = true;
            return null;
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_RESERVED" });
    expect(ran).toBe(false);
  });
});

describe("1269 F0 breakfast of a shower ticket while the shower is off", () => {
  const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
  const was = flag.FACILITY_SHOWER_ENABLED;
  afterEach(() => {
    flag.FACILITY_SHOWER_ENABLED = was;
  });

  it("no new order and no pay link (403); the guest can still cancel", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const other = await newTicket();
    flag.FACILITY_SHOWER_ENABLED = false;

    const created = await other.api.create(
      other.ticketId,
      breakfastBody(world),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    expect(created.body.error.code).toBe("FACILITY_SHOWER_DISABLED");

    const paid = await api.pay(ticketId, order.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(403);
    expect(paid.body.error.code).toBe("FACILITY_SHOWER_DISABLED");
    expect((await linkedOf(world, order.id)).status).toBe("awaiting_payment");

    expect((await api.cancel(ticketId, order.id)).status).toBe(200);
  });

  it("the pay link of an ended ticket is closed, not left open by the gate", async () => {
    const { member, ticketId, api } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    await updateTicket(
      ticketId,
      `ends_at = now() - interval '1 minute', cleaning_ends_at = now() + interval '9 minutes'`,
    );
    flag.FACILITY_SHOWER_ENABLED = false;

    const response = await api.pay(ticketId, order.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("BREAKFAST_UNAVAILABLE");
    expect(await linkAcceptsPayment(token)).toBe(false);
    expect((await linkedOf(world, order.id)).status).toBe("cancelled");
  });
});
