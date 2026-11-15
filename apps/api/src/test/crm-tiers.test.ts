// legend-3zd1 slice 5: tiers, tier history, the tier multiplier in earn, referral
// and the isolation of the new tables (docs/briefs/sub-3zd1-slices.md, "Tes
// gagal-dulu"; design docs/design/ws08-member-loyalty.md M6 and "0197").
// Written BEFORE the code: migration 0210 and the services do not exist yet, so
// these tests must fail now. They are written from the contract, not the code.
//
// Assumptions (the brief is silent):
// - `evaluateProfileTier(tx, context, profileId, now)` takes the tenant's
//   ScopedTenantContext and is called under the profile lock; the helper takes
//   the lock itself (a second lock in the same transaction is harmless).
// - Rolling window: `visited_at >= now - program.rollingMonths` months; the
//   program row is seeded with rolling_months = 12.
// - The `referral` rules of the program are the jsonb column `loyalty_programs.referral`
//   (shape of `referralRulesSchema`); tests set it with SQL as the migration owner.
// - A referee whose first order is below `minFirstOrderIdr` gets no bonus, and neither
//   does the referrer; the resulting referral status is not pinned.
// - The ledger `source_id` of the referee bonus is the first order id, as ULID or as
//   the UUID form of that ULID (the brief says "id order pertama").
// - A tier create with a rank that already exists answers 400, 409 or 422 (not pinned).
// - Tier rows made over HTTP in the shared fixture tenant are removed in afterAll
//   (as the migration owner; legend_app has no DELETE on loyalty_tiers).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { ulidToUuid } from "@starter/shared/core";
import { tierChangedPayloadSchema } from "@starter/shared/crm";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withMemberScope, withProfileLock } from "../db/member-scope.ts";
import { evaluateProfileTier } from "../services/loyalty-tier.service.ts";
import {
  applyReferralAtSignup,
  ensureReferralCode,
} from "../services/referral.service.ts";
import { agent, originHeader } from "./helpers";
import {
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import {
  NOW,
  asTenant,
  createWorld,
  deliver,
  ensureConsentPolicies,
  hex64,
  ledgerOf,
  recordOf,
  memberHeaders,
  newMemberUser,
  orderPaidEvent,
  outboxEvents,
  owner,
  rejection,
  seedMember,
  seedOrder,
  seedProfile,
  seedProgram,
  short,
  balanceOf,
  type World,
} from "./member-loyalty-helpers.ts";
import { scopeOf } from "./member-rewards-helpers.ts";

let app: Express;
let boss: Staff;
let cashier: Staff;
const httpTierIds: string[] = [];

const headers = { ...memberHeaders, ...originHeader };

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  boss = await staffWithRole(app, { template: "owner", label: "Pemilik Tier" });
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Kasir Tier",
  });
});

afterAll(async () => {
  if (httpTierIds.length > 0)
    await asTenant(seededTenantId, (client) =>
      client.query(
        "DELETE FROM loyalty_tiers WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, httpTierIds],
      ),
    );
  await owner.end();
});

// ---- fixtures -----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** `date` shifted by whole calendar months (UTC). */
function monthsFrom(date: Date, months: number): Date {
  const shifted = new Date(date);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted;
}

/** A fresh tenant whose program rolls over 12 months. */
async function tierWorld(): Promise<World> {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  await asTenant(world.tenantId, (client) =>
    client.query(
      "UPDATE loyalty_programs SET rolling_months = 12 WHERE tenant_id = $1",
      [world.tenantId],
    ),
  );
  return world;
}

type TierSeed = {
  name?: string;
  rank: number;
  spend?: number;
  visits?: number;
  multiplierBp?: number;
  birthdayPoints?: number;
  active?: boolean;
};

async function seedTier(tenantId: string, tier: TierSeed): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO loyalty_tiers
         (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        id,
        tenantId,
        tier.name ?? `Tier ${tier.rank}`,
        tier.rank,
        tier.spend ?? 1_000_000_000,
        tier.visits ?? 1_000_000,
        JSON.stringify({
          pointsMultiplierBp: tier.multiplierBp ?? 10_000,
          birthdayRewardPoints: tier.birthdayPoints ?? 0,
          reservationPriority: false,
          exclusivePromotions: false,
          facilityFreeAccessQuota: 0,
        }),
        tier.active ?? true,
      ],
    ),
  );
  return id;
}

async function setProfileTier(
  tenantId: string,
  profileId: string,
  tierId: string | null,
): Promise<void> {
  await asTenant(tenantId, (client) =>
    client.query(
      "UPDATE customer_profiles SET tier_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, profileId, tierId],
    ),
  );
}

