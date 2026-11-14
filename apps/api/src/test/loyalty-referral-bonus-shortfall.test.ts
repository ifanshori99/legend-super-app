// legend-referral-bonus-shortfall (second-opinion P2).
// Written BEFORE the fix: S1 must fail on the current base, S2 and S3 are
// controls. Rule source: the founder money rule ("no party is paid more, the
// outlet does not lose") and the shortfall meaning used by legend-nkp77: points
// that LAPSED (expired) are not a refund_after_redeem shortfall; points that were
// SPENT (redeemed) before the refund are. Not written from the services.
//
// Fixture: a rewarded referral (referrer bonus 100, referee bonus 50 + 10 earned
// for the first order), cloned from loyalty-referral-followups.test.ts.
//
// Assumptions (the brief is silent):
// - The anomaly is booked once per member side, so the anomalies are filtered by
//   customer_profile_id.
// - The shortfall figure lives in loyalty_anomalies.details->shortfallPoints
//   (numeric in JSON; compared with Number()).
// - S3: "the referrer is not lapsed" is built as the referrer having SPENT the
//   bonus (balance-bound side); the referee's two lots lapse and are swept.
//
// Expected numbers
//   S1  referrer 100 + 500 -> sweep -> 500 -> void -> 500; referee 60 -> 0;
//       no refund_after_redeem anomaly at all.
//   S2  referrer 100 -> redeem 100 -> 0 -> void -> 0; one refund_after_redeem
//       for the referrer with shortfallPoints 100; none for the referee.
//   S3  referrer: as S2 (one anomaly, shortfall 100); referee lapsed to 0: none.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { expirePointsForProfile } from "../services/loyalty-expiry.service.ts";
import { postLedgerEntry } from "../services/point-ledger.service.ts";
import { applyReferralAtSignup } from "../services/referral.service.ts";
import {
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderVoidedEvent,
  owner,
  seedMember,
  seedOrder,
  seedProgram,
  short,
  type LedgerRow,
  type World,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const FAR = new Date("2035-01-01T00:00:00Z");

const sumPoints = (rows: LedgerRow[]) =>
  rows.reduce((total, row) => total + Number(row.points), 0);

function neverNegative(rows: LedgerRow[]): boolean {
  let running = 0;
  for (const row of rows) {
    running += Number(row.points);
    if (running < 0) return false;
  }
  return true;
}

async function expectLedgerConsistent(world: World, profileId: string) {
  const rows = await ledgerOf(world.tenantId, profileId);
  expect(neverNegative(rows)).toBe(true);
  expect(sumPoints(rows)).toBe(await balanceOf(world.tenantId, profileId));
}

function runExpiry(world: World, profileId: string, now: Date) {
  return withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return expirePointsForProfile(tx, world.tenantId, profileId, now);
  });
}

/** Sweeps every lot of the member that has an expiry before FAR. */
async function lapseShortLots(world: World, profileId: string) {
  const lapsing = (await ledgerOf(world.tenantId, profileId)).filter(
    (row) =>
      row.expires_at !== null && row.expires_at.getTime() < FAR.getTime(),
  );
  expect(lapsing.length).toBeGreaterThanOrEqual(1);
  const lastExpiry = Math.max(...lapsing.map((r) => r.expires_at!.getTime()));
  await runExpiry(world, profileId, new Date(lastExpiry + 1000));
}

/** The member spends every point (redeem), so nothing is left to take back. */
async function redeemAll(world: World, profileId: string, points: number) {
  const redemptionId = randomUUID();
  await withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    await postLedgerEntry(
      tx,
      world.context,
      {
        tenantId: world.tenantId,
        customerProfileId: profileId,
        type: "redeem",
        points: -points,
        sourceType: "reward_redemption",
        sourceId: redemptionId,
        event: { rewardId: randomUUID(), redemptionId },
      },
      NOW,
    );
  });
}

type ShortfallAnomaly = {
  customer_profile_id: string;
  details: Record<string, unknown> | null;
};

