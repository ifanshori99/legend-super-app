// (brief 1108, SO refund ronde 11 finding P1-2 = docs/qa/second-opinion-refund-ronde11-1107.md
// finding 2, P1, tier K "jangan sampai rugi"): red-first tests, written from that report,
// docs/briefs/1108-fix-refund-ronde11.md (CTO decision 2) and docs/briefs/1072-invarian.md
// (I7: a report larger than everything held or counted for that refund id is held in full),
// with the pattern of refund-1101-f4-f5-recorder-larger-report.test.ts, not from the
// implementation.
//
// Rule under test: once a provider fact X of T exists (booked by the recorder door, or
// counted by finance from a hold named X), a LATER signed `payment.refunded` that names the
// same X and the same T with a LARGER amount must not be treated as a plain duplicate. The
// uncovered increase is held in full as a conflict (I7): the open hold is worth at least
// the whole larger report, the old fact and its journal are not rewritten, refunds of the
// rest of the bill are refused, and replays add no hold row. This holds while the DOIT
// refund switch is off (the release-1 state, CTO: "saklar mati + laporan membesar untuk X
// yang sudah fact = hold, bukan diam"). It is not the over-count echo `legend-jw2xt`.
//
// Scenarios (SO):
//   A: T Rp100.000, switch off, fact X/T Rp30.000 booked by the recorder (no own refund in
//      flight, no hold open); then X/T Rp80.000.
//   B: anonymous fact Rp30.000, report X/T Rp30.000 held, finance counts it as `separate`
//      (a fact named X now exists, the hold is closed); then X/T Rp80.000.
//   D: live-own hold X Rp30.000 closed by itself after fact X Rp30.000 was booked (our
//      refund R failed); then X/T Rp80.000.
//   C: A, then the Rp80.000 hold is closed `not_this_intent`; the identical report opens
//      nothing, but X/T Rp90.000 (larger than anything held) is held again.
//
// Rules pinned:
//   - after the larger report an open hold of at least the larger amount exists (A, B: Rp80.000;
//     C: Rp90.000), never lowered by a smaller or equal report, in any order;
//   - the facts stay exactly as they were (no rewrite, no new fact) and no journal event
//     is added by the larger report; the provider is not asked;
//   - a refund of the rest of the bill is refused (409/422 at request or approve): A and C
//     Rp40.000, B Rp10.000 (without the hold it would still fit);
//   - replays of the larger report and of the old report add no hold row.
//
// Assumptions (the brief does not fix them):
//   - The brief asks to list recorder callers other than the webhook (finance settle by
//     hand). Those are internal; these tests go through the webhook, the only door visible
//     from the HTTP contract. A settle-by-hand caller is not exercised here.
//   - The premise fact X is booked while the switch is ON (the recorder door does not depend
//     on the switch, SO "tanpa flag aktif" of refund-1101 F4), then the switch is turned OFF
//     before the larger report, as in the SO scenario. Premise asserts fail loudly if the
//     premise is not met, so a red run cannot come from the setup.
//   - "Held in full" = the open hold is at least the larger report (SO: "hold konflik
//     Rp80.000"); the reason text and whether the old hold row is raised or a surplus row is
//     opened are not pinned.
//   - D (architect review, SO "varian langsung F4") builds the live-own hold that closes by
//     itself with the steps refund-1045-b-04 observes: our refund R Rp10.000 is sent and
//     times out with no provider ref (payout_attempts 1, R approved); the signed report
//     X/T Rp30.000 is held as live-own; R is then declined through the lookup the retry
//     route uses (`fake.setStatus` + retry, R failed); the replay of the report books fact X
//     Rp30.000 and closes the hold as `counted_against_intent` (1045-b-04 "id" door). Those
//     steps are observable through the HTTP/harness surface, so D asserts them as premises.
//     If the premise fails the setup (not the fix) is what is wrong.
//   - In C the identical Rp80.000 report after `not_this_intent` opens nothing (as
//     refund-1101-f6 f6-04 and f5-01's control) and Rp90.000 is "more than ever held" (I7).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1108-p1-2-recorder-larger-after-fact.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1108p12");

const A_IDR = 30_000;
const BIG_IDR = 80_000;
const BIGGER_IDR = 90_000;
const newId = () => `rf_${randomBytes(6).toString("hex")}`;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them. Premises are built with the
// switch ON; each test turns it OFF before the larger report.
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

/** Recorder door report: a new envelope id on every call. */
const report = (code: Code, id: string, amountIdr: number) => () =>
  h.refundIdEvent(code.providerRef, id, amountIdr);

const maxOpen = async (intentId: string) =>
  Math.max(0, ...(await h.openOf(intentId)).map((row) => row.amount_idr));

async function expectRefundRefused(
  intentId: string,
  amountIdr: number,
  label: string,
) {
  const filed = await h.manualRefund(intentId, amountIdr);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${amountIdr}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect([409, 422], `${label}: requesting ${amountIdr}`).toContain(
      filed.status,
    );
  }
}

