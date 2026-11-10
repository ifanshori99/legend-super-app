// legend-111j: the append-only point ledger and the balance the database keeps
// (docs/design/ws08-member-loyalty.md M5, LOY-01..02; brief 290a "Tes gagal-dulu").
//
// Code under test runs as legend_app through `withTenant`; rows are seeded and
// read back as the migration owner. Fail-first: the services and migration 0203
// may not exist yet.
//
// Assumptions:
// - A rejected statement is checked by message text of the PostgreSQL error
//   (append-only trigger text from the brief, `permission denied` for grants,
//   the CHECK name or "points_balance" for the negative balance).
// - Earn rows use the order ULID as `source_id` (contract: "Order ids are ULIDs").
// - A partial refund reverses ceil(booked * cumulativeRefundedEligible / eligible)
//   cumulatively (design M6 refund step 3).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import {
  listLedgerForProfile,
  postLedgerEntry,
  type LedgerPostInput,
} from "../services/point-ledger.service.ts";
import {
  DATE,
  NOW,
  anomaliesOf,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  outboxEvents,
  profileOf,
  recordOf,
  rejection,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";

const IN_A_YEAR = new Date("2027-11-08T03:00:00Z");

/** Posts one ledger row as legend_app under the profile lock. */
function post(
  world: World,
  profileId: string,
  input: Omit<LedgerPostInput, "tenantId" | "customerProfileId">,
) {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return postLedgerEntry(
      tx,
      world.context,
      { tenantId: world.tenantId, customerProfileId: profileId, ...input },
      NOW,
    );
  });
}

const earn = (world: World, profileId: string, points: number) =>
  post(world, profileId, {
    type: "earn",
    points,
    sourceType: "order",
    sourceId: createUlid(),
    expiresAt: IN_A_YEAR,
    businessDate: DATE,
  });

const redeem = (world: World, profileId: string, points: number) => {
  const redemptionId = randomUUID();
  return post(world, profileId, {
    type: "redeem",
    points: -points,
    sourceType: "reward_redemption",
    sourceId: redemptionId,
    // The points.redeemed event payload names the reward and the redemption.
    event: { rewardId: randomUUID(), redemptionId },
  });
};

let world: World;

beforeAll(async () => {
  world = await createWorld();
  await seedProgram(world.tenantId, { pointValueIdr: 100 });
});

