// Breakfast pay + fire under concurrency (bead oa0qk; founder decision Q43;
// "jangan sampai rugi"). Two or more real database connections run the pay
// consumer (`payment.paid` -> deliverOrderPaymentEvent), the staff fire endpoint,
// the worker sweep and member cancel at the same time. Whatever order they
// interleave in, the state must stay consistent: a kitchen ticket exists only
// for an order that is paid AND fired, nothing is marked paid twice, and no
// intent is refunded for more than it paid. Written from
// docs/briefs/sub-oa0qk-breakfast-pay.md and the shared contract, not from the
// implementation.
//
// Ids: BRK-CONC-01 pay consumer vs fire, BRK-CONC-02 two intents at once,
// BRK-CONC-03 cancel vs pay and cancel vs cancel, BRK-CONC-04 sweep vs fire.
//
// Assumptions:
// - Either side of a race may win: fire answers 200 (the consumer committed
//   first) or 409 BREAKFAST_NOT_PAID (fire first); both are correct as long as
//   the final state agrees with the answer.
// - The forced-overlap case holds the order and linked-order row locks from a
//   third connection so both operations queue behind it. The wait for queued
//   backends is best effort (it never fails the test), so a faster path that
//   does not block (an early 409 from a plain read) still passes.
// - A cancel of a paid, unfired order refunds the full paid amount once; a
//   payment landing after a cancel is refunded in full. Both are asserted
//   through the sum of refund requests of the intent.

import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
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
  owner,
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
  waitForLockWaiters,
  type BreakfastOrderView,
  type BreakfastWorld,
  type Member,
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

type Placed = {
  member: Member;
  ticketId: string;
  order: BreakfastOrderView;
};

async function placed(): Promise<Placed> {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const order = await placeOrder(world, member, ticketId);
  return { member, ticketId, order };
}

/** An order whose payment has settled but whose event has not been consumed yet. */
async function settledNotDelivered() {
  const one = await placed();
  const token = await payLink(world, one.member, one.ticketId, one.order.id);
  const { intentId, event } = await payIntent(world, token);
  return { ...one, token, intentId, event };
}

/**
 * Global money invariants for the tenant: a kitchen ticket of a breakfast order
 * implies a paid linked order, and nothing is "fired" without a payment.
 */
async function expectNoFiredUnpaid() {
  const rows = await asOwnerTenant(world.tenant.tenantId, async (client) => {
    const tickets = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM kitchen_tickets t
         JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
         LEFT JOIN facility_linked_orders l ON l.tenant_id = t.tenant_id AND l.order_id = t.order_id
        WHERE t.tenant_id = $1 AND o.channel = 'facility'
          AND (l.order_id IS NULL OR l.paid_at IS NULL OR l.status NOT IN ('paid', 'fired'))`,
      [world.tenant.tenantId],
    );
    const fired = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facility_linked_orders
        WHERE tenant_id = $1 AND status = 'fired'
          AND (paid_at IS NULL OR paid_intent_id IS NULL OR paid_idr <> total_idr)`,
      [world.tenant.tenantId],
    );
    return {
      ticketsWithoutPayment: tickets.rows[0]!.n,
      firedUnpaid: fired.rows[0]!.n,
    };
  });
  expect(rows).toEqual({ ticketsWithoutPayment: 0, firedUnpaid: 0 });
}

/** The final state of one order agrees with the answer the fire call got. */
async function expectConsistentWithFire(
  orderId: string,
  fire: { status: number; body: { error?: { code?: string } } },
) {
  const linked = await linkedOf(world, orderId);
  const tickets = await kitchenTicketCount(world, orderId);
  expect(tickets).toBeLessThanOrEqual(1);
  if (fire.status === 200) {
    expect(linked.status).toBe("fired");
    expect(tickets).toBe(1);
    expect(linked.paidAt).not.toBeNull();
    expect(linked.paidIntentId).not.toBeNull();
    expect(linked.paid).toBe(linked.total);
  } else {
    expect(fire.status).toBe(409);
    expect(fire.body.error?.code).toBe("BREAKFAST_NOT_PAID");
    expect(linked.status).toBe("paid");
    expect(tickets).toBe(0);
  }
}