/** Premise A: T paid, fact X/T Rp30.000 booked by the recorder, nothing held, switch then off. */
async function factFromRecorder() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const x = newId();
  await h.replayAll(report(code, x, A_IDR), 1);
  expect(
    await h.providerRows(code.id),
    `premise: fact X Rp30.000 booked (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toMatchObject([{ provider_refund_id: x, amount_idr: A_IDR }]);
  expect(await h.openOf(code.id), "premise: no hold open").toHaveLength(0);
  flags.DOIT_REFUNDS_ENABLED = false;
  return { code, x };
}

/** Premise B: anonymous fact Rp30.000, report X/T Rp30.000 held, counted by finance as separate. */
async function factCountedFromHold() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const anonymous = await h.declineWithoutRef(code, A_IDR);
  const countedAnonymous = await h.resolveHold(
    anonymous,
    "counted_against_intent",
  );
  expect(countedAnonymous.status, JSON.stringify(countedAnonymous.body)).toBe(
    200,
  );
  const x = newId();
  await h.replayAll(report(code, x, A_IDR), 1);
  const open = await h.openOf(code.id);
  expect(
    open,
    `premise: one open hold named X (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toHaveLength(1);
  const counted = await h.resolveHold(
    open[0]!.id,
    "counted_against_intent",
    undefined,
    "separate",
  );
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  const facts = await h.providerRows(code.id);
  expect(
    facts.map((row) => row.amount_idr),
    "premise: the anonymous fact and the fact X",
  ).toEqual([A_IDR, A_IDR]);
  expect(
    facts.some((row) => row.provider_refund_id === x),
    "premise: a fact named X exists",
  ).toBe(true);
  expect(await h.openOf(code.id), "premise: nothing open").toHaveLength(0);
  flags.DOIT_REFUNDS_ENABLED = false;
  return { code, x };
}

/** The larger report is held in full; facts, journal and provider are untouched; replays add nothing. */
async function expectHeldInFull(
  code: Code,
  x: string,
  amountIdr: number,
  label: string,
  facts: Awaited<ReturnType<typeof h.providerRows>>,
  eventsBefore: number,
  callsBefore: number,
) {
  const holds = JSON.stringify(await h.allHolds(code.id));
  expect(
    await maxOpen(code.id),
    `${label}: an open hold covers the larger report of Rp${amountIdr} (holds: ${holds})`,
  ).toBeGreaterThanOrEqual(amountIdr);
  expect(
    await h.providerRows(code.id),
    `${label}: facts are not rewritten and none is added`,
  ).toEqual(facts);
  expect(
    await h.refundEventsOfIntent(code.id),
    `${label}: no journal event from the larger report`,
  ).toBe(eventsBefore);

  const rows = (await h.allHolds(code.id)).length;
  await h.replayAll(report(code, x, amountIdr), 2);
  await h.replayAll(report(code, x, A_IDR), 1);
  expect(
    (await h.allHolds(code.id)).length,
    `${label}: replays of the larger and of the old report add no hold row`,
  ).toBe(rows);
  expect(
    await maxOpen(code.id),
    `${label}: never lowered by an equal or smaller report`,
  ).toBeGreaterThanOrEqual(amountIdr);
  expect(h.fake.calls, `${label}: nothing reached the provider`).toHaveLength(
    callsBefore,
  );
}

describe("P1-2 (P1) a larger report of an id that is already a fact is held, never a silent duplicate", () => {
  it("1108-p1-2-01 A: fact X/T Rp30.000 booked by the recorder, switch off, then X/T Rp80.000: an open hold of at least Rp80.000, the fact and journal untouched, a refund of Rp40.000 refused, replays add nothing", async () => {
    const { code, x } = await factFromRecorder();
    const facts = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectHeldInFull(
      code,
      x,
      BIG_IDR,
      "p1-2-01",
      facts,
      eventsBefore,
      callsBefore,
    );
    await expectRefundRefused(code.id, 40_000, "p1-2-01");
    expect(h.fake.calls, "p1-2-01: nothing reached the provider").toHaveLength(
      callsBefore,
    );
  });

  it("1108-p1-2-02 A, equal report first: the identical X/T Rp30.000 after the fact is a plain duplicate (no hold, no fact), only the larger one is held", async () => {
    const { code, x } = await factFromRecorder();
    const facts = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(report(code, x, A_IDR), 2);
    expect(
      await h.allHolds(code.id),
      "control: an equal report of a known fact opens nothing",
    ).toHaveLength(0);
    expect(await h.providerRows(code.id)).toEqual(facts);

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectHeldInFull(
      code,
      x,
      BIG_IDR,
      "p1-2-02",
      facts,
      eventsBefore,
      callsBefore,
    );
  });

  it("1108-p1-2-03 B: finance counted the hold named X as separate (fact X exists, hold closed), then X/T Rp80.000: an open hold of at least Rp80.000, facts untouched, a refund of Rp10.000 refused", async () => {
    const { code, x } = await factCountedFromHold();
    const facts = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectHeldInFull(
      code,
      x,
      BIG_IDR,
      "p1-2-03",
      facts,
      eventsBefore,
      callsBefore,
    );
    await expectRefundRefused(code.id, 10_000, "p1-2-03");
  });

  it("1108-p1-2-04 C: the Rp80.000 hold closed not_this_intent: the identical report opens nothing, X/T Rp90.000 is held again (more than ever held)", async () => {
    const { code, x } = await factFromRecorder();
    const facts = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(report(code, x, BIG_IDR), 1);
    const open = (await h.openOf(code.id)).filter(
      (row) => row.amount_idr >= BIG_IDR,
    );
    expect(
      open,
      `premise: the Rp80.000 report is held (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toHaveLength(1);
    const closed = await h.resolveHold(open[0]!.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await h.openOf(code.id), "premise: nothing open").toHaveLength(0);

    const rows = (await h.allHolds(code.id)).length;
    await h.replayAll(report(code, x, BIG_IDR), 2);
    expect(
      (await h.allHolds(code.id)).length,
      "the identical report after not_this_intent adds no hold row",
    ).toBe(rows);
    expect(await h.openOf(code.id)).toHaveLength(0);

    await h.replayAll(report(code, x, BIGGER_IDR), 1);
    await expectHeldInFull(
      code,
      x,
      BIGGER_IDR,
      "p1-2-04",
      facts,
      eventsBefore,
      callsBefore,
    );
    await expectRefundRefused(code.id, 40_000, "p1-2-04");
  });

  it("1108-p1-2-05 two connections: X/T Rp80.000 delivered twice at the same time after fact X Rp30.000 ends with an open hold of at least Rp80.000 and the fact untouched", async () => {
    const { code, x } = await factFromRecorder();
    const facts = await h.providerRows(code.id);
    const big = h.refundIdEvent(code.providerRef, x, BIG_IDR);
    const big2 = h.refundIdEvent(code.providerRef, x, BIG_IDR);

    const answers = await Promise.all([h.deliver(big), h.deliver(big2)]);
    for (const answer of answers)
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    await h.runWorker();
    await h.replayAll(() => big, 1);

    expect(
      await maxOpen(code.id),
      `covered (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThanOrEqual(BIG_IDR);
    expect(await h.providerRows(code.id), "fact untouched").toEqual(facts);
    expect(
      (await h.allHolds(code.id)).length,
      "not more than one hold row per envelope",
    ).toBeLessThanOrEqual(2);
  });

  it("1108-p1-2-06 D: live-own hold X Rp30.000 closed by itself after fact X Rp30.000 was booked, then X/T Rp80.000: an open hold of at least Rp80.000, the fact untouched, a refund of Rp40.000 refused", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    // Our refund R Rp10.000 sent, timed out with no ref: only then is a provider report of
    // another id held as live-own (as refund-1101-f4 f4-03).
    const filed = await h.manualRefund(code.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    h.fake.enqueue("throw");
    const approved = await h.approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await h.refundRow(refundId), "premise: R in flight").toMatchObject({
      status: "approved",
      provider_ref: null,
    });
    const x = newId();

    await h.replayAll(report(code, x, A_IDR), 1);
    const live = (await h.openOf(code.id)).filter(
      (row) => row.provider_refund_id === x,
    );
    expect(
      live,
      `premise: the report X is held live-own (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toHaveLength(1);

    // R is declined, then the replay books fact X and closes the live-own hold by itself.
    h.fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: `PR-DECLINED-${randomBytes(4).toString("hex")}`,
      code: "declined",
    });
    const retried = await h.retryRefund(refundId);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await h.refundRow(refundId)).status, "premise: R failed").toBe(
      "failed",
    );
    await h.replayAll(report(code, x, A_IDR), 2);
    expect(
      (await h.providerRows(code.id)).map((row) => [
        row.provider_refund_id,
        row.amount_idr,
      ]),
      "premise: fact X Rp30.000 booked",
    ).toEqual([[x, A_IDR]]);
    expect(
      (await h.allHolds(code.id)).find((row) => row.id === live[0]!.id),
      "premise: the live-own hold closed by itself as counted",
    ).toMatchObject({ resolution: "counted_against_intent" });
    expect(
      (await h.openOf(code.id)).filter((row) => row.provider_refund_id === x),
      "premise: no open hold named X",
    ).toHaveLength(0);

    flags.DOIT_REFUNDS_ENABLED = false;
    const facts = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectHeldInFull(
      code,
      x,
      BIG_IDR,
      "p1-2-06",
      facts,
      eventsBefore,
      callsBefore,
    );
    await expectRefundRefused(code.id, 40_000, "p1-2-06");
  });
});