/** A paid order of the member plus its visit row (the tier window reads visits). */
async function seedVisit(
  world: World,
  profileId: string,
  spendIdr: number,
  visitedAt: Date,
): Promise<void> {
  const businessDate = visitedAt.toISOString().slice(0, 10);
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId,
    grossSalesIdr: spendIdr,
    businessDate,
  });
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO customer_visits
         (tenant_id, outlet_id, customer_profile_id, order_id, business_date, visited_at, spend_idr, item_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [
        world.tenantId,
        world.outletA,
        profileId,
        ulidToUuid(orderUlid),
        businessDate,
        visitedAt,
        spendIdr,
      ],
    ),
  );
}

function evaluate(
  world: World,
  profileId: string,
  now: Date = NOW,
): Promise<boolean> {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return evaluateProfileTier(tx, world.context, profileId, now);
  });
}

async function tierOf(tenantId: string, profileId: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      tier_id: string | null;
      tier_evaluated_at: Date | null;
    }>(
      "SELECT tier_id, tier_evaluated_at FROM customer_profiles WHERE tenant_id = $1 AND id = $2",
      [tenantId, profileId],
    );
    return rows[0]!;
  });
}

type HistoryRow = {
  from_tier_id: string | null;
  to_tier_id: string | null;
  reason: string;
  rolling_spend_idr: string;
  rolling_visits: number;
};

async function historyOf(
  tenantId: string,
  profileId: string,
): Promise<HistoryRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<HistoryRow>(
      `SELECT from_tier_id, to_tier_id, reason, rolling_spend_idr::text, rolling_visits
         FROM customer_tier_history
        WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY created_at, id`,
      [tenantId, profileId],
    );
    return rows;
  });
}

// ---- tier multiplier in earn ----------------------------------------------------

/** A member with `tierId` (or none), one paid order of `gross`; returns the earn points. */
async function earnedWithTier(
  world: World,
  tier: { id: string } | null,
  gross = 100_000,
): Promise<number> {
  const member = await seedMember(world.tenantId);
  if (tier) await setProfileTier(world.tenantId, member.id, tier.id);
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: member.id,
    grossSalesIdr: gross,
  });
  await deliver(
    world,
    orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: gross,
    }),
  );
  const earn = (await ledgerOf(world.tenantId, member.id)).find(
    (row) => row.type === "earn",
  );
  return earn ? Number(earn.points) : 0;
}

describe("the tier multiplier in earn", () => {
  it("a member without a tier earns at 1x (10 000 bp regression)", async () => {
    const world = await tierWorld();
    expect(await earnedWithTier(world, null)).toBe(10);
  });

  it("a 10 000 bp tier earns exactly the same as no tier", async () => {
    const world = await tierWorld();
    const base = { id: await seedTier(world.tenantId, { rank: 1 }) };
    expect(await earnedWithTier(world, base)).toBe(10);
  });

  it("a 15 000 bp tier earns 1.5x and a 20 000 bp tier 2x", async () => {
    const world = await tierWorld();
    const gold = {
      id: await seedTier(world.tenantId, { rank: 2, multiplierBp: 15_000 }),
    };
    const platinum = {
      id: await seedTier(world.tenantId, { rank: 3, multiplierBp: 20_000 }),
    };
    expect(await earnedWithTier(world, gold)).toBe(15);
    expect(await earnedWithTier(world, platinum)).toBe(20);
  });

  it("the multiplied points round down (2 base points at 1.5x = 3)", async () => {
    const world = await tierWorld();
    const gold = {
      id: await seedTier(world.tenantId, { rank: 2, multiplierBp: 15_000 }),
    };
    expect(await earnedWithTier(world, gold, 25_000)).toBe(3);
  });

  it("an inactive tier gives 1x", async () => {
    const world = await tierWorld();
    const off = {
      id: await seedTier(world.tenantId, {
        rank: 2,
        multiplierBp: 20_000,
        active: false,
      }),
    };
    expect(await earnedWithTier(world, off)).toBe(10);
  });
});

// ---- tier evaluation ------------------------------------------------------------