describe("LOY-01 point_ledger is append-only", () => {
  it("LOY-01 UPDATE of a ledger row is rejected for legend_app", async () => {
    const member = await seedMember(world.tenantId);
    const { entry } = await earn(world, member.id, 10);
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE point_ledger SET points = 99 WHERE tenant_id = ${world.tenantId} AND id = ${entry.id}`,
        ),
      ),
    );
    expect(message).toMatch(/append-only|permission denied/i);
    expect((await ledgerOf(world.tenantId, member.id))[0]!.points).toBe("10");
  });

  it("LOY-01 DELETE of a ledger row is rejected for legend_app", async () => {
    const member = await seedMember(world.tenantId);
    const { entry } = await earn(world, member.id, 10);
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`DELETE FROM point_ledger WHERE tenant_id = ${world.tenantId} AND id = ${entry.id}`,
        ),
      ),
    );
    expect(message).toMatch(/append-only|permission denied/i);
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(1);
  });
});

describe("LOY-01 the balance equals the ledger sum", () => {
  it("LOY-01 stays equal to the ledger sum after a random sequence of rows", async () => {
    const member = await seedMember(world.tenantId);
    // Deterministic pseudo-random sequence (mulberry32), so a failure replays.
    let seed = 20261108;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let expected = 0;
    for (let step = 0; step < 40; step += 1) {
      const roll = next();
      if (roll < 0.55 || expected === 0) {
        const points = 1 + Math.floor(next() * 50);
        await earn(world, member.id, points);
        expected += points;
      } else if (roll < 0.85) {
        const points = 1 + Math.floor(next() * expected);
        await redeem(world, member.id, points);
        expected -= points;
      } else {
        const points = 1 + Math.floor(next() * expected);
        await post(world, member.id, {
          type: "adjust",
          points: -points,
          sourceType: "adjustment",
          sourceId: randomUUID(),
          reason: "Koreksi uji",
        });
        expected -= points;
      }
      expect(await balanceOf(world.tenantId, member.id)).toBe(expected);
    }
    const rows = await ledgerOf(world.tenantId, member.id);
    const sum = rows.reduce((total, row) => total + Number(row.points), 0);
    expect(sum).toBe(expected);
    expect(await balanceOf(world.tenantId, member.id)).toBe(sum);
    // The service read model agrees with the stored rows, newest first.
    const page = await withTenant(db, world.context, (tx) =>
      listLedgerForProfile(tx, world.tenantId, member.id, { limit: 100 }),
    );
    expect(page.items).toHaveLength(rows.length);
    expect(page.items.reduce((total, row) => total + row.points, 0)).toBe(sum);
  });

  it("LOY-02 an insert that would make the balance negative fails and changes nothing", async () => {
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 5);
    const message = await rejection(redeem(world, member.id, 6));
    expect(message).toMatch(/points_balance|check/i);
    expect(await balanceOf(world.tenantId, member.id)).toBe(5);
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(1);
  });

  it("LOY-01 posting the same source twice books one row and reports inserted:false", async () => {
    const member = await seedMember(world.tenantId);
    const input = {
      type: "earn" as const,
      points: 7,
      sourceType: "order" as const,
      sourceId: createUlid(),
      expiresAt: IN_A_YEAR,
    };
    const first = await post(world, member.id, input);
    const second = await post(world, member.id, input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(7);
    expect(
      await outboxEvents(world.tenantId, "points.earned", member.id),
    ).toHaveLength(1);
  });

  it("LOY-01 the database sets point value and liability, never the caller", async () => {
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 12);
    const [row] = await ledgerOf(world.tenantId, member.id);
    expect(row!.point_value_idr).toBe("100");
    expect(row!.liability_idr).toBe("1200");
  });

  it("LOY-01 a manual adjust needs a reason; a positive one needs an expiry", async () => {
    const member = await seedMember(world.tenantId);
    await rejection(
      post(world, member.id, {
        type: "adjust",
        points: -1,
        sourceType: "adjustment",
        sourceId: randomUUID(),
        reason: null,
      }),
    );
    await rejection(
      post(world, member.id, {
        type: "adjust",
        points: 5,
        sourceType: "adjustment",
        sourceId: randomUUID(),
        reason: "Hadiah",
        expiresAt: null,
      }),
    );
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(0);
  });
});

describe("LOY-01 grants: points_balance is not writable by legend_app", () => {
  it("LOY-01 INSERT of a profile with a nonzero points_balance is rejected by the insert trigger", async () => {
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(sql`
          INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, points_balance)
          VALUES (${randomUUID()}, ${world.tenantId}, ${randomUUID()}, 'Curang', 'pending_verification', 500)`),
      ),
    );
    // The ORM names every column on INSERT, so the grant covers the column
    // and a BEFORE INSERT trigger holds new profiles at zero.
    expect(message).toMatch(/starts at zero points/i);
  });

  it("LOY-01 INSERT of a profile without points_balance is allowed and starts at 0", async () => {
    const id = randomUUID();
    await withTenant(db, world.context, (tx) =>
      tx.execute(sql`
        INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status)
        VALUES (${id}, ${world.tenantId}, ${randomUUID()}, 'Jujur', 'pending_verification')`),
    );
    expect(await balanceOf(world.tenantId, id)).toBe(0);
  });

  it("LOY-01 UPDATE of points_balance is rejected by the grant", async () => {
    const member = await seedMember(world.tenantId);
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE customer_profiles SET points_balance = 1000 WHERE tenant_id = ${world.tenantId} AND id = ${member.id}`,
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });
});

describe("LOY-01 the point value locks at the first ledger row", () => {
  it("LOY-01 changing point_value_idr after the first row is rejected; before it is allowed", async () => {
    const fresh = await createWorld();
    await seedProgram(fresh.tenantId, { pointValueIdr: 100 });
    const member = await seedMember(fresh.tenantId);
    const change = (value: number) =>
      withTenant(db, fresh.context, (tx) =>
        tx.execute(
          sql`UPDATE loyalty_programs SET point_value_idr = ${value} WHERE tenant_id = ${fresh.tenantId}`,
        ),
      );
    await change(150); // not locked yet
    await post(fresh, member.id, {
      type: "earn",
      points: 10,
      sourceType: "order",
      sourceId: createUlid(),
      expiresAt: IN_A_YEAR,
    });
    const message = await rejection(change(200));
    expect(message).toMatch(/point_value|locked|kunci/i);
    const [row] = await ledgerOf(fresh.tenantId, member.id);
    expect(row!.point_value_idr).toBe("150");
    expect(row!.liability_idr).toBe("1500");
  });

  it("LOY-01 a ledger insert without a loyalty_programs row for the tenant is rejected", async () => {
    const bare = await createWorld();
    const member = await seedMember(bare.tenantId);
    await rejection(
      post(bare, member.id, {
        type: "earn",
        points: 1,
        sourceType: "order",
        sourceId: createUlid(),
        expiresAt: IN_A_YEAR,
      }),
    );
    expect(await balanceOf(bare.tenantId, member.id)).toBe(0);
  });
});

