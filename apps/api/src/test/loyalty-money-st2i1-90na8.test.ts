// legend-st2i1 + legend-90na8 (brief docs/briefs/loyalty-points-money.md): points
// never created twice, balance never negative, idempotent on retry and under
// concurrency. Written from the brief and the cards, not from the services.
//
// legend-st2i1: the referral bonus is reversed when the referee's FIRST paid
// order is voided (order.voided, voidedFinalOrder) or fully refunded
// (order.refunded), through the loyalty earn consumer.
// legend-90na8: split-bill claim tokens (POST /api/table-sessions/:id/points-claim).
//
// Assumptions (the cards are silent):
// - Reversal rows are `type = 'reverse'` with `reverses_entry_id` = the bonus
//   row; their `source_type` / `source_id` are not pinned.
// - "Refund penuh" = one order.refunded event whose gross equals the whole
//   order. Several partial refunds that add up to the whole are NOT pinned.
// - A reversal is capped by the balance (a spent live bonus is taken back from
//   the balance) and, once the bonus grant expired, by what is left of it
//   (0 when gone): no points are taken from other grants a second time.
// - After the reversal the referral is 'expired' and cannot qualify again.
// - A voided order that is NOT the referral's first order, an open-order void
//   (voidedFinalOrder false) and a partial refund leave the bonuses alone.
// - Split claims: a bare (token-less) claim never takes a split order, whether
//   or not all parts are paid (ws03-points-claim.test.ts pins the bare case for
//   fully paid splits); an expired / used / foreign token is refused with a 4xx
//   and nothing is posted. Points of a part are floor(share / 1000) with share =
//   floor(eligible * part / total) (pro-rata), as in ws03-points-claim.test.ts.
// - "Retry idempotent": same key, same member -> 200 again, still one row. A
//   second key after the part is claimed may answer 200 (replay) or 409 but
//   never adds a row.
// - If a 90na8 test passes on the base branch, that is evidence the card was
//   already done, not a broken test.

import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { expirePointsForProfile } from "../services/loyalty-expiry.service.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  postLedgerEntry,
  type LedgerPostInput,
} from "../services/point-ledger.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { applyReferralAtSignup } from "../services/referral.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner as floorOwner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import {
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  hex64,
  ledgerOf,
  newMemberUser,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  owner as loyaltyOwner,
  seedMember,
  seedOrder,
  seedProgram,
  short,
  type LedgerRow,
  type MemberUser,
  type World,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";

afterAll(async () => {
  await floorOwner.end();
  await loyaltyOwner.end();
});

// =============================================================================
// legend-st2i1: reverse the referral bonus on void / full refund of the first order
// =============================================================================

type Rules = Partial<{
  enabled: boolean;
  referrerPoints: number;
  refereePoints: number;
  minFirstOrderIdr: number;
  maxReferralsPerCustomerPerMonth: number;
}>;

async function referralWorld(rules: Rules = {}): Promise<World> {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      "UPDATE loyalty_programs SET rolling_months = 12 WHERE tenant_id = $1",
      [world.tenantId],
    );
    await client.query(
      "UPDATE loyalty_programs SET referral = $2::jsonb WHERE tenant_id = $1",
      [
        world.tenantId,
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
    );
  });
  return world;
}

type ReferralRow = {
  id: string;
  status: string;
  first_order_id: string | null;
};

