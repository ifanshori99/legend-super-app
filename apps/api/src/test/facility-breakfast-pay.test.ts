// Breakfast from the access ticket must be paid before the kitchen (bead oa0qk;
// founder decision Q43; PRD §3 F22 "Sarapan Siap Saat Keluar Shower", FAC-10;
// money rules "jangan sampai rugi"). Real Express app, Better Auth, the WS-05
// payment service and PostgreSQL with RLS in one isolated tenant. Written from
// docs/briefs/sub-oa0qk-breakfast-pay.md and the shared contract, not from the
// implementation. Concurrency lives in facility-breakfast-concurrency.test.ts.
//
// Ids: BRK-PAY-01 unpaid never reaches the KDS, BRK-PAY-02 double payment,
// BRK-PAY-03 cancel and refund, BRK-PAY-04 create idempotency and ticket rules.
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
// - Raw inserts into kitchen_tickets for an unpaid facility order fail with
//   SQLSTATE 23514 and constraint kitchen_tickets_breakfast_paid.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader } from "./helpers.ts";
import { routeFiredItemsToKitchen } from "../services/kds.service.ts";
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
  orderItemFireStatuses,
  paidEvent,
  payIntent,
  payLink,
  placeOrder,
  placePaidOrder,
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
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, status, priority, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'new', 0, now())`,
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

  it("BRK-PAY-01 the worker sweep skips an unpaid order even when its fire time has passed", async () => {
    const { member, ticketId } = await newTicket();
    const order = await placeOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - 5 * MINUTE));

    await runSweep(world);
    await runSweep(world, new Date(Date.now() + 120 * MINUTE));

    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("awaiting_payment");
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status === "held",
      ),
    ).toBe(true);
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

  it("BRK-PAY-01 the trigger lets a paid order through (control: the guard is about payment, not the channel)", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    expect((await linkedOf(world, order.id)).status).toBe("paid");

    expect(await rawKitchenTicket(order.id)).toBeNull();
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
      const b = await openIntent(world, token);
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
    const { order, token } = await placePaidOrder(world, member, ticketId);
    expect((await staffFire(world, order.id)).status).toBe(200);
    expect(await kitchenTicketCount(world, order.id)).toBe(1);

    const late = await openIntent(world, token);
    await settle(world, late.id, order.totalIdr);
    await deliver(world, await paidEvent(world, late.id));

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("fired");
    expect(linked.paidIntentId).not.toBe(late.id);
    expect(refundedSum(await refundsOf(world, late.id))).toBe(order.totalIdr);
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