describe("tier evaluation", () => {
  it("a member who reaches a threshold gets the tier, one history row and one tier.changed event", async () => {
    const world = await tierWorld();
    const silver = await seedTier(world.tenantId, {
      rank: 1,
      spend: 200_000,
      visits: 3,
    });
    await seedTier(world.tenantId, { rank: 2, spend: 1_000_000, visits: 10 });
    const member = await seedMember(world.tenantId);
    for (let index = 0; index < 3; index += 1)
      await seedVisit(
        world,
        member.id,
        10_000,
        new Date(NOW.getTime() - (index + 1) * DAY_MS),
      );

    expect(await evaluate(world, member.id)).toBe(true);

    const profile = await tierOf(world.tenantId, member.id);
    expect(profile.tier_id).toBe(silver);
    expect(profile.tier_evaluated_at).not.toBeNull();
    const history = await historyOf(world.tenantId, member.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_tier_id: null,
      to_tier_id: silver,
      reason: "evaluation",
      rolling_spend_idr: "30000",
      rolling_visits: 3,
    });
    const events = await outboxEvents(
      world.tenantId,
      "tier.changed",
      member.id,
    );
    expect(events).toHaveLength(1);
    expect(tierChangedPayloadSchema.parse(events[0]!.payload)).toMatchObject({
      customerProfileId: member.id,
      fromTierId: null,
      toTierId: silver,
      reason: "evaluation",
      rollingSpendIdr: 30_000,
      rollingVisits: 3,
    });
  });

  it("evaluating twice in the same period writes one history row and one event", async () => {
    const world = await tierWorld();
    const silver = await seedTier(world.tenantId, {
      rank: 1,
      spend: 50_000,
      visits: 100,
    });
    const member = await seedMember(world.tenantId);
    await seedVisit(world, member.id, 60_000, new Date(NOW.getTime() - DAY_MS));

    expect(await evaluate(world, member.id)).toBe(true);
    expect(await evaluate(world, member.id)).toBe(false);
    expect(await evaluate(world, member.id)).toBe(false);

    expect((await tierOf(world.tenantId, member.id)).tier_id).toBe(silver);
    expect(await historyOf(world.tenantId, member.id)).toHaveLength(1);
    expect(
      await outboxEvents(world.tenantId, "tier.changed", member.id),
    ).toHaveLength(1);
  });

  it("a member who qualifies for nothing stays without a tier, with no history", async () => {
    const world = await tierWorld();
    await seedTier(world.tenantId, { rank: 1, spend: 500_000, visits: 5 });
    const member = await seedMember(world.tenantId);
    await seedVisit(world, member.id, 10_000, new Date(NOW.getTime() - DAY_MS));

    expect(await evaluate(world, member.id)).toBe(false);

    const profile = await tierOf(world.tenantId, member.id);
    expect(profile.tier_id).toBeNull();
    expect(profile.tier_evaluated_at).not.toBeNull();
    expect(await historyOf(world.tenantId, member.id)).toHaveLength(0);
    expect(
      await outboxEvents(world.tenantId, "tier.changed", member.id),
    ).toHaveLength(0);
  });

  it("the highest qualifying rank wins, spend alone is enough, and an inactive tier is ignored", async () => {
    const world = await tierWorld();
    const silver = await seedTier(world.tenantId, {
      rank: 1,
      spend: 100_000,
      visits: 50,
    });
    const gold = await seedTier(world.tenantId, {
      rank: 2,
      spend: 1_000_000,
      visits: 50,
    });
    await seedTier(world.tenantId, {
      rank: 3,
      spend: 1_000_000,
      visits: 50,
      active: false,
    });
    const big = await seedMember(world.tenantId);
    await seedVisit(world, big.id, 1_200_000, new Date(NOW.getTime() - DAY_MS));
    const small = await seedMember(world.tenantId);
    await seedVisit(world, small.id, 150_000, new Date(NOW.getTime() - DAY_MS));

    await evaluate(world, big.id);
    await evaluate(world, small.id);

    expect((await tierOf(world.tenantId, big.id)).tier_id).toBe(gold);
    expect((await tierOf(world.tenantId, small.id)).tier_id).toBe(silver);
  });

  it("only visits inside the rolling window count", async () => {
    const world = await tierWorld();
    await seedTier(world.tenantId, { rank: 1, spend: 100_000, visits: 100 });
    const member = await seedMember(world.tenantId);
    // 13 months old: outside the 12-month window.
    await seedVisit(world, member.id, 500_000, monthsFrom(NOW, -13));

    expect(await evaluate(world, member.id)).toBe(false);
    expect((await tierOf(world.tenantId, member.id)).tier_id).toBeNull();

    // 11 months old: inside.
    await seedVisit(world, member.id, 500_000, monthsFrom(NOW, -11));
    expect(await evaluate(world, member.id)).toBe(true);
    const history = await historyOf(world.tenantId, member.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      rolling_spend_idr: "500000",
      rolling_visits: 1,
    });
  });

  it("a member whose visits leave the window drops to no tier, with history and event", async () => {
    const world = await tierWorld();
    const silver = await seedTier(world.tenantId, {
      rank: 1,
      spend: 100_000,
      visits: 100,
    });
    const member = await seedMember(world.tenantId);
    await seedVisit(world, member.id, 200_000, monthsFrom(NOW, -6));
    expect(await evaluate(world, member.id)).toBe(true);

    // 14 months after the visit: out of the window.
    expect(await evaluate(world, member.id, monthsFrom(NOW, 8))).toBe(true);

    expect((await tierOf(world.tenantId, member.id)).tier_id).toBeNull();
    const history = await historyOf(world.tenantId, member.id);
    expect(history).toHaveLength(2);
    // Found by content: created_at follows the DB clock, so row order is not proof.
    expect(history.find((row) => row.from_tier_id === silver)).toMatchObject({
      from_tier_id: silver,
      to_tier_id: null,
      reason: "evaluation",
    });
    const events = await outboxEvents(
      world.tenantId,
      "tier.changed",
      member.id,
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload.toTierId)).toContain(null);
  });

  it("the tier change, the history row and tier.changed commit together or not at all", async () => {
    const world = await tierWorld();
    const silver = await seedTier(world.tenantId, {
      rank: 1,
      spend: 10_000,
      visits: 100,
    });
    const member = await seedMember(world.tenantId);
    await seedVisit(world, member.id, 50_000, new Date(NOW.getTime() - DAY_MS));

    // The caller's transaction fails right after the evaluation: nothing stays.
    await rejection(
      withTenant(db, world.context, async (tx) => {
        await withProfileLock(tx, world.tenantId, member.id);
        expect(
          await evaluateProfileTier(tx, world.context, member.id, NOW),
        ).toBe(true);
        throw new Error("rollback after evaluation");
      }),
    );
    expect((await tierOf(world.tenantId, member.id)).tier_id).toBeNull();
    expect(await historyOf(world.tenantId, member.id)).toHaveLength(0);
    expect(
      await outboxEvents(world.tenantId, "tier.changed", member.id),
    ).toHaveLength(0);

    // A committed evaluation leaves all three.
    expect(await evaluate(world, member.id)).toBe(true);
    expect((await tierOf(world.tenantId, member.id)).tier_id).toBe(silver);
    expect(await historyOf(world.tenantId, member.id)).toHaveLength(1);
    expect(
      await outboxEvents(world.tenantId, "tier.changed", member.id),
    ).toHaveLength(1);
  });
});

