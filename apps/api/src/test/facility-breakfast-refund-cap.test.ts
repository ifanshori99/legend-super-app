// Breakfast money vs the admin refund cap (bead oa0qk, commit 0c130f50; founder
// rule "jangan sampai rugi"). Real Express app, Better Auth, the WS-05 payment
// service and PostgreSQL with RLS in one isolated tenant. Written from
// docs/briefs/sub-oa0qk-breakfast-pay.md and the shared contract, not from the
// implementation. Reuses facility-breakfast-helpers.ts.
//
// Ids: BRK-PAY-05 a fired breakfast is a sale, so its paid intent can no longer
// be refunded; BRK-PAY-06 a paid order whose intent was fully refunded before
// fire time is cancelled by the sweep instead of reaching the kitchen.
//
// Assumptions:
// - "Refundable balance" is `cap - reserved` of `refundableBalance(tx, intent,
//   { lockDeposit: false })` (payment-admin.service, as order-recovery-refund
//   tests read it): pending refunds reserve their amount.
// - Admin refund request is `POST /api/payments/admin/refunds` (shared
//   createRefundInputSchema), filed by a user holding `payment.reconcile`. A
//   request above the refundable balance is refused with 409, as in
//   payment-admin-api (PAY-04 concurrent refunds). A control request on an
//   unfired paid order proves the permission/setup works, so the 409 can only
//   come from the cap.
// - "Fully refunded before fire time" is a pending admin refund request for the
//   whole paid amount (pending refunds reserve it, so the balance is 0).
// - A cancelled-by-sweep order raises no extra refund request: the only refund
//   rows of the intent stay the one the admin filed.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import { createApp } from "../app.ts";
import { originHeader } from "./helpers.ts";
import {
  MINUTE,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  kitchenTicketCount,
  linkedOf,
  memberApi,
  newMember,
  orderItemFireStatuses,
  owner,
  placePaidOrder,
  refundedSum,
  refundsOf,
  removeGateway,
  runSweep,
  seedTicket,
  setFireAt,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import { staffOfIsolatedTenant, type Staff } from "./floor-test-helpers.ts";

let app: Express;
let world: BreakfastWorld;
let finance: Staff;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  // The seeded floor role also files refunds; the account is created after the
  // change so no cached grant is stale.
  await owner.query(
    "UPDATE roles SET permissions = permissions || '[\"payment.reconcile\"]'::jsonb WHERE id = $1",
    [world.tenant.roleId],
  );
  finance = await staffOfIsolatedTenant(app, world.tenant);
});

afterAll(async () => {
  removeGateway();
  await dropBreakfastWorld(world);
  await endPools();
});

async function newTicket() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  return { member, ticketId, api: memberApi(world, member) };
}

/** `cap - reserved` of the intent, as the admin refund module sees it. */
async function refundableOf(intentId: string): Promise<number> {
  return withTenant(db, world.context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, world.context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    expect(intent, "paid intent exists").toBeDefined();
    const balance = await refundableBalance(tx, intent!, {
      lockDeposit: false,
    });
    return Number(balance.cap) - Number(balance.reserved);
  });
}

function requestRefund(intentId: string, amountIdr: number) {
  return finance.client
    .post("/api/payments/admin/refunds")
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `brk-cap-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian sarapan uji",
    });
}

describe("BRK-PAY-05 a fired breakfast cannot be refunded through the admin refund path", () => {
  it("BRK-PAY-05 control: before the kitchen gets it, the paid intent is refundable and an admin request is accepted", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);

    const balance = await refundableOf(intentId);
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeLessThanOrEqual(order.totalIdr);

    const response = await requestRefund(intentId, 1);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe("pending");
    expect(refundedSum(await refundsOf(world, intentId))).toBe(1);
  });

  it("BRK-PAY-05 after the order is fired the refundable balance is 0 and an admin refund request is refused", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    expect(await refundableOf(intentId)).toBeGreaterThan(0);

    const fired = await staffFire(world, order.id);
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);

    expect(await refundableOf(intentId)).toBe(0);

    // The whole amount, and even the smallest amount, are over the cap.
    for (const amount of [order.totalIdr, 1]) {
      const response = await requestRefund(intentId, amount);
      expect(
        response.status,
        `refund of ${amount}: ${JSON.stringify(response.body)}`,
      ).toBe(409);
    }
    expect(await refundsOf(world, intentId)).toHaveLength(0);
    expect(await refundableOf(intentId)).toBe(0);
    // Nothing about the fired order changed.
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
  });

  it("BRK-PAY-05 an order fired by the worker sweep is capped the same way", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);

    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);
    expect((await linkedOf(world, order.id)).status).toBe("fired");

    expect(await refundableOf(intentId)).toBe(0);
    const response = await requestRefund(intentId, 1);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await refundsOf(world, intentId)).toHaveLength(0);
  });
});

describe("BRK-PAY-06 a paid order whose intent was fully refunded is cancelled at fire time", () => {
  it("BRK-PAY-06 the sweep cancels it: status cancelled, no kitchen ticket, no extra refund", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const paid = (await linkedOf(world, order.id)).paid;
    expect(paid).toBe(order.totalIdr);

    // An admin returns the whole payment before the kitchen time.
    const refund = await requestRefund(intentId, paid);
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(await refundableOf(intentId)).toBe(0);
    expect((await linkedOf(world, order.id)).status).toBe("paid");

    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.cancelledAt).not.toBeNull();
    expect(linked.firedAt).toBeNull();
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect(
      (await orderItemFireStatuses(world, order.id)).every(
        (status) => status !== "fired",
      ),
    ).toBe(true);
    // Money: only the admin's refund exists; nobody is paid back twice.
    const refunds = await refundsOf(world, intentId);
    expect(refunds).toHaveLength(1);
    expect(refundedSum(refunds)).toBe(paid);
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
  });

  it("BRK-PAY-06 running the sweep again changes nothing (no loop, no ticket, no refund)", async () => {
    const { member, ticketId } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const paid = (await linkedOf(world, order.id)).paid;
    expect((await requestRefund(intentId, paid)).status).toBe(201);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));

    await runSweep(world);
    const first = await linkedOf(world, order.id);
    expect(first.status).toBe("cancelled");

    await runSweep(world);
    await runSweep(world);
    const again = await linkedOf(world, order.id);
    expect(again.status).toBe("cancelled");
    expect(again.cancelledAt).toEqual(first.cancelledAt);
    expect(again.refunded).toBe(first.refunded);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(paid);
  });

  it("BRK-PAY-06 control: a paid order that was not refunded is still fired by the same sweep", async () => {
    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    expect(await kitchenTicketCount(world, order.id)).toBe(1);
  });
});
