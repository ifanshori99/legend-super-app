// legend-wa4hp: a void or refund also lowers the member's visit count and
// lifetime spend, not only the points (brief 290c "Slice T2", 290c-slices "Slice V").
// Tier (3zd1) and missions (m4p5) read those two numbers.
//
// Events are synthetic envelopes delivered through the `loyalty-earn` consumer
// (`deliver`), exactly like member-earn.test.ts. Each test owns a fresh tenant.
//
// Assumptions (the spec does not spell all of them out):
// - Lifetime spend of a paid order is its eligible spend (gross - discount -
//   points tender), the same figure the earn row uses. Every order below has no
//   service charge or PBJT, so eligible = gross - paidPointsIdr.
// - A refund lowers spend by the refunded eligible amount (refund gross -
//   refundPointsIdr), as the 290a partial-refund test pins for the points.
// - A visit counts as removed when the order is voided (final order), or when
//   the cumulative refund reaches the full eligible spend. A partial refund
//   keeps the visit (visits_count and the customer_visits row stay), but the
//   row's spend_idr goes down by the same refunded amount.
// - A void of an open (not final) order changes nothing.
// - Replay guard: the same refund id / void id, delivered again as the same
//   event or as a new envelope, changes nothing a second time.
// - "Never below 0" is pinned by lowering the stored counters by hand first:
//   an order whose eligible spend is bigger than the stored lifetime spend.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import {
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
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

async function worldWithMember() {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  const member = await seedMember(world.tenantId);
  return { world, member };
}

/** Seeds the order and delivers `order.paid` for the member. */
async function pay(
  world: World,
  member: { id: string },
  input: { grossSalesIdr: number; paidPointsIdr?: number },
): Promise<string> {
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: member.id,
    grossSalesIdr: input.grossSalesIdr,
  });
  await deliver(
    world,
    orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: input.grossSalesIdr,
      paidPointsIdr: input.paidPointsIdr,
    }),
  );
  return orderUlid;
}

type VisitRow = { order_id: string; spend_idr: string };

async function visitRows(
  tenantId: string,
  profileId: string,
): Promise<VisitRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<VisitRow>(
      `SELECT order_id, spend_idr::text FROM customer_visits
        WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY order_id`,
      [tenantId, profileId],
    );
    return rows;
  });
}

const refund = (
  world: World,
  orderUlid: string,
  input: {
    refundId?: string;
    grossSalesIdr: number;
    refundPointsIdr?: number;
  },
) =>
  orderRefundedEvent(world, {
    orderUlid,
    outletId: world.outletA,
    ...input,
  });

async function totals(world: World, profileId: string) {
  const profile = await profileOf(world.tenantId, profileId);
  return {
    visits: profile.visits_count,
    spend: profile.lifetime_spend_idr,
    visitRows: await visitCount(world.tenantId, profileId),
  };
}

describe("LOY-02 wa4hp: void lowers visits and spend", () => {
  it("LOY-02 voiding a final order: visits -1, spend -= its eligible spend, its visit row is gone", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    const second = await pay(world, member, { grossSalesIdr: 50_000 });
    expect(await totals(world, member.id)).toEqual({
      visits: 2,
      spend: "150000",
      visitRows: 2,
    });

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: first,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );

    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });
    expect(
      (await visitRows(world.tenantId, member.id)).map((row) => row.order_id),
    ).toEqual([ulidToUuid(second)]);
    // The points reversal of 290a keeps working: 10 of the 15 points are gone.
    expect(await balanceOf(world.tenantId, member.id)).toBe(5);
  });

  it("LOY-02 voiding an open (not final) order changes neither visits nor spend", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await pay(world, member, { grossSalesIdr: 50_000 });
    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: first,
        outletId: world.outletA,
        voidId: null,
        voidedFinalOrder: false,
      }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 2,
      spend: "150000",
      visitRows: 2,
    });
  });

  it("LOY-02 a void after a partial refund lowers spend only by what was not yet refunded", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await pay(world, member, { grossSalesIdr: 50_000 });
    await deliver(world, refund(world, first, { grossSalesIdr: 40_000 }));
    expect((await totals(world, member.id)).spend).toBe("110000");

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: first,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    // 150.000 - 40.000 (refund) - 60.000 (rest of the order) = 50.000.
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });
  });

  it("LOY-02 replaying a void (same event, or a new envelope with the same void id) changes nothing", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await pay(world, member, { grossSalesIdr: 50_000 });
    const voidId = randomUUID();
    const voided = orderVoidedEvent(world, {
      orderUlid: first,
      outletId: world.outletA,
      voidId,
      voidedFinalOrder: true,
    });
    await deliver(world, voided);
    await deliver(world, voided);
    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: first,
        outletId: world.outletA,
        voidId,
        voidedFinalOrder: true,
      }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });
  });
});

