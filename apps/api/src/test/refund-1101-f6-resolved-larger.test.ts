// (brief 1103, SO refund ronde 10 finding F6 = refund 1101 F6, P2, tier K "jangan sampai
// rugi"): red-first tests, written from docs/briefs/1103-fix-refund-ronde10.md (CTO decision
// 1 last bullet: the mismatch hold has a fixed key = hash of R + owning intent + T2;
// decision 2: a report larger than a resolved hold opens a new generation, I7 of
// docs/briefs/1072-invarian.md) and the pattern of
// refund-1101-f6-mismatch-no-id-one-hold.test.ts, not from the implementation.
//
// Rule under test: the fixed key of a mismatch hold (report keyed R, owned by T1, naming T2,
// no refund id) must not swallow a LARGER report after finance resolved the first hold. A
// report of Rp30.000 is held and then closed or counted by finance; a later report of the
// same key with Rp80.000 (or an unreadable amount) opens a NEW generation hold of the full
// value. Replays of the Rp30.000 or Rp80.000 report afterwards add no more holds.
//
// Scenario: T1 paid, R Rp30.000 completed (ref X), T2 paid. Report keyed R, payment T2, no
// refund id, Rp30.000 -> hold on T2. Finance resolves it. Then the larger report arrives.
//
// Rules pinned (per resolution, `not_this_intent` and `counted_against_intent`):
//   - after the larger report there is exactly ONE open hold on T2 and it is at least
//     Rp80.000 (the first, resolved hold stays resolved: a new row, not a reopened one);
//   - replays of the Rp80.000 and of the Rp30.000 report (new envelope ids, poller and
//     worker rounds) add no hold row and leave the one open hold in place;
//   - the reports create no provider fact and no `payment.provider_refunded` event beyond
//     what finance's own count made; nothing is held on T1; nothing reaches the provider;
//   - the same holds for an unreadable amount ('80000.0'): one open hold of at least
//     Rp80.000.
//
// Assumptions (the brief does not fix them):
//   - Run with the switch ON (matched door active), as the sibling f6 file.
//   - The new generation hold uses the transaction-conflict reason (as the lead's brief
//     says "generasi baru, CONFLICT"); that reason is pinned for the new hold only.
//   - For an unreadable amount the hold covers the full value, max(intent, evidence)
//     = Rp100.000 per refund-1088-r3; only "at least Rp80.000" is pinned.
//   - Finance can count the first (readable, no refund id) mismatch hold with
//     `counted_against_intent` and no refund id (answer 200); counting may book an
//     anonymous fact, so the fact and journal baselines are taken after the resolution.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1101-f6-resolved-larger.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1101f6b");

const R_IDR = 30_000;
const BIG_IDR = 80_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them.
beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
  resetPaymentRefundGateways();
  registerPaymentRefundGateway(h.fake);
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
  setPaymentRefundGateway(null);
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

type World = { t1: Code; t2: Code; refundId: string };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, R_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  return { t1, t2, refundId: own.refundId };
}

/** Report keyed R, payment T2, no refund id; new envelope id on every call. */
const envelope = (w: World, amount: unknown) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    idempotency_key: `refund:${w.refundId}`,
    payment_id: w.t2.providerRef,
    status: "succeeded",
    amount,
  },
});

