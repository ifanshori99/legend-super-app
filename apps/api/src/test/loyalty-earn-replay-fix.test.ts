// legend-vqft5 (P1): earn points came back too many when refund A was rejected
// while refund B was still active. Written BEFORE the fix: the tests marked
// "fix" must fail on the clean base (15ccf6e86).
// Source of rules: the brief (set-based design) and the founder money rule
// ("the member may lose, the outlet never does"). Not written from the services.
//
// Order: eligible spend Rp100.000, 1 point per Rp1.000 -> booked 100 points.
// Rule pinned (order independent): after a rejection the order's refunded
// eligible amount equals min(eligible, sum of the asked amounts of every refund
// that is still active), and the member holds booked - ceil(booked * refunded /
// eligible) points (the member may hold fewer, never more).
//
// Assumptions (the brief is silent):
// - A fully refunded order is state "reversed" (visits 0, lifetime spend 0); a
//   partly refunded one is "booked", lifetime spend = eligible - refunded and
//   visits stay 1 (as in order-recovery-refund-loyalty.test.ts).
// - The reversal id of a refund is its refundId (= order issue id), the way
//   loyalty-referral-followups.test.ts delivers refunds and rejections.
// - Re-delivering an already processed refund event or rejection (same event id,
//   or a new envelope of the same issue) changes nothing.
// - A rejection that arrives before the refund it rejects is a no-op.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import {
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
  type LedgerRow,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const REVERSAL = "order_issue.refund_reversal_requested";
const ELIGIBLE = 100_000;
const BOOKED = 100;

// ---------------------------------------------------------------------------
// fixtures (copied from loyalty-referral-followups.test.ts)
// ---------------------------------------------------------------------------

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

type Scene = {
  world: World;
  memberId: string;
  orderUlid: string;
};

/** A member with one paid QR order: eligible 100.000 -> 100 points booked. */
async function paidScene(): Promise<Scene> {
  const world = await createWorld();
  await seedProgram(world.tenantId, { earnSpendIdr: 1_000 });
  const member = await seedMember(world.tenantId);
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    channel: "qr",
    profileId: member.id,
    grossSalesIdr: ELIGIBLE,
  });
  await deliver(
    world,
    orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      channel: "qr",
      grossSalesIdr: ELIGIBLE,
    }),
  );
  expect(await balanceOf(world.tenantId, member.id)).toBe(BOOKED);
  expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
    state: "booked",
    eligible_spend_idr: String(ELIGIBLE),
    booked_points: String(BOOKED),
    refunded_eligible_idr: "0",
    reversed_points: "0",
  });
  return { world, memberId: member.id, orderUlid };
}

const refundOf = (s: Scene, issueId: string, amountIdr: number) =>
  orderRefundedEvent(s.world, {
    orderUlid: s.orderUlid,
    outletId: s.world.outletA,
    refundId: issueId,
    grossSalesIdr: amountIdr,
  });

const rejectionFor = (s: Scene, issueId: string, amountIdr: number) =>
  rejectionEvent(s.world, { orderUlid: s.orderUlid, issueId, amountIdr });

const balance = (s: Scene) => balanceOf(s.world.tenantId, s.memberId);
const record = (s: Scene) => recordOf(s.world.tenantId, s.orderUlid);
const ledger = (s: Scene) => ledgerOf(s.world.tenantId, s.memberId);

const sumPoints = (rows: LedgerRow[]) =>
  rows.reduce((total, row) => total + Number(row.points), 0);

/** Ledger sum equals the balance and the running balance never dips below zero. */
async function expectLedgerConsistent(s: Scene) {
  const rows = await ledger(s);
  let running = 0;
  for (const row of rows) {
    running += Number(row.points);
    expect(running).toBeGreaterThanOrEqual(0);
  }
  expect(sumPoints(rows)).toBe(await balance(s));
}

/** Points the member may hold when `activeAsked` is the sum of the active refunds. */
const maxBalanceFor = (activeAsked: number) =>
  BOOKED - Math.ceil((BOOKED * Math.min(ELIGIBLE, activeAsked)) / ELIGIBLE);

/**
 * Removes the stored outbox event of one refund, as the migration owner (the
 * app role cannot DELETE from the outbox). Simulates a refund that is active
 * but has no stored event any more.
 */