describe("customer_tier_history is append-only for legend_app", () => {
  it("UPDATE, DELETE and TRUNCATE of a history row are refused", async () => {
    const world = await tierWorld();
    await seedTier(world.tenantId, { rank: 1, spend: 10_000, visits: 100 });
    const member = await seedMember(world.tenantId);
    await seedVisit(world, member.id, 50_000, new Date(NOW.getTime() - DAY_MS));
    await evaluate(world, member.id);
    expect(await historyOf(world.tenantId, member.id)).toHaveLength(1);

    const update = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`UPDATE customer_tier_history SET reason = 'manual' WHERE tenant_id = ${world.tenantId}`,
        ),
      ),
    );
    expect(update).toMatch(/append-only|permission denied/i);
    const remove = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(
          sql`DELETE FROM customer_tier_history WHERE tenant_id = ${world.tenantId}`,
        ),
      ),
    );
    expect(remove).toMatch(/append-only|permission denied/i);
    const truncate = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(sql`TRUNCATE customer_tier_history`),
      ),
    );
    expect(truncate).toMatch(/permission denied/i);

    const history = await historyOf(world.tenantId, member.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.reason).toBe("evaluation");
  });
});

// ---- referral -------------------------------------------------------------------

type Rules = Partial<{
  enabled: boolean;
  referrerPoints: number;
  refereePoints: number;
  minFirstOrderIdr: number;
  maxReferralsPerCustomerPerMonth: number;
}>;

async function setReferralRules(
  tenantId: string,
  rules: Rules = {},
): Promise<void> {
  await asTenant(tenantId, (client) =>
    client.query(
      "UPDATE loyalty_programs SET referral = $2::jsonb WHERE tenant_id = $1",
      [
        tenantId,
        JSON.stringify({
          enabled: true,
          referrerPoints: 100,
          refereePoints: 50,
          qualifyingEvent: "first_paid_order",
          minFirstOrderIdr: 0,
          maxReferralsPerCustomerPerMonth: 10,
          ...rules,
        }),
      ],
    ),
  );
}

async function referralWorld(rules: Rules = {}): Promise<World> {
  const world = await tierWorld();
  await setReferralRules(world.tenantId, rules);
  return world;
}

/** An active member who owns a referral code. */
async function referrerOf(world: World) {
  const member = await seedMember(world.tenantId);
  const code = `REF${short().toUpperCase()}`;
  await asTenant(world.tenantId, (client) =>
    client.query(
      "UPDATE customer_profiles SET referral_code = $3 WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, member.id, code],
    ),
  );
  return { ...member, code };
}

function signup(world: World, refereeProfileId: string, code: string) {
  return withTenant(db, world.context, (tx) =>
    applyReferralAtSignup(tx, {
      tenantId: world.tenantId,
      refereeProfileId,
      code,
    }),
  );
}

type ReferralRow = {
  id: string;
  referrer_profile_id: string;
  referee_profile_id: string;
  code: string;
  status: string;
  first_order_id: string | null;
  referrer_points: number;
  referee_points: number;
  qualified_at: Date | null;
  rewarded_at: Date | null;
};