async function send(body: object) {
  const answered = await h.deliver(body);
  expect(
    answered.status,
    `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
  await h.runWorker();
}

type Resolution = "not_this_intent" | "counted_against_intent";

/** Small report held, then finance resolves it; returns the resolved hold id. */
async function heldThenResolved(w: World, resolution: Resolution) {
  await send(envelope(w, R_IDR));
  const open = await h.openOf(w.t2.id);
  expect(
    open,
    `premise: one open hold (holds: ${JSON.stringify(await h.allHolds(w.t2.id))})`,
  ).toHaveLength(1);
  const resolved = await h.resolveHold(open[0]!.id, resolution);
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  expect(await h.openOf(w.t2.id), "premise: nothing open").toHaveLength(0);
  return open[0]!.id;
}

async function expectNewGeneration(
  w: World,
  firstHoldId: string,
  label: string,
  facts: number[],
  eventsBefore: number,
  callsBefore: number,
) {
  const holds = JSON.stringify(await h.allHolds(w.t2.id));
  const open = await h.openOf(w.t2.id);
  expect(
    open,
    `${label}: exactly one open hold after the larger report (holds: ${holds})`,
  ).toHaveLength(1);
  expect(
    open[0]!.amount_idr,
    `${label}: the new hold covers the larger report`,
  ).toBeGreaterThanOrEqual(BIG_IDR);
  expect(
    open[0]!.id,
    `${label}: a new row, the resolved hold stays resolved`,
  ).not.toBe(firstHoldId);
  expect(open[0]!.reason, `${label}: conflict reason`).toBe(
    HOLD_TRANSACTION_CONFLICT_REASON,
  );

  const rows = (await h.allHolds(w.t2.id)).length;
  await h.replayAll(() => envelope(w, BIG_IDR), 2);
  await h.replayAll(() => envelope(w, R_IDR), 1);
  await send(envelope(w, BIG_IDR));
  await send(envelope(w, R_IDR));
  expect(
    (await h.allHolds(w.t2.id)).length,
    `${label}: replays of the Rp30.000 and Rp80.000 report add no hold row`,
  ).toBe(rows);
  const stillOpen = await h.openOf(w.t2.id);
  expect(stillOpen, `${label}: still the one open hold`).toHaveLength(1);
  expect(stillOpen[0]!.id).toBe(open[0]!.id);
  expect(stillOpen[0]!.amount_idr).toBeGreaterThanOrEqual(BIG_IDR);

  expect(await h.factAmounts(w.t2.id), `${label}: no new fact on T2`).toEqual(
    facts,
  );
  expect(
    await h.refundEventsOfIntent(w.t2.id),
    `${label}: no new journal event on T2`,
  ).toBe(eventsBefore);
  expect(await h.allHolds(w.t1.id), `${label}: no hold on T1`).toHaveLength(0);
  expect(h.fake.calls, `${label}: nothing reached the provider`).toHaveLength(
    callsBefore,
  );
}

const resolutions: Resolution[] = ["not_this_intent", "counted_against_intent"];

describe("F6 (P2) a larger mismatch report after finance resolved the hold opens a new generation", () => {
  resolutions.forEach((resolution, index) => {
    it(`1101-f6-resolved-0${index + 1} Rp30.000 held and ${resolution}, then the Rp80.000 report (same key, no refund id): one new open hold of at least Rp80.000; replays of either amount add nothing`, async () => {
      const w = await world();
      const firstHoldId = await heldThenResolved(w, resolution);
      const facts = await h.factAmounts(w.t2.id);
      const eventsBefore = await h.refundEventsOfIntent(w.t2.id);
      const callsBefore = h.fake.calls.length;

      await send(envelope(w, BIG_IDR));
      await expectNewGeneration(
        w,
        firstHoldId,
        `f6-resolved-0${index + 1}`,
        facts,
        eventsBefore,
        callsBefore,
      );
    });

    it(`1101-f6-resolved-0${index + 3} Rp30.000 held and ${resolution}, then a report with an unreadable amount ('80000.0'): one new open hold of at least Rp80.000; replays add nothing`, async () => {
      const w = await world();
      const firstHoldId = await heldThenResolved(w, resolution);
      const facts = await h.factAmounts(w.t2.id);
      const eventsBefore = await h.refundEventsOfIntent(w.t2.id);
      const callsBefore = h.fake.calls.length;

      await send(envelope(w, "80000.0"));
      await expectNewGeneration(
        w,
        firstHoldId,
        `f6-resolved-0${index + 3}`,
        facts,
        eventsBefore,
        callsBefore,
      );
    });
  });
});
