// legend-m4p5 slice T1: rewards, redemptions, cancel, expiry, fulfil and the
// isolation of the new tables (brief 290c "Tes gagal-dulu"; docs/briefs/sub-290c-slices.md).
// Written BEFORE the code: these tests must fail now (the services/routes do not exist).
//
// Assumptions (the brief is silent or says TBD-verify):
// - Redemption expiry is `redeemedAt + reward.redemption_valid_days` days.
// - A redeem over HTTP answers 200 or 201; the body is `{ data: redemption }`.
// - A missing/invalid body is 400 or 422 (the shared error mapper decides).
// - Fulfil with an unknown code is 404 NOT_FOUND; fulfil at an outlet outside the
//   caller's scope or without `crm.loyalty.fulfil` is 403.
// - Cancel of a fulfilled/cancelled/expired redemption, or of one whose voucher is
//   no longer `issued`, is 409 REDEMPTION_NOT_CANCELLABLE (slice fixed fact).
// - Listing helpers return `{ items, nextCursor }` at service level.
// - Mission rows are seeded with raw SQL to test only their isolation (T2 covers behavior).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { rewardRedemptionSchema } from "@starter/shared/crm";
import { idr, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withMemberScope } from "../db/member-scope.ts";
import { hashPromoCode } from "../services/crm-promo-engine.ts";
import { runRedemptionExpiry } from "../worker/redemption-expiry.job.ts";
import { updateReward } from "../services/loyalty-rewards-admin.service.ts";
import {
  expireRedemption,
  fulfilRedemption,
  listActiveRewards,
  listMemberRedemptions,
} from "../services/reward-redemption.service.ts";
import { agent, originHeader } from "./helpers";
import {
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers";
import {
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  ensureConsentPolicies,
  markTraining,
  memberHeaders,
  newMemberUser,
  owner,
  rejection,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  cleanupSeededRewards,
  cancelAs,
  errorCodeOf,
  eventsOf,
  grantPoints,
  key,
  ledgerDetail,
  markVoucherRedeemed,
  redeemAs,
  redemptionRow,
  redemptionsOf,
  rewardOf,
  scopeOf,
  seedMenuItem,
  seedReward,
  vouchersOf,
} from "./member-rewards-helpers.ts";

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  await seedProgram(seededTenantId);
});