async function referralsOf(tenantId: string): Promise<ReferralRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<ReferralRow>(
      `SELECT id, status, first_order_id
         FROM referrals WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  });
}

/** Pays an order of the profile through the earn consumer; returns its ULID. */
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

/** Reverse rows that point at one ledger entry. */
const reversalsOf = async (
  tenantId: string,
  profileId: string,
  entryId: string,
) =>
  (await ledgerOf(tenantId, profileId)).filter(
    (row) => row.type === "reverse" && row.reverses_entry_id === entryId,
  );

const sumPoints = (rows: LedgerRow[]) =>
  rows.reduce((total, row) => total + Number(row.points), 0);

/** The running balance never dips below zero, whatever the posting order. */
function neverNegative(rows: LedgerRow[]): boolean {
  let running = 0;
  for (const row of rows) {
    running += Number(row.points);
    if (running < 0) return false;
  }
  return true;
}

/** Posts a ledger row the way the services do (profile lock, app role). */
function postRow(
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

/** The member spends points on a reward (FIFO charging happens at expiry). */
function spend(world: World, profileId: string, points: number) {
  const redemptionId = randomUUID();
  return postRow(world, profileId, {
    type: "redeem",
    points: -points,
    sourceType: "reward_redemption",
    sourceId: redemptionId,
    event: { rewardId: randomUUID(), redemptionId },
  });
}

function runExpiry(world: World, profileId: string, now: Date) {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return expirePointsForProfile(tx, world.tenantId, profileId, now);
  });
}

/** Referrer (100 points) and referee (50 points); the referee's first order is paid. */
async function rewardedReferral(rules: Rules = {}) {
  const world = await referralWorld(rules);
  const referrer = await seedMember(world.tenantId);
  const code = `REF${short().toUpperCase()}`;
  await asTenant(world.tenantId, (client) =>
    client.query(
      "UPDATE customer_profiles SET referral_code = $3 WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, referrer.id, code],
    ),
  );
  const referee = await seedMember(world.tenantId);
  await withTenant(db, world.context, (tx) =>
    applyReferralAtSignup(tx, {
      tenantId: world.tenantId,
      refereeProfileId: referee.id,
      code,
    }),
  );
  const orderUlid = await payOrder(world, referee.id);

  const [referral] = await referralsOf(world.tenantId);
  expect(referral!.status).toBe("rewarded");
  const referrerBonuses = await referralBonuses(world.tenantId, referrer.id);
  const refereeBonuses = await referralBonuses(world.tenantId, referee.id);
  expect(referrerBonuses).toHaveLength(1);
  expect(refereeBonuses).toHaveLength(1);
  // 10 points for the order (Rp100.000 at 1 point per Rp10.000) plus the bonus.
  expect(await balanceOf(world.tenantId, referrer.id)).toBe(100);
  expect(await balanceOf(world.tenantId, referee.id)).toBe(60);
  return {
    world,
    referrer,
    referee,
    orderUlid,
    referralId: referral!.id,
    referrerBonus: referrerBonuses[0]!,
    refereeBonus: refereeBonuses[0]!,
  };
}

type RewardedReferral = Awaited<ReturnType<typeof rewardedReferral>>;

const voidFirstOrder = (s: RewardedReferral) =>
  orderVoidedEvent(s.world, {
    orderUlid: s.orderUlid,
    outletId: s.world.outletA,
    voidId: randomUUID(),
    voidedFinalOrder: true,
  });

const refundFirstOrderFully = (s: RewardedReferral) =>
  orderRefundedEvent(s.world, {
    orderUlid: s.orderUlid,
    outletId: s.world.outletA,
    grossSalesIdr: 100_000,
  });

/** Both bonuses are reversed in full, once, and nothing new was created. */
async function expectFullyReversed(s: RewardedReferral) {
  const { world, referrer, referee } = s;
  const referrerReversal = await reversalsOf(
    world.tenantId,
    referrer.id,
    s.referrerBonus.id,
  );
  expect(referrerReversal).toHaveLength(1);
  expect(Number(referrerReversal[0]!.points)).toBe(-100);
  const refereeReversal = await reversalsOf(
    world.tenantId,
    referee.id,
    s.refereeBonus.id,
  );
  expect(refereeReversal).toHaveLength(1);
  expect(Number(refereeReversal[0]!.points)).toBe(-50);

  expect(await balanceOf(world.tenantId, referrer.id)).toBe(0);
  expect(await balanceOf(world.tenantId, referee.id)).toBe(0);
  // Still exactly one bonus per side: the reversal created no new bonus.
  expect(await referralBonuses(world.tenantId, referrer.id)).toHaveLength(1);
  expect(await referralBonuses(world.tenantId, referee.id)).toHaveLength(1);
  expect(neverNegative(await ledgerOf(world.tenantId, referrer.id))).toBe(true);
  expect(neverNegative(await ledgerOf(world.tenantId, referee.id))).toBe(true);
  expect((await referralsOf(world.tenantId))[0]!.status).toBe("expired");
}

describe("legend-st2i1 referral bonus reversed on void or full refund of the first order", () => {
  it("legend-st2i1 voiding the first order reverses the referrer and the referee bonus, and expires the referral", async () => {
    const s = await rewardedReferral();
    await deliver(s.world, voidFirstOrder(s));
    await expectFullyReversed(s);
  });

  it("legend-st2i1 a full refund of the first order reverses both bonuses too", async () => {
    const s = await rewardedReferral();
    await deliver(s.world, refundFirstOrderFully(s));
    await expectFullyReversed(s);
  });

  it("legend-st2i1 replaying the void or the refund event, or both, reverses nothing twice", async () => {
    const s = await rewardedReferral();
    const voided = voidFirstOrder(s);
    const refunded = refundFirstOrderFully(s);
    await deliver(s.world, voided);
    await deliver(s.world, voided);
    await deliver(s.world, refunded);
    await deliver(s.world, refunded);
    await deliver(s.world, voided);
    await expectFullyReversed(s);
  });

  it("legend-st2i1 events delivered at the same time reverse each bonus once", async () => {
    const s = await rewardedReferral();
    const voided = voidFirstOrder(s);
    const refunded = refundFirstOrderFully(s);
    const results = await Promise.allSettled([
      deliver(s.world, voided),
      deliver(s.world, voided),
      deliver(s.world, refunded),
      deliver(s.world, refunded),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // The worker retries what failed: after redelivery everything converges.
    await deliver(s.world, voided);
    await deliver(s.world, refunded);
    await expectFullyReversed(s);
  });

  it("legend-st2i1 a partial refund of the first order keeps both bonuses and the referral rewarded", async () => {
    const s = await rewardedReferral();
    await deliver(
      s.world,
      orderRefundedEvent(s.world, {
        orderUlid: s.orderUlid,
        outletId: s.world.outletA,
        grossSalesIdr: 50_000,
      }),
    );
    expect(
      await reversalsOf(s.world.tenantId, s.referrer.id, s.referrerBonus.id),
    ).toHaveLength(0);
    expect(
      await reversalsOf(s.world.tenantId, s.referee.id, s.refereeBonus.id),
    ).toHaveLength(0);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(100);
    // 60 minus the 5 earned points of the refunded half; the 50 bonus stays.
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(55);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("rewarded");
  });

  it("legend-st2i1 voiding an open order, or an order that is not the first one, leaves the bonuses alone", async () => {
    const s = await rewardedReferral();
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid: s.orderUlid,
        outletId: s.world.outletA,
        voidId: null,
        voidedFinalOrder: false,
      }),
    );
    const second = await payOrder(s.world, s.referee.id);
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid: second,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(
      await reversalsOf(s.world.tenantId, s.referrer.id, s.referrerBonus.id),
    ).toHaveLength(0);
    expect(
      await reversalsOf(s.world.tenantId, s.referee.id, s.refereeBonus.id),
    ).toHaveLength(0);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(100);
    // 60 from the first order, the second order was earned and voided again.
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(60);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("rewarded");
  });

  it("legend-st2i1 the reversal is limited to the balance: nothing goes negative", async () => {
    const s = await rewardedReferral();
    // The referrer spent 80 of the 100; the referee spent 55 of the 60.
    await spend(s.world, s.referrer.id, 80);
    await spend(s.world, s.referee.id, 55);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(20);
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(5);

    await deliver(s.world, voidFirstOrder(s));

    const referrerReversal = await reversalsOf(
      s.world.tenantId,
      s.referrer.id,
      s.referrerBonus.id,
    );
    expect(sumPoints(referrerReversal)).toBe(-20);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(0);
    expect(neverNegative(await ledgerOf(s.world.tenantId, s.referrer.id))).toBe(
      true,
    );
    expect(neverNegative(await ledgerOf(s.world.tenantId, s.referee.id))).toBe(
      true,
    );
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("expired");
  });

  it("legend-st2i1 a spent live bonus is taken back from the balance, up to the whole bonus", async () => {
    const s = await rewardedReferral();
    // Another, later-expiring grant of 500 points; the spend of 80 is charged
    // to the oldest-expiring grant first, which is the 100-point bonus.
    await grantPoints(s.world.tenantId, s.referrer.id, 500);
    await spend(s.world, s.referrer.id, 80);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(520);

    await deliver(s.world, voidFirstOrder(s));
    await deliver(s.world, voidFirstOrder(s)); // a second event, same order

    const reversal = await reversalsOf(
      s.world.tenantId,
      s.referrer.id,
      s.referrerBonus.id,
    );
    expect(sumPoints(reversal)).toBe(-100);
    // The member keeps nothing of a voided order bonus: 520 - 100.
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(420);
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(0);
  });

  it("legend-st2i1 a bonus grant that already expired reverses 0 and never takes points from other grants", async () => {
    const s = await rewardedReferral();
    await grantPoints(s.world.tenantId, s.referrer.id, 500);
    const expiresAt = s.referrerBonus.expires_at!;
    expect(
      await runExpiry(
        s.world,
        s.referrer.id,
        new Date(expiresAt.getTime() + 1000),
      ),
    ).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(500);

    await deliver(s.world, voidFirstOrder(s));

    const reversal = await reversalsOf(
      s.world.tenantId,
      s.referrer.id,
      s.referrerBonus.id,
    );
    expect(sumPoints(reversal)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(500);
    expect(neverNegative(await ledgerOf(s.world.tenantId, s.referrer.id))).toBe(
      true,
    );
    // The referee side is still reversed in full, and the referral is closed.
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(0);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("expired");
  });

  it("legend-st2i1 a bonus partly spent, then partly expired, then voided reverses only what did not expire", async () => {
    const s = await rewardedReferral();
    // The spend of 80 is charged to the oldest-expiring grant, the 100 bonus;
    // the 20 left of it expire.
    await grantPoints(s.world.tenantId, s.referrer.id, 500);
    await spend(s.world, s.referrer.id, 80);
    const expiresAt = s.referrerBonus.expires_at!;
    expect(
      await runExpiry(
        s.world,
        s.referrer.id,
        new Date(expiresAt.getTime() + 1000),
      ),
    ).toBe(20);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(500);

    await deliver(s.world, voidFirstOrder(s));
    await deliver(s.world, voidFirstOrder(s)); // a second event, same order

    const reversal = await reversalsOf(
      s.world.tenantId,
      s.referrer.id,
      s.referrerBonus.id,
    );
    // 100 bonus - 20 expired = 80 the member used: taken back, not 0, not 100.
    expect(sumPoints(reversal)).toBe(-80);
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(420);
    expect(neverNegative(await ledgerOf(s.world.tenantId, s.referrer.id))).toBe(
      true,
    );
  });

  it("legend-st2i1 a first order partly paid with points, then refunded in full, reverses both bonuses", async () => {
    const world = await referralWorld();
    const referrer = await seedMember(world.tenantId);
    const code = `REF${short().toUpperCase()}`;
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET referral_code = $3 WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, referrer.id, code],
      ),
    );
    const referee = await seedMember(world.tenantId);
    await withTenant(db, world.context, (tx) =>
      applyReferralAtSignup(tx, {
        tenantId: world.tenantId,
        refereeProfileId: referee.id,
        code,
      }),
    );
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: referee.id,
      grossSalesIdr: 100_000,
    });
    // Rp40.000 paid with points: the eligible spend is Rp60.000.
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
        paidPointsIdr: 40_000,
      }),
    );
    const [referral] = await referralsOf(world.tenantId);
    expect(referral!.status).toBe("rewarded");
    const [referrerBonus] = await referralBonuses(world.tenantId, referrer.id);
    const [refereeBonus] = await referralBonuses(world.tenantId, referee.id);
    expect(referrerBonus).toBeDefined();
    expect(refereeBonus).toBeDefined();

    const refund = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: 100_000,
      refundPointsIdr: 40_000,
    });
    await deliver(world, refund);
    await deliver(world, refund); // a second event, same refund

    const referrerReversal = await reversalsOf(
      world.tenantId,
      referrer.id,
      referrerBonus!.id,
    );
    expect(sumPoints(referrerReversal)).toBe(-100);
    const refereeReversal = await reversalsOf(
      world.tenantId,
      referee.id,
      refereeBonus!.id,
    );
    expect(sumPoints(refereeReversal)).toBe(-50);
    expect(await balanceOf(world.tenantId, referrer.id)).toBe(0);
    expect(await balanceOf(world.tenantId, referee.id)).toBe(0);
    expect((await referralsOf(world.tenantId))[0]!.status).toBe("expired");
  });

  it("legend-st2i1 after the reversal the referral cannot qualify again: the next paid order pays no bonus", async () => {
    const s = await rewardedReferral();
    await deliver(s.world, refundFirstOrderFully(s));

    await payOrder(s.world, s.referee.id);
    await payOrder(s.world, s.referee.id);

    expect(await referralBonuses(s.world.tenantId, s.referrer.id)).toHaveLength(
      1,
    );
    expect(await referralBonuses(s.world.tenantId, s.referee.id)).toHaveLength(
      1,
    );
    expect(await balanceOf(s.world.tenantId, s.referrer.id)).toBe(0);
    // Only the two new orders earn (10 points each); no new bonus.
    expect(await balanceOf(s.world.tenantId, s.referee.id)).toBe(20);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("expired");
  });

  it("legend-st2i1 a void of an order whose referral never paid a bonus writes no referral row", async () => {
    // Below the minimum first order: no bonus was ever paid.
    const world = await referralWorld({ minFirstOrderIdr: 150_000 });
    const referrer = await seedMember(world.tenantId);
    const code = `REF${short().toUpperCase()}`;
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET referral_code = $3 WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, referrer.id, code],
      ),
    );
    const referee = await seedMember(world.tenantId);
    await withTenant(db, world.context, (tx) =>
      applyReferralAtSignup(tx, {
        tenantId: world.tenantId,
        refereeProfileId: referee.id,
        code,
      }),
    );
    const orderUlid = await payOrder(world, referee.id, 100_000);
    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    for (const profile of [referrer, referee]) {
      const rows = await ledgerOf(world.tenantId, profile.id);
      expect(rows.filter((row) => row.source_type === "referral")).toEqual([]);
      expect(rows.filter((row) => row.type === "bonus")).toEqual([]);
    }
    expect(await balanceOf(world.tenantId, referrer.id)).toBe(0);
    expect(await balanceOf(world.tenantId, referee.id)).toBe(0);
  });
});

// =============================================================================
// legend-90na8: split-bill point claims
// =============================================================================

const SPEND_PER_POINT = 1000;
const pointsOf = (paidIdr: number) => Math.floor(paidIdr / SPEND_PER_POINT);

const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRSPLITMONEY",
      issuer: null,
    };
    return {
      providerRef: `QSM-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}