async function dropStoredRefundEvent(s: Scene, issueId: string) {
  const deleted = await asTenant(s.world.tenantId, async (client) => {
    const result = await client.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'order.refunded'
          AND event->'payload'->>'refundId' = $2`,
      [s.world.tenantId, issueId],
    );
    return result.rowCount ?? 0;
  });
  expect(deleted).toBeGreaterThan(0);
}

const adjustRows = async (s: Scene) =>
  (await ledger(s)).filter((row) => row.type === "adjust");

// ===========================================================================
// legend-vqft5
// ===========================================================================

describe("legend-vqft5 rejecting refund A while refund B is still active gives back only what B does not cover", () => {
  it("legend-vqft5 fix T1: A 100k, B 30k (counted 0), A rejected -> 70 points back, then C 70k closes the order at 0", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();

    await storeAndDeliver(s.world, refundOf(s, issueA, 100_000));
    expect(await balance(s)).toBe(0);
    await storeAndDeliver(s.world, refundOf(s, issueB, 30_000));
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      state: "reversed",
      refunded_eligible_idr: "100000",
      reversed_points: "100",
    });

    const rejectA = rejectionFor(s, issueA, 100_000);
    await deliver(s.world, rejectA);
    // B (30k) is still active: the member gets 70 back (the old code paid 100).
    expect(await balance(s)).toBe(70);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "30000",
      reversed_points: "30",
      reversal_shortfall_points: "0",
    });
    const afterA = await profileOf(s.world.tenantId, s.memberId);
    expect(Number(afterA.lifetime_spend_idr)).toBe(70_000);
    expect(afterA.visits_count).toBe(1);

    // C 70k together with B (30k) is a full refund: nothing is left.
    await storeAndDeliver(s.world, refundOf(s, issueC, 70_000));
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      state: "reversed",
      refunded_eligible_idr: "100000",
      reversed_points: "100",
      reversal_shortfall_points: "0",
    });
    const afterC = await profileOf(s.world.tenantId, s.memberId);
    expect(Number(afterC.lifetime_spend_idr)).toBe(0);
    expect(afterC.visits_count).toBe(0);

    // A replay of the rejection changes nothing.
    await deliver(s.world, rejectA);
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      state: "reversed",
      refunded_eligible_idr: "100000",
      reversed_points: "100",
    });
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 fix T2: A 60k, B 60k (counted 40k), A rejected -> refunded 60k and balance 40, then B rejected -> balance 100", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    const issueB = randomUUID();

    await storeAndDeliver(s.world, refundOf(s, issueA, 60_000));
    expect(await balance(s)).toBe(40);
    await storeAndDeliver(s.world, refundOf(s, issueB, 60_000));
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      refunded_eligible_idr: "100000",
      reversed_points: "100",
    });

    await deliver(s.world, rejectionFor(s, issueA, 60_000));
    // B alone asks 60k, so 60k stay refunded (not 40k) and the member holds 40.
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "60000",
      reversed_points: "60",
    });
    expect(await balance(s)).toBe(40);

    await deliver(s.world, rejectionFor(s, issueB, 60_000));
    expect(await balance(s)).toBe(BOOKED);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "0",
      reversed_points: "0",
      reversal_shortfall_points: "0",
    });
    expect(
      Number(
        (await profileOf(s.world.tenantId, s.memberId)).lifetime_spend_idr,
      ),
    ).toBe(ELIGIBLE);
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 fix T3: after A was rejected over B (balance 70), rejecting B returns the member to 100, never more than booked", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueA, 100_000));
    await storeAndDeliver(s.world, refundOf(s, issueB, 30_000));
    await deliver(s.world, rejectionFor(s, issueA, 100_000));
    expect(await balance(s)).toBe(70);

    const rejectB = rejectionFor(s, issueB, 30_000);
    await deliver(s.world, rejectB);
    await deliver(s.world, rejectB); // replay
    expect(await balance(s)).toBe(BOOKED);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "0",
      reversed_points: "0",
      reversal_shortfall_points: "0",
    });
    const profile = await profileOf(s.world.tenantId, s.memberId);
    expect(Number(profile.lifetime_spend_idr)).toBe(ELIGIBLE);
    expect(profile.visits_count).toBe(1);
    // The whole ledger nets to the booked 100 (nothing paid beyond booked).
    expect(sumPoints(await ledger(s))).toBe(BOOKED);
    await expectLedgerConsistent(s);
  });
});

describe("legend-vqft5 money: any order of refunds and rejections, replayed, never leaves the member above the active refunds allow", () => {
  type Op = "A" | "B" | "C" | "xA" | "xB" | "xC";
  const ASKED = { A: 50_000, B: 40_000, C: 30_000 } as const; // 120k > eligible

  // Fixed mixed orders (no randomness: a failure must be reproducible).
  const sequences: Op[][] = [
    ["A", "B", "C", "xA", "xB", "xC"],
    ["A", "B", "C", "xB", "xA"],
    ["A", "B", "xA", "C", "xC", "xB"],
    ["A", "xA", "B", "C", "xB"],
    ["A", "B", "C", "xC", "xA"],
    ["C", "B", "A", "xA", "xC"],
  ];

  for (const sequence of sequences) {
    it(`legend-vqft5 fix T4 money: ${sequence.join(" ")}, then every event replayed twice`, async () => {
      const s = await paidScene();
      const issues = {
        A: randomUUID(),
        B: randomUUID(),
        C: randomUUID(),
      };
      const delivered: EventEnvelope[] = [];
      const active = new Set<"A" | "B" | "C">();

      async function expectWithinBound() {
        const activeAsked = [...active].reduce(
          (total, key) => total + ASKED[key],
          0,
        );
        const now = await balance(s);
        expect(now).toBeGreaterThanOrEqual(0);
        expect(now).toBeLessThanOrEqual(maxBalanceFor(activeAsked));
        expect(now).toBeLessThanOrEqual(BOOKED);
        // The record keeps min(eligible, sum of the active refunds).
        expect((await record(s))!.refunded_eligible_idr).toBe(
          String(Math.min(ELIGIBLE, activeAsked)),
        );
        await expectLedgerConsistent(s);
      }

      for (const op of sequence) {
        if (op.startsWith("x")) {
          const key = op.slice(1) as "A" | "B" | "C";
          const event = rejectionFor(s, issues[key], ASKED[key]);
          delivered.push(event);
          await deliver(s.world, event);
          active.delete(key);
        } else {
          const key = op as "A" | "B" | "C";
          const event = refundOf(s, issues[key], ASKED[key]);
          delivered.push(event);
          await storeAndDeliver(s.world, event);
          active.add(key);
        }
        await expectWithinBound();
      }

      const settled = await balance(s);
      for (let round = 0; round < 2; round += 1)
        for (const event of delivered) await deliver(s.world, event);
      expect(await balance(s)).toBe(settled);
      await expectWithinBound();
    });
  }
});

describe("legend-vqft5 regression: the single-refund behaviour is unchanged", () => {
  it("legend-vqft5 T5: a single refund 40k, rejected -> the member gets all 40 back, replays change nothing", async () => {
    const s = await paidScene();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueId, 40_000));
    expect(await balance(s)).toBe(60);
    expect(await record(s)).toMatchObject({
      refunded_eligible_idr: "40000",
      reversed_points: "40",
    });

    const rejection = rejectionFor(s, issueId, 40_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);
    expect(await balance(s)).toBe(BOOKED);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "0",
      reversed_points: "0",
      reversal_shortfall_points: "0",
    });
    expect(
      Number(
        (await profileOf(s.world.tenantId, s.memberId)).lifetime_spend_idr,
      ),
    ).toBe(ELIGIBLE);
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 T5: a single full refund, rejected -> 100 back and the order is booked again", async () => {
    const s = await paidScene();
    const issueId = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueId, ELIGIBLE));
    expect(await balance(s)).toBe(0);
    await deliver(s.world, rejectionFor(s, issueId, ELIGIBLE));
    expect(await balance(s)).toBe(BOOKED);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "0",
      reversed_points: "0",
    });
    expect((await profileOf(s.world.tenantId, s.memberId)).visits_count).toBe(
      1,
    );
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 T5: a rejection that arrives before any refund is a no-op", async () => {
    const s = await paidScene();
    const before = await ledger(s);
    await deliver(s.world, rejectionFor(s, randomUUID(), 40_000));
    expect(await balance(s)).toBe(BOOKED);
    expect(await ledger(s)).toHaveLength(before.length);
    expect(await adjustRows(s)).toEqual([]);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "0",
      reversed_points: "0",
    });
  });

  it("legend-vqft5 T5: rejecting an issue that was never refunded does not disturb another active refund", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueA, 40_000));
    expect(await balance(s)).toBe(60);
    await deliver(s.world, rejectionFor(s, randomUUID(), 40_000));
    expect(await balance(s)).toBe(60);
    expect(await record(s)).toMatchObject({
      refunded_eligible_idr: "40000",
      reversed_points: "40",
    });
    expect(await adjustRows(s)).toEqual([]);
  });
});

describe("legend-vqft5 retry and concurrent delivery of the same rejection never pay twice", () => {
  it("legend-vqft5 fix T6: A 100k, B 30k, the same rejection of A delivered three times -> 70 once", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueA, 100_000));
    await storeAndDeliver(s.world, refundOf(s, randomUUID(), 30_000));

    const rejection = rejectionFor(s, issueA, 100_000);
    await deliver(s.world, rejection);
    await deliver(s.world, rejection);
    await deliver(s.world, rejectionFor(s, issueA, 100_000)); // new envelope, same issue

    expect(await balance(s)).toBe(70);
    expect(sumPoints(await adjustRows(s))).toBe(70);
    expect(await record(s)).toMatchObject({
      refunded_eligible_idr: "30000",
      reversed_points: "30",
    });
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 fix T6: the same rejection of A delivered at the same time pays 70 once", async () => {
    const s = await paidScene();
    const issueA = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueA, 100_000));
    await storeAndDeliver(s.world, refundOf(s, randomUUID(), 30_000));
    const rejection = rejectionFor(s, issueA, 100_000);

    const results = await Promise.allSettled([
      deliver(s.world, rejection),
      deliver(s.world, rejection),
      deliver(s.world, rejectionFor(s, issueA, 100_000)),
      deliver(s.world, rejectionFor(s, issueA, 100_000)),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // The worker retries what failed: after redelivery everything converges.
    await deliver(s.world, rejection);

    expect(await balance(s)).toBe(70);
    expect(sumPoints(await adjustRows(s))).toBe(70);
    expect(await record(s)).toMatchObject({
      state: "booked",
      refunded_eligible_idr: "30000",
      reversed_points: "30",
    });
    await expectLedgerConsistent(s);
  });
});

describe("legend-vqft5 hardening: an active refund without a stored event counts as asking the whole eligible amount", () => {
  it("legend-vqft5 fix T7: Y 100k (event deleted), X 30k, X rejected -> balance stays 0 and nothing is paid back", async () => {
    const s = await paidScene();
    const issueY = randomUUID();
    const issueX = randomUUID();

    await storeAndDeliver(s.world, refundOf(s, issueY, 100_000));
    expect(await balance(s)).toBe(0);
    await storeAndDeliver(s.world, refundOf(s, issueX, 30_000));
    expect(await balance(s)).toBe(0);
    await dropStoredRefundEvent(s, issueY);

    const rejectX = rejectionFor(s, issueX, 30_000);
    await deliver(s.world, rejectX);
    // Y is still active and its amount is unknown: assume it asked everything,
    // so the member gets nothing back (the outlet never pays more).
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      state: "reversed",
      refunded_eligible_idr: "100000",
      reversed_points: "100",
    });
    expect(sumPoints(await adjustRows(s))).toBe(0);
    const profile = await profileOf(s.world.tenantId, s.memberId);
    expect(Number(profile.lifetime_spend_idr)).toBe(0);

    // A replay of the rejection changes nothing.
    await deliver(s.world, rejectX);
    expect(await balance(s)).toBe(0);
    expect(sumPoints(await adjustRows(s))).toBe(0);
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 T7: control with Y's event kept -> the same rejection of X also leaves the balance at 0", async () => {
    const s = await paidScene();
    const issueY = randomUUID();
    const issueX = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueY, 100_000));
    await storeAndDeliver(s.world, refundOf(s, issueX, 30_000));

    await deliver(s.world, rejectionFor(s, issueX, 30_000));
    expect(await balance(s)).toBe(0);
    expect(await record(s)).toMatchObject({
      state: "reversed",
      refunded_eligible_idr: "100000",
      reversed_points: "100",
    });
    expect(sumPoints(await adjustRows(s))).toBe(0);
    await expectLedgerConsistent(s);
  });

  it("legend-vqft5 T7: Y 100k (event deleted) rejected itself later is not affected by X's rejection order", async () => {
    // Assumption: rejecting Y after X was rejected restores nothing below zero
    // and never lifts the member above booked.
    const s = await paidScene();
    const issueY = randomUUID();
    const issueX = randomUUID();
    await storeAndDeliver(s.world, refundOf(s, issueY, 100_000));
    await storeAndDeliver(s.world, refundOf(s, issueX, 30_000));
    await dropStoredRefundEvent(s, issueY);
    await deliver(s.world, rejectionFor(s, issueX, 30_000));
    expect(await balance(s)).toBe(0);

    await deliver(s.world, rejectionFor(s, issueY, 100_000));
    expect(await balance(s)).toBeLessThanOrEqual(BOOKED);
    expect(await balance(s)).toBeGreaterThanOrEqual(0);
    await expectLedgerConsistent(s);
  });
});
