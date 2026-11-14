// legend-3zd1 slice 5: point expiry (B13), the birthday bonus and `expiringSoon`
// (docs/briefs/sub-3zd1-slices.md "Aturan teknis penting"; design
// docs/design/ws08-member-loyalty.md M5 and "0197").
// Written BEFORE the code: migration 0210 and the expiry/tier services do not
// exist yet, so these tests must fail now. They are written from the contract.
//
// Assumptions (the brief is silent):
// - `expirePointsForProfile` and `grantBirthdayBonus` run under the profile lock;
//   the helpers take it themselves. `expirePointsForProfile` returns the total
//   points it expired (0 when it writes nothing).
// - `grantBirthdayBonus` returns true when it wrote the bonus row and false when
//   it wrote nothing (not the day, no tier, 0 points, already given this year,
//   consent withdrawn, member not active, program off).
// - Birthday `expires_at` = now + program.expiryMonths months; compared with a
//   one-day tolerance because month arithmetic on the 29th-31st is not pinned.
// - `GET /api/member/points` always carries `meta.expiringSoon`; without expiring
//   points it is `{ points: 0, earliestExpiresAt: null }`.
// - Over HTTP the real clock applies, so grants expire days after the real "now".
// - A grant that is already past its `expires_at` is not "expiring soon" (it is
//   the expiry job's work); this is not tested.
// - Brief algorithm note: the FIFO allocation of `used` must skip points that an
//   earlier expire row already removed from a grant; otherwise a redeem made
//   after a grant expired is charged to that dead grant and a later grant
//   expires too much. One test below pins the correct member-visible result.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createUlid } from "@starter/shared/core";
import { pointsExpiredPayloadSchema } from "@starter/shared/crm";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import {
  expirePointsForProfile,
  expiringSoonOf,
  grantBirthdayBonus,
} from "../services/loyalty-expiry.service.ts";
import {
  postLedgerEntry,
  type LedgerPostInput,
} from "../services/point-ledger.service.ts";
import {
  DATE,
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  ensureConsentPolicies,
  ledgerOf,
  memberHeaders,
  newMemberUser,
  orderPaidEvent,
  orderRefundedEvent,
  outboxEvents,
  owner,
  rejection,
  seedConsent,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";
import { seededTenantId } from "./floor-test-helpers";
import { runLoyaltyExpirySweep } from "../worker/loyalty-expiry.job.ts";
import { runLoyaltyTierSweep } from "../worker/loyalty-tier.job.ts";

// Passes through to the real functions; the sweep tests make chosen profiles
// fail and record which profiles each job visited.
const probe = vi.hoisted(() => ({
  failing: new Set<string>(),
  expiryCalls: [] as string[],
  tierCalls: [] as string[],
}));

vi.mock("../services/loyalty-expiry.service.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/loyalty-expiry.service.ts")
    >();
  return {
    ...actual,
    expirePointsForProfile: async (
      ...args: Parameters<typeof actual.expirePointsForProfile>
    ) => {
      probe.expiryCalls.push(args[2]);
      if (probe.failing.has(args[2])) throw new Error("injected failure");
      return actual.expirePointsForProfile(...args);
    },
  };
});

vi.mock("../services/loyalty-tier.service.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/loyalty-tier.service.ts")
    >();
  return {
    ...actual,
    evaluateProfileTier: async (
      ...args: Parameters<typeof actual.evaluateProfileTier>
    ) => {
      probe.tierCalls.push(args[2]);
      if (probe.failing.has(args[2])) throw new Error("injected failure");
      return actual.evaluateProfileTier(...args);
    },
  };
});

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  await seedProgram(seededTenantId);
});

afterAll(async () => {
  await owner.end();
});

const DAY_MS = 24 * 60 * 60 * 1000;
// Expiry instants of the grants and the clocks the job runs at.
const D1 = new Date("2026-12-01T00:00:00Z");
const D2 = new Date("2027-01-01T00:00:00Z");
const D3 = new Date("2027-02-01T00:00:00Z");
const T1 = new Date("2026-12-15T00:00:00Z"); // after D1 only
const T2 = new Date("2027-01-15T00:00:00Z"); // after D1 and D2
const T3 = new Date("2027-03-01T00:00:00Z"); // after all

async function expiryWorld(options: { expiryMonths?: number } = {}) {
  const world = await createWorld();
  await seedProgram(world.tenantId, {
    pointValueIdr: 100,
    expiryMonths: options.expiryMonths ?? 12,
  });
  const member = await seedMember(world.tenantId);
  return { world, member };
}

function post(
  world: World,
  profileId: string,
  input: Omit<LedgerPostInput, "tenantId" | "customerProfileId">,
  // The clock of the posting: its row id (ULID) carries this instant.
  at: Date = NOW,
) {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return postLedgerEntry(
      tx,
      world.context,
      { tenantId: world.tenantId, customerProfileId: profileId, ...input },
      at,
    );
  });
}