afterAll(async () => {
  await cleanupSeededRewards();
  await owner.end();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

/** A fresh tenant with a program and one member holding `points`. */
async function setup(points = 200) {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  const member = await seedMember(world.tenantId);
  if (points > 0) await grantPoints(world.tenantId, member.id, points);
  return { world, member, scope: scopeOf(world.tenantId, member) };
}

describe("LOY-03 redeem a reward", () => {
  it("LOY-03 redeeming an item reward creates a pending redemption, one redeem ledger row, less stock and less balance", async () => {
    const { world, member, scope } = await setup(200);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 5,
    });

    const redemption = await redeemAs(scope, rewardId, key());

    expect(redemption.status).toBe("pending");
    expect(redemption.rewardId).toBe(rewardId);
    expect(redemption.customerProfileId).toBe(member.id);
    expect(redemption.pointsSpent).toBe(50);
    expect(redemption.redemptionCode).toMatch(CODE_PATTERN);
    expect(redemption.fulfilledAt).toBeNull();
    expect(redemption.cancelledAt).toBeNull();
    expect(rewardRedemptionSchema.safeParse(redemption).success).toBe(true);

    expect(await balanceOf(world.tenantId, member.id)).toBe(150);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(4);

    const ledger = await ledgerDetail(world.tenantId, member.id);
    const redeemRows = ledger.filter((row) => row.type === "redeem");
    expect(redeemRows).toHaveLength(1);
    expect(redeemRows[0]).toMatchObject({
      points: -50,
      source_type: "reward_redemption",
      source_id: redemption.id,
      expires_at: null,
    });
    const events = await eventsOf(world.tenantId, "points.redeemed", member.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.rewardId).toBe(rewardId);
  });

  it("LOY-03 a reward with unlimited stock keeps stock null", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 10,
      stock: null,
    });
    await redeemAs(scope, rewardId, key());
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBeNull();
  });

  it("LOY-03 the redemption expires after the reward's redemption_valid_days", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 10,
      redemptionValidDays: 7,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    expect(new Date(redemption.expiresAt).getTime()).toBe(
      NOW.getTime() + 7 * DAY_MS,
    );
  });

  it("LOY-03 the same idempotency key returns the first redemption and posts no second ledger row", async () => {
    const { world, member, scope } = await setup(200);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 5,
    });
    const idempotencyKey = key();

    const first = await redeemAs(scope, rewardId, idempotencyKey);
    const second = await redeemAs(scope, rewardId, idempotencyKey);

    expect(second.id).toBe(first.id);
    expect(second.redemptionCode).toBe(first.redemptionCode);
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(1);
    const ledger = await ledgerDetail(world.tenantId, member.id);
    expect(ledger.filter((row) => row.type === "redeem")).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(4);
  });

  it("LOY-03 too few points: POINTS_INSUFFICIENT, no ledger row, stock unchanged", async () => {
    const { world, member, scope } = await setup(30);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 3,
    });

    expect(await errorCodeOf(redeemAs(scope, rewardId, key()))).toBe(
      "POINTS_INSUFFICIENT",
    );

    const ledger = await ledgerDetail(world.tenantId, member.id);
    expect(ledger.filter((row) => row.type === "redeem")).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(30);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(3);
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(0);
  });

  it("LOY-03 a reward with no stock left answers REWARD_OUT_OF_STOCK", async () => {
    const { world, member, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 10,
      stock: 0,
    });
    expect(await errorCodeOf(redeemAs(scope, rewardId, key()))).toBe(
      "REWARD_OUT_OF_STOCK",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
  });

  it("LOY-03 per-customer limit: the second redemption answers REDEMPTION_LIMIT_REACHED, a cancelled one frees the slot", async () => {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 10,
      perCustomerLimit: 1,
    });

    const first = await redeemAs(scope, rewardId, key());
    expect(await errorCodeOf(redeemAs(scope, rewardId, key()))).toBe(
      "REDEMPTION_LIMIT_REACHED",
    );
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(1);

    // pending + fulfilled count toward the limit; cancelled does not.
    await cancelAs(scope, first.id);
    const again = await redeemAs(scope, rewardId, key());
    expect(again.status).toBe("pending");
  });

  it("LOY-03 an expired, inactive or not-yet-started reward answers REWARD_EXPIRED", async () => {
    const { world, member, scope } = await setup(300);
    const ended = await seedReward(world.tenantId, {
      pointsCost: 10,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2026-11-01T00:00:00Z",
    });
    const inactive = await seedReward(world.tenantId, {
      pointsCost: 10,
      isActive: false,
    });
    const future = await seedReward(world.tenantId, {
      pointsCost: 10,
      validFrom: "2026-12-01T00:00:00Z",
    });
    for (const rewardId of [ended, inactive, future])
      expect(await errorCodeOf(redeemAs(scope, rewardId, key()))).toBe(
        "REWARD_EXPIRED",
      );
    expect(await balanceOf(world.tenantId, member.id)).toBe(300);
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(0);
  });

  it("LOY-03 an unknown reward, or one of another tenant, answers NOT_FOUND", async () => {
    const { scope } = await setup(100);
    const other = await createWorld();
    await seedProgram(other.tenantId);
    const foreignReward = await seedReward(other.tenantId, { pointsCost: 10 });
    expect(await errorCodeOf(redeemAs(scope, randomUUID(), key()))).toBe(
      "NOT_FOUND",
    );
    expect(await errorCodeOf(redeemAs(scope, foreignReward, key()))).toBe(
      "NOT_FOUND",
    );
  });

  it("LOY-03 redeeming a voucher reward issues a voucher row bound to the member, with the redemption code", async () => {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
      voucherValueIdr: 25_000,
    });

    const redemption = await redeemAs(scope, rewardId, key());

    const vouchers = await vouchersOf(world.tenantId, member.id);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]).toMatchObject({
      customer_profile_id: member.id,
      promotion_id: null,
      source: "loyalty_reward",
      status: "issued",
      value_idr: "25000",
      code_hash: hashPromoCode(redemption.redemptionCode),
    });
    expect(vouchers[0]!.valid_until?.getTime()).toBe(
      new Date(redemption.expiresAt).getTime(),
    );
    expect(redemption.voucherId).toBe(vouchers[0]!.id);
    expect(redemption.rewardType).toBe("voucher");
  });

  it("LOY-03 20 parallel redemptions of a reward with stock 1: exactly one succeeds, the rest REWARD_OUT_OF_STOCK", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 1,
    });
    const members = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const member = await seedMember(world.tenantId);
        await grantPoints(world.tenantId, member.id, 100);
        return member;
      }),
    );

    const results = await Promise.allSettled(
      members.map((member) =>
        redeemAs(scopeOf(world.tenantId, member), rewardId, key()),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const result of rejected)
      expect((result.reason as { code?: string }).code).toBe(
        "REWARD_OUT_OF_STOCK",
      );
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(0);

    let spent = 0;
    for (const member of members)
      if ((await balanceOf(world.tenantId, member.id)) === 50) spent += 1;
    expect(spent).toBe(1);
  }, 60_000);

  it("LOY-03 20 parallel redemptions by one member with 20 keys spend the balance once and never go negative", async () => {
    const { world, member, scope } = await setup(50);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: null,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => redeemAs(scope, rewardId, key())),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect((result.reason as { code?: string }).code).toBe(
          "POINTS_INSUFFICIENT",
        );
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    expect(await redemptionsOf(world.tenantId, member.id)).toHaveLength(1);
  }, 60_000);
});