describe("BRK-CONC-01 the pay consumer and fire at the same time never fire an unpaid order", () => {
  it("BRK-CONC-01 both queue behind a held lock on the order; after release the state agrees with the fire answer", async () => {
    const { order, event } = await settledNotDelivered();
    expect((await linkedOf(world, order.id)).status).toBe("awaiting_payment");

    // Third connection holds the order and linked-order rows.
    const holder = await owner.connect();
    let released = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [world.tenant.tenantId],
      );
      await holder.query(
        "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2::uuid FOR UPDATE",
        [world.tenant.tenantId, ulidToUuid(order.id)],
      );
      await holder.query(
        "SELECT order_id FROM facility_linked_orders WHERE tenant_id = $1 AND order_id = $2::uuid FOR UPDATE",
        [world.tenant.tenantId, ulidToUuid(order.id)],
      );
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;

      const consumer = deliver(world, event);
      const fire = staffFire(world, order.id).then((response) => response);
      await waitForLockWaiters(2, holderPid);

      await holder.query("COMMIT");
      released = true;
      const [, fired] = await Promise.all([consumer, fire]);

      await expectConsistentWithFire(order.id, fired);
      expect((await linkedOf(world, order.id)).paid).toBe(order.totalIdr);
    } finally {
      if (!released) await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    await expectNoFiredUnpaid();
  });

  it("BRK-CONC-01 six orders, consumer and fire released together: every order is consistent and none is fired unpaid", async () => {
    const batch = await Promise.all(
      Array.from({ length: 6 }, () => settledNotDelivered()),
    );
    const outcomes = await Promise.all(
      batch.map(async ({ order, event }) => {
        const [, fire] = await Promise.all([
          deliver(world, event),
          staffFire(world, order.id).then((response) => response),
        ]);
        return { order, fire };
      }),
    );
    for (const { order, fire } of outcomes)
      await expectConsistentWithFire(order.id, fire);
    await expectNoFiredUnpaid();
  });

  it("BRK-CONC-01 fire repeated several times while the consumer runs fires at most once", async () => {
    const { order, event } = await settledNotDelivered();
    const [, ...fires] = await Promise.all([
      deliver(world, event),
      staffFire(world, order.id).then((response) => response),
      staffFire(world, order.id).then((response) => response),
      staffFire(world, order.id).then((response) => response),
    ]);
    for (const fire of fires) expect([200, 409]).toContain(fire.status);
    expect(await kitchenTicketCount(world, order.id)).toBeLessThanOrEqual(1);
    const linked = await linkedOf(world, order.id);
    if (fires.some((fire) => fire.status === 200)) {
      expect(linked.status).toBe("fired");
      expect(await kitchenTicketCount(world, order.id)).toBe(1);
    } else {
      expect(linked.status).toBe("paid");
      expect(await kitchenTicketCount(world, order.id)).toBe(0);
    }
    await expectNoFiredUnpaid();
  });
});

describe("BRK-CONC-02 two intents settled at the same time are paid once", () => {
  it("BRK-CONC-02 events of two intents (and a duplicate) consumed concurrently: one payer, the extra intent refunded in full once", async () => {
    const { member, ticketId, order } = await placed();
    const token = await payLink(world, member, ticketId, order.id);
    const a = await openIntent(world, token);
    const b = await openSecondIntent(world, token);
    await settle(world, a.id, order.totalIdr);
    await settle(world, b.id, order.totalIdr);
    const eventA = await paidEvent(world, a.id);
    const eventB = await paidEvent(world, b.id);

    await Promise.all([
      deliver(world, eventA),
      deliver(world, eventB),
      deliver(world, eventA),
      deliver(world, eventB),
    ]);

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("paid");
    expect(linked.paid).toBe(order.totalIdr);
    const payer = linked.paidIntentId!;
    expect([a.id, b.id]).toContain(payer);
    const extra = payer === a.id ? b.id : a.id;
    expect(await refundsOf(world, payer)).toHaveLength(0);
    const extraRefunds = await refundsOf(world, extra);
    expect(extraRefunds).toHaveLength(1);
    expect(refundedSum(extraRefunds)).toBe(order.totalIdr);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-CONC-02 a second intent settling while the first fires: the extra payment is refunded in full, the kitchen gets one ticket", async () => {
    const { order, token } = await (async () => {
      const one = await placed();
      return {
        order: one.order,
        token: await payLink(world, one.member, one.ticketId, one.order.id),
      };
    })();
    // The guest opened two codes before paying: both intents exist before the
    // link is paid (opening one after payment is refused with 409). The first
    // code is final at the provider before the second opens; its late payment
    // is still valid.
    const first = await openIntent(world, token);
    const second = await openSecondIntent(world, token);
    await settle(world, first.id, order.totalIdr);
    await deliver(world, await paidEvent(world, first.id));
    await settle(world, second.id, order.totalIdr);
    const secondEvent = await paidEvent(world, second.id);

    const [, fire] = await Promise.all([
      deliver(world, secondEvent),
      staffFire(world, order.id).then((response) => response),
    ]);

    expect(fire.status, JSON.stringify(fire.body)).toBe(200);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("fired");
    expect(linked.paidIntentId).toBe(first.id);
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    expect(refundedSum(await refundsOf(world, second.id))).toBe(order.totalIdr);
    expect(await refundsOf(world, first.id)).toHaveLength(0);
    await expectNoFiredUnpaid();
  });
});

