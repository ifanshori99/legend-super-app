// legend-bijqd + legend-sbxr0 + legend-nkp77 (brief: loyalty referral followups).
// Written BEFORE the fix: the tests marked "fix" must fail on the current base.
// Source of rules: the three cards (`bd show`), the founder answers Q5 / Q6 and
// the founder money rule ("no party is paid more, the outlet does not lose; when
// in doubt pick the rule that limits payment"). Not written from the services.
//
// legend-bijqd (Q6)  A referee's first order paid fully with points (eligible
//   spend 0) never triggers the referral bonus, whatever minFirstOrderIdr is.
//   A partial refund never reverses a bonus.
// legend-sbxr0 (Q5)  A refund that reversed the referral bonus and is later
//   REJECTED (ORD-09, order_issue.refund_reversal_requested) gives the bonus
//   back EXACTLY once (retry and concurrent delivery never pay twice). Nothing
//   is given back when the order was voided, or another refund still covers the
//   reversal, or the bonus was never reversed.
// legend-nkp77  The +adjust credit of a rejected refund is tied to the earn grant
//   it came from, so once both grants expired a void takes back 0 (not 50) and
//   the expired points are not recorded as a refund_after_redeem shortfall.
//
// Assumptions (the cards are silent):
// - The ledger shape of a restored bonus is NOT pinned (type / source_type): the
//   tests read the member balance and the sum of the ledger instead.
// - A referral that did not qualify stays 'pending'.
// - "Another active refund": a second full order.refunded (other issue id) of the
//   same order while the first is still open. Rejecting the first must not pay
//   the bonus back. What happens once BOTH are rejected is not pinned beyond
//   "never more than the original bonus" (restrictive rule).
// - After a bonus was restored the referral is live again, so a new full refund
//   reverses it again and its rejection restores it once more.
// - A refund that was never applied to the bonus (partial refund) restores no
//   bonus when rejected.
// - A rejected-refund event for an expired-grant case: the sweep is run with
//   expirePointsForProfile as in loyalty-money-29shf-4frkf.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import { expirePointsForProfile } from "../services/loyalty-expiry.service.ts";
import { postLedgerEntry } from "../services/point-ledger.service.ts";
import { applyReferralAtSignup } from "../services/referral.service.ts";
import {
  NEXT_DAY,
  NOW,
  anomaliesOf,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  owner,
  recordOf,
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

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const FAR = new Date("2035-01-01T00:00:00Z");

type Rules = Partial<{
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

const referralStatus = async (tenantId: string) =>
  (await referralsOf(tenantId))[0]!.status;

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

const bonusRows = async (tenantId: string, profileId: string) =>
  (await ledgerOf(tenantId, profileId)).filter(
    (row) => row.type === "bonus" && row.source_type === "referral",
  );

/** Ledger sum, balance and non-negativity must agree for a member. */
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

/** Next outbox sequence per order: the helper envelopes all use 1. */
let storedSequence = 0;

/** Stores an order event in the outbox like the recovery refund does. */
async function storeEvent(world: World, event: EventEnvelope): Promise<void> {
  storedSequence += 1;
  await withTenant(db, world.context, (tx) =>
    appendOutbox(tx, world.context, {
      id: createUlid(),
      event: { ...event, sequence: storedSequence },
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
}

/** Stores the event, then delivers it (the refund consumer reads the outbox). */
async function storeAndDeliver(world: World, event: EventEnvelope) {
  await storeEvent(world, event);
  await deliver(world, event);
}

const REVERSAL = "order_issue.refund_reversal_requested";

/** A rejected recovery refund (ORD-09), built with the catalog definition. */
function rejectionEvent(
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

type Pair = {
  world: World;
  referrerId: string;
  refereeId: string;
};

/** A referrer with a code and a referee who signed up with it (referral pending). */
async function pendingReferral(rules: Rules = {}): Promise<Pair> {
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
  expect(await referralStatus(world.tenantId)).toBe("pending");
  return { world, referrerId: referrer.id, refereeId: referee.id };
}

/** Seeds an order of the referee and builds its paid event (not delivered). */
async function paidEventFor(
  pair: Pair,
  opts: {
    gross?: number;
    paidPointsIdr?: number;
    channel?: "pos" | "qr";
  } = {},
) {
  const gross = opts.gross ?? 100_000;
  const channel = opts.channel ?? "qr";
  const orderUlid = await seedOrder(pair.world.tenantId, {
    outletId: pair.world.outletA,
    channel,
    profileId: pair.refereeId,
    grossSalesIdr: gross,
  });
  const base = orderPaidEvent(pair.world, {
    orderUlid,
    outletId: pair.world.outletA,
    channel,
    grossSalesIdr: gross,
    paidPointsIdr: opts.paidPointsIdr,
  });
  return { orderUlid, event: base };
}

/** Referrer 100 + referee 50 points; the referee's QR first order (100.000) is paid. */
async function rewardedReferral(rules: Rules = {}) {
  const pair = await pendingReferral(rules);
  const { orderUlid, event } = await paidEventFor(pair);
  await deliver(pair.world, event);
  expect(await referralStatus(pair.world.tenantId)).toBe("rewarded");
  expect(await bonusRows(pair.world.tenantId, pair.referrerId)).toHaveLength(1);
  expect(await bonusRows(pair.world.tenantId, pair.refereeId)).toHaveLength(1);
  // The referee also earned 10 points for the order (Rp100.000 per Rp10.000).
  expect(await balanceOf(pair.world.tenantId, pair.referrerId)).toBe(100);
  expect(await balanceOf(pair.world.tenantId, pair.refereeId)).toBe(60);
  return { ...pair, orderUlid };
}
type Rewarded = Awaited<ReturnType<typeof rewardedReferral>>;

function refundEvent(s: Rewarded, issueId: string, gross: number) {
  return orderRefundedEvent(s.world, {
    orderUlid: s.orderUlid,
    outletId: s.world.outletA,
    refundId: issueId,
    grossSalesIdr: gross,
  });
}

const rejectionFor = (s: Rewarded, issueId: string, amountIdr: number) =>
  rejectionEvent(s.world, { orderUlid: s.orderUlid, issueId, amountIdr });

/** Both members' ledgers add up to their balance and never dip below zero. */
async function expectPairConsistent(s: Pair) {
  await expectLedgerConsistent(s.world, s.referrerId);
  await expectLedgerConsistent(s.world, s.refereeId);
}

// ===========================================================================
// legend-bijqd
// ===========================================================================

describe("legend-bijqd a first order paid fully with points never triggers the referral bonus", () => {
  for (const minFirstOrderIdr of [0, 50_000, 100_000]) {
    it(`legend-bijqd fix: eligible 0 pays no bonus with minFirstOrderIdr ${minFirstOrderIdr}`, async () => {
      const pair = await pendingReferral({ minFirstOrderIdr });
      const { orderUlid, event } = await paidEventFor(pair, {
        paidPointsIdr: 100_000,
      });
      await deliver(pair.world, event);
      await deliver(pair.world, event); // a retry changes nothing either
      // The event WAS processed (so "no bonus" is not "nothing happened").
      expect(await recordOf(pair.world.tenantId, orderUlid)).toMatchObject({
        eligible_spend_idr: "0",
      });

      for (const id of [pair.referrerId, pair.refereeId]) {
        expect(await bonusRows(pair.world.tenantId, id)).toEqual([]);
        expect(await ledgerOf(pair.world.tenantId, id)).toEqual([]);
        expect(await balanceOf(pair.world.tenantId, id)).toBe(0);
      }
      const status = await referralStatus(pair.world.tenantId);
      expect(["qualified", "rewarded"]).not.toContain(status);
      expect(status).toBe("pending");
    });
  }

  it("legend-bijqd refunding the fully point-paid first order (full or partial) reverses nothing and leaves the referral pending", async () => {
    const pair = await pendingReferral();
    const { orderUlid, event } = await paidEventFor(pair, {
      paidPointsIdr: 100_000,
    });
    await deliver(pair.world, event);
    expect(await recordOf(pair.world.tenantId, orderUlid)).toMatchObject({
      eligible_spend_idr: "0",
    });

    const partial = orderRefundedEvent(pair.world, {
      orderUlid,
      outletId: pair.world.outletA,
      grossSalesIdr: 30_000,
      refundPointsIdr: 30_000,
    });
    const full = orderRefundedEvent(pair.world, {
      orderUlid,
      outletId: pair.world.outletA,
      grossSalesIdr: 100_000,
      refundPointsIdr: 100_000,
    });
    await deliver(pair.world, partial);
    await deliver(pair.world, full);
    await deliver(pair.world, full);

    for (const id of [pair.referrerId, pair.refereeId]) {
      expect(await ledgerOf(pair.world.tenantId, id)).toEqual([]);
      expect(await balanceOf(pair.world.tenantId, id)).toBe(0);
    }
    expect(await referralStatus(pair.world.tenantId)).toBe("pending");
  });

  it("legend-bijqd money: after a point-paid first order the pair is never paid more than once", async () => {
    const pair = await pendingReferral();
    const first = await paidEventFor(pair, {
      paidPointsIdr: 100_000,
    });
    await deliver(pair.world, first.event);
    // Whether a later cash order qualifies is the engineer's call (not pinned);
    // what is pinned: at most one bonus per side, never above the configured one.
    const second = await paidEventFor(pair);
    await deliver(pair.world, second.event);
    await deliver(pair.world, second.event);

    expect(
      (await bonusRows(pair.world.tenantId, pair.referrerId)).length,
    ).toBeLessThanOrEqual(1);
    expect(
      (await bonusRows(pair.world.tenantId, pair.refereeId)).length,
    ).toBeLessThanOrEqual(1);
    expect(
      await balanceOf(pair.world.tenantId, pair.referrerId),
    ).toBeLessThanOrEqual(100);
    expect(
      await balanceOf(pair.world.tenantId, pair.refereeId),
    ).toBeLessThanOrEqual(50 + 10);
    await expectPairConsistent(pair);
  });

  it("legend-bijqd a first order only partly paid with points still pays the bonus, and a partial refund never reverses it", async () => {
    const pair = await pendingReferral();
    const { orderUlid, event } = await paidEventFor(pair, {
      paidPointsIdr: 40_000, // eligible spend Rp60.000 > 0
    });
    await deliver(pair.world, event);
    expect(await referralStatus(pair.world.tenantId)).toBe("rewarded");
    expect(await balanceOf(pair.world.tenantId, pair.referrerId)).toBe(100);

    const refund = orderRefundedEvent(pair.world, {
      orderUlid,
      outletId: pair.world.outletA,
      grossSalesIdr: 20_000,
    });
    await deliver(pair.world, refund);
    await deliver(pair.world, refund);

    const referrerRows = await ledgerOf(pair.world.tenantId, pair.referrerId);
    expect(referrerRows.filter((row) => row.type === "reverse")).toEqual([]);
    expect(await balanceOf(pair.world.tenantId, pair.referrerId)).toBe(100);
    // The referee keeps the whole 50 bonus (only part of the 6 earned points go).
    expect(await bonusRows(pair.world.tenantId, pair.refereeId)).toHaveLength(
      1,
    );
    const [refereeBonus] = await bonusRows(pair.world.tenantId, pair.refereeId);
    expect(
      (await ledgerOf(pair.world.tenantId, pair.refereeId)).filter(
        (row) => row.reverses_entry_id === refereeBonus!.id,
      ),
    ).toEqual([]);
    expect(
      await balanceOf(pair.world.tenantId, pair.refereeId),
    ).toBeGreaterThanOrEqual(50);
    expect(await referralStatus(pair.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(pair);
  });
});

// ===========================================================================
// legend-sbxr0
// ===========================================================================

describe("legend-sbxr0 a rejected refund gives back the referral bonus it reversed, exactly once", () => {
  it("legend-sbxr0 fix: full refund reverses both bonuses, its rejection restores both and the referral is rewarded again", async () => {
    const s = await rewardedReferral();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueId, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    expect(await referralStatus(s.world.tenantId)).toBe("expired");

    await deliver(s.world, rejectionFor(s, issueId, 100_000));

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    // 50 bonus + the 10 earned points the same rejection gives back.
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 fix: delivering the rejection again (retry) restores nothing more", async () => {
    const s = await rewardedReferral();
    const issueId = randomUUID();
    const refund = refundEvent(s, issueId, 100_000);
    const rejection = rejectionFor(s, issueId, 100_000);
    await storeAndDeliver(s.world, refund);
    await deliver(s.world, rejection);
    const referrerAfter = await ledgerOf(s.world.tenantId, s.referrerId);
    const refereeAfter = await ledgerOf(s.world.tenantId, s.refereeId);
    expect(sumPoints(referrerAfter)).toBe(100);
    expect(sumPoints(refereeAfter)).toBe(60);

    await deliver(s.world, rejection);
    await deliver(s.world, rejectionFor(s, issueId, 100_000)); // same issue, new envelope
    await deliver(s.world, refund); // the late original refund is a no-op too

    expect(await ledgerOf(s.world.tenantId, s.referrerId)).toEqual(
      referrerAfter,
    );
    expect(await ledgerOf(s.world.tenantId, s.refereeId)).toEqual(refereeAfter);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
  });

  it("legend-sbxr0 fix: the same rejection delivered at the same time restores the bonus once", async () => {
    const s = await rewardedReferral();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueId, 100_000));
    const rejection = rejectionFor(s, issueId, 100_000);

    const results = await Promise.allSettled([
      deliver(s.world, rejection),
      deliver(s.world, rejection),
      deliver(s.world, rejectionFor(s, issueId, 100_000)),
      deliver(s.world, rejectionFor(s, issueId, 100_000)),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // The worker retries what failed: after redelivery everything converges.
    await deliver(s.world, rejection);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect(sumPoints(await ledgerOf(s.world.tenantId, s.referrerId))).toBe(100);
    expect(sumPoints(await ledgerOf(s.world.tenantId, s.refereeId))).toBe(60);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 a rejected partial refund never touched the bonus, so nothing extra comes back", async () => {
    const s = await rewardedReferral();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueId, 50_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(55);

    const rejection = rejectionFor(s, issueId, 50_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect(await bonusRows(s.world.tenantId, s.referrerId)).toHaveLength(1);
    expect(await bonusRows(s.world.tenantId, s.refereeId)).toHaveLength(1);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 the order was voided after the refund: a rejected refund restores no bonus", async () => {
    const s = await rewardedReferral();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueId, 100_000));
    await storeAndDeliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid: s.orderUlid,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    await deliver(s.world, rejectionFor(s, issueId, 100_000));

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    expect(await referralStatus(s.world.tenantId)).toBe("expired");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 the referral already expired for another cause (void first): the later rejected refund restores no bonus", async () => {
    const s = await rewardedReferral();
    await storeAndDeliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid: s.orderUlid,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await referralStatus(s.world.tenantId)).toBe("expired");
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueId, 100_000));

    const rejection = rejectionFor(s, issueId, 100_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    expect(await referralStatus(s.world.tenantId)).toBe("expired");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 money: another full refund still covers the order, so rejecting the first one restores no bonus, and rejecting both never exceeds the original", async () => {
    const s = await rewardedReferral();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
    await storeAndDeliver(s.world, refundEvent(s, issueB, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    await deliver(s.world, rejectionFor(s, issueA, 100_000));

    // B is still active: the bonus of a refunded order must stay reversed.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    // The referee may get back the 10 earned points of A, never the 50 bonus.
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );
    expect(await referralStatus(s.world.tenantId)).toBe("expired");

    await deliver(s.world, rejectionFor(s, issueB, 100_000));
    await deliver(s.world, rejectionFor(s, issueA, 100_000));

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBeLessThanOrEqual(
      100,
    );
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      60,
    );
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 money: refund, reject, refund again, reject again, replay everything: never more than the original bonus", async () => {
    const s = await rewardedReferral();
    const issueA = randomUUID();
    const issueB = randomUUID();
    const refundA = refundEvent(s, issueA, 100_000);
    const rejectA = rejectionFor(s, issueA, 100_000);
    const refundB = refundEvent(s, issueB, 100_000);
    const rejectB = rejectionFor(s, issueB, 100_000);

    await storeAndDeliver(s.world, refundA);
    await deliver(s.world, rejectA);
    await storeAndDeliver(s.world, refundB);
    await deliver(s.world, rejectB);
    for (const event of [refundA, rejectA, refundB, rejectB, rejectA, rejectB])
      await deliver(s.world, event);

    // Everything was rejected: the member is whole again, and not a point more.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect(sumPoints(await ledgerOf(s.world.tenantId, s.referrerId))).toBe(100);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(s);
  });
});

describe("legend-sbxr0 review additions (architect)", () => {
  it("legend-sbxr0 (a) full refund A reverses the bonus, A rejected restores it exactly once, retried and concurrent", async () => {
    const s = await rewardedReferral();
    const issueA = randomUUID();
    const refundA = refundEvent(s, issueA, 100_000);
    const rejectA = rejectionFor(s, issueA, 100_000);
    await storeAndDeliver(s.world, refundA);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    await Promise.allSettled([
      deliver(s.world, rejectA),
      deliver(s.world, rejectA),
      deliver(s.world, rejectionFor(s, issueA, 100_000)),
    ]);
    await deliver(s.world, rejectA); // worker retry
    await deliver(s.world, rejectA);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    const referrerRows = await ledgerOf(s.world.tenantId, s.referrerId);
    // One bonus, one reversal, exactly one restoring credit: 100 - 100 + 100.
    expect(referrerRows).toHaveLength(3);
    expect(sumPoints(referrerRows)).toBe(100);
    expect(await referralStatus(s.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 (b) A full, A rejected, then a full refund B reverses the restored bonus again", async () => {
    const s = await rewardedReferral();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
    await deliver(s.world, rejectionFor(s, issueA, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);

    const refundB = refundEvent(s, issueB, 100_000);
    await storeAndDeliver(s.world, refundB);
    await deliver(s.world, refundB); // replay

    // The member does not keep the restored bonus of a refunded order.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);
    const reversed = (await ledgerOf(s.world.tenantId, s.referrerId)).filter(
      (row) => row.type === "reverse",
    );
    expect(sumPoints(reversed)).toBe(-200); // taken twice, restored once between
    expect(await referralStatus(s.world.tenantId)).toBe("expired");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 (c) referee bonus already lapsed: the rejection restores the referrer only, a later full refund leaves nobody paid more", async () => {
    const s = await rewardedReferral();
    // The referee's grants (bonus and earn) lapse and are swept; the referrer's stay live.
    const refereeGrants = (
      await ledgerOf(s.world.tenantId, s.refereeId)
    ).filter((row) => row.expires_at !== null);
    const lastExpiry = Math.max(
      ...refereeGrants.map((r) => r.expires_at!.getTime()),
    );
    await runExpiry(s.world, s.refereeId, new Date(lastExpiry + 1000));
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(0);

    const issueA = randomUUID();
    const issueB = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    await deliver(s.world, rejectionFor(s, issueA, 100_000));

    // Referrer is whole again; the lapsed referee bonus (50) is NOT paid out anew
    // (limiting rule). At most the 10 earned points may come back.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );

    await storeAndDeliver(s.world, refundEvent(s, issueB, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );
    await expectPairConsistent(s);
  });
});

// ===========================================================================
// legend-nkp77
// ===========================================================================

describe("legend-nkp77 the credit of a rejected refund is tied to the earn grant it came from", () => {
  /**
   * 1 point per Rp1.000: a QR order of Rp100.000 earns 100. Another grant of 50
   * (far expiry) is the member's live money that no reversal may touch.
   */
  async function rejectedRefundWorld() {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1_000 });
    const member = await seedMember(world.tenantId);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      channel: "qr",
      profileId: member.id,
    });
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid,
        outletId: world.outletA,
        channel: "qr",
      }),
    );
    await grantPoints(world.tenantId, member.id, 50, FAR);
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);

    const issueId = randomUUID();
    await storeAndDeliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        refundId: issueId,
        grossSalesIdr: 50_000,
      }),
    ); // reverses 50
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
    await deliver(
      world,
      rejectionEvent(world, { orderUlid, issueId, amountIdr: 50_000 }),
    ); // +50 adjust
    expect(await balanceOf(world.tenantId, member.id)).toBe(150);

    const voided = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId: randomUUID(),
      voidedFinalOrder: true,
    });
    return { world, member, orderUlid, voided };
  }

  const reverseSum = async (world: World, memberId: string) =>
    sumPoints(
      (await ledgerOf(world.tenantId, memberId)).filter(
        (row) => row.type === "reverse",
      ),
    );

  it("legend-nkp77 fix: both grants expired, a void takes back 0, leaves the live grant and records no shortfall", async () => {
    const { world, member, orderUlid, voided } = await rejectedRefundWorld();

    // The sweep after every grant of the order (earn and adjust) is past its expiry.
    const orderGrants = (await ledgerOf(world.tenantId, member.id)).filter(
      (row) =>
        (row.type === "earn" || row.type === "adjust") &&
        row.expires_at !== null &&
        row.expires_at.getTime() < FAR.getTime(),
    );
    expect(orderGrants.length).toBeGreaterThanOrEqual(2);
    const lastExpiry = Math.max(
      ...orderGrants.map((row) => row.expires_at!.getTime()),
    );
    await runExpiry(world, member.id, new Date(lastExpiry + 1000));
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    const reversedBefore = await reverseSum(world, member.id);
    expect(reversedBefore).toBe(-50); // only refund A's reversal

    await deliver(world, voided);
    await deliver(world, voided); // replay

    // Cap is 0: nothing more leaves, the live 50 stay whole.
    expect(await reverseSum(world, member.id)).toBe(reversedBefore);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    // Expired points are not a refund_after_redeem shortfall.
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      reversal_shortfall_points: "0",
    });
    expect(await anomaliesOf(world.tenantId, "refund_after_redeem")).toEqual(
      [],
    );
    await expectLedgerConsistent(world, member.id);
  });

  it("legend-nkp77 while the grants are still live, a void takes back the whole order including the restored credit", async () => {
    // Guard against fixing nkp77 by turning the cap off or too far down.
    const { world, member, voided } = await rejectedRefundWorld();

    await deliver(world, voided);
    await deliver(world, voided); // replay

    // 100 earned - 50 reversed + 50 restored = 100 live of the order: all taken.
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect(await reverseSum(world, member.id)).toBe(-150);
    await expectLedgerConsistent(world, member.id);
  });
});