describe("LOY-03 cancel a redemption", () => {
  it("LOY-03 cancel restores the points with a positive adjust row, an adjusted event and the stock; a second cancel changes nothing", async () => {
    const { world, member, scope } = await setup(200);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 5,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    const redeemRow = (await ledgerDetail(world.tenantId, member.id)).find(
      (row) => row.type === "redeem",
    )!;

    const cancelled = await cancelAs(scope, redemption.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(5);

    const ledger = await ledgerDetail(world.tenantId, member.id);
    const restores = ledger.filter((row) => row.type === "adjust");
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({
      points: 50,
      source_type: "adjustment",
      source_id: redemption.id,
      reverses_entry_id: redeemRow.id,
      reason: "redemption_cancelled",
      expires_at: null,
    });
    const events = await eventsOf(world.tenantId, "points.adjusted", member.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      kind: "restore",
      reversesEntryId: redeemRow.id,
      points: 50,
    });

    // Second cancel: rejected, nothing added.
    expect(await errorCodeOf(cancelAs(scope, redemption.id))).toBe(
      "REDEMPTION_NOT_CANCELLABLE",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(5);
    expect(
      (await ledgerDetail(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(1);
  });

  it("LOY-03 two parallel cancels of one redemption restore the points exactly once", async () => {
    const { world, member, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());

    const results = await Promise.allSettled([
      cancelAs(scope, redemption.id),
      cancelAs(scope, redemption.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(
      (await ledgerDetail(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(1);
  });

  it("LOY-03 cancelling a voucher redemption cancels the voucher", async () => {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
    });
    const redemption = await redeemAs(scope, rewardId, key());

    await cancelAs(scope, redemption.id);

    const [voucher] = await vouchersOf(world.tenantId, member.id);
    expect(voucher!.status).toBe("cancelled");
    expect(await balanceOf(world.tenantId, member.id)).toBe(300);
  });

  it("LOY-03 cancel is refused once the voucher is used: REDEMPTION_NOT_CANCELLABLE and nothing changes", async () => {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
      stock: 3,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    const [voucher] = await vouchersOf(world.tenantId, member.id);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    await markVoucherRedeemed(
      world.tenantId,
      voucher!.id,
      orderUlid,
      "2026-11-08T01:00:00Z",
    );

    expect(await errorCodeOf(cancelAs(scope, redemption.id))).toBe(
      "REDEMPTION_NOT_CANCELLABLE",
    );

    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "pending",
    );
    expect((await vouchersOf(world.tenantId, member.id))[0]!.status).toBe(
      "redeemed",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
    expect((await rewardOf(world.tenantId, rewardId)).stock).toBe(2);
    expect(
      (await ledgerDetail(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(0);
  });

  it("LOY-03 another member cannot cancel the redemption and gets NOT_FOUND", async () => {
    const { world, member, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());
    const intruder = await seedMember(world.tenantId);

    expect(
      await errorCodeOf(
        cancelAs(scopeOf(world.tenantId, intruder), redemption.id),
      ),
    ).toBe("NOT_FOUND");
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "pending",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
  });
});

describe("LOY-03 expiry of pending redemptions", () => {
  async function sweep(world: World, now: Date) {
    return runRedemptionExpiry(db, world.context, now);
  }

  it("LOY-03 a due redemption expires: points back with reason redemption_expired, stock back, voucher cancelled; a re-run posts nothing", async () => {
    const { world, member, scope } = await setup(300);
    const itemReward = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 5,
      redemptionValidDays: 7,
    });
    const voucherReward = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
      redemptionValidDays: 7,
    });
    const item = await redeemAs(scope, itemReward, key());
    const voucherRedemption = await redeemAs(scope, voucherReward, key());
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);

    const due = new Date(NOW.getTime() + 8 * DAY_MS);
    const result = await sweep(world, due);

    expect(result).toMatchObject({ expired: 2, fulfilled: 0 });
    expect((await redemptionRow(world.tenantId, item.id)).status).toBe(
      "expired",
    );
    expect(
      (await redemptionRow(world.tenantId, voucherRedemption.id)).status,
    ).toBe("expired");
    expect(await balanceOf(world.tenantId, member.id)).toBe(300);
    expect((await rewardOf(world.tenantId, itemReward)).stock).toBe(5);
    expect((await vouchersOf(world.tenantId, member.id))[0]!.status).toBe(
      "cancelled",
    );
    const restores = (await ledgerDetail(world.tenantId, member.id)).filter(
      (row) => row.type === "adjust",
    );
    expect(restores).toHaveLength(2);
    for (const restore of restores) {
      expect(restore.reason).toBe("redemption_expired");
      expect(restore.source_type).toBe("adjustment");
      expect(restore.reverses_entry_id).not.toBeNull();
    }
    expect(
      (await eventsOf(world.tenantId, "points.adjusted", member.id)).length,
    ).toBe(2);

    // Re-run: nothing more.
    const rerun = await sweep(world, due);
    expect(rerun).toMatchObject({ expired: 0, fulfilled: 0 });
    expect(
      (await ledgerDetail(world.tenantId, member.id)).filter(
        (row) => row.type === "adjust",
      ),
    ).toHaveLength(2);
    expect(await balanceOf(world.tenantId, member.id)).toBe(300);
    expect((await rewardOf(world.tenantId, itemReward)).stock).toBe(5);
  });

  it("LOY-03 a redemption that is not yet due stays pending", async () => {
    const { world, member, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      redemptionValidDays: 7,
    });
    const redemption = await redeemAs(scope, rewardId, key());

    const result = await sweep(world, new Date(NOW.getTime() + 1 * DAY_MS));

    expect(result).toMatchObject({ expired: 0, fulfilled: 0 });
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "pending",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
  });

  it("LOY-03 a due voucher redemption whose voucher was used becomes fulfilled, not expired, and keeps the points spent", async () => {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
      redemptionValidDays: 7,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    const [voucher] = await vouchersOf(world.tenantId, member.id);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    await markVoucherRedeemed(
      world.tenantId,
      voucher!.id,
      orderUlid,
      "2026-11-09T05:00:00Z",
    );

    const result = await sweep(world, new Date(NOW.getTime() + 8 * DAY_MS));

    expect(result).toMatchObject({ expired: 0, fulfilled: 1 });
    const row = await redemptionRow(world.tenantId, redemption.id);
    expect(row.status).toBe("fulfilled");
    expect(row.fulfilled_at?.toISOString()).toBe("2026-11-09T05:00:00.000Z");
    expect(row.order_id).toBe(ulidToUuid(orderUlid));
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
    expect(
      (await ledgerDetail(world.tenantId, member.id)).filter(
        (r) => r.type === "adjust",
      ),
    ).toHaveLength(0);
  });
});

describe("LOY-03 lists", () => {
  it("LOY-03 listActiveRewards returns active, in-validity rewards only and pages with a cursor", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const active = [
      await seedReward(world.tenantId, { name: "A" }),
      await seedReward(world.tenantId, { name: "B" }),
      await seedReward(world.tenantId, { name: "C" }),
    ];
    await seedReward(world.tenantId, { isActive: false });
    await seedReward(world.tenantId, { validUntil: "2026-01-02T00:00:00Z" });

    const first = await withTenant(db, world.context, (tx) =>
      listActiveRewards(tx, world.tenantId, { limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await withTenant(db, world.context, (tx) =>
      listActiveRewards(tx, world.tenantId, {
        limit: 2,
        cursor: first.nextCursor!,
      }),
    );
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.items, ...second.items].map((reward) => reward.id).sort(),
    ).toEqual([...active].sort());
  });

  it("LOY-03 listMemberRedemptions returns only the caller's redemptions", async () => {
    const { world, member, scope } = await setup(300);
    const other = await seedMember(world.tenantId);
    await grantPoints(world.tenantId, other.id, 100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 10 });
    const own = [
      await redeemAs(scope, rewardId, key()),
      await redeemAs(scope, rewardId, key()),
      await redeemAs(scope, rewardId, key()),
    ];
    const foreign = await redeemAs(
      scopeOf(world.tenantId, other),
      rewardId,
      key(),
    );

    const first = await withMemberScope(db, scope, (tx) =>
      listMemberRedemptions(tx, scope, { limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await withMemberScope(db, scope, (tx) =>
      listMemberRedemptions(tx, scope, {
        limit: 2,
        cursor: first.nextCursor!,
      }),
    );
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(ids.sort()).toEqual(own.map((item) => item.id).sort());
    expect(ids).not.toContain(foreign.id);
    expect(member.id).toBe(scope.customerProfileId);
  });
});

describe("LOY-03 database guards on reward_redemptions", () => {
  it("LOY-03 a fulfilled redemption cannot go back to pending and the identity columns cannot change", async () => {
    const { world, member, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 10 });
    const redemption = await redeemAs(scope, rewardId, key());

    await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE reward_redemptions SET points_spent = 999 WHERE id = ${redemption.id}`,
        ),
      ),
    );
    await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE reward_redemptions SET customer_profile_id = ${randomUUID()} WHERE id = ${redemption.id}`,
        ),
      ),
    );
    await withTenant(db, world.context, (tx) =>
      tx.execute(
        sql`UPDATE reward_redemptions SET status = 'fulfilled', fulfilled_at = now() WHERE id = ${redemption.id}`,
      ),
    );
    await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE reward_redemptions SET status = 'pending', fulfilled_at = NULL WHERE id = ${redemption.id}`,
        ),
      ),
    );
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "fulfilled",
    );
    expect(
      (await redemptionsOf(world.tenantId, member.id))[0]!.points_spent,
    ).toBe(10);
  });

  it("LOY-03 the application role cannot delete redemptions", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 10 });
    const redemption = await redeemAs(scope, rewardId, key());
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`DELETE FROM reward_redemptions WHERE id = ${redemption.id}`,
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe("TEN-01 tenant isolation of the reward tables", () => {
  /** A tenant with a reward, a redemption, a voucher, a mission and its progress. */
  async function tenantWithRewardData() {
    const { world, member, scope } = await setup(300);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
    });
    await redeemAs(scope, rewardId, key());
    const missionId = randomUUID();
    await asTenant(world.tenantId, async (client) => {
      await client.query(
        `INSERT INTO missions (id, tenant_id, name, description, type, rule, reward, period, is_active)
         VALUES ($1, $2, 'Misi Uji', '', 'visit_count', $3, $4, $5, true)`,
        [
          missionId,
          world.tenantId,
          JSON.stringify({ kind: "visit_count", targetVisits: 3 }),
          JSON.stringify({ kind: "points", points: 20 }),
          JSON.stringify({ kind: "monthly" }),
        ],
      );
      await client.query(
        `INSERT INTO mission_progress (tenant_id, mission_id, customer_profile_id, period_key, progress, target)
         VALUES ($1, $2, $3, '2026-11', 1, 3)`,
        [world.tenantId, missionId, member.id],
      );
    });
    return { world, member, rewardId, missionId };
  }

  it("TEN-01 tenant B sees no reward, redemption, voucher, mission or progress row of tenant A", async () => {
    const a = await tenantWithRewardData();
    const b = await tenantWithRewardData();
    for (const table of [
      "rewards",
      "reward_redemptions",
      "missions",
      "mission_progress",
      "vouchers",
    ]) {
      const own = await withTenant(db, a.world.context, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${a.world.tenantId}`,
        ),
      );
      expect(Number(own.rows[0]!.n), `${table} own`).toBeGreaterThan(0);
      const foreign = await withTenant(db, b.world.context, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${a.world.tenantId}`,
        ),
      );
      expect(Number(foreign.rows[0]!.n), `${table} leaked`).toBe(0);
    }
  });

  it("TEN-01 tenant B cannot write a reward or a mission for tenant A", async () => {
    const a = await createWorld();
    const b = await createWorld();
    await rejection(
      withTenant(db, b.context, (tx) =>
        tx.execute(sql`
          INSERT INTO rewards (id, tenant_id, name, description, type, points_cost, valid_from, voucher_value_idr, is_active, sort_order)
          VALUES (${randomUUID()}, ${a.tenantId}, 'Curang', '', 'voucher', 10, now(), 1000, true, 0)`),
      ),
    );
    await rejection(
      withTenant(db, b.context, (tx) =>
        tx.execute(sql`
          INSERT INTO missions (id, tenant_id, name, description, type, rule, reward, period, is_active)
          VALUES (${randomUUID()}, ${a.tenantId}, 'Curang', '', 'visit_count',
                  '{"kind":"visit_count","targetVisits":1}'::jsonb, '{"kind":"points","points":1}'::jsonb,
                  '{"kind":"monthly"}'::jsonb, true)`),
      ),
    );
  });

  it("TEN-01 a redemption code is unique within one tenant, and the same code may exist in another tenant", async () => {
    const a = await tenantWithRewardData();
    const [existing] = await redemptionsOf(a.world.tenantId, a.member.id);
    const other = await setup(100);
    const rewardId = await seedReward(other.world.tenantId, { pointsCost: 10 });
    const message = await rejection(
      asTenant(a.world.tenantId, (client) =>
        client.query(
          `INSERT INTO reward_redemptions
             (id, tenant_id, reward_id, customer_profile_id, points_spent, status, redemption_code, idempotency_key, redeemed_at, expires_at)
           VALUES ($1, $2, $3, $4, 10, 'pending', $5, $6, now(), now() + interval '1 day')`,
          [
            randomUUID(),
            a.world.tenantId,
            a.rewardId,
            a.member.id,
            existing!.redemption_code,
            key(),
          ],
        ),
      ),
    );
    expect(message).toMatch(/duplicate|unique/i);
    // Another tenant is not blocked by the code; the redeem works there.
    const redemption = await redeemAs(other.scope, rewardId, key());
    expect(redemption.status).toBe("pending");
  });
});

describe("LOY-01 member isolation of the reward tables", () => {
  it("LOY-01 member RLS is a restrictive member_self policy on reward_redemptions, mission_progress and vouchers", async () => {
    const { rows } = await owner.query<{
      tablename: string;
      permissive: string;
    }>(
      `SELECT tablename, permissive FROM pg_policies
        WHERE policyname = 'member_self' AND tablename = ANY($1::text[])`,
      [["reward_redemptions", "mission_progress", "vouchers"]],
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([
      "mission_progress",
      "reward_redemptions",
      "vouchers",
    ]);
    expect(rows.every((row) => row.permissive === "RESTRICTIVE")).toBe(true);
  });

  it("LOY-01 with the GUC set, a raw select of another member's redemptions, progress and vouchers is empty", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 10,
    });
    const missionId = randomUUID();
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO missions (id, tenant_id, name, description, type, rule, reward, period, is_active)
         VALUES ($1, $2, 'Misi', '', 'visit_count', '{"kind":"visit_count","targetVisits":3}', '{"kind":"points","points":5}', '{"kind":"monthly"}', true)`,
        [missionId, world.tenantId],
      ),
    );
    const a = await seedMember(world.tenantId);
    const b = await seedMember(world.tenantId);
    for (const member of [a, b]) {
      await grantPoints(world.tenantId, member.id, 100);
      await redeemAs(scopeOf(world.tenantId, member), rewardId, key());
      await asTenant(world.tenantId, (client) =>
        client.query(
          `INSERT INTO mission_progress (tenant_id, mission_id, customer_profile_id, period_key, progress, target)
           VALUES ($1, $2, $3, '2026-11', 1, 3)`,
          [world.tenantId, missionId, member.id],
        ),
      );
    }
    const scope = scopeOf(world.tenantId, a);
    const count = (query: ReturnType<typeof sql>) =>
      withMemberScope(db, scope, async (tx) =>
        Number((await tx.execute(query)).rows[0]!.n),
      );

    for (const [table, column] of [
      ["reward_redemptions", "customer_profile_id"],
      ["mission_progress", "customer_profile_id"],
      ["vouchers", "customer_profile_id"],
    ] as const) {
      const t = sql.identifier(table);
      const c = sql.identifier(column);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM ${t} WHERE ${c} = ${a.id}`,
        ),
        `${table} own`,
      ).toBe(1);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM ${t} WHERE ${c} = ${b.id}`,
        ),
        `${table} other`,
      ).toBe(0);
    }
  });

  it("LOY-01 a member cannot read or cancel another member's redemption over HTTP", async () => {
    const a = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const b = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await grantPoints(seededTenantId, a.profileId!, 200);
    const rewardId = await seedReward(seededTenantId, {
      pointsCost: 50,
      stock: null,
    });
    const redeemed = await a.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect([200, 201]).toContain(redeemed.status);
    const redemptionId = redeemed.body.data.id as string;

    const list = await b.client
      .get("/api/member/redemptions")
      .set(memberHeaders);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(redemptionId);

    const cancel = await b.client
      .post(`/api/member/redemptions/${redemptionId}/cancel`)
      .set(memberHeaders)
      .set(originHeader);
    expect(cancel.status).toBe(404);
    expect(cancel.body.error.code).toBe("NOT_FOUND");
    expect((await redemptionRow(seededTenantId, redemptionId)).status).toBe(
      "pending",
    );

    const ownList = await a.client
      .get("/api/member/redemptions")
      .set(memberHeaders);
    expect(
      (ownList.body.data as { id: string }[]).map((row) => row.id),
    ).toContain(redemptionId);
  });

  it("LOY-01 a member cannot see another member's vouchers over HTTP", async () => {
    const a = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const b = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await grantPoints(seededTenantId, a.profileId!, 200);
    const rewardId = await seedReward(seededTenantId, {
      type: "voucher",
      pointsCost: 50,
    });
    const redeemed = await a.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect([200, 201]).toContain(redeemed.status);

    const own = await a.client.get("/api/member/vouchers").set(memberHeaders);
    expect(own.status).toBe(200);
    expect(
      (own.body.data as { customerProfileId: string }[]).map(
        (row) => row.customerProfileId,
      ),
    ).toEqual([a.profileId]);
    const foreign = await b.client
      .get("/api/member/vouchers")
      .set(memberHeaders);
    expect(foreign.status).toBe(200);
    expect(foreign.body.data).toEqual([]);
  });
});