async function shortfallAnomalies(
  tenantId: string,
  profileId: string,
): Promise<ShortfallAnomaly[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<ShortfallAnomaly>(
      `SELECT customer_profile_id, details
         FROM loyalty_anomalies
        WHERE tenant_id = $1 AND kind = 'refund_after_redeem'
          AND customer_profile_id = $2
        ORDER BY created_at`,
      [tenantId, profileId],
    );
    return rows;
  });
}

/** Referrer 100 + referee 50 points; the referee's QR first order (100.000) is paid. */
async function rewardedReferral() {
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
        }),
      ],
    );
  });
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
    channel: "qr",
    profileId: referee.id,
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
  expect(await balanceOf(world.tenantId, referrer.id)).toBe(100);
  expect(await balanceOf(world.tenantId, referee.id)).toBe(60);
  return {
    world,
    referrerId: referrer.id,
    refereeId: referee.id,
    orderUlid,
  };
}
type Rewarded = Awaited<ReturnType<typeof rewardedReferral>>;

function voidEvent(s: Rewarded) {
  return orderVoidedEvent(s.world, {
    orderUlid: s.orderUlid,
    outletId: s.world.outletA,
    voidId: randomUUID(),
    voidedFinalOrder: true,
  });
}

describe("legend-referral-bonus-shortfall lapsed bonus points are not a refund_after_redeem shortfall", () => {
  it("S1 fix: the referrer bonus lapsed, another grant of 500 is live: a void takes nothing from the 500 and records no shortfall", async () => {
    const s = await rewardedReferral();
    await grantPoints(s.world.tenantId, s.referrerId, 500, FAR);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(600);

    // Only the 100 bonus lapses; the 500 (far expiry) stay.
    await lapseShortLots(s.world, s.referrerId);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(500);

    const voided = voidEvent(s);
    await deliver(s.world, voided);
    await deliver(s.world, voided); // replay changes nothing

    // The lapsed bonus is gone, the live grant is not touched.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(500);
    // Lapsed points are not a shortfall, on either side.
    expect(await shortfallAnomalies(s.world.tenantId, s.referrerId)).toEqual(
      [],
    );
    expect(await shortfallAnomalies(s.world.tenantId, s.refereeId)).toEqual([]);
    // The referee (live bonus and earn) gives everything back.
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    await expectLedgerConsistent(s.world, s.referrerId);
    await expectLedgerConsistent(s.world, s.refereeId);
  });

  it("S2 control: the referrer spent the bonus (redeem to 0): a void records the 100 as a shortfall", async () => {
    const s = await rewardedReferral();
    await redeemAll(s.world, s.referrerId, 100);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    const voided = voidEvent(s);
    await deliver(s.world, voided);
    await deliver(s.world, voided); // replay changes nothing

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    const anomalies = await shortfallAnomalies(s.world.tenantId, s.referrerId);
    expect(anomalies).toHaveLength(1);
    expect(Number(anomalies[0]!.details?.shortfallPoints)).toBe(100);
    // The referee still had everything: no anomaly on that side.
    expect(await shortfallAnomalies(s.world.tenantId, s.refereeId)).toEqual([]);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    await expectLedgerConsistent(s.world, s.referrerId);
    await expectLedgerConsistent(s.world, s.refereeId);
  });

  it("S3 the referee side lapsed, the referrer side spent: only the spent side is a shortfall", async () => {
    const s = await rewardedReferral();
    // Referee: bonus 50 and earn 10 both lapse and are swept.
    await lapseShortLots(s.world, s.refereeId);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    // Referrer: spends the 100 before the refund.
    await redeemAll(s.world, s.referrerId, 100);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    const voided = voidEvent(s);
    await deliver(s.world, voided);
    await deliver(s.world, voided); // replay changes nothing

    const referrerAnomalies = await shortfallAnomalies(
      s.world.tenantId,
      s.referrerId,
    );
    expect(referrerAnomalies).toHaveLength(1);
    expect(Number(referrerAnomalies[0]!.details?.shortfallPoints)).toBe(100);
    // Lapsed on the referee side: not a shortfall.
    expect(await shortfallAnomalies(s.world.tenantId, s.refereeId)).toEqual([]);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    await expectLedgerConsistent(s.world, s.referrerId);
    await expectLedgerConsistent(s.world, s.refereeId);
  });
});
