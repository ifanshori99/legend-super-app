// (brief 1119, SO refund ronde 12 finding P1-1 = docs/qa/second-opinion-refund-ronde12-1117.md
// finding 1, P1, tier K "jangan sampai rugi"): red-first tests, written from that report,
// docs/briefs/1119-fix-refund-ronde12.md (CTO decisions 1-3) and docs/briefs/1072-invarian.md,
// with the pattern of refund-1088-r1-mismatch-hold-raise.test.ts and
// refund-1108-p1-1-switch-off-payment-object.test.ts, not from the implementation.
//
// Rule under test (CTO decision 1/2): finance's `counted_against_intent` may close a hold only
// when the provider facts booked for that refund id of that payment cover the hold's NOMINAL
// (fact >= hold). The existence of a fact with the same id is not enough. Below that the
// resolver answers 409 (assumed code REFUND_HOLD_FACT_SHORT), the hold stays open in full (not
// lowered, not closed, still counted by the refund limit), no fact or journal event is added.
//
// Scenario (SO): T2 paid Rp100.000, fact X/T2 Rp30.000 booked. The switch is off. A signed
// `refund.succeeded` carries R of T1 as key but names payment T2, refund X, Rp80.000: the
// mismatch door opens a REFERENCE_MISMATCH hold of Rp80.000 on T2 (it runs before the switch
// gate). Finance checks that X belongs to T2 and picks `counted_against_intent`. Today the
// fact X30 is enough to close the hold, the limit only counts Rp30.000, a manual refund of
// Rp70.000 fits: Rp80.000 + Rp70.000 = Rp150.000 out of Rp100.000.
//
// Rules pinned:
//   - counted on the Rp80.000 hold with fact Rp30.000 (and Rp50.000): 409 with code
//     REFUND_HOLD_FACT_SHORT; the hold stays open with amount Rp80.000, facts and journal events
//     of T2 are unchanged, replays do not close or lower it;
//   - a manual refund of Rp70.000 on T2 is refused (409/422 at request, approve or settle);
//   - worst case (report is real) out = max(reported, fact) + manual refunds <= Rp100.000;
//   - not_this_intent stays possible on the short hold (finance keeps an exit);
//   - controls: fact Rp80.000 (>= hold) lets counted close the hold (200), no second fact,
//     and Rp21.000 more is still refused.
//
// Assumptions (the brief does not fix them):
//   - Error code `REFUND_HOLD_FACT_SHORT` (brief: "kode jelas, mis. ..."): the test pins status
//     409 and that code. If engineering picks another code, only FACT_SHORT_CODE changes.
//   - The mismatch hold keeps the reported amount (Rp80.000) and names X, or is anonymous; in
//     the second case finance passes X as providerRefundId.
//   - "Refused" for a manual refund = 409/422 at request, approve or settle-by-hand. With the
//     switch off approve answers 200/503 and the refund waits for finance, so settle is the
//     last door.
//   - Premises (fact booked with the switch on, the report opening a hold) are asserted, so a
//     red run cannot come from the setup.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1119-p1-1-mismatch-hold-fact-short.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import {
  FACT_SHORT_CODE,
  countMismatch,
  expectRefused,
  expectWorstCaseWithinPaid,
  holdById,
  installSwitchHooks,
  maxOpen,
  mismatchReport,
  mismatchWorld,
  recorderReport,
  tryManualOut,
  type MismatchWorld,
} from "./refund-1119-support";

const h = createRefundHarness("1119p11");
installSwitchHooks(h, true);

const HOLD_IDR = 80_000;
const FACT_IDR = 30_000;

async function expectHoldIntact(w: MismatchWorld, label: string) {
  const row = await holdById(h, w.t2.id, w.hold.id);
  expect(row.resolved_at, `${label}: the hold stays open`).toBeNull();
  expect(row.amount_idr, `${label}: the hold is not lowered`).toBe(
    w.hold.amount_idr,
  );
  expect(
    await maxOpen(h, w.t2.id),
    `${label}: an open hold of at least Rp${HOLD_IDR} counts`,
  ).toBeGreaterThanOrEqual(HOLD_IDR);
}