// ===========================================================================
// money: concurrent first orders pay the referral pair once
// ===========================================================================

describe("legend-bijqd + legend-sbxr0 money: the referral pair is paid at most once", () => {
  it("legend-bijqd two first orders paid at the same time pay one bonus per side, and a retry adds none", async () => {
    const pair = await pendingReferral();
    const first = await paidEventFor(pair);
    const second = await paidEventFor(pair);

    const results = await Promise.allSettled([
      deliver(pair.world, first.event),
      deliver(pair.world, second.event),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // The worker retries what failed.
    await deliver(pair.world, first.event);
    await deliver(pair.world, second.event);

    expect(await bonusRows(pair.world.tenantId, pair.referrerId)).toHaveLength(
      1,
    );
    expect(await bonusRows(pair.world.tenantId, pair.refereeId)).toHaveLength(
      1,
    );
    expect(await balanceOf(pair.world.tenantId, pair.referrerId)).toBe(100);
    // 50 bonus + 10 earned points for each of the two orders.
    expect(await balanceOf(pair.world.tenantId, pair.refereeId)).toBe(70);
    expect(await referralStatus(pair.world.tenantId)).toBe("rewarded");
    await expectPairConsistent(pair);
  });
});

// ===========================================================================
// round 3 (architect, money): the rule when in doubt is the one that LIMITS
// payment. Assumptions of this round:
// - "Another active refund" counts even when its own amount was counted as 0 by
//   the cumulative cap (refund B after a full refund A).
// - A restored bonus expires like a normal grant (expires_at before FAR), so the
//   sweep can lapse it; the tests only read balances and the ledger sum.
// - Policy to confirm (restrictive): the bonus of a rejected refund is restored
//   on NEITHER side when the referrer is no longer 'active', or when the
//   referrer already has maxReferralsPerCustomerPerMonth other 'rewarded'
//   referrals rewarded in the same Asia/Jakarta calendar month as the original
//   bonus. The referee's 10 earned points come back through the normal earn
//   path, so the referee asserts use "<= 10", never the 50 bonus.
// ===========================================================================

const codeOf = (world: World, profileId: string) =>
  asTenant(world.tenantId, async (client) => {
    const { rows } = await client.query<{ referral_code: string }>(
      "SELECT referral_code FROM customer_profiles WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, profileId],
    );
    return rows[0]!.referral_code;
  });

/** A second referee of the same referrer signs up and pays a first order. */
async function secondRewardedReferral(s: Rewarded): Promise<string> {
  const code = await codeOf(s.world, s.referrerId);
  const referee = await seedMember(s.world.tenantId);
  await withTenant(db, s.world.context, (tx) =>
    applyReferralAtSignup(tx, {
      tenantId: s.world.tenantId,
      refereeProfileId: referee.id,
      code,
    }),
  );
  const { event } = await paidEventFor({
    world: s.world,
    referrerId: s.referrerId,
    refereeId: referee.id,
  });
  await deliver(s.world, event);
  return referee.id;
}

/**
 * Referral 1 is fully refunded (bonus reversed, referral expired) and referral 2
 * is rewarded. Then the monthly cap is set and referral 2's rewarded_at is put
 * `daysBefore` days before the ORIGINAL bonus, so the month window is controlled.
 */
async function cappedSetup(cap: number, daysBefore: number) {
  const s = await rewardedReferral();
  const issueA = randomUUID();
  await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
  expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
  expect(await referralStatus(s.world.tenantId)).toBe("expired");

  const otherRefereeId = await secondRewardedReferral(s);
  expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
  await asTenant(s.world.tenantId, async (client) => {
    await client.query(
      `UPDATE referrals
          SET rewarded_at = (SELECT created_at FROM point_ledger
                              WHERE tenant_id = $1 AND customer_profile_id = $2
                                AND type = 'bonus' AND source_type = 'referral'
                              ORDER BY posting_seq LIMIT 1) - make_interval(days => $4::int)
        WHERE tenant_id = $1 AND referee_profile_id = $3 AND status = 'rewarded'`,
      [s.world.tenantId, s.referrerId, otherRefereeId, daysBefore],
    );
    await client.query(
      `UPDATE loyalty_programs
          SET referral = jsonb_set(referral, '{maxReferralsPerCustomerPerMonth}', to_jsonb($2::int))
        WHERE tenant_id = $1`,
      [s.world.tenantId, cap],
    );
  });
  return { s, issueA };
}

describe("legend-sbxr0 round 3 (1): the bonus is restored only when no other refund is active", () => {
  it("legend-sbxr0 fix: A full, B 30k counted 0, A rejected, then C 70k: the bonus stays reversed (B + C = a full refund)", async () => {
    const s = await rewardedReferral();
    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    // B is recorded, but the cumulative cap counts it as 0 (A already took all).
    await storeAndDeliver(s.world, refundEvent(s, issueB, 30_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);

    const rejectA = rejectionFor(s, issueA, 100_000);
    await deliver(s.world, rejectA);

    // B (30k > 0) is still active: expected referrer 0 (the old guard paid 100).
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );
    expect(await referralStatus(s.world.tenantId)).toBe("expired");

    // C 70k completes a full refund together with B: still nothing paid back.
    await storeAndDeliver(s.world, refundEvent(s, issueC, 70_000));
    await deliver(s.world, rejectA); // replay
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );
    expect(await referralStatus(s.world.tenantId)).toBe("expired");
    await expectPairConsistent(s);
  });
});

describe("legend-sbxr0 round 3 (2): restoring never passes the monthly cap or an inactive referrer", () => {
  for (const status of ["suspended", "closed"] as const) {
    it(`legend-sbxr0 fix: referrer ${status} when the refund is rejected: no bonus restored on either side`, async () => {
      const s = await rewardedReferral();
      const issueId = randomUUID();
      await storeAndDeliver(s.world, refundEvent(s, issueId, 100_000));
      expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
      await asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE customer_profiles SET membership_status = $3 WHERE tenant_id = $1 AND id = $2",
          [s.world.tenantId, s.referrerId, status],
        ),
      );

      const rejection = rejectionFor(s, issueId, 100_000);
      await deliver(s.world, rejection);
      await deliver(s.world, rejection);

      // Expected: referrer 0 and the referee never gets the 50 bonus (only the
      // 10 earned points may return).
      expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(0);
      expect(
        await balanceOf(s.world.tenantId, s.refereeId),
      ).toBeLessThanOrEqual(10);
      expect(await referralStatus(s.world.tenantId)).toBe("expired");
      await expectPairConsistent(s);
    });
  }

  it("legend-sbxr0 fix: the referrer already has 1 other referral rewarded this month and the cap is 1: nothing is restored", async () => {
    const { s, issueA } = await cappedSetup(1, 0);
    const rejection = rejectionFor(s, issueA, 100_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);

    // Referrer keeps only referral 2's 100 (not 200); referee 1 never gets 50.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(100);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBeLessThanOrEqual(
      10,
    );
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("expired");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 control: the same month but a cap of 2 leaves room, so the bonus is restored once", async () => {
    const { s, issueA } = await cappedSetup(2, 0);
    const rejection = rejectionFor(s, issueA, 100_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(200);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("rewarded");
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 control: the other referral was rewarded 40 days before the bonus (another month), so even a cap of 1 restores it", async () => {
    const { s, issueA } = await cappedSetup(1, 40);
    await deliver(s.world, rejectionFor(s, issueA, 100_000));

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(200);
    expect(await balanceOf(s.world.tenantId, s.refereeId)).toBe(60);
    expect((await referralsOf(s.world.tenantId))[0]!.status).toBe("rewarded");
    await expectPairConsistent(s);
  });
});