const earn = (
  world: World,
  profileId: string,
  points: number,
  expiresAt: Date,
) =>
  post(world, profileId, {
    type: "earn",
    points,
    sourceType: "order",
    sourceId: createUlid(),
    expiresAt,
    businessDate: DATE,
  });

const missionBonus = (
  world: World,
  profileId: string,
  points: number,
  expiresAt: Date,
) =>
  post(world, profileId, {
    type: "bonus",
    points,
    sourceType: "mission",
    sourceId: randomUUID(),
    expiresAt,
  });

const positiveAdjust = (
  world: World,
  profileId: string,
  points: number,
  expiresAt: Date | null,
) =>
  post(world, profileId, {
    type: "adjust",
    points,
    sourceType: "adjustment",
    sourceId: randomUUID(),
    reason: "Hadiah manual",
    expiresAt,
  });

const negativeAdjust = (world: World, profileId: string, points: number) =>
  post(world, profileId, {
    type: "adjust",
    points: -points,
    sourceType: "adjustment",
    sourceId: randomUUID(),
    reason: "Koreksi manual",
  });

const redeem = (world: World, profileId: string, points: number) => {
  const redemptionId = randomUUID();
  return post(world, profileId, {
    type: "redeem",
    points: -points,
    sourceType: "reward_redemption",
    sourceId: redemptionId,
    event: { rewardId: randomUUID(), redemptionId },
  });
};

/** A cancelled or expired redemption puts its points back (positive adjust → the redeem row). */
const restore = (
  world: World,
  profileId: string,
  redeemEntryId: string,
  points: number,
  at: Date = NOW,
) =>
  post(
    world,
    profileId,
    {
      type: "adjust",
      points,
      sourceType: "adjustment",
      sourceId: randomUUID(),
      reversesEntryId: redeemEntryId,
      reason: "redemption_cancelled",
      expiresAt: null,
    },
    at,
  );

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

const expireRows = async (tenantId: string, profileId: string) =>
  (await ledgerOf(tenantId, profileId)).filter((row) => row.type === "expire");