const gateway = new FakeGateway();

describe("legend-90na8 split-bill point claims never pay more than the pro-rata spend", () => {
  let app: Express;
  let tenant: IsolatedTenant;
  let staff: Staff;
  let headers: { Host: string };

  function contextOf(tenantId: string): ScopedTenantContext {
    return establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
  }

  async function asOwnerTenant<T>(
    tenantId: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await floorOwner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  type Guest = { token: string; sessionId: string };

  async function seat(): Promise<Guest> {
    const zone = await createZone(
      staff.client,
      { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
      headers,
    );
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    const qr = await issueQr(staff.client, table.id, headers);
    const response = await scan(app, {
      token: qr.token,
      hostname: tenant.hostname,
    });
    expect(response.status).toBe(201);
    return {
      token: response.body.data.sessionToken,
      sessionId: response.body.data.session.id,
    };
  }

  /** A guest request builder; `member` carries the logged-in cookie, if any. */
  function as(guest: Guest, member?: MemberUser) {
    const client = member ? member.client : agent(app);
    const auth = (test: ReturnType<typeof client.get>) =>
      test
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${guest.token}`)
        .set(originHeader);
    const base = `/api/table-sessions/${guest.sessionId}`;
    return {
      view: () => auth(client.get(base)),
      add: (menuItemId: string, expectedCartVersion: number) =>
        auth(client.post(`${base}/cart/lines`)).send({
          idempotencyKey: randomUUID(),
          modifierIds: [],
          menuItemId,
          quantity: 1,
          expectedCartVersion,
        }),
      checkout: (expectedCartVersion: number) =>
        auth(client.post(`${base}/orders`)).send({
          expectedCartVersion,
          idempotencyKey: randomUUID(),
        }),
      split: (body: Record<string, unknown>) =>
        auth(client.post(`${base}/splits`)).send(body),
      paySplit: (billSplitId: string) =>
        auth(client.post(`${base}/payments`)).send({
          target: { kind: "split", billSplitId },
          method: "qris",
          payerSecret: secretFor(billSplitId),
          idempotencyKey: randomUUID(),
        }),
      splitClaim: (splitId: string, payerSecret: string) =>
        auth(client.post(`${base}/splits/${splitId}/claim`)).send({
          payerSecret,
        }),
      pointClaim: (claimToken?: string) =>
        auth(
          client.get(
            `${base}/points-claim${claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ""}`,
          ),
        ),
      claim: (claimToken?: string, idempotencyKey = randomUUID()) =>
        auth(client.post(`${base}/points-claim`)).send({
          idempotencyKey,
          ...(claimToken ? { claimToken } : {}),
        }),
    };
  }

  async function paidEvent(intentId: string): Promise<EventEnvelope> {
    const { rows } = await floorOwner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
       ORDER BY created_at, id`,
      [tenant.tenantId, intentId],
    );
    expect(rows).toHaveLength(1);
    return eventEnvelopeSchema.parse(rows[0]!.event);
  }

  /** Settles an open intent with a verified webhook and runs the QR consumer. */
  async function settle(intentId: string, amountIdr: number): Promise<void> {
    await confirmPayment(contextOf(tenant.tenantId), intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    });
    const event = await paidEvent(intentId);
    const context = contextOf(tenant.tenantId);
    await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(context, event, tx, new Date()),
    );
  }

  type Skew = { serviceIdr: number; taxIdr: number; discountIdr: number };
  /** Service charge, tax and discount, so spend, total and share all differ. */
  const skew: Skew = { serviceIdr: 4000, taxIdr: 4000, discountIdr: 2000 };

  /** Places one pay-first order of one kopi (not paid) with the skew applied. */
  async function placeOrder(guest: Guest) {
    const view = await as(guest).view();
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const added = await as(guest).add(ids.kopi, view.body.data.cart.version);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const placed = await as(guest).checkout(added.body.data.cart.version);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = placed.body.data.order.id as string;
    const { rows } = await floorOwner.query(
      `UPDATE orders
          SET service_charge_idr = $3, tax_idr = $4, discount_idr = $5,
              prices_include_tax = false, rounding_idr = 0,
              total_idr = subtotal_idr - $5 + $3 + $4
        WHERE tenant_id = $1 AND id = $2::uuid
        RETURNING subtotal_idr::bigint AS subtotal, total_idr::bigint AS total`,
      [
        tenant.tenantId,
        ulidToUuid(orderId),
        skew.serviceIdr,
        skew.taxIdr,
        skew.discountIdr,
      ],
    );
    const subtotal = Number(rows[0].subtotal);
    return {
      orderId,
      totalIdr: Number(rows[0].total),
      eligibleIdr: subtotal - skew.discountIdr,
    };
  }

  type SplitDto = { id: string; shareIndex: number; amountIdr: number };
  type SplitOrder = Awaited<ReturnType<typeof placeOrder>> & {
    parts: SplitDto[];
  };

  /** Pro-rata spend of one part (rounded down) and the points it earns. */
  const shareOf = (split: SplitOrder, index: number) =>
    Math.floor(
      (split.eligibleIdr * split.parts[index]!.amountIdr) / split.totalIdr,
    );
  const partPoints = (split: SplitOrder, index: number) =>
    pointsOf(shareOf(split, index));

  /** One order split in two equal parts; `paid` of them are paid and hand out a token. */
  async function splitOrder(guest: Guest, paid: 1 | 2) {
    const order = await placeOrder(guest);
    const created = await as(guest).split({
      method: "equal",
      parts: 2,
      idempotencyKey: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const parts: SplitDto[] = [...created.body.data.splits].sort(
      (a: SplitDto, b: SplitDto) => a.shareIndex - b.shareIndex,
    );
    expect(parts).toHaveLength(2);
    const tokens: string[] = [];
    for (const part of parts.slice(0, paid)) {
      const pay = await as(guest).paySplit(part.id);
      expect(pay.status, JSON.stringify(pay.body)).toBe(201);
      await settle(pay.body.data.id as string, part.amountIdr);
      const claim = await as(guest).splitClaim(part.id, secretFor(part.id));
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      expect(claim.body.data.claimToken).toMatch(/^sc_/);
      tokens.push(claim.body.data.claimToken as string);
    }
    return { split: { ...order, parts } as SplitOrder, tokens };
  }

  /** A logged-in member with an active, verified profile and loyalty consent. */
  async function newMember(): Promise<MemberUser & { profileId: string }> {
    const user = await newMemberUser(app);
    const profile = await seedMember(tenant.tenantId, {
      userId: user.userId,
      name: user.name,
    });
    return { ...user, profileId: profile.id };
  }

  const claimRows = async (profileId: string) =>
    (await ledgerOf(tenant.tenantId, profileId)).filter(
      (row) => row.source_type === "table_claim",
    );

  /** Every table_claim row of the given members. */
  const claimRowsOf = async (members: { profileId: string }[]) =>
    (
      await Promise.all(members.map((member) => claimRows(member.profileId)))
    ).flat();

  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    app = createApp();
    setPaymentGateway(gateway);
    setTableSessionSettlementLookup(qrOrderSettlementLookup);
    setAuditWriter(coreAuditWriter);

    tenant = await createIsolatedTenant(`sm-${randomUUID().slice(0, 6)}`);
    staff = await staffOfIsolatedTenant(app, tenant);
    headers = { Host: tenant.hostname };
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'Klaim Split Uji', 0)`,
        [ids.category, tenant.tenantId, tenant.brandId],
      );
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
        [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
      );
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
        [ids.priceList, tenant.tenantId, tenant.outletId],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 25000)`,
        [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
      );
      await client.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
        [ids.taxSettings, tenant.tenantId, staff.userId],
      );
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-SM', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [ids.taxRule, tenant.tenantId, staff.userId],
      );
      for (const purpose of ["loyalty", "marketing", "ai"])
        await client.query(
          `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
           VALUES ($1, $2, '2026-01', $3, '2026-01-01T00:00:00+07:00')
           ON CONFLICT (tenant_id, purpose, version) DO NOTHING`,
          [tenant.tenantId, purpose, hex64()],
        );
    });
  });

  beforeEach(async () => {
    await seedProgram(tenant.tenantId, {
      isActive: true,
      earnSpendIdr: SPEND_PER_POINT,
      earnPoints: 1,
      expiryMonths: 12,
      dailyCap: 100_000,
    });
  });

  afterAll(async () => {
    setPaymentGateway(null);
    setTableSessionSettlementLookup(null);
    setAuditWriter(null);
    // Audit rows are append-only, so the isolated tenant stays; give it a valid
    // creator so the platform tenant list still parses it.
    await floorOwner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  });

  it("legend-90na8 a part claimed by one member, then the order-level claim by another: refused, total stays pro-rata", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 2);
    const a = await newMember();
    const b = await newMember();

    const part = await as(guest, a).claim(tokens[0]!);
    expect(part.status, JSON.stringify(part.body)).toBe(200);

    // Order-level claim (no token) by another member: nothing left to take.
    const orderLevel = await as(guest, b).claim();
    expect(orderLevel.status, JSON.stringify(orderLevel.body)).toBe(409);
    const view = await as(guest, b).pointClaim();
    expect(view.body.data.status).toBe("unavailable");
    expect(view.body.data.points).toBe(0);
    // The member who took the part cannot take the order either.
    const sameMember = await as(guest, a).claim();
    expect(sameMember.status, JSON.stringify(sameMember.body)).toBe(409);
    expect(await claimRows(b.profileId)).toEqual([]);

    // The other part is still its own claim, and the total is exactly pro-rata.
    const partB = await as(guest, b).claim(tokens[1]!);
    expect(partB.status, JSON.stringify(partB.body)).toBe(200);

    const rows = await claimRowsOf([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source_id).sort()).toEqual(
      split.parts.map((p) => p.id).sort(),
    );
    const total = rows.reduce((sum, row) => sum + Number(row.points), 0);
    expect(total).toBe(partPoints(split, 0) + partPoints(split, 1));
    expect(total).toBeLessThanOrEqual(pointsOf(split.eligibleIdr));
    expect(await balanceOf(tenant.tenantId, a.profileId)).toBe(
      partPoints(split, 0),
    );
    expect(await balanceOf(tenant.tenantId, b.profileId)).toBe(
      partPoints(split, 1),
    );
  });

  it("legend-90na8 an order-level claim tried first takes nothing, and the parts then pay their pro-rata once", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 2);
    const a = await newMember();
    const b = await newMember();

    const orderLevel = await as(guest, a).claim();
    expect(orderLevel.status, JSON.stringify(orderLevel.body)).toBe(409);
    expect(await claimRows(a.profileId)).toEqual([]);
    expect(await balanceOf(tenant.tenantId, a.profileId)).toBe(0);

    expect((await as(guest, a).claim(tokens[0]!)).status).toBe(200);
    expect((await as(guest, b).claim(tokens[1]!)).status).toBe(200);
    // No second pass: a bare claim after both parts are gone is refused too.
    expect((await as(guest, b).claim()).status).toBe(409);

    const rows = await claimRowsOf([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + Number(row.points), 0)).toBe(
      partPoints(split, 0) + partPoints(split, 1),
    );
  });

  it("legend-90na8 a split order with only one part paid: the order-level claim is refused, the paid part earns only its share", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 1);
    const a = await newMember();
    const b = await newMember();

    const orderLevel = await as(guest, b).claim();
    expect(orderLevel.status, JSON.stringify(orderLevel.body)).toBe(409);
    expect(await claimRows(b.profileId)).toEqual([]);

    const paidPart = await as(guest, a).claim(tokens[0]!);
    expect(paidPart.status, JSON.stringify(paidPart.body)).toBe(200);
    const rows = await claimRows(a.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(split.parts[0]!.id);
    expect(Number(rows[0]!.points)).toBe(partPoints(split, 0));
    // Well below what the whole order would pay: the unpaid half is not paid out.
    expect(Number(rows[0]!.points)).toBeLessThan(pointsOf(split.eligibleIdr));
    expect(await balanceOf(tenant.tenantId, b.profileId)).toBe(0);
  });

  it("legend-90na8 an expired part token is refused on POST with no ledger row, and the other part stays claimable", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 2);
    const a = await newMember();
    const b = await newMember();

    await floorOwner.query(
      `UPDATE bill_splits SET claim_expires_at = now() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, split.parts[0]!.id],
    );

    const view = await as(guest).pointClaim(tokens[0]!);
    if (view.status === 200)
      expect(["expired", "unavailable"]).toContain(view.body.data.status);
    const refused = await as(guest, a).claim(tokens[0]!);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(await claimRows(a.profileId)).toEqual([]);
    expect(await balanceOf(tenant.tenantId, a.profileId)).toBe(0);
    // Retrying the expired token with a new key still takes nothing.
    const again = await as(guest, a).claim(tokens[0]!);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await claimRows(a.profileId)).toEqual([]);

    // Part B has its own expiry: it can still be claimed.
    const partB = await as(guest, b).claim(tokens[1]!);
    expect(partB.status, JSON.stringify(partB.body)).toBe(200);
    const rows = await claimRows(b.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(split.parts[1]!.id);
    expect(Number(rows[0]!.points)).toBe(partPoints(split, 1));
  });

  it("legend-90na8 retrying a part claim is idempotent: the same key answers again, a new key adds nothing", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 2);
    const a = await newMember();
    const key = randomUUID();

    const first = await as(guest, a).claim(tokens[0]!, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await as(guest, a).claim(tokens[0]!, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.status).toBe("claimed");
    expect(replay.body.data.points).toBe(partPoints(split, 0));

    const otherKey = await as(guest, a).claim(tokens[0]!);
    expect([200, 409], JSON.stringify(otherKey.body)).toContain(
      otherKey.status,
    );

    const rows = await claimRows(a.profileId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.points)).toBe(partPoints(split, 0));
    expect(await balanceOf(tenant.tenantId, a.profileId)).toBe(
      partPoints(split, 0),
    );
  });

  it("legend-90na8 the same part claimed at the same time, by one member twice or by two members, is paid once", async () => {
    const guest = await seat();
    const { split, tokens } = await splitOrder(guest, 2);
    const a = await newMember();
    const b = await newMember();

    const results = await Promise.all([
      as(guest, a).claim(tokens[0]!),
      as(guest, a).claim(tokens[0]!),
      as(guest, b).claim(tokens[0]!),
      as(guest, b).claim(), // order-level attempt in the same moment
    ]);
    const statuses = results.map((response) => response.status);
    const detail = JSON.stringify(
      results.map((response) => ({
        status: response.status,
        body: response.body,
      })),
    );
    // The bare order-level attempt never wins.
    expect(results[3]!.status, detail).toBe(409);
    // At least one claim of the part is honoured, none is a server error.
    expect(statuses.slice(0, 3), detail).toContain(200);
    for (const status of statuses) expect(status, detail).toBeLessThan(500);

    const rows = await claimRowsOf([a, b]);
    expect(rows, detail).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(split.parts[0]!.id);
    expect(Number(rows[0]!.points)).toBe(partPoints(split, 0));
    const balances =
      (await balanceOf(tenant.tenantId, a.profileId)) +
      (await balanceOf(tenant.tenantId, b.profileId));
    expect(balances).toBe(partPoints(split, 0));
  });
});
