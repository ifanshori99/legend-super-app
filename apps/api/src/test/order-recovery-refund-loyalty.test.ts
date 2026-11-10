// legend-h1dyy (Codex finding 2): a rejected QR pay-first recovery refund
// appends `order_issue.refund_reversal_requested`; the loyalty consumer gives
// back the points the matching `order.refunded` (payload.refundId = issue id)
// took, and the refunded eligible spend, once.
//
// The loyalty consumer is driven with the stored events (pattern of
// member-earn.test.ts): `order.refunded` is appended to `domain_event_outbox`
// (the consumer reads the refunded amount from there) and then delivered; the
// reversal envelope is built with the catalog definition the service uses.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import {
  DATE,
  NEXT_DAY,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  owner,
  profileOf,
  recordOf,
  seedMember,
  seedOrder,
  seedProgram,
  visitCount,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const REVERSAL = "order_issue.refund_reversal_requested";

/** 1 point per 1.000: a 100.000 QR order books 100 points. */
async function paidQrOrder(world: World, memberId: string) {
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    channel: "qr",
    profileId: memberId,
    grossSalesIdr: 100_000,
  });
  await deliver(
    world,
    orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      channel: "qr",
      grossSalesIdr: 100_000,
    }),
  );
  return orderUlid;
}

/** Stores `order.refunded` in the outbox like the recovery refund does. */
async function storeEvent(world: World, event: EventEnvelope): Promise<void> {
  await withTenant(db, world.context, (tx) =>
    appendOutbox(tx, world.context, {
      id: createUlid(),
      event,
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
}

function reversalEvent(
  world: World,
  input: { orderUlid: string; issueId: string; amountIdr: number },
): EventEnvelope {
  const definition = qrOrderEvents[REVERSAL];
  return definition.envelopeSchema.parse({
    id: createUlid(),
    tenantId: world.tenantId,
    outletId: world.outletA,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.issueId,
    sequence: 1,
    occurredAt: NEXT_DAY,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.issueId}:1`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: input.orderUlid,
      orderIssueId: input.issueId,
      refundId: randomUUID(),
      amountIdr: input.amountIdr,
      rejectedAt: NEXT_DAY,
    },
  }) as EventEnvelope;
}

describe("ORD-09 rejected recovery refund gives the loyalty points back", () => {
  it("ORD-09 half refund takes 50 of 100 points; the rejection credits 50 back once", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1_000 });
    const member = await seedMember(world.tenantId);
    const orderUlid = await paidQrOrder(world, member.id);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    const issueId = randomUUID();
    const refunded = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      refundId: issueId,
      grossSalesIdr: 50_000,
    });
    await storeEvent(world, refunded);
    await deliver(world, refunded);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(
      Number((await profileOf(world.tenantId, member.id)).lifetime_spend_idr),
    ).toBe(50_000);

    const reversal = reversalEvent(world, {
      orderUlid,
      issueId,
      amountIdr: 50_000,
    });
    await deliver(world, reversal);

    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      reversed_points: "0",
      refunded_eligible_idr: "0",
      reversal_shortfall_points: "0",
    });
    const adjusts = (await ledgerOf(world.tenantId, member.id)).filter(
      (row) => row.type === "adjust",
    );
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0]).toMatchObject({
      points: "50",
      source_type: "adjustment",
      source_id: issueId,
    });
    expect(adjusts[0]!.expires_at).not.toBeNull();
    const profile = await profileOf(world.tenantId, member.id);
    expect(Number(profile.lifetime_spend_idr)).toBe(100_000);
    expect(await visitCount(world.tenantId, member.id)).toBe(1);

    // Replay of the reversal and of the original refund: nothing changes.
    await deliver(world, reversal);
    await deliver(world, refunded);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(
      (await ledgerOf(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(1);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      reversed_points: "0",
      refunded_eligible_idr: "0",
    });
    expect(
      Number((await profileOf(world.tenantId, member.id)).lifetime_spend_idr),
    ).toBe(100_000);
  });

  it("ORD-09 a rejection of a refund loyalty never applied changes nothing", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1_000 });
    const member = await seedMember(world.tenantId);
    const orderUlid = await paidQrOrder(world, member.id);

    await deliver(
      world,
      reversalEvent(world, {
        orderUlid,
        issueId: randomUUID(),
        amountIdr: 50_000,
      }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(
      (await ledgerOf(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(0);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      reversed_points: "0",
      refunded_eligible_idr: "0",
    });
  });

  it("ORD-09 single-line order fully refunded then rejected: the visit comes back; a later full refund drops visits_count by exactly 1", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1_000 });
    const member = await seedMember(world.tenantId);
    // A second paid order keeps a visit counted, so a double drop shows.
    await paidQrOrder(world, member.id);
    const orderUlid = await paidQrOrder(world, member.id);

    const issueId = randomUUID();
    const refunded = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      refundId: issueId,
      grossSalesIdr: 100_000,
    });
    await storeEvent(world, refunded);
    await deliver(world, refunded);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect((await recordOf(world.tenantId, orderUlid))?.state).toBe("reversed");
    expect(await visitCount(world.tenantId, member.id)).toBe(1);
    expect((await profileOf(world.tenantId, member.id)).visits_count).toBe(1);

    await deliver(
      world,
      reversalEvent(world, { orderUlid, issueId, amountIdr: 100_000 }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      reversed_points: "0",
      refunded_eligible_idr: "0",
    });
    expect(
      Number((await profileOf(world.tenantId, member.id)).lifetime_spend_idr),
    ).toBe(200_000);
    // The visit the refund removed is back: the row and visits_count.
    expect(await visitCount(world.tenantId, member.id)).toBe(2);
    expect((await profileOf(world.tenantId, member.id)).visits_count).toBe(2);
    const [visit] = await asTenant(world.tenantId, async (client) => {
      const { rows } = await client.query<{
        spend_idr: string;
        outlet_id: string;
        business_date: string;
      }>(
        `SELECT spend_idr::text, outlet_id, business_date::text
           FROM customer_visits WHERE tenant_id = $1 AND order_id = $2`,
        [world.tenantId, ulidToUuid(orderUlid)],
      );
      return rows;
    });
    expect(visit).toMatchObject({
      spend_idr: "100000",
      outlet_id: world.outletA,
      business_date: DATE,
    });

    // A later full refund of the order (another issue) removes the visit
    // once: visits_count 2 -> 1.
    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        refundId: randomUUID(),
        grossSalesIdr: 100_000,
      }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await visitCount(world.tenantId, member.id)).toBe(1);
    expect((await profileOf(world.tenantId, member.id)).visits_count).toBe(1);
  });
});