describe("BRK-CONC-03 cancel races never refund more than was paid", () => {
  it("BRK-CONC-03 cancel and the pay consumer at the same time: the order ends cancelled and the intent is refunded exactly its payment, whichever won", async () => {
    const { member, ticketId, order, intentId, event } =
      await settledNotDelivered();
    const api = memberApi(world, member);

    const [, cancelled] = await Promise.all([
      deliver(world, event),
      api.cancel(ticketId, order.id).then((response) => response),
    ]);

    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
    const refunds = await refundsOf(world, intentId);
    expect(refundedSum(refunds)).toBe(order.totalIdr);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    await expectNoFiredUnpaid();
  });

  it("BRK-CONC-03 cancel pressed three times at once on a paid order refunds the payment once", async () => {
    const { member, ticketId, order } = await placed();
    const token = await payLink(world, member, ticketId, order.id);
    const { intentId, event } = await payIntent(world, token);
    await deliver(world, event);
    const paid = (await linkedOf(world, order.id)).paid;
    const api = memberApi(world, member);

    const responses = await Promise.all([
      api.cancel(ticketId, order.id).then((response) => response),
      api.cancel(ticketId, order.id).then((response) => response),
      api.cancel(ticketId, order.id).then((response) => response),
    ]);

    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.order.status).toBe("cancelled");
      expect(response.body.data.refundIdr).toBeLessThanOrEqual(paid);
    }
    const reported = responses.reduce(
      (sum, response) => sum + (response.body.data.refundIdr as number),
      0,
    );
    expect(reported).toBe(paid);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(paid);
    const linked = await linkedOf(world, order.id);
    expect(linked.refunded).toBe(paid);
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
  });

  it("BRK-CONC-03 cancel and staff fire on a paid order at the same time: one of them wins and the money matches", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const api = memberApi(world, member);

    const [cancelled, fire] = await Promise.all([
      api.cancel(ticketId, order.id).then((response) => response),
      staffFire(world, order.id).then((response) => response),
    ]);

    const linked = await linkedOf(world, order.id);
    const refunds = refundedSum(await refundsOf(world, intentId));
    if (linked.status === "fired") {
      // Fire won: cancel was refused and nothing was refunded.
      expect(fire.status).toBe(200);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.error.code).toBe("BREAKFAST_ALREADY_FIRED");
      expect(refunds).toBe(0);
      expect(await kitchenTicketCount(world, order.id)).toBe(1);
    } else {
      // Cancel won: refunded in full, the kitchen got nothing.
      expect(linked.status).toBe("cancelled");
      expect(cancelled.status).toBe(200);
      expect(fire.status).toBe(409);
      expect(fire.body.error.code).toBe("BREAKFAST_ORDER_CANCELLED");
      expect(refunds).toBe(order.totalIdr);
      expect(await kitchenTicketCount(world, order.id)).toBe(0);
    }
    expect(refunds).toBeLessThanOrEqual(linked.paid);
    await expectNoFiredUnpaid();
  });
});

describe("BRK-CONC-04 the sweep and staff fire never double-fire", () => {
  it("BRK-CONC-04 two sweeps and a staff fire at once on a due paid order create one kitchen ticket", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const { order } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));

    const [, , fire] = await Promise.all([
      runSweep(world),
      runSweep(world),
      staffFire(world, order.id).then((response) => response),
    ]);

    expect(fire.status, JSON.stringify(fire.body)).toBe(200);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    await expectNoFiredUnpaid();
  });

  // Fire time passed but the ticket (default: ends in 60 min) is still running,
  // so an unpaid order is not cancelled by the sweep (brief "Keputusan sweep unpaid").
  it("BRK-CONC-04 a sweep racing the pay consumer on a due order fires only if the payment committed", async () => {
    const { order, event } = await settledNotDelivered();
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));

    await Promise.all([deliver(world, event), runSweep(world)]);

    const linked = await linkedOf(world, order.id);
    const tickets = await kitchenTicketCount(world, order.id);
    expect(["paid", "fired"]).toContain(linked.status);
    expect(tickets).toBe(linked.status === "fired" ? 1 : 0);
    expect(linked.paid).toBe(order.totalIdr);
    // A later sweep fires the order that the first one had to skip.
    await runSweep(world);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
    await expectNoFiredUnpaid();
  });
});