describe("LOY-02 reversals through the earn consumer", () => {
  async function paidOrder(w: World, grossSalesIdr: number) {
    const member = await seedMember(w.tenantId);
    const orderUlid = await seedOrder(w.tenantId, {
      outletId: w.outletA,
      profileId: member.id,
      grossSalesIdr,
    });
    await deliver(
      w,
      orderPaidEvent(w, { orderUlid, outletId: w.outletA, grossSalesIdr }),
    );
    return { member, orderUlid };
  }

  it("LOY-02 two partial refunds reverse exactly booked_points", async () => {
    const w = await createWorld();
    await seedProgram(w.tenantId);
    const { member, orderUlid } = await paidOrder(w, 100_000); // 10 points
    expect(await balanceOf(w.tenantId, member.id)).toBe(10);

    const refund1 = randomUUID();
    const refund2 = randomUUID();
    // 33.333 of 100.000: ceil(10 * 33333 / 100000) = 4 (rounds against the member).
    await deliver(
      w,
      orderRefundedEvent(w, {
        orderUlid,
        outletId: w.outletA,
        refundId: refund1,
        grossSalesIdr: 33_333,
      }),
    );
    expect(await balanceOf(w.tenantId, member.id)).toBe(6);
    // The rest: cumulative target is 10, so the second row is 6, not 7.
    await deliver(
      w,
      orderRefundedEvent(w, {
        orderUlid,
        outletId: w.outletA,
        refundId: refund2,
        grossSalesIdr: 66_667,
      }),
    );

    const rows = await ledgerOf(w.tenantId, member.id);
    const reversals = rows.filter((row) => row.type === "reverse");
    expect(reversals.map((row) => row.points)).toEqual(["-4", "-6"]);
    expect(reversals.map((row) => row.source_id)).toEqual([refund1, refund2]);
    expect(reversals.every((row) => row.source_type === "refund")).toBe(true);
    expect(
      reversals.every((row) => row.reverses_entry_id === rows[0]!.id),
    ).toBe(true);
    expect(await balanceOf(w.tenantId, member.id)).toBe(0);
    const record = await recordOf(w.tenantId, orderUlid);
    expect(record).toMatchObject({
      state: "reversed",
      booked_points: "10",
      reversed_points: "10",
      reversal_shortfall_points: "0",
    });
    expect(
      await outboxEvents(w.tenantId, "points.reversed", member.id),
    ).toHaveLength(2);
  });

  it("LOY-02 replaying a refund event reverses once", async () => {
    const w = await createWorld();
    await seedProgram(w.tenantId);
    const { member, orderUlid } = await paidOrder(w, 100_000);
    const event = orderRefundedEvent(w, {
      orderUlid,
      outletId: w.outletA,
      grossSalesIdr: 50_000,
    });
    await deliver(w, event);
    await deliver(w, event);
    expect(
      (await ledgerOf(w.tenantId, member.id)).filter(
        (row) => row.type === "reverse",
      ),
    ).toHaveLength(1);
    expect(await balanceOf(w.tenantId, member.id)).toBe(5);
  });

  it("LOY-02 a full refund after the points were redeemed is clamped and the shortfall recorded", async () => {
    const w = await createWorld();
    await seedProgram(w.tenantId);
    const { member, orderUlid } = await paidOrder(w, 100_000); // 10 points
    await redeem(w, member.id, 6); // 4 left
    await deliver(
      w,
      orderRefundedEvent(w, {
        orderUlid,
        outletId: w.outletA,
        grossSalesIdr: 100_000,
      }),
    );
    // The balance never goes negative: only the 4 left are taken back.
    expect(await balanceOf(w.tenantId, member.id)).toBe(0);
    const reversals = (await ledgerOf(w.tenantId, member.id)).filter(
      (row) => row.type === "reverse",
    );
    expect(reversals.map((row) => row.points)).toEqual(["-4"]);
    expect(await recordOf(w.tenantId, orderUlid)).toMatchObject({
      reversed_points: "4",
      reversal_shortfall_points: "6",
    });
    const anomalies = await anomaliesOf(w.tenantId, "refund_after_redeem");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ customer_profile_id: member.id });
  });

  it("LOY-02 a voided final order reverses all remaining points with source void", async () => {
    const w = await createWorld();
    await seedProgram(w.tenantId);
    const { member, orderUlid } = await paidOrder(w, 100_000);
    const voidId = randomUUID();
    await deliver(
      w,
      orderVoidedEvent(w, {
        orderUlid,
        outletId: w.outletA,
        voidId,
        voidedFinalOrder: true,
      }),
    );
    const reversals = (await ledgerOf(w.tenantId, member.id)).filter(
      (row) => row.type === "reverse",
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      points: "-10",
      source_type: "void",
      source_id: voidId,
    });
    expect((await profileOf(w.tenantId, member.id)).points_balance).toBe("0");
  });
});