async function referralsOf(tenantId: string): Promise<ReferralRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<ReferralRow>(
      `SELECT id, referrer_profile_id, referee_profile_id, code, status, first_order_id,
              referrer_points, referee_points, qualified_at, rewarded_at
         FROM referrals WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  });
}

/** Pays the referee's order through the earn consumer; returns the order ULID. */
async function payOrder(
  world: World,
  profileId: string,
  gross = 100_000,
): Promise<string> {
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId,
    grossSalesIdr: gross,
  });
  await deliver(
    world,
    orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: gross,
    }),
  );
  return orderUlid;
}

const referralBonuses = async (tenantId: string, profileId: string) =>
  (await ledgerOf(tenantId, profileId)).filter(
    (row) => row.type === "bonus" && row.source_type === "referral",
  );

describe("referral sign-up", () => {
  it("a referral code at sign-up creates one pending referral with the program points copied", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);

    await signup(world, referee.id, referrer.code);
    // The program changes later: the row keeps the points of sign-up time.
    await setReferralRules(world.tenantId, {
      referrerPoints: 999,
      refereePoints: 999,
    });

    const rows = await referralsOf(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      referrer_profile_id: referrer.id,
      referee_profile_id: referee.id,
      code: referrer.code,
      status: "pending",
      first_order_id: null,
      referrer_points: 100,
      referee_points: 50,
      qualified_at: null,
      rewarded_at: null,
    });
  });

  it("an unknown code, a disabled program and a self-referral are silently ignored", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const stranger = await seedMember(world.tenantId);

    await expect(
      signup(world, stranger.id, "NOSUCHCODE"),
    ).resolves.not.toThrow();
    // Self-referral: the referee enters their own code.
    await expect(
      signup(world, referrer.id, referrer.code),
    ).resolves.not.toThrow();
    expect(await referralsOf(world.tenantId)).toHaveLength(0);

    await setReferralRules(world.tenantId, { enabled: false });
    await expect(
      signup(world, stranger.id, referrer.code),
    ).resolves.not.toThrow();
    expect(await referralsOf(world.tenantId)).toHaveLength(0);
  });

  it("a referee has one referrer: a second sign-up code adds no row, and the table refuses a duplicate", async () => {
    const world = await referralWorld();
    const first = await referrerOf(world);
    const second = await referrerOf(world);
    const referee = await seedMember(world.tenantId);

    await signup(world, referee.id, first.code);
    await expect(signup(world, referee.id, second.code)).resolves.not.toThrow();

    const rows = await referralsOf(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referrer_profile_id).toBe(first.id);

    const duplicate = await rejection(
      asTenant(world.tenantId, (client) =>
        client.query(
          `INSERT INTO referrals (id, tenant_id, referrer_profile_id, referee_profile_id, code, status, referrer_points, referee_points)
           VALUES ($1, $2, $3, $4, $5, 'pending', 100, 50)`,
          [randomUUID(), world.tenantId, second.id, referee.id, second.code],
        ),
      ),
    );
    expect(duplicate).toMatch(/unique|duplicate/i);
  });

  it("the table refuses a referral of a customer to themselves", async () => {
    const world = await referralWorld();
    const member = await seedMember(world.tenantId);
    const message = await rejection(
      asTenant(world.tenantId, (client) =>
        client.query(
          `INSERT INTO referrals (id, tenant_id, referrer_profile_id, referee_profile_id, code, status, referrer_points, referee_points)
           VALUES ($1, $2, $3, $3, 'SELFREF1', 'pending', 100, 50)`,
          [randomUUID(), world.tenantId, member.id],
        ),
      ),
    );
    expect(message).toMatch(/check|referrals/i);
  });

  it("ensureReferralCode makes one stable 8-character code when referral is on, and null when it is off", async () => {
    const world = await referralWorld();
    const member = await seedMember(world.tenantId);
    const ensure = (profileId: string) =>
      withTenant(db, world.context, (tx) =>
        ensureReferralCode(tx, world.tenantId, profileId),
      );

    const code = await ensure(member.id);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(await ensure(member.id)).toBe(code);

    await setReferralRules(world.tenantId, { enabled: false });
    const other = await seedMember(world.tenantId);
    expect(await ensure(other.id)).toBeNull();
    // A profile that already has a code keeps it.
    expect(await ensure(member.id)).toBe(code);
  });
});

describe("referral through real HTTP sign-up and profile", () => {
  const POLICY = "2026-01";

  // The seeded tenant is shared: these tests turn its referral rules on and
  // switch them off again when the block ends.
  beforeAll(async () => {
    await seedProgram(seededTenantId);
    await setReferralRules(seededTenantId);
  });
  afterAll(async () => {
    await setReferralRules(seededTenantId, { enabled: false });
  });

  async function codedReferrer() {
    const user = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const code = `REF${short().toUpperCase()}`;
    await asTenant(seededTenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET referral_code = $3 WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, user.profileId, code],
      ),
    );
    return { ...user, code };
  }

  it("a new member who signs up over HTTP with a referral code gets one pending referral and an own code", async () => {
    const referrer = await codedReferrer();
    const referee = await newMemberUser(app, {
      profile: false,
      verifiedWhatsapp: true,
    });

    const response = await referee.client
      .post("/api/member/consents")
      .set(headers)
      .send({
        purpose: "loyalty",
        granted: true,
        policyVersion: POLICY,
        referralCode: referrer.code,
      });
    expect(response.status).toBe(200);

    const { rows } = await asTenant(seededTenantId, (client) =>
      client.query<{ id: string; referral_code: string | null }>(
        "SELECT id, referral_code FROM customer_profiles WHERE tenant_id = $1 AND user_id = $2",
        [seededTenantId, referee.userId],
      ),
    );
    const created = rows[0]!;
    expect(created.referral_code).toMatch(/^[A-Z0-9]{8}$/);

    const mine = (await referralsOf(seededTenantId)).filter(
      (row) => row.referee_profile_id === created.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      referrer_profile_id: referrer.profileId,
      code: referrer.code,
      status: "pending",
      referrer_points: 100,
      referee_points: 50,
    });
  });

  it("GET /api/member/profile gives an existing member without a code a stable one when referral is on", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });

    const first = await member.client.get("/api/member/profile").set(headers);
    expect(first.status).toBe(200);
    expect(first.body.data.referralCode).toMatch(/^[A-Z0-9]{8}$/);
    const stored = await asTenant(seededTenantId, (client) =>
      client.query<{ referral_code: string | null }>(
        "SELECT referral_code FROM customer_profiles WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, member.profileId],
      ),
    );
    expect(stored.rows[0]!.referral_code).toBe(first.body.data.referralCode);

    const second = await member.client.get("/api/member/profile").set(headers);
    expect(second.body.data.referralCode).toBe(first.body.data.referralCode);
  });

  it("GET /api/member/profile gives no code when the referral program is off", async () => {
    await setReferralRules(seededTenantId, { enabled: false });
    try {
      const member = await newMemberUser(app, {
        profile: "active",
        verifiedWhatsapp: true,
      });
      const response = await member.client
        .get("/api/member/profile")
        .set(headers);
      expect(response.status).toBe(200);
      expect(response.body.data.referralCode).toBeNull();
    } finally {
      await setReferralRules(seededTenantId);
    }
  });
});

describe("referral qualification", () => {
  it("an order blocked as self-serve does not qualify the referral", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);

    // The cashier of the order is the referee's own user: blocked_self_serve.
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: referee.id,
      cashierId: referee.userId,
    });
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid,
        outletId: world.outletA,
        cashierId: referee.userId,
      }),
    );

    expect((await recordOf(world.tenantId, orderUlid))?.state).toBe("blocked");
    expect((await referralsOf(world.tenantId))[0]!.status).toBe("pending");
    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(0);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
  });

  it("the referee's first paid order rewards both sides once", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);

    const orderUlid = await payOrder(world, referee.id);

    const [referral] = await referralsOf(world.tenantId);
    expect(referral).toMatchObject({
      status: "rewarded",
      first_order_id: ulidToUuid(orderUlid),
    });
    expect(referral!.qualified_at).not.toBeNull();
    expect(referral!.rewarded_at).not.toBeNull();

    const referrerBonus = await referralBonuses(world.tenantId, referrer.id);
    expect(referrerBonus).toHaveLength(1);
    expect(referrerBonus[0]).toMatchObject({
      points: "100",
      source_id: referral!.id,
    });
    expect(referrerBonus[0]!.expires_at).not.toBeNull();
    const refereeBonus = await referralBonuses(world.tenantId, referee.id);
    expect(refereeBonus).toHaveLength(1);
    expect(refereeBonus[0]!.points).toBe("50");
    expect([orderUlid, ulidToUuid(orderUlid)]).toContain(
      refereeBonus[0]!.source_id,
    );
    expect(await balanceOf(world.tenantId, referrer.id)).toBe(100);
    // 10 earned points for the order plus the 50 bonus.
    expect(await balanceOf(world.tenantId, referee.id)).toBe(60);
  });

  it("a second paid order, or a replayed event, pays nothing more", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);

    const first = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: referee.id,
    });
    const event = orderPaidEvent(world, {
      orderUlid: first,
      outletId: world.outletA,
    });
    await deliver(world, event);
    await deliver(world, event);
    await payOrder(world, referee.id);

    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(1);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(1);
    expect(await balanceOf(world.tenantId, referrer.id)).toBe(100);
    expect((await referralsOf(world.tenantId))[0]!.status).toBe("rewarded");
  });

  it("a side whose points are 0 gets no bonus row", async () => {
    const world = await referralWorld({ refereePoints: 0 });
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);

    await payOrder(world, referee.id);

    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(1);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
    expect((await referralsOf(world.tenantId))[0]!.status).toBe("rewarded");
  });

  it("a first order below the minimum pays no bonus to either side", async () => {
    const world = await referralWorld({ minFirstOrderIdr: 150_000 });
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);

    await payOrder(world, referee.id, 100_000);

    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(0);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
    expect((await referralsOf(world.tenantId))[0]!.status).not.toBe("rewarded");
  });

  it("when the program turns referral off before the first order, nothing is paid", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);
    await setReferralRules(world.tenantId, { enabled: false });

    await payOrder(world, referee.id);

    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(0);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
  });

  it("the referrer's monthly cap: the referral over the cap expires with no bonus", async () => {
    const world = await referralWorld({ maxReferralsPerCustomerPerMonth: 1 });
    const referrer = await referrerOf(world);
    const one = await seedMember(world.tenantId);
    const two = await seedMember(world.tenantId);
    await signup(world, one.id, referrer.code);
    await signup(world, two.id, referrer.code);

    await payOrder(world, one.id);
    await payOrder(world, two.id);

    const rows = await referralsOf(world.tenantId);
    const byReferee = (id: string) =>
      rows.find((row) => row.referee_profile_id === id)!;
    expect(byReferee(one.id).status).toBe("rewarded");
    expect(byReferee(two.id).status).toBe("expired");
    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(1);
    expect(await referralBonuses(world.tenantId, two.id)).toHaveLength(0);
    // The capped referee still earned points for the order itself.
    expect(await balanceOf(world.tenantId, two.id)).toBe(10);
  });

  it("a referrer who is no longer active at qualification gets the referral expired, no bonus", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const referee = await seedMember(world.tenantId);
    await signup(world, referee.id, referrer.code);
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET membership_status = 'suspended' WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, referrer.id],
      ),
    );

    await payOrder(world, referee.id);

    expect((await referralsOf(world.tenantId))[0]!.status).toBe("expired");
    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(0);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
  });

  it("a referee whose WhatsApp number already had another profile is refused, no bonus", async () => {
    const world = await referralWorld();
    const referrer = await referrerOf(world);
    const hash = hex64();
    // The earlier profile (any status) of the same person.
    await seedProfile(world.tenantId, {
      status: "closed",
      whatsappHash: hash,
    });
    const referee = await seedMember(world.tenantId, { whatsappHash: hash });
    await signup(world, referee.id, referrer.code);

    await payOrder(world, referee.id);

    expect((await referralsOf(world.tenantId))[0]!.status).toBe("expired");
    expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(0);
    expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(0);
  });
});

// ---- isolation of the new tables ------------------------------------------------

describe("referrals isolation", () => {
  it("referrals has tenant RLS and a restrictive member policy", async () => {
    const { rows } = await owner.query<{ permissive: string }>(
      "SELECT permissive FROM pg_policies WHERE tablename = 'referrals'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.permissive === "RESTRICTIVE")).toBe(true);
    const { rows: flags } = await owner.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'referrals'",
    );
    expect(flags[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("with app.customer_profile_id set a member sees only referrals they are in; staff see all", async () => {
    const world = await tierWorld();
    const a = await seedMember(world.tenantId);
    const b = await seedMember(world.tenantId);
    const c = await seedMember(world.tenantId);
    const d = await seedMember(world.tenantId);
    const e = await seedMember(world.tenantId);
    const insert = (referrerId: string, refereeId: string) =>
      asTenant(world.tenantId, (client) =>
        client.query(
          `INSERT INTO referrals (id, tenant_id, referrer_profile_id, referee_profile_id, code, status, referrer_points, referee_points)
           VALUES ($1, $2, $3, $4, $5, 'pending', 100, 50)`,
          [
            randomUUID(),
            world.tenantId,
            referrerId,
            refereeId,
            `ISO${short().toUpperCase()}`,
          ],
        ),
      );
    await insert(a.id, b.id); // A refers B
    await insert(c.id, d.id); // unrelated to A and B
    await insert(e.id, a.id); // E refers A

    const countAs = (profile: typeof a) =>
      withMemberScope(db, scopeOf(world.tenantId, profile), async (tx) =>
        Number(
          (await tx.execute(sql`SELECT count(*)::int AS n FROM referrals`))
            .rows[0]!.n,
        ),
      );
    expect(await countAs(a)).toBe(2); // as referrer and as referee
    expect(await countAs(b)).toBe(1);
    expect(await countAs(e)).toBe(1);
    expect(await countAs(c)).toBe(1);

    const staffSees = await withTenant(db, world.context, async (tx) =>
      Number(
        (await tx.execute(sql`SELECT count(*)::int AS n FROM referrals`))
          .rows[0]!.n,
      ),
    );
    expect(staffSees).toBe(3);

    // Another tenant never sees these rows, with or without the GUC.
    const other = await tierWorld();
    const otherSees = await withTenant(db, other.context, async (tx) =>
      Number(
        (await tx.execute(sql`SELECT count(*)::int AS n FROM referrals`))
          .rows[0]!.n,
      ),
    );
    expect(otherSees).toBe(0);
  });
});

// ---- staff permission over HTTP ---------------------------------------------------

const uniqueName = (prefix: string) => `${prefix} ${short()}`;
const freeRank = () => 1_000 + Math.floor(Math.random() * 900_000);

function tierBody(overrides: Record<string, unknown> = {}) {
  return {
    name: uniqueName("Tier"),
    rank: freeRank(),
    thresholdSpendIdr: 500_000,
    thresholdVisits: 5,
    benefits: {
      pointsMultiplierBp: 12_000,
      birthdayRewardPoints: 25,
      reservationPriority: false,
      exclusivePromotions: false,
      facilityFreeAccessQuota: 0,
    },
    isActive: true,
    ...overrides,
  };
}

async function createTierAsBoss(overrides: Record<string, unknown> = {}) {
  const body = tierBody(overrides);
  const response = await boss.client
    .post("/api/loyalty/tiers")
    .set(headers)
    .send(body);
  if ([200, 201].includes(response.status))
    httpTierIds.push(response.body.data.id as string);
  return { body, response };
}

describe("tier administration over HTTP (crm.loyalty.manage)", () => {
  it("the owner creates, lists and updates a tier; tiers are deactivated, not deleted", async () => {
    const { body, response } = await createTierAsBoss();
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      name: body.name,
      rank: body.rank,
      thresholdSpendIdr: 500_000,
      thresholdVisits: 5,
      isActive: true,
    });
    expect(response.body.data.benefits).toMatchObject({
      pointsMultiplierBp: 12_000,
      birthdayRewardPoints: 25,
    });
    const tierId = response.body.data.id as string;

    const list = await boss.client.get("/api/loyalty/tiers").set(headers);
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { id: string }[]).some((tier) => tier.id === tierId),
    ).toBe(true);

    const patched = await boss.client
      .patch(`/api/loyalty/tiers/${tierId}`)
      .set(headers)
      .send({ name: "Nama Baru", thresholdVisits: 8, isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      id: tierId,
      name: "Nama Baru",
      thresholdVisits: 8,
      isActive: false,
    });
    const after = await boss.client.get("/api/loyalty/tiers").set(headers);
    expect(
      (after.body.data as { id: string; isActive: boolean }[]).find(
        (tier) => tier.id === tierId,
      ),
    ).toMatchObject({ isActive: false });
  });

  it("an invalid tier body is 422 and a taken rank is refused", async () => {
    for (const bad of [
      { rank: 0 },
      { name: "" },
      { thresholdSpendIdr: -1 },
      { benefits: { pointsMultiplierBp: 5_000 } },
    ]) {
      const response = await boss.client
        .post("/api/loyalty/tiers")
        .set(headers)
        .send(tierBody(bad));
      expect(response.status, JSON.stringify(bad)).toBe(422);
    }
    const { body } = await createTierAsBoss();
    const duplicate = await boss.client
      .post("/api/loyalty/tiers")
      .set(headers)
      .send(tierBody({ rank: body.rank }));
    expect([400, 409, 422]).toContain(duplicate.status);
  });

  it("a cashier (no crm.loyalty.manage) gets 403 on list, create and update, and changes nothing", async () => {
    const { response } = await createTierAsBoss({ name: "Tier Kasir Uji" });
    const tierId = response.body.data.id as string;

    expect(
      (await cashier.client.get("/api/loyalty/tiers").set(headers)).status,
    ).toBe(403);
    const create = await cashier.client
      .post("/api/loyalty/tiers")
      .set(headers)
      .send(tierBody());
    expect(create.status).toBe(403);
    const update = await cashier.client
      .patch(`/api/loyalty/tiers/${tierId}`)
      .set(headers)
      .send({ name: "Dibajak" });
    expect(update.status).toBe(403);

    const list = await boss.client.get("/api/loyalty/tiers").set(headers);
    expect(
      (list.body.data as { id: string; name: string }[]).find(
        (tier) => tier.id === tierId,
      )!.name,
    ).toBe("Tier Kasir Uji");
  });

  it("a visitor without a session gets 401 and a member session gets 403", async () => {
    const anonymous = await agent(app).get("/api/loyalty/tiers").set(headers);
    expect(anonymous.status).toBe(401);

    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const asMember = await member.client.get("/api/loyalty/tiers").set(headers);
    expect(asMember.status).toBe(403);
    const create = await member.client
      .post("/api/loyalty/tiers")
      .set(headers)
      .send(tierBody());
    expect(create.status).toBe(403);
  });
});