describe("point expiry", () => {
  it("nothing expires before expires_at; a grant expires exactly at expires_at", async () => {
    const { world, member } = await expiryWorld();
    const grant = await earn(world, member.id, 100, D1);

    expect(await runExpiry(world, member.id, new Date(D1.getTime() - 1))).toBe(
      0,
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await expireRows(world.tenantId, member.id)).toHaveLength(0);

    expect(await runExpiry(world, member.id, D1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: "-100",
      source_type: "expiry",
      reverses_entry_id: grant.entry.id,
    });
    expect(rows[0]!.source_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("expiry is idempotent: a rerun with no new data writes nothing", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    await earn(world, member.id, 40, D2);

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    const before = await ledgerOf(world.tenantId, member.id);
    expect(await runExpiry(world, member.id, T1)).toBe(0);
    expect(await runExpiry(world, member.id, T1)).toBe(0);

    expect(await ledgerOf(world.tenantId, member.id)).toEqual(before);
    expect(await balanceOf(world.tenantId, member.id)).toBe(40);
    expect(
      await outboxEvents(world.tenantId, "points.expired", member.id),
    ).toHaveLength(1);
  });

  it("each expire row emits points.expired with the points and the balance after", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    await earn(world, member.id, 40, D2);

    await runExpiry(world, member.id, T1);

    const events = await outboxEvents(
      world.tenantId,
      "points.expired",
      member.id,
    );
    expect(events).toHaveLength(1);
    expect(pointsExpiredPayloadSchema.parse(events[0]!.payload)).toMatchObject({
      customerProfileId: member.id,
      points: 100,
      balanceAfter: 40,
      liabilityIdr: 10_000,
    });
  });

  it("a partial refund reduces what expires: only the unreversed part expires", async () => {
    const { world, member } = await expiryWorld();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
    );
    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 50_000,
      }),
    );
    const rows = await ledgerOf(world.tenantId, member.id);
    const grant = rows.find((row) => row.type === "earn")!;
    expect(Number(grant.points)).toBe(10);
    expect(await balanceOf(world.tenantId, member.id)).toBe(5);
    expect(grant.expires_at).not.toBeNull();
    const afterExpiry = new Date(grant.expires_at!.getTime() + 1000);

    expect(await runExpiry(world, member.id, afterExpiry)).toBe(5);

    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const expired = await expireRows(world.tenantId, member.id);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      points: "-5",
      reverses_entry_id: grant.id,
    });
  });

  it("a fully refunded grant expires nothing", async () => {
    const { world, member } = await expiryWorld();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
    );
    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
      }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const grant = (await ledgerOf(world.tenantId, member.id)).find(
      (row) => row.type === "earn",
    )!;

    expect(
      await runExpiry(
        world,
        member.id,
        new Date(grant.expires_at!.getTime() + 1000),
      ),
    ).toBe(0);
    expect(await expireRows(world.tenantId, member.id)).toHaveLength(0);
  });

  it("a redeem is charged to the oldest-expiring grant first (FIFO), whatever the posting order", async () => {
    const { world, member } = await expiryWorld();
    // Posted in reverse: the later-expiring grant first.
    const later = await earn(world, member.id, 100, D2);
    const sooner = await earn(world, member.id, 100, D1);
    await redeem(world, member.id, 120);

    // D1's grant is fully used by the redeem (100 of 120), so nothing expires at T1.
    expect(await runExpiry(world, member.id, T1)).toBe(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(80);

    // D2's grant had 20 used, so 80 expire.
    expect(await runExpiry(world, member.id, T2)).toBe(80);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: "-80",
      reverses_entry_id: later.entry.id,
    });
    expect(rows.some((row) => row.reverses_entry_id === sooner.entry.id)).toBe(
      false,
    );
  });

  it("a redeem made after the grant was earned is counted: only the rest expires", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    await redeem(world, member.id, 40);

    expect(await runExpiry(world, member.id, T1)).toBe(60);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a redeem after an earlier grant already expired does not make a later grant expire too much", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    await earn(world, member.id, 100, D2);
    await earn(world, member.id, 50, D3);

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);
    // The member spends 30 of what is left: it comes out of the D2 grant.
    await redeem(world, member.id, 30);

    expect(await runExpiry(world, member.id, T2)).toBe(70);
    // 100 + 100 + 50 earned, 30 redeemed, 100 + 70 expired: the D3 grant is whole.
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(await runExpiry(world, member.id, T2)).toBe(0);
    expect(await runExpiry(world, member.id, T3)).toBe(50);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a refund after its grant already expired is taken from the later grants, so they do not expire too much", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D1);
    await earn(world, member.id, 100, D2);
    await earn(world, member.id, 100, D3);

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    // The refund of grant A's order reverses 50 points that already expired:
    // they come out of what is left, i.e. the D2 grant.
    await post(world, member.id, {
      type: "reverse",
      points: -50,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: a.entry.id,
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);

    expect(await runExpiry(world, member.id, T2)).toBe(50);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await runExpiry(world, member.id, T3)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("bonus rows and positive manual adjusts with expires_at are grants too: one expire row per grant", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 50, D1);
    const b = await missionBonus(world, member.id, 30, D1);
    const c = await positiveAdjust(world, member.id, 20, D1);

    expect(await runExpiry(world, member.id, T1)).toBe(100);

    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.reverses_entry_id).sort()).toEqual(
      [a.entry.id, b.entry.id, c.entry.id].sort(),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a negative manual adjust counts as used points", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    await negativeAdjust(world, member.id, 30);

    expect(await runExpiry(world, member.id, T1)).toBe(70);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("points restored after their grant expired expire again, with the next n", async () => {
    const { world, member } = await expiryWorld();
    const grant = await earn(world, member.id, 100, D1);
    const used = await redeem(world, member.id, 60);

    // 40 were never used, so they expire first.
    expect(await runExpiry(world, member.id, T1)).toBe(40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);

    // The redemption is cancelled after the grant expired: 60 points come back ...
    await restore(world, member.id, used.entry.id, 60);
    expect(await balanceOf(world.tenantId, member.id)).toBe(60);

    // ... and expire in the next run, as a second expire row of the same grant.
    expect(await runExpiry(world, member.id, T1)).toBe(60);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reverses_entry_id === grant.entry.id)).toBe(
      true,
    );
    expect(new Set(rows.map((row) => row.source_id)).size).toBe(2);
    expect(rows.map((row) => row.points)).toEqual(["-40", "-60"]);

    // Nothing left to expire.
    expect(await runExpiry(world, member.id, T3)).toBe(0);
    expect(await expireRows(world.tenantId, member.id)).toHaveLength(2);
  });

  it("a restore before expiry keeps the original expiry: the points expire with their grant", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1);
    const used = await redeem(world, member.id, 100);
    await restore(world, member.id, used.entry.id, 100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  // A (expires D1) is fully used by R1; B (expires D2) is partly used by R2.
  // Assumption: "A expired" means the sweep ran at T1 (it writes nothing, A has
  // no live points left). The restore of R1 is posted at T1, after D1.
  it("a restore posted after the consumed grant expired does not take points off a later grant: the restored points expire at the next run, the later grant keeps its own", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D1); // A
    await earn(world, member.id, 100, D2); // B
    const r1 = await redeem(world, member.id, 100); // R1 uses A
    await redeem(world, member.id, 60); // R2 uses 60 of B; B has 40 left
    expect(await balanceOf(world.tenantId, member.id)).toBe(40);

    expect(await runExpiry(world, member.id, T1)).toBe(0); // A has nothing live
    await restore(world, member.id, r1.entry.id, 100, T1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(140);

    // The 100 restored points sit on A, which is already past D1: they expire
    // now. B must not give any of its points to A.
    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(40);
    const afterT1 = await expireRows(world.tenantId, member.id);
    expect(afterT1).toHaveLength(1);
    expect(afterT1[0]).toMatchObject({
      points: "-100",
      reverses_entry_id: a.entry.id,
    });

    // B expires only its own 40 at D2.
    expect(await runExpiry(world, member.id, T2)).toBe(40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a restore posted before the consumed grant expires still reallocates: the later redeem moves onto the refilled grant, the later grant stays whole", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1); // A
    await earn(world, member.id, 100, D2); // B
    const r1 = await redeem(world, member.id, 100); // R1 uses A
    await redeem(world, member.id, 60); // R2 uses 60 of B
    await restore(world, member.id, r1.entry.id, 100); // at NOW, before D1
    expect(await balanceOf(world.tenantId, member.id)).toBe(140);

    // A is refilled and R2 moves onto it: A has 40 live, B has 100.
    expect(await runExpiry(world, member.id, T1)).toBe(40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await runExpiry(world, member.id, T2)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a positive manual adjust without expires_at is rejected and changes nothing", async () => {
    const { world, member } = await expiryWorld();
    const message = await rejection(positiveAdjust(world, member.id, 5, null));
    expect(message).toMatch(/point_ledger_adjust_check|check|expires/i);
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("the balance never goes negative and always equals the ledger sum, over a random history", async () => {
    const { world, member } = await expiryWorld();
    // Deterministic pseudo-random sequence (mulberry32), so a failure replays.
    let seed = 20261110;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let clock = NOW;
    let balance = 0;
    for (let step = 0; step < 30; step += 1) {
      const roll = next();
      if (roll < 0.45 || balance === 0) {
        const points = 1 + Math.floor(next() * 50);
        const expiresAt = new Date(
          clock.getTime() + (1 + Math.floor(next() * 4)) * 30 * DAY_MS,
        );
        await earn(world, member.id, points, expiresAt);
        balance += points;
      } else if (roll < 0.7) {
        const points = 1 + Math.floor(next() * balance);
        await redeem(world, member.id, points);
        balance -= points;
      } else {
        clock = new Date(
          clock.getTime() + (1 + Math.floor(next() * 40)) * DAY_MS,
        );
        const expired = await runExpiry(world, member.id, clock);
        balance -= expired;
        // A second run at the same clock has nothing left to do.
        expect(await runExpiry(world, member.id, clock)).toBe(0);
      }
      const stored = await balanceOf(world.tenantId, member.id);
      expect(stored).toBe(balance);
      expect(stored).toBeGreaterThanOrEqual(0);
    }
    const rows = await ledgerOf(world.tenantId, member.id);
    expect(rows.reduce((total, row) => total + Number(row.points), 0)).toBe(
      balance,
    );
    // Far in the future everything that is left expires.
    await runExpiry(world, member.id, new Date(clock.getTime() + 400 * DAY_MS));
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });
});

// A redeem / negative adjust consumes only grants posted before it (ledger replay by
// posting order), not grants that arrive later, even when a later grant expires sooner.
describe("expiry follows posting order (legend-w5by9)", () => {
  it("a grant posted after a redeem is not charged for it: the early-expiring later grant expires whole", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D2); // A
    await redeem(world, member.id, 100); // uses A
    const b = await earn(world, member.id, 100, D1); // B expires before A

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: "-100",
      reverses_entry_id: b.entry.id,
    });

    expect(await runExpiry(world, member.id, T2)).toBe(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a partial redeem uses up only the earlier grant: the later grant expires whole", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D2); // A
    await redeem(world, member.id, 60); // A has 40 left
    await earn(world, member.id, 100, D1); // B

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(40);
    expect(await runExpiry(world, member.id, T2)).toBe(40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("a restored redeem gives the points back to the grant it consumed, with that grant's expiry", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D2); // A
    const used = await redeem(world, member.id, 100);
    await earn(world, member.id, 100, D1); // B
    await restore(world, member.id, used.entry.id, 100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(200);

    expect(await runExpiry(world, member.id, T1)).toBe(100); // B
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T2)).toBe(100); // A
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.reverses_entry_id).toBe(a.entry.id);
  });

  it("a partial restore gives back only that many points to the consumed grant", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D2); // A
    const used = await redeem(world, member.id, 100);
    await earn(world, member.id, 100, D1); // B
    await restore(world, member.id, used.entry.id, 40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(140);

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(40);
    expect(await runExpiry(world, member.id, T2)).toBe(40);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("two grants with the same expiry: the redeem used the earlier-posted one, the later one expires", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D1); // A
    await redeem(world, member.id, 100);
    const b = await earn(world, member.id, 100, D1); // B, same expiry

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reverses_entry_id).toBe(b.entry.id);
  });

  it("a negative manual adjust before a later grant does not eat that grant", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, D2); // A
    await negativeAdjust(world, member.id, 100);
    await earn(world, member.id, 100, D1); // B

    expect(await runExpiry(world, member.id, T1)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("expiringSoon follows posting order too: the later early-expiring grant is the one reported", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 100, inDays(20)); // A
    await redeem(world, member.id, 100); // uses A
    await earn(world, member.id, 100, inDays(10)); // B

    const result = await soon(world, member.id, 15); // window covers B only
    expect(result.points).toBe(100);
    expect(Date.parse(result.earliestExpiresAt!)).toBe(inDays(10).getTime());
  });

  it("a full restore of a redeem that spanned two grants, with a later redeem in between: T1 expires 50 on A, T2 expires 100 on B", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D1); // A
    const b = await earn(world, member.id, 100, D2); // B
    const r1 = await redeem(world, member.id, 150); // R1
    await redeem(world, member.id, 50); // R2
    await restore(world, member.id, r1.entry.id, 150);
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);

    expect(await runExpiry(world, member.id, T1)).toBe(50);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    expect(await runExpiry(world, member.id, T2)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);

    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      points: "-50",
      reverses_entry_id: a.entry.id,
    });
    expect(rows[1]).toMatchObject({
      points: "-100",
      reverses_entry_id: b.entry.id,
    });
  });

  it("an order refund of the redeemed grant, then a restore: nothing expires at D2, the later grant expires whole at D3", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D2); // A
    const used = await redeem(world, member.id, 100); // R uses A
    const b = await earn(world, member.id, 100, D3); // B
    // The refund of A's order reverses A's 100 points (a `reverse` row).
    await post(world, member.id, {
      type: "reverse",
      points: -100,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: a.entry.id,
    });
    await restore(world, member.id, used.entry.id, 100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T2)).toBe(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T3)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: "-100",
      reverses_entry_id: b.entry.id,
    });
  });

  it("an order refund of the redeemed grant, then a partial restore: nothing expires at D2, the later grant expires whole at D3", async () => {
    const { world, member } = await expiryWorld();
    const a = await earn(world, member.id, 100, D2); // A
    const used = await redeem(world, member.id, 60); // R uses 60 of A
    const b = await earn(world, member.id, 100, D3); // B
    await post(world, member.id, {
      type: "reverse",
      points: -100,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: a.entry.id,
    });
    await restore(world, member.id, used.entry.id, 60);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T2)).toBe(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);

    expect(await runExpiry(world, member.id, T3)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const rows = await expireRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: "-100",
      reverses_entry_id: b.entry.id,
    });
  });
});

