// Breakfast money that arrives for a closed bill (bead 519 item 3, Codex 518;
// founder rule "jangan sampai rugi"): a guest cancels the breakfast, then the
// money still arrives (late payment / Duitku BILL_CLOSED). The gateway parks it
// as `payment_unallocated_funds` and emits `payment.funds_unallocated`; the
// breakfast consumer must hand it back, never keep it. Real Express app, Better
// Auth, the WS-05 payment service and PostgreSQL with RLS in one isolated
// tenant. Written from docs/briefs/519-breakfast-codex-fix.md and the shared
// contract, not from the implementation. Fixtures: facility-breakfast-helpers.ts.
//
// Id: BRK-PAY-09 payment.funds_unallocated of a breakfast order.
//
// Assumptions:
// - The late money is parked by the existing `recordUnsettledGatewayFunds`
//   (the function the Duitku BILL_CLOSED path calls), which writes the fund row
//   and the `payment.funds_unallocated` outbox event. The test then delivers
//   that outbox event through the existing single entry point
//   `deliverOrderPaymentEvent` (helper `deliver`), as the worker does.
// - "One full refund per fund": exactly one `payment_refunds` row with
//   `unallocated_fund_id` = the fund and `amount_idr` = the fund amount, in a
//   live status (pending, approved or completed), filed by `system:facility`,
//   with a reason text that does not mention QR (same rule as BRK-PAY-02).
// - Two parked transactions on one intent are two funds and get one refund each;
//   the sum of refunds never exceeds the money that arrived.
// - A fund of a bill that is not a breakfast order (here: a bare payment link
//   with no order) is not touched by the breakfast consumer: no refund row.
// - The cancelled order stays cancelled, unpaid and out of the kitchen.

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createPaymentLink,
  recordUnsettledGatewayFunds,
  type CreatePaymentLinkInput,
} from "../services/payment.service.ts";
import {
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
  owner,
  payLink,
  placeOrder,
  refundedSum,
  refundsOf,
  removeGateway,
  seedTicket,
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

type FundRow = { id: string; amount: number; resolution: string | null };
type FundRefund = {
  id: string;
  status: string;
  amount: number;
  requestedBy: string;
  reason: string;
};

/** Money that arrives for a bill that is already closed: parked, with its event. */
async function parkLateMoney(intentId: string, amountIdr: number) {
  const intent = await withTenant(db, world.context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, world.context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    return row;
  });
  expect(intent, "intent exists").toBeDefined();
  await recordUnsettledGatewayFunds(
    world.context,
    intent!,
    {
      provider: intent!.provider,
      providerRef: `LATE-${randomBytes(6).toString("hex")}`,
      source: "verified_webhook",
      paidAmountIdr: amountIdr,
      receivedAt: new Date(),
    },
    new Date(),
  );
}

async function fundsOf(intentId: string): Promise<FundRow[]> {
  const { rows } = await owner.query<{
    id: string;
    amount: string;
    resolution: string | null;
  }>(
    `SELECT id, amount_idr::text AS amount, resolution FROM payment_unallocated_funds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at, id`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    resolution: row.resolution,
  }));
}

/** The `payment.funds_unallocated` outbox events of the intent, oldest first. */
async function fundEvents(intentId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.funds_unallocated'
        AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function refundsOfFund(fundId: string): Promise<FundRefund[]> {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
    reason: string;
  }>(
    `SELECT id, status, amount_idr::text AS amount, requested_by, reason
       FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2`,
    [world.tenant.tenantId, fundId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
    requestedBy: row.requested_by,
    reason: row.reason,
  }));
}