describe("P1-1 (P1) a mismatch hold is not counted by a fact that covers less than the hold", () => {
  it("1119-p1-1-01 hold Rp80.000 + fact Rp30.000, switch off: counted is refused 409 REFUND_HOLD_FACT_SHORT, the hold stays open in full, facts and journal untouched, refund of Rp70.000 refused, replays do not close it", async () => {
    const w = await mismatchWorld(h, {
      hold: HOLD_IDR,
      fact: FACT_IDR,
      switchOn: false,
    });
    const facts = await h.providerRows(w.t2.id);
    const events = await h.refundEventsOfIntent(w.t2.id);
    const calls = h.fake.calls.length;

    const counted = await countMismatch(h, w);
    expect(
      counted.status,
      `counted on a hold the fact does not cover: ${JSON.stringify(counted.body)}`,
    ).toBe(409);
    expect(counted.body.error?.code, JSON.stringify(counted.body)).toBe(
      FACT_SHORT_CODE,
    );
    await expectHoldIntact(w, "after refused counted");
    expect(
      await h.providerRows(w.t2.id),
      "no fact booked or rewritten",
    ).toEqual(facts);
    expect(
      await h.refundEventsOfIntent(w.t2.id),
      "no journal event from the refused counted",
    ).toBe(events);

    // The same refusal again (finance clicks twice) and replays of both reports.
    const again = await countMismatch(h, w);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    await h.replayAll(mismatchReport(w.t2, w.refundId, w.x, HOLD_IDR), 2);
    await h.replayAll(() => recorderReport(h, w.t2, w.x, FACT_IDR), 1);
    await expectHoldIntact(w, "after replays");
    expect(await h.providerRows(w.t2.id), "facts unchanged by replays").toEqual(
      facts,
    );

    const probe = await tryManualOut(h, w.t2.id, BILL_IDR - FACT_IDR);
    expectRefused(probe, "p1-1-01");
    expectWorstCaseWithinPaid(HOLD_IDR, FACT_IDR, [probe], "p1-1-01");
    expect(h.fake.calls, "nothing reached the provider").toHaveLength(calls);
  });

  it("1119-p1-1-02 hold Rp80.000 + fact Rp50.000, switch off: still short, counted refused 409, hold open in full, refund of Rp50.000 refused", async () => {
    const w = await mismatchWorld(h, {
      hold: HOLD_IDR,
      fact: 50_000,
      switchOn: false,
    });
    const counted = await countMismatch(h, w);
    expect(counted.status, JSON.stringify(counted.body)).toBe(409);
    expect(counted.body.error?.code, JSON.stringify(counted.body)).toBe(
      FACT_SHORT_CODE,
    );
    await expectHoldIntact(w, "p1-1-02");
    const probe = await tryManualOut(h, w.t2.id, BILL_IDR - 50_000);
    expectRefused(probe, "p1-1-02");
    expectWorstCaseWithinPaid(HOLD_IDR, 50_000, [probe], "p1-1-02");
  });

  it("1119-p1-1-03 same with the switch ON (matched door active): counted refused 409, hold open in full, refund of Rp70.000 refused", async () => {
    const w = await mismatchWorld(h, {
      hold: HOLD_IDR,
      fact: FACT_IDR,
      switchOn: true,
    });
    const counted = await countMismatch(h, w);
    expect(counted.status, JSON.stringify(counted.body)).toBe(409);
    expect(counted.body.error?.code, JSON.stringify(counted.body)).toBe(
      FACT_SHORT_CODE,
    );
    await expectHoldIntact(w, "p1-1-03");
    const probe = await tryManualOut(h, w.t2.id, BILL_IDR - FACT_IDR);
    expectRefused(probe, "p1-1-03");
    expectWorstCaseWithinPaid(HOLD_IDR, FACT_IDR, [probe], "p1-1-03");
  });

  it("1119-p1-1-04 finance keeps an exit: not_this_intent closes the short hold (200), nothing is booked", async () => {
    const w = await mismatchWorld(h, {
      hold: HOLD_IDR,
      fact: FACT_IDR,
      switchOn: false,
    });
    const facts = await h.providerRows(w.t2.id);
    const counted = await countMismatch(h, w);
    expect(counted.status, JSON.stringify(counted.body)).toBe(409);
    const closed = await h.resolveHold(w.hold.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(
      (await holdById(h, w.t2.id, w.hold.id)).resolution,
      "closed as not this intent",
    ).toBe("not_this_intent");
    expect(await h.providerRows(w.t2.id), "no fact booked").toEqual(facts);
  });

  it("1119-p1-1-05 control: fact Rp80.000 covers the hold of Rp80.000: counted closes it (200), no second fact, Rp21.000 more is still refused", async () => {
    const w = await mismatchWorld(h, {
      hold: HOLD_IDR,
      fact: HOLD_IDR,
      switchOn: false,
    });
    const facts = await h.providerRows(w.t2.id);
    const counted = await countMismatch(h, w);
    expect(
      counted.status,
      `a fact that covers the hold closes it: ${JSON.stringify(counted.body)}`,
    ).toBe(200);
    expect(
      (await holdById(h, w.t2.id, w.hold.id)).resolution,
      "closed as counted",
    ).toBe("counted_against_intent");
    expect(
      (await h.providerRows(w.t2.id)).reduce((sum, r) => sum + r.amount_idr, 0),
      "counting books nothing on top of the covering fact",
    ).toBe(facts.reduce((sum, r) => sum + r.amount_idr, 0));
    const probe = await tryManualOut(h, w.t2.id, BILL_IDR - HOLD_IDR + 1_000);
    expectRefused(probe, "p1-1-05");
    expectWorstCaseWithinPaid(HOLD_IDR, HOLD_IDR, [probe], "p1-1-05");
  });
});