// ---- birthday bonus ---------------------------------------------------------------

type BirthdayOptions = {
  birth?: string | null;
  birthdayPoints?: number;
  tier?: boolean;
  status?: "active" | "suspended";
  consent?: boolean;
};

async function birthdayMember(world: World, options: BirthdayOptions = {}) {
  const status = options.status ?? "active";
  const member = await seedMember(world.tenantId, { status });
  if (options.consent === false)
    await seedConsent(world.tenantId, member.id, {
      decision: "withdrawn",
      recordedAt: "2026-02-01T00:00:00Z",
    });
  let tierId: string | null = null;
  if (options.tier ?? true) {
    tierId = randomUUID();
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO loyalty_tiers
           (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits, is_active)
         VALUES ($1, $2, 'Gold', $3, 1000000000, 1000000, $4::jsonb, true)`,
        [
          tierId,
          world.tenantId,
          Math.floor(Math.random() * 1_000_000) + 1,
          JSON.stringify({
            pointsMultiplierBp: 10_000,
            birthdayRewardPoints: options.birthdayPoints ?? 50,
            reservationPriority: false,
            exclusivePromotions: false,
            facilityFreeAccessQuota: 0,
          }),
        ],
      ),
    );
  }
  await asTenant(world.tenantId, (client) =>
    client.query(
      "UPDATE customer_profiles SET birth_month_day = $3, tier_id = $4 WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, member.id, options.birth ?? "11-08", tierId],
    ),
  );
  return member;
}

function birthday(
  world: World,
  profileId: string,
  now: Date,
): Promise<boolean> {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return grantBirthdayBonus(tx, world.tenantId, profileId, now);
  });
}

const birthdayRows = async (tenantId: string, profileId: string) =>
  (await ledgerOf(tenantId, profileId)).filter(
    (row) => row.type === "bonus" && row.source_type === "birthday",
  );

// 2026-11-08 10:00 in Jakarta.
const BIRTHDAY_NOW = NOW;

describe("birthday bonus", () => {
  it("on the birthday a tier member gets the tier's birthday points, expiring after the program's expiry months", async () => {
    const { world } = await expiryWorld({ expiryMonths: 12 });
    const member = await birthdayMember(world, { birthdayPoints: 50 });

    expect(await birthday(world, member.id, BIRTHDAY_NOW)).toBe(true);

    const rows = await birthdayRows(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: "50", source_type: "birthday" });
    expect(rows[0]!.source_id).toMatch(/^[0-9a-f-]{36}$/);
    const expected = new Date("2027-11-08T03:00:00Z").getTime();
    expect(
      Math.abs(rows[0]!.expires_at!.getTime() - expected),
    ).toBeLessThanOrEqual(DAY_MS);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(
      await outboxEvents(world.tenantId, "points.earned", member.id),
    ).toHaveLength(1);
  });

  it("the bonus is booked once per year, however often the job runs", async () => {
    const { world } = await expiryWorld();
    const member = await birthdayMember(world);

    expect(await birthday(world, member.id, BIRTHDAY_NOW)).toBe(true);
    expect(await birthday(world, member.id, BIRTHDAY_NOW)).toBe(false);
    expect(
      await birthday(
        world,
        member.id,
        new Date(BIRTHDAY_NOW.getTime() + 3_600_000),
      ),
    ).toBe(false);
    expect(await birthdayRows(world.tenantId, member.id)).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);

    // The next year is a new birthday.
    expect(
      await birthday(world, member.id, new Date("2027-11-08T03:00:00Z")),
    ).toBe(true);
    const rows = await birthdayRows(world.tenantId, member.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.source_id)).size).toBe(2);
  });

  it("no bonus on other days", async () => {
    const { world } = await expiryWorld();
    const member = await birthdayMember(world, { birth: "11-09" });
    expect(await birthday(world, member.id, BIRTHDAY_NOW)).toBe(false);
    expect(await birthdayRows(world.tenantId, member.id)).toHaveLength(0);
  });

  it("the day is the Asia/Jakarta date, not the UTC date", async () => {
    const { world } = await expiryWorld();
    const member = await birthdayMember(world, { birth: "11-08" });
    // 2026-11-07 20:00 UTC is 2026-11-08 03:00 in Jakarta.
    expect(
      await birthday(world, member.id, new Date("2026-11-07T20:00:00Z")),
    ).toBe(true);
    const other = await birthdayMember(world, { birth: "11-07" });
    expect(
      await birthday(world, other.id, new Date("2026-11-07T20:00:00Z")),
    ).toBe(false);
  });

  it("a 29 February birthday is celebrated on 28 February in a year that is not a leap year", async () => {
    const { world } = await expiryWorld();
    const member = await birthdayMember(world, { birth: "02-29" });

    expect(
      await birthday(world, member.id, new Date("2027-02-28T03:00:00Z")),
    ).toBe(true);
    // In a leap year the day is 29 February, not 28.
    const leap = await birthdayMember(world, { birth: "02-29" });
    expect(
      await birthday(world, leap.id, new Date("2028-02-28T03:00:00Z")),
    ).toBe(false);
    expect(
      await birthday(world, leap.id, new Date("2028-02-29T03:00:00Z")),
    ).toBe(true);
  });

  it("no tier, or a tier with 0 birthday points, writes nothing", async () => {
    const { world } = await expiryWorld();
    const noTier = await birthdayMember(world, { tier: false });
    const zero = await birthdayMember(world, { birthdayPoints: 0 });

    expect(await birthday(world, noTier.id, BIRTHDAY_NOW)).toBe(false);
    expect(await birthday(world, zero.id, BIRTHDAY_NOW)).toBe(false);
    expect(await birthdayRows(world.tenantId, noTier.id)).toHaveLength(0);
    expect(await birthdayRows(world.tenantId, zero.id)).toHaveLength(0);
  });

  it("a member whose tier is no longer active gets no bonus", async () => {
    const { world } = await expiryWorld();
    const member = await birthdayMember(world);
    await asTenant(world.tenantId, (client) =>
      client.query(
        `UPDATE loyalty_tiers SET is_active = false
          WHERE tenant_id = $1
            AND id = (SELECT tier_id FROM customer_profiles WHERE tenant_id = $1 AND id = $2)`,
        [world.tenantId, member.id],
      ),
    );

    expect(await birthday(world, member.id, BIRTHDAY_NOW)).toBe(false);
    expect(await birthdayRows(world.tenantId, member.id)).toHaveLength(0);
  });

  it("a suspended member, a member without loyalty consent and an inactive program get nothing", async () => {
    const { world } = await expiryWorld();
    const suspended = await birthdayMember(world, { status: "suspended" });
    const noConsent = await birthdayMember(world, { consent: false });

    expect(await birthday(world, suspended.id, BIRTHDAY_NOW)).toBe(false);
    expect(await birthday(world, noConsent.id, BIRTHDAY_NOW)).toBe(false);

    const ok = await birthdayMember(world);
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE loyalty_programs SET is_active = false WHERE tenant_id = $1",
        [world.tenantId],
      ),
    );
    expect(await birthday(world, ok.id, BIRTHDAY_NOW)).toBe(false);

    for (const profile of [suspended, noConsent, ok])
      expect(await birthdayRows(world.tenantId, profile.id)).toHaveLength(0);
  });
});

// ---- expiringSoon -------------------------------------------------------------------

function soon(world: World, profileId: string, days?: number) {
  return withTenant(db, world.context, (tx) =>
    days === undefined
      ? expiringSoonOf(tx, world.tenantId, profileId, NOW)
      : expiringSoonOf(tx, world.tenantId, profileId, NOW, days),
  );
}

const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("expiringSoon", () => {
  it("sums the unused points that expire within 30 days and names the earliest date", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 40, inDays(10));
    await earn(world, member.id, 60, inDays(20));
    await earn(world, member.id, 100, inDays(45));

    const result = await soon(world, member.id);
    expect(result.points).toBe(100);
    expect(Date.parse(result.earliestExpiresAt!)).toBe(inDays(10).getTime());
  });

  it("used points are taken from the earliest grants first", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 40, inDays(10));
    await earn(world, member.id, 60, inDays(20));
    await earn(world, member.id, 100, inDays(45));
    await redeem(world, member.id, 50);

    const result = await soon(world, member.id);
    // The 10-day grant is gone (40 used), 10 of the 20-day grant are used.
    expect(result.points).toBe(50);
    expect(Date.parse(result.earliestExpiresAt!)).toBe(inDays(20).getTime());
  });

  it("the window is a parameter", async () => {
    const { world, member } = await expiryWorld();
    await earn(world, member.id, 40, inDays(10));
    await earn(world, member.id, 100, inDays(45));

    expect((await soon(world, member.id, 60)).points).toBe(140);
    expect((await soon(world, member.id, 5)).points).toBe(0);
  });

  it("a member with no expiring points gets 0 and no date", async () => {
    const { world, member } = await expiryWorld();
    expect(await soon(world, member.id)).toEqual({
      points: 0,
      earliestExpiresAt: null,
    });
    await earn(world, member.id, 100, inDays(200));
    expect(await soon(world, member.id)).toEqual({
      points: 0,
      earliestExpiresAt: null,
    });
  });
});

describe("GET /api/member/points meta.expiringSoon", () => {
  it("carries the member's own points expiring within 30 days", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const other = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const soonDate = new Date(Date.now() + 10 * DAY_MS);
    await grantPoints(seededTenantId, member.profileId!, 30, soonDate);
    await grantPoints(
      seededTenantId,
      member.profileId!,
      100,
      new Date(Date.now() + 90 * DAY_MS),
    );
    // Another member's expiring points are not counted.
    await grantPoints(
      seededTenantId,
      other.profileId!,
      999,
      new Date(Date.now() + 5 * DAY_MS),
    );

    const response = await member.client
      .get("/api/member/points")
      .set(memberHeaders);
    expect(response.status).toBe(200);
    expect(response.body.meta.expiringSoon.points).toBe(30);
    expect(Date.parse(response.body.meta.expiringSoon.earliestExpiresAt)).toBe(
      soonDate.getTime(),
    );
  });

  it("is zero with no date for a member whose points do not expire soon", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const empty = await member.client
      .get("/api/member/points")
      .set(memberHeaders);
    expect(empty.status).toBe(200);
    expect(empty.body.meta.expiringSoon).toEqual({
      points: 0,
      earliestExpiresAt: null,
    });

    await grantPoints(
      seededTenantId,
      member.profileId!,
      50,
      new Date(Date.now() + 200 * DAY_MS),
    );
    const far = await member.client
      .get("/api/member/points")
      .set(memberHeaders);
    expect(far.body.meta.expiringSoon).toEqual({
      points: 0,
      earliestExpiresAt: null,
    });
  });
});

// ---- sweeps: cursor and retry of failed profiles --------------------------------------

describe("expiry sweep", () => {
  it("a tenant larger than one tick's batches is swept over several ticks from a saved cursor, then the day is done", async () => {
    const { world } = await expiryWorld();
    const members = [];
    for (let index = 0; index < 5; index += 1) {
      const member = await seedMember(world.tenantId);
      await earn(world, member.id, 100, D1);
      members.push(member);
    }
    const limits = { batchSize: 2, maxBatches: 1 };

    const first = await runLoyaltyExpirySweep(world.context, T1, limits);
    const second = await runLoyaltyExpirySweep(world.context, T1, limits);
    const third = await runLoyaltyExpirySweep(world.context, T1, limits);

    expect([first, second, third].map((result) => result?.profiles)).toEqual([
      2, 2, 1,
    ]);
    expect(third?.nextAfterId).toBeNull();
    for (const member of members)
      expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    expect(await runLoyaltyExpirySweep(world.context, T1, limits)).toBeNull();
  });

  it("a new day starts the scan again from the beginning", async () => {
    const { world } = await expiryWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100, D1);
    await earn(world, member.id, 100, D2);

    const day1 = await runLoyaltyExpirySweep(world.context, T1);
    expect(day1?.expiredPoints).toBe(100);
    expect(await runLoyaltyExpirySweep(world.context, T1)).toBeNull();
    const day2 = await runLoyaltyExpirySweep(world.context, T2);
    expect(day2?.expiredPoints).toBe(100);
  });

  it("a profile that keeps failing is retried alone, three ticks, then left until tomorrow", async () => {
    const { world } = await expiryWorld();
    const good = await seedMember(world.tenantId);
    const bad = await seedMember(world.tenantId);
    await earn(world, good.id, 100, D1);
    await earn(world, bad.id, 100, D1);
    probe.failing.add(bad.id);
    probe.expiryCalls.length = 0;
    try {
      const scan = await runLoyaltyExpirySweep(world.context, T1);
      expect(scan).toMatchObject({ profiles: 1, failed: 1 });
      expect(scan?.failedIds).toEqual([bad.id]);

      for (let tick = 0; tick < 3; tick += 1) {
        const retry = await runLoyaltyExpirySweep(world.context, T1);
        expect(retry).toMatchObject({ profiles: 0, failed: 1 });
      }
      expect(await runLoyaltyExpirySweep(world.context, T1)).toBeNull();
      // One scan visit for each, then three retries of the failed one only.
      expect(probe.expiryCalls.filter((id) => id === good.id)).toHaveLength(1);
      expect(probe.expiryCalls.filter((id) => id === bad.id)).toHaveLength(4);
      expect(await balanceOf(world.tenantId, good.id)).toBe(0);
      expect(await balanceOf(world.tenantId, bad.id)).toBe(100);
    } finally {
      probe.failing.delete(bad.id);
    }
  });

  it("a failed profile that recovers on a retry ends the day", async () => {
    const { world } = await expiryWorld();
    const good = await seedMember(world.tenantId);
    const bad = await seedMember(world.tenantId);
    await earn(world, good.id, 100, D1);
    await earn(world, bad.id, 100, D1);
    probe.failing.add(bad.id);
    try {
      expect(await runLoyaltyExpirySweep(world.context, T1)).toMatchObject({
        failed: 1,
      });
    } finally {
      probe.failing.delete(bad.id);
    }
    const retry = await runLoyaltyExpirySweep(world.context, T1);
    expect(retry).toMatchObject({ profiles: 1, failed: 0, expiredPoints: 100 });
    expect(await balanceOf(world.tenantId, bad.id)).toBe(0);
    expect(await runLoyaltyExpirySweep(world.context, T1)).toBeNull();
  });
});

describe("tier sweep", () => {
  it("a tenant larger than one tick's batches is swept over several ticks from a saved cursor", async () => {
    const { world } = await expiryWorld();
    // `expiryWorld` already seeded one member: five in all.
    for (let index = 0; index < 4; index += 1) await seedMember(world.tenantId);
    const limits = { batchSize: 2, maxBatches: 1 };

    const results = [
      await runLoyaltyTierSweep(world.context, T1, limits),
      await runLoyaltyTierSweep(world.context, T1, limits),
      await runLoyaltyTierSweep(world.context, T1, limits),
    ];

    expect(results.map((result) => result?.evaluated)).toEqual([2, 2, 1]);
    expect(await runLoyaltyTierSweep(world.context, T1, limits)).toBeNull();
  });

  it("a profile that keeps failing is retried alone, three ticks, then left until tomorrow", async () => {
    const { world } = await expiryWorld();
    const good = await seedMember(world.tenantId);
    const bad = await seedMember(world.tenantId);
    probe.failing.add(bad.id);
    probe.tierCalls.length = 0;
    try {
      // The member seeded by `expiryWorld` and `good` pass; `bad` fails.
      const scan = await runLoyaltyTierSweep(world.context, T1);
      expect(scan).toMatchObject({ evaluated: 2, failed: 1 });
      for (let tick = 0; tick < 3; tick += 1)
        expect(await runLoyaltyTierSweep(world.context, T1)).toMatchObject({
          evaluated: 0,
          failed: 1,
        });
      expect(await runLoyaltyTierSweep(world.context, T1)).toBeNull();
      expect(probe.tierCalls.filter((id) => id === good.id)).toHaveLength(1);
      expect(probe.tierCalls.filter((id) => id === bad.id)).toHaveLength(4);
    } finally {
      probe.failing.delete(bad.id);
    }
  });
});