describe("LOY-03 member reward routes over HTTP", () => {
  it("LOY-03 an active member lists rewards, redeems over HTTP, sees the redemption and cancels it for a refund of the points", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await grantPoints(seededTenantId, member.profileId!, 120);
    const rewardId = await seedReward(seededTenantId, {
      name: `Kopi Gratis ${key()}`,
      pointsCost: 40,
      stock: 3,
    });
    const idempotencyKey = key();

    // The reward is listed (walk the pages; the seeded tenant is shared).
    let found = false;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 20 && !found; pageNo += 1) {
      const list = await member.client
        .get(
          `/api/member/rewards?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
        )
        .set(memberHeaders);
      expect(list.status).toBe(200);
      found = (list.body.data as { id: string }[]).some(
        (reward) => reward.id === rewardId,
      );
      cursor = list.body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(found).toBe(true);

    const redeemed = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey });
    expect([200, 201]).toContain(redeemed.status);
    expect(rewardRedemptionSchema.safeParse(redeemed.body.data).success).toBe(
      true,
    );
    expect(redeemed.body.data.status).toBe("pending");
    expect(redeemed.body.data.pointsSpent).toBe(40);

    // Replay with the same key: same redemption, one deduction.
    const replay = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(redeemed.body.data.id);
    const profile = await member.client
      .get("/api/member/profile")
      .set(memberHeaders);
    expect(profile.body.data.pointsBalance).toBe(80);

    const mine = await member.client
      .get("/api/member/redemptions")
      .set(memberHeaders);
    expect(mine.status).toBe(200);
    expect((mine.body.data as { id: string }[]).map((row) => row.id)).toEqual([
      redeemed.body.data.id,
    ]);

    const cancelled = await member.client
      .post(`/api/member/redemptions/${redeemed.body.data.id}/cancel`)
      .set(memberHeaders)
      .set(originHeader);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    const after = await member.client
      .get("/api/member/profile")
      .set(memberHeaders);
    expect(after.body.data.pointsBalance).toBe(120);

    const again = await member.client
      .post(`/api/member/redemptions/${redeemed.body.data.id}/cancel`)
      .set(memberHeaders)
      .set(originHeader);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REDEMPTION_NOT_CANCELLABLE");
  });

  it("LOY-03 redeeming with too few points over HTTP answers 409 POINTS_INSUFFICIENT", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const rewardId = await seedReward(seededTenantId, { pointsCost: 40 });
    const response = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("POINTS_INSUFFICIENT");
  });

  it("LOY-03 a missing idempotency key is rejected and nothing is redeemed", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await grantPoints(seededTenantId, member.profileId!, 100);
    const rewardId = await seedReward(seededTenantId, { pointsCost: 40 });
    const response = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({});
    expect([400, 422]).toContain(response.status);
    expect(await redemptionsOf(seededTenantId, member.profileId!)).toHaveLength(
      0,
    );
  });

  it("LOY-03 a pending_verification member gets 403 MEMBERSHIP_NOT_ACTIVE on redeem", async () => {
    const member = await newMemberUser(app, {
      profile: "pending_verification",
    });
    const rewardId = await seedReward(seededTenantId, { pointsCost: 40 });
    const response = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBERSHIP_NOT_ACTIVE");
  });

  it("LOY-03 a signed-in user without a profile gets 404 CUSTOMER_NOT_FOUND on the member reward routes", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Tanpa Profil Hadiah",
    });
    for (const path of [
      "/api/member/rewards",
      "/api/member/redemptions",
      "/api/member/missions",
      "/api/member/vouchers",
    ]) {
      const response = await staff.client.get(path).set(memberHeaders);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("CUSTOMER_NOT_FOUND");
    }
  });

  it("LOY-03 an anonymous visitor gets 401 on the member reward routes", async () => {
    const anonymous = agent(app);
    for (const path of ["/api/member/rewards", "/api/member/redemptions"]) {
      const response = await anonymous.get(path).set(memberHeaders);
      expect(response.status, path).toBe(401);
    }
  });

  it("LOY-01 a member session gets 403 PERMISSION_DENIED on the staff reward, mission and fulfil routes", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    for (const path of ["/api/loyalty/rewards", "/api/loyalty/missions"]) {
      const response = await member.client.get(path).set(memberHeaders);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe("PERMISSION_DENIED");
    }
    const fulfil = await member.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send({ redemptionCode: "ABCDEFGH23", outletId: seededOutletA });
    expect(fulfil.status).toBe(403);
    expect(fulfil.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("LOY-03 fulfil a redemption by code", () => {
  /** An active member with points and one pending redemption in the seeded tenant. */
  async function pendingRedemption(
    options: Parameters<typeof seedReward>[1] = {},
  ) {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await grantPoints(seededTenantId, member.profileId!, 300);
    const rewardId = await seedReward(seededTenantId, {
      pointsCost: 50,
      ...options,
    });
    const response = await member.client
      .post(`/api/member/rewards/${rewardId}/redemptions`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect([200, 201]).toContain(response.status);
    return {
      member,
      redemption: response.body.data as {
        id: string;
        redemptionCode: string;
      },
    };
  }

  const fulfilBody = (code: string, orderId?: string) => ({
    redemptionCode: code,
    outletId: seededOutletA,
    ...(orderId ? { orderId } : {}),
  });

  it("LOY-03 a cashier with crm.loyalty.fulfil fulfils an item reward by its code; a second fulfil and a member cancel are refused", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Fulfil",
    });
    const { member, redemption } = await pendingRedemption();

    const response = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody(redemption.redemptionCode));

    expect(response.status).toBe(200);
    expect(rewardRedemptionSchema.safeParse(response.body.data).success).toBe(
      true,
    );
    expect(response.body.data.status).toBe("fulfilled");
    expect(response.body.data.fulfilledAt).not.toBeNull();
    expect(response.body.data.fulfilledOutletId).toBe(seededOutletA);
    const row = await redemptionRow(seededTenantId, redemption.id);
    expect(row.status).toBe("fulfilled");

    // Already fulfilled: a second fulfil and a member cancel both fail.
    const again = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody(redemption.redemptionCode));
    expect(again.status).toBeGreaterThanOrEqual(400);
    const cancel = await member.client
      .post(`/api/member/redemptions/${redemption.id}/cancel`)
      .set(memberHeaders)
      .set(originHeader);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("REDEMPTION_NOT_CANCELLABLE");
  });

  it("LOY-03 fulfilling a voucher reward before its voucher is used answers 422 VOUCHER_INVALID; after use it is fulfilled with the order", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Voucher",
    });
    const { member, redemption } = await pendingRedemption({
      type: "voucher",
      pointsCost: 100,
    });

    const early = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody(redemption.redemptionCode));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("VOUCHER_INVALID");
    expect((await redemptionRow(seededTenantId, redemption.id)).status).toBe(
      "pending",
    );

    const [voucher] = await vouchersOf(seededTenantId, member.profileId!);
    const orderUlid = await seedOrder(seededTenantId, {
      outletId: seededOutletA,
      profileId: member.profileId!,
    });
    await markVoucherRedeemed(
      seededTenantId,
      voucher!.id,
      orderUlid,
      new Date().toISOString(),
    );
    const late = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody(redemption.redemptionCode));
    expect(late.status).toBe(200);
    expect(late.body.data.status).toBe("fulfilled");
    expect(late.body.data.orderId).toBe(orderUlid);
  });

  it("LOY-03 an unknown code answers 404 NOT_FOUND", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Kode Salah",
    });
    const response = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody("ZZZZZZZZZZ"));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("LOY-03 a cashier cannot fulfil at an outlet outside their scope, and a waiter lacks the permission", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Outlet A",
    });
    const waiter = await staffWithRole(app, {
      template: "waiter",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Pelayan",
    });
    const { redemption } = await pendingRedemption();

    const elsewhere = await cashier.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send({
        redemptionCode: redemption.redemptionCode,
        outletId: seededOutletB,
      });
    expect(elsewhere.status).toBe(403);
    const unauthorised = await waiter.client
      .post("/api/loyalty/redemptions/fulfil")
      .set(memberHeaders)
      .set(originHeader)
      .send(fulfilBody(redemption.redemptionCode));
    expect(unauthorised.status).toBe(403);
    expect(unauthorised.body.error.code).toBe("PERMISSION_DENIED");
    expect((await redemptionRow(seededTenantId, redemption.id)).status).toBe(
      "pending",
    );
  });

  it("LOY-03 fulfil through the service marks the redemption fulfilled with the actor and outlet", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());
    const actor = randomUUID();

    const result = await withTenant(db, world.context, (tx) =>
      fulfilRedemption(
        tx,
        world.context,
        actor,
        { redemptionCode: redemption.redemptionCode, outletId: world.outletA },
        NOW,
      ),
    );

    expect(result.status).toBe("fulfilled");
    expect(result.fulfilledOutletId).toBe(world.outletA);
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "fulfilled",
    );
  });
});

describe("LOY-03 fulfil never lands on a training order (legend-dbrw3)", () => {
  it("LOY-03 fulfilling an item reward against a training order is refused and the redemption stays pending", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());
    const trainingOrder = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await markTraining(world.tenantId, trainingOrder);

    const code = await errorCodeOf(
      withTenant(db, world.context, (tx) =>
        fulfilRedemption(
          tx,
          world.context,
          randomUUID(),
          {
            redemptionCode: redemption.redemptionCode,
            outletId: world.outletA,
            orderId: trainingOrder,
          },
          NOW,
        ),
      ),
    );
    expect(code).toBe("VOUCHER_INVALID");
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "pending",
    );

    // The same redemption still fulfils against a real order.
    const realOrder = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    const done = await withTenant(db, world.context, (tx) =>
      fulfilRedemption(
        tx,
        world.context,
        randomUUID(),
        {
          redemptionCode: redemption.redemptionCode,
          outletId: world.outletA,
          orderId: realOrder,
        },
        NOW,
      ),
    );
    expect(done.status).toBe("fulfilled");
  });
});

describe("LOY-03 settlement follows the redemption, not the current reward type", () => {
  /** Raw edit as the migration owner: the PATCH guard blocks this on purpose. */
  async function retypeReward(
    tenantId: string,
    rewardId: string,
    to: "voucher" | "free_item",
  ) {
    const menuItemId = to === "free_item" ? await seedMenuItem(tenantId) : null;
    await asTenant(tenantId, (client) =>
      client.query(
        `UPDATE rewards SET type = $3, menu_item_id = $4, voucher_value_idr = $5
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, rewardId, to, menuItemId, to === "voucher" ? 25_000 : null],
      ),
    );
  }

  function fulfilAs(world: World, code: string) {
    return withTenant(db, world.context, (tx) =>
      fulfilRedemption(
        tx,
        world.context,
        randomUUID(),
        { redemptionCode: code, outletId: world.outletA },
        NOW,
      ),
    );
  }

  it("LOY-03 fulfil of a voucher redemption still needs the used voucher after the reward became an item reward", async () => {
    const { world, member, scope } = await setup(200);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    await retypeReward(world.tenantId, rewardId, "free_item");

    expect(await errorCodeOf(fulfilAs(world, redemption.redemptionCode))).toBe(
      "VOUCHER_INVALID",
    );

    const [voucher] = await vouchersOf(world.tenantId, member.id);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    await markVoucherRedeemed(
      world.tenantId,
      voucher!.id,
      orderUlid,
      "2026-11-08T01:00:00Z",
    );
    const result = await fulfilAs(world, redemption.redemptionCode);
    expect(result.status).toBe("fulfilled");
    expect((await redemptionRow(world.tenantId, redemption.id)).order_id).toBe(
      ulidToUuid(orderUlid),
    );
  });

  it("LOY-03 fulfil of an item redemption works after the reward became a voucher reward", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());
    await retypeReward(world.tenantId, rewardId, "voucher");

    const result = await fulfilAs(world, redemption.redemptionCode);
    expect(result.status).toBe("fulfilled");
  });

  it("LOY-03 expiry cancels the voucher of a voucher redemption after the reward became an item reward", async () => {
    const { world, member, scope } = await setup(200);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 100,
      redemptionValidDays: 7,
    });
    const redemption = await redeemAs(scope, rewardId, key());
    await retypeReward(world.tenantId, rewardId, "free_item");

    const result = await runRedemptionExpiry(
      db,
      world.context,
      new Date(NOW.getTime() + 8 * DAY_MS),
    );

    expect(result).toMatchObject({ expired: 1, fulfilled: 0 });
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "expired",
    );
    expect((await vouchersOf(world.tenantId, member.id))[0]!.status).toBe(
      "cancelled",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);
  });
});