describe("LOY-02 wa4hp: refund lowers spend, and visits when it reaches the full eligible spend", () => {
  it("LOY-02 a partial refund lowers spend by the refunded eligible amount and keeps the visit", async () => {
    const { world, member } = await worldWithMember();
    // Eligible 80.000 (100.000 gross, 20.000 paid with points).
    const first = await pay(world, member, {
      grossSalesIdr: 100_000,
      paidPointsIdr: 20_000,
    });
    await pay(world, member, { grossSalesIdr: 50_000 });
    expect((await totals(world, member.id)).spend).toBe("130000");

    // Refund of 50.000 gross, 10.000 of it paid with points: eligible 40.000.
    await deliver(
      world,
      refund(world, first, { grossSalesIdr: 50_000, refundPointsIdr: 10_000 }),
    );

    expect(await totals(world, member.id)).toEqual({
      visits: 2,
      spend: "90000",
      visitRows: 2,
    });
    const row = (await visitRows(world.tenantId, member.id)).find(
      (visit) => visit.order_id === ulidToUuid(first),
    );
    expect(row?.spend_idr).toBe("40000");
  });

  it("LOY-02 refunds that add up to the full eligible spend remove the visit, once", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await pay(world, member, { grossSalesIdr: 50_000 });

    await deliver(world, refund(world, first, { grossSalesIdr: 60_000 }));
    expect(await totals(world, member.id)).toEqual({
      visits: 2,
      spend: "90000",
      visitRows: 2,
    });

    const lastRefundId = randomUUID();
    await deliver(
      world,
      refund(world, first, {
        refundId: lastRefundId,
        grossSalesIdr: 40_000,
      }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });

    // The refund that finished the order arrives again: nothing moves.
    await deliver(
      world,
      refund(world, first, {
        refundId: lastRefundId,
        grossSalesIdr: 40_000,
      }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });
  });

  it("LOY-02 replaying a partial refund (same event, or same refund id in a new envelope) lowers spend once", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    const refundId = randomUUID();
    const event = refund(world, first, { refundId, grossSalesIdr: 30_000 });
    await deliver(world, event);
    await deliver(world, event);
    await deliver(
      world,
      refund(world, first, { refundId, grossSalesIdr: 30_000 }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "70000",
      visitRows: 1,
    });
  });

  it("LOY-02 a void after a full refund does not take the visit away a second time", async () => {
    const { world, member } = await worldWithMember();
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await pay(world, member, { grossSalesIdr: 50_000 });
    await deliver(world, refund(world, first, { grossSalesIdr: 100_000 }));
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: first,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "50000",
      visitRows: 1,
    });
  });
});

describe("LOY-02 wa4hp: counters never go below 0", () => {
  it("LOY-02 a void on counters that are already smaller than the order leaves 0, not a negative", async () => {
    const { world, member } = await worldWithMember();
    const only = await pay(world, member, { grossSalesIdr: 100_000 });
    // Counters lowered by hand (data fix, an earlier bug): smaller than the order.
    await asTenant(world.tenantId, (client) =>
      client.query(
        `UPDATE customer_profiles SET visits_count = 0, lifetime_spend_idr = 30000
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenantId, member.id],
      ),
    );

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: only,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );

    const profile = await profileOf(world.tenantId, member.id);
    expect(profile.visits_count).toBe(0);
    expect(profile.lifetime_spend_idr).toBe("0");
    expect(await visitCount(world.tenantId, member.id)).toBe(0);
  });
});

describe("LOY-02 wa4hp: a void or refund also lowers counters of a visit that booked no points", () => {
  it("LOY-02 voiding a capped order (state capped, 0 points) still lowers visits and spend", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { dailyCap: 10 });
    const member = await seedMember(world.tenantId);
    await pay(world, member, { grossSalesIdr: 100_000 });
    const capped = await pay(world, member, { grossSalesIdr: 50_000 });
    expect(await recordOf(world.tenantId, capped)).toMatchObject({
      state: "capped",
    });
    expect(await totals(world, member.id)).toEqual({
      visits: 2,
      spend: "150000",
      visitRows: 2,
    });

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid: capped,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );

    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "100000",
      visitRows: 1,
    });
    // No points moved, and the record keeps its state.
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect(await recordOf(world.tenantId, capped)).toMatchObject({
      state: "capped",
      refunded_eligible_idr: "50000",
    });
  });

  it("LOY-02 voiding a blocked self-serve order still lowers visits and spend", async () => {
    const { world, member } = await worldWithMember();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
      grossSalesIdr: 100_000,
      cashierId: member.userId,
    });
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
        cashierId: member.userId,
      }),
    );
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "blocked",
      outcome_reason: "blocked_self_serve",
    });
    expect(await totals(world, member.id)).toMatchObject({ visits: 1 });

    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );

    expect(await totals(world, member.id)).toEqual({
      visits: 0,
      spend: "0",
      visitRows: 0,
    });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "blocked",
    });
  });

  it("LOY-02 a refund after an earlier partial refund already reversed all points (state reversed) still lowers spend and the visit", async () => {
    const { world, member } = await worldWithMember();
    // 100.000 eligible, 10 points (10.000 IDR per point, rounded up against the
    // member): a 90.001 refund reaches the 10-point target, so the record turns
    // "reversed" while 9.999 of the spend is still not refunded.
    const first = await pay(world, member, { grossSalesIdr: 100_000 });
    await deliver(world, refund(world, first, { grossSalesIdr: 90_001 }));
    expect(await recordOf(world.tenantId, first)).toMatchObject({
      state: "reversed",
    });
    expect(await totals(world, member.id)).toEqual({
      visits: 1,
      spend: "9999",
      visitRows: 1,
    });

    await deliver(world, refund(world, first, { grossSalesIdr: 9_999 }));

    expect(await totals(world, member.id)).toEqual({
      visits: 0,
      spend: "0",
      visitRows: 0,
    });
  });
});
