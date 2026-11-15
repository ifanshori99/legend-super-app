// legend-29shf + legend-4frkf: loyalty points must never pay out twice.
// Written BEFORE the fix: the "fix" tests below must fail on the current base.
// Source of rules: docs/briefs/loyalty-points-money.md and the card texts
// (`bd show legend-29shf`, `bd show legend-4frkf`), plus the existing
// expiry contract (crm-expiry.test.ts).
//
// legend-29shf  Redeem must settle point expiry first. A grant past its
//   `expires_at` that the daily sweep has not yet run for is dead: it cannot
//   fund a redemption (insufficient balance is refused), is not consumed by a
//   redeem, balance never goes negative, a retry with the same key is idempotent.
//
// legend-4frkf  A refund/void of an order whose earn grant already expired must
//   not cut any other live grant of the member. DECISION (founder rule "pick the
//   rule that limits payment"): a reversal is bounded to what is left of the
//   order's own grant (the unused part), so reversing an expired grant posts 0.
//   Assumption: "reverse 0" is asserted as "no points leave the balance" (sum of
//   reverse rows = 0, other grants intact), not as the existence of a 0-point
//   ledger row (a ledger row of 0 points may be forbidden by the ledger itself).

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { expirePointsForProfile } from "../services/loyalty-expiry.service.ts";
import {
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  owner,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  cleanupSeededRewards,
  errorCodeOf,
  grantPoints,
  key,
  ledgerDetail,
  redeemAs,
  redemptionsOf,
  scopeOf,
  seedReward,
} from "./member-rewards-helpers.ts";

afterAll(async () => {
  await cleanupSeededRewards();
  await owner.end();
});

// Grant expiry instants (grants are posted at the helper clock, 2026-11-08).
const D1 = new Date("2026-12-01T00:00:00Z"); // the dead grant
const AFTER_D1 = new Date("2026-12-15T00:00:00Z"); // redeem clock: D1 passed, no sweep yet
const LATE = new Date("2030-06-01T00:00:00Z"); // live grant outlives AFTER_D1
const FAR = new Date("2035-01-01T00:00:00Z");

function runExpiry(
  world: World,
  profileId: string,
  now: Date,
): Promise<number> {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return expirePointsForProfile(tx, world.tenantId, profileId, now);
  });
}

const sum = (rows: { points: number | string }[]) =>
  rows.reduce((total, row) => total + Number(row.points), 0);

// ---------------------------------------------------------------------------
// legend-29shf
// ---------------------------------------------------------------------------

async function redeemWorld(deadPoints: number, livePoints: number) {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  const member = await seedMember(world.tenantId);
  // Dead grant is posted first (oldest, expires first) so FIFO would charge it.
  await grantPoints(world.tenantId, member.id, deadPoints, D1);
  await grantPoints(world.tenantId, member.id, livePoints, LATE);
  return { world, member, scope: scopeOf(world.tenantId, member) };
}

describe("legend-29shf redeem settles expiry first", () => {
  it("legend-29shf a grant past expires_at but not yet swept cannot fund a redeem: POINTS_INSUFFICIENT, nothing posted", async () => {
    // 50 dead + 60 live = 110 in the stored balance, but only 60 are real.
    const { world, member, scope } = await redeemWorld(50, 60);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 80 });

    expect(await errorCodeOf(redeemAs(scope, rewardId, key(), AFTER_D1))).toBe(
      "POINTS_INSUFFICIENT",
    );

    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(0);
    const ledger = await ledgerDetail(world.tenantId, member.id);
    expect(ledger.filter((row) => row.type === "redeem")).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBeGreaterThanOrEqual(
      0,
    );
    // The daily sweep still removes exactly the dead grant afterwards.
    expect(await runExpiry(world, member.id, AFTER_D1)).toBe(50);
    expect(await balanceOf(world.tenantId, member.id)).toBe(60);
  });

  it("legend-29shf a grant expiring exactly at the redeem instant is already dead", async () => {
    const { world, member, scope } = await redeemWorld(50, 60);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 80 });

    expect(await errorCodeOf(redeemAs(scope, rewardId, key(), D1))).toBe(
      "POINTS_INSUFFICIENT",
    );
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(0);
  });

  it("legend-29shf a redeem that the live grant can pay expires the dead grant first and is charged to the live grant only", async () => {
    const { world, member, scope } = await redeemWorld(50, 100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 70 });

    const redemption = await redeemAs(scope, rewardId, key(), AFTER_D1);
    expect(redemption.pointsSpent).toBe(70);

    const ledger = await ledgerDetail(world.tenantId, member.id);
    const [dead, live] = ledger.filter((row) => row.type === "earn");
    const expired = ledger.filter((row) => row.type === "expire");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      points: -50,
      reverses_entry_id: dead!.id,
    });
    expect(ledger.filter((row) => row.type === "redeem")).toHaveLength(1);
    // 150 granted - 50 expired - 70 redeemed. If the redeem were charged to the
    // dead grant the member would keep 80 (the dead 50 would fund the reward).
    expect(await balanceOf(world.tenantId, member.id)).toBe(30);

    // The later sweep finds nothing left to expire on the dead grant.
    expect(await runExpiry(world, member.id, AFTER_D1)).toBe(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(30);
    expect(live!.expires_at?.getTime()).toBe(LATE.getTime());
  });

  it("legend-29shf retry with the same idempotency key returns the first redemption and posts nothing more", async () => {
    const { world, member, scope } = await redeemWorld(50, 100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 70 });
    const idempotencyKey = key();

    const first = await redeemAs(scope, rewardId, idempotencyKey, AFTER_D1);
    const second = await redeemAs(scope, rewardId, idempotencyKey, AFTER_D1);

    expect(second.id).toBe(first.id);
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(1);
    const ledger = await ledgerDetail(world.tenantId, member.id);
    expect(ledger.filter((row) => row.type === "redeem")).toHaveLength(1);
    expect(ledger.filter((row) => row.type === "expire")).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(30);
  });

  it("legend-29shf two concurrent redeems on 50 dead + 60 live points: one wins, balance never negative", async () => {
    const { world, member, scope } = await redeemWorld(50, 60);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });

    const results = await Promise.allSettled([
      redeemAs(scope, rewardId, key(), AFTER_D1),
      redeemAs(scope, rewardId, key(), AFTER_D1),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect((rejected?.reason as { code?: string } | undefined)?.code).toBe(
      "POINTS_INSUFFICIENT",
    );
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// legend-4frkf
// ---------------------------------------------------------------------------

async function refundWorld() {
  const world = await createWorld();
  await seedProgram(world.tenantId, { expiryMonths: 12, pointValueIdr: 100 });
  const member = await seedMember(world.tenantId);
  return { world, member };
}

/** Pays a 100.000 order (10 points) and returns its ids. */
async function payOrder(world: World, memberId: string) {
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: memberId,
  });
  await deliver(
    world,
    orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
  );
  return orderUlid;
}