describe("LOY-03 reward PATCH with pending redemptions", () => {
  it("LOY-03 changing type, menuItemId or voucherValueIdr is 409 while a redemption is pending", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    await redeemAs(scope, rewardId, key());
    const otherItem = await seedMenuItem(world.tenantId);

    expect(
      await errorCodeOf(
        updateReward(world.context, randomUUID(), rewardId, {
          type: "voucher",
          menuItemId: null,
          voucherValueIdr: idr(10_000),
        }),
      ),
    ).toBe("REWARD_HAS_PENDING_REDEMPTIONS");
    expect(
      await errorCodeOf(
        updateReward(world.context, randomUUID(), rewardId, {
          menuItemId: otherItem,
        }),
      ),
    ).toBe("REWARD_HAS_PENDING_REDEMPTIONS");
  });

  it("LOY-03 switching between unlimited and limited stock is 409 while a redemption is pending", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    await redeemAs(scope, rewardId, key());

    expect(
      await errorCodeOf(
        updateReward(world.context, randomUUID(), rewardId, { stock: 5 }),
      ),
    ).toBe("REWARD_HAS_PENDING_REDEMPTIONS");
  });

  it("LOY-03 other fields stay editable while pending, and the type is editable once nothing is pending", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, { pointsCost: 50 });
    const redemption = await redeemAs(scope, rewardId, key());

    const renamed = await updateReward(world.context, randomUUID(), rewardId, {
      name: "Nama baru",
      pointsCost: 60,
    });
    expect(renamed.name).toBe("Nama baru");

    await cancelAs(scope, redemption.id);
    const retyped = await updateReward(world.context, randomUUID(), rewardId, {
      type: "voucher",
      menuItemId: null,
      voucherValueIdr: idr(10_000),
    });
    expect(retyped.type).toBe("voucher");
  });
});

describe("LOY-03 expiry settles one redemption per transaction", () => {
  it("LOY-03 expireRedemption skips a redemption that is not due and settles a due one", async () => {
    const { world, scope } = await setup(100);
    const rewardId = await seedReward(world.tenantId, {
      pointsCost: 50,
      redemptionValidDays: 7,
    });
    const redemption = await redeemAs(scope, rewardId, key());

    const early = await withTenant(db, world.context, (tx) =>
      expireRedemption(tx, world.context, redemption.id, NOW),
    );
    expect(early).toBe("skipped");
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "pending",
    );

    const late = new Date(NOW.getTime() + 8 * DAY_MS);
    expect(
      await withTenant(db, world.context, (tx) =>
        expireRedemption(tx, world.context, redemption.id, late),
      ),
    ).toBe("expired");
    expect(
      await withTenant(db, world.context, (tx) =>
        expireRedemption(tx, world.context, redemption.id, late),
      ),
    ).toBe("skipped");
  });
});