async function tenantRefundCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_refunds WHERE tenant_id = $1`,
    [world.tenant.tenantId],
  );
  return rows[0]!.n;
}

/** A breakfast order whose guest opened a code, then cancelled before paying. */
async function cancelledOrderWithIntent() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const api = memberApi(world, member);
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const intent = await openIntent(world, token);
  const cancelled = await api.cancel(ticketId, order.id);
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  expect(cancelled.body.data.order.status).toBe("cancelled");
  return { order, intentId: intent.id };
}

function expectFacilityRefund(refund: FundRefund, amount: number) {
  expect(refund.amount).toBe(amount);
  expect(["pending", "approved", "completed"]).toContain(refund.status);
  expect(refund.requestedBy).toBe("system:facility");
  expect(refund.reason).not.toMatch(/qr/i);
}

describe("BRK-PAY-09 money that arrives after the breakfast was cancelled is refunded, once per fund", () => {
  it("BRK-PAY-09 the late money of a cancelled breakfast gets exactly one full refund and the order stays cancelled", async () => {
    const { order, intentId } = await cancelledOrderWithIntent();
    await parkLateMoney(intentId, order.totalIdr);

    const funds = await fundsOf(intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]!.amount).toBe(order.totalIdr);
    expect(await refundsOf(world, intentId)).toHaveLength(0);
    const events = await fundEvents(intentId);
    expect(events).toHaveLength(1);

    await deliver(world, events[0]!);

    const refunds = await refundsOfFund(funds[0]!.id);
    expect(refunds).toHaveLength(1);
    expectFacilityRefund(refunds[0]!, order.totalIdr);
    // Money out equals money in: nobody is paid back more than they paid.
    expect(refundedSum(await refundsOf(world, intentId))).toBe(order.totalIdr);

    const linked = await linkedOf(world, order.id);
    expect(linked.status).toBe("cancelled");
    expect(linked.paidIntentId).toBeNull();
    expect(linked.firedAt).toBeNull();
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
  });

  it("BRK-PAY-09 delivering the same event again, many times, adds no refund", async () => {
    const { order, intentId } = await cancelledOrderWithIntent();
    await parkLateMoney(intentId, order.totalIdr);
    const [fund] = await fundsOf(intentId);
    const [event] = await fundEvents(intentId);

    await deliver(world, event!);
    const first = await refundsOfFund(fund!.id);
    expect(first).toHaveLength(1);

    for (let replay = 0; replay < 3; replay += 1) await deliver(world, event!);

    expect(await refundsOfFund(fund!.id)).toEqual(first);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(order.totalIdr);
  });

  it("BRK-PAY-09 two separate payments parked on one intent are two funds with one full refund each, never more than was received", async () => {
    const { order, intentId } = await cancelledOrderWithIntent();
    await parkLateMoney(intentId, order.totalIdr);
    await parkLateMoney(intentId, order.totalIdr);

    const funds = await fundsOf(intentId);
    expect(funds).toHaveLength(2);
    const events = await fundEvents(intentId);
    expect(events).toHaveLength(2);

    // Delivered out of order and replayed.
    for (const event of [events[1]!, events[0]!, events[1]!, events[0]!])
      await deliver(world, event);

    for (const fund of funds) {
      const refunds = await refundsOfFund(fund.id);
      expect(refunds, `fund ${fund.id}`).toHaveLength(1);
      expectFacilityRefund(refunds[0]!, fund.amount);
    }
    const received = funds.reduce((sum, fund) => sum + fund.amount, 0);
    expect(refundedSum(await refundsOf(world, intentId))).toBe(received);
  });

  it("BRK-PAY-09 a fund that is not a breakfast bill is not touched: no refund is filed", async () => {
    // Control for the breakfast case above: the same event flow on a bill that
    // belongs to no breakfast order must leave the money for its own owner.
    const bill: CreatePaymentLinkInput = {
      outletId: world.tenant.outletId as CreatePaymentLinkInput["outletId"],
      reference: `UJI-${randomBytes(3).toString("hex")}`.toUpperCase(),
      tableLabel: null,
      pax: null,
      subtotalIdr: 50_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 50_000,
      returnPath: null,
    };
    const link = await createPaymentLink(
      world.context,
      bill,
      world.staff.userId,
    );
    const intent = await openIntent(world, link.token);
    await parkLateMoney(intent.id, 50_000);
    const [fund] = await fundsOf(intent.id);
    const events = await fundEvents(intent.id);
    expect(fund).toBeDefined();
    expect(events).toHaveLength(1);

    const before = await tenantRefundCount();
    await deliver(world, events[0]!);

    expect(await refundsOfFund(fund!.id)).toHaveLength(0);
    expect(await tenantRefundCount()).toBe(before);
    expect((await fundsOf(intent.id))[0]!.resolution).toBeNull();
  });

  it("BRK-PAY-09 a breakfast fund does not disturb another cancelled breakfast: each intent keeps only its own refund", async () => {
    const one = await cancelledOrderWithIntent();
    const two = await cancelledOrderWithIntent();
    await parkLateMoney(one.intentId, one.order.totalIdr);
    await parkLateMoney(two.intentId, two.order.totalIdr);

    await deliver(world, (await fundEvents(one.intentId))[0]!);

    expect(refundedSum(await refundsOf(world, one.intentId))).toBe(
      one.order.totalIdr,
    );
    // The second guest's money has not been delivered yet: nothing for it.
    expect(await refundsOf(world, two.intentId)).toHaveLength(0);

    await deliver(world, (await fundEvents(two.intentId))[0]!);
    expect(refundedSum(await refundsOf(world, two.intentId))).toBe(
      two.order.totalIdr,
    );
    expect(refundedSum(await refundsOf(world, one.intentId))).toBe(
      one.order.totalIdr,
    );
  });
});