async function earnGrantOf(world: World, memberId: string) {
  const rows = await ledgerOf(world.tenantId, memberId);
  const grant = rows.find((row) => row.type === "earn" && row.expires_at);
  return grant!;
}

const reverseRows = async (world: World, memberId: string) =>
  (await ledgerOf(world.tenantId, memberId)).filter(
    (row) => row.type === "reverse",
  );

describe("legend-4frkf refund after the order's grant expired", () => {
  it("legend-4frkf full refund of an order whose grant expired leaves another live grant untouched", async () => {
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR); // other, live grant
    const grant = await earnGrantOf(world, member.id);
    expect(await balanceOf(world.tenantId, member.id)).toBe(60);

    const afterExpiry = new Date(grant.expires_at!.getTime() + 1000);
    expect(await runExpiry(world, member.id, afterExpiry)).toBe(10);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);

    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
      }),
    );

    // The expired grant has nothing left to take back: the live 50 stay whole.
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(sum(await reverseRows(world, member.id))).toBe(0);
  });

  it("legend-4frkf retrying the same refund event stays at 0 and posts nothing more", async () => {
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR);
    const grant = await earnGrantOf(world, member.id);
    await runExpiry(
      world,
      member.id,
      new Date(grant.expires_at!.getTime() + 1000),
    );

    const refund = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: 100_000,
    });
    await deliver(world, refund);
    const afterFirst = await ledgerOf(world.tenantId, member.id);
    await deliver(world, refund);

    expect(await ledgerOf(world.tenantId, member.id)).toEqual(afterFirst);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
  });

  it("legend-4frkf partial refund before expiry, then the rest after expiry: total taken back is only the live 5, never double", async () => {
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR);
    const grant = await earnGrantOf(world, member.id);

    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 50_000,
      }),
    );
    expect(sum(await reverseRows(world, member.id))).toBe(-5);
    expect(await balanceOf(world.tenantId, member.id)).toBe(55);

    // The remaining 5 of the grant expire.
    expect(
      await runExpiry(
        world,
        member.id,
        new Date(grant.expires_at!.getTime() + 1000),
      ),
    ).toBe(5);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);

    // Refund of the other half: the grant is empty, nothing more may leave.
    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 50_000,
      }),
    );
    expect(sum(await reverseRows(world, member.id))).toBe(-5);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
  });

  it("legend-4frkf voiding the paid order after its grant expired also takes nothing from other grants", async () => {
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR);
    const grant = await earnGrantOf(world, member.id);
    await runExpiry(
      world,
      member.id,
      new Date(grant.expires_at!.getTime() + 1000),
    );

    const voided = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId: randomUUID(),
      voidedFinalOrder: true,
    });
    await deliver(world, voided);
    await deliver(world, voided); // replay

    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(sum(await reverseRows(world, member.id))).toBe(0);
  });

  it("legend-4frkf redeem 8 of the order's 10 points, 2 expire, then a full refund takes back the 8 the redeem used (not 0)", async () => {
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR); // later-expiring live grant
    const grant = await earnGrantOf(world, member.id);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 8 });
    // FIFO: the redeem is charged to the earlier-expiring order grant first.
    await redeemAs(scopeOf(world.tenantId, member), rewardId, key());
    expect(await balanceOf(world.tenantId, member.id)).toBe(52);

    expect(
      await runExpiry(
        world,
        member.id,
        new Date(grant.expires_at!.getTime() + 1000),
      ),
    ).toBe(2);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);

    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
      }),
    );

    // 10 granted - 2 expired = 8 still the order's: the redeemed 8 come back
    // out of the balance, nothing above that.
    expect(sum(await reverseRows(world, member.id))).toBe(-8);
    expect(await balanceOf(world.tenantId, member.id)).toBe(42);
  });

  it("legend-4frkf a refund of a still-live grant keeps working: takes back its points once", async () => {
    // Guard against fixing 4frkf by turning reversals off.
    const { world, member } = await refundWorld();
    const orderUlid = await payOrder(world, member.id);
    await grantPoints(world.tenantId, member.id, 50, FAR);
    const refund = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: 100_000,
    });

    await deliver(world, refund);
    await deliver(world, refund);

    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(sum(await reverseRows(world, member.id))).toBe(-10);
  });
});