describe("legend-sbxr0 + legend-4frkf round 3 (3): a lapsed restored bonus is not taken from another grant", () => {
  /**
   * The referrer also holds an unrelated live grant of 50 (far expiry). Refund A
   * (full) reverses the 100 bonus, its rejection restores it: 150 in total.
   */
  async function restoredWithOtherGrant() {
    const s = await rewardedReferral();
    await grantPoints(s.world.tenantId, s.referrerId, 50, FAR);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(150);
    const issueA = randomUUID();
    await storeAndDeliver(s.world, refundEvent(s, issueA, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(50);
    await deliver(s.world, rejectionFor(s, issueA, 100_000));
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(150);
    return s;
  }

  const reversedOf = async (s: Rewarded) =>
    sumPoints(
      (await ledgerOf(s.world.tenantId, s.referrerId)).filter(
        (row) => row.type === "reverse",
      ),
    );

  it("legend-sbxr0 fix: the restored bonus lapsed, then a full refund B takes back 0 and leaves the other 50", async () => {
    const s = await restoredWithOtherGrant();
    const lapsing = (await ledgerOf(s.world.tenantId, s.referrerId)).filter(
      (row) =>
        row.expires_at !== null && row.expires_at.getTime() < FAR.getTime(),
    );
    const lastExpiry = Math.max(
      ...lapsing.map((row) => row.expires_at!.getTime()),
    );
    await runExpiry(s.world, s.referrerId, new Date(lastExpiry + 1000));
    // Only the unrelated 50 survive the sweep.
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(50);
    const reversedBefore = await reversedOf(s);
    expect(reversedBefore).toBe(-100); // refund A only

    const refundB = refundEvent(s, randomUUID(), 100_000);
    await storeAndDeliver(s.world, refundB);
    await deliver(s.world, refundB); // replay

    // Expected: nothing more leaves the referrer, the other grant is untouched.
    expect(await reversedOf(s)).toBe(reversedBefore);
    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(50);
    await expectPairConsistent(s);
  });

  it("legend-sbxr0 control: the restored bonus is still live, a full refund B takes back exactly the 100 and not the other 50", async () => {
    const s = await restoredWithOtherGrant();
    const refundB = refundEvent(s, randomUUID(), 100_000);
    await storeAndDeliver(s.world, refundB);
    await deliver(s.world, refundB);

    expect(await balanceOf(s.world.tenantId, s.referrerId)).toBe(50);
    expect(await reversedOf(s)).toBe(-200); // A's 100 and B's 100
    await expectPairConsistent(s);
  });
});

describe("legend-29shf-4frkf round 3 (4): the reversal shortfall is cumulative, never counted twice", () => {
  for (const [first, second, shortfalls] of [
    [50_000, 50_000, ["50", "100"]],
    [30_000, 70_000, ["30", "100"]],
  ] as const) {
    it(`legend-29shf-4frkf fix: balance 0, refunds ${first} then ${second}: shortfall ${shortfalls[0]} then ${shortfalls[1]} (never above the 100 booked)`, async () => {
      const world = await createWorld();
      await seedProgram(world.tenantId, { earnSpendIdr: 1_000 }); // 100 points
      const member = await seedMember(world.tenantId);
      const orderUlid = await seedOrder(world.tenantId, {
        outletId: world.outletA,
        channel: "qr",
        profileId: member.id,
      });
      await deliver(
        world,
        orderPaidEvent(world, {
          orderUlid,
          outletId: world.outletA,
          channel: "qr",
        }),
      );
      expect(await balanceOf(world.tenantId, member.id)).toBe(100);
      // The member spends every point: nothing is left to take back.
      const redemptionId = randomUUID();
      await withTenant(db, world.context, async (tx) => {
        await withProfileLock(tx, world.tenantId, member.id);
        await postLedgerEntry(
          tx,
          world.context,
          {
            tenantId: world.tenantId,
            customerProfileId: member.id,
            type: "redeem",
            points: -100,
            sourceType: "reward_redemption",
            sourceId: redemptionId,
            event: { rewardId: randomUUID(), redemptionId },
          },
          NOW,
        );
      });
      expect(await balanceOf(world.tenantId, member.id)).toBe(0);

      const firstRefund = orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: first,
      });
      await deliver(world, firstRefund);
      expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
        reversed_points: "0",
        reversal_shortfall_points: shortfalls[0],
      });

      const secondRefund = orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: second,
      });
      await deliver(world, secondRefund);
      await deliver(world, secondRefund); // replay changes nothing
      await deliver(world, firstRefund); // late replay of the first too

      // Expected: 100 (the booked points), not 150 / 130 (previous + capped).
      expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
        reversed_points: "0",
        reversal_shortfall_points: shortfalls[1],
      });
      expect(await balanceOf(world.tenantId, member.id)).toBe(0);
      await expectLedgerConsistent(world, member.id);
    });
  }
});
