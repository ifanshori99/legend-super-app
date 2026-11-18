// (brief 1119, SO refund ronde 12 finding P1-2 = docs/qa/second-opinion-refund-ronde12-1117.md
// finding 2, P1, tier K "jangan sampai rugi"): red-first tests, written from that report,
// docs/briefs/1119-fix-refund-ronde12.md (CTO decisions 1-3) and docs/briefs/1072-invarian.md
// (I7), with the pattern of refund-1108-p1-2-recorder-larger-after-fact.test.ts (case D), not
// from the implementation.
//
// Rule under test (CTO decision 1/2): the automatic closers of a hold as counted (the live-own
// closer after a recorded fact, and the duplicate path) close it only when the facts booked
// for that refund id of that payment cover the hold's NOMINAL. A smaller report does not
// close a larger open hold; the hold stays open in full and keeps counting against the refund
// limit.
//
// Scenario (SO), order reversed against 1108 case D: T paid Rp100.000. Our refund R
// (Rp10.000) is sent and times out (approved, no provider ref). A signed `payment.refunded`
// X/T Rp80.000 is held as live-own (Rp80.000). R is then declined and finance closes the
// failure hold of R as `not_this_intent`; the hold X stays open. The switch is turned off. A
// NEW envelope `payment.refunded` X/T Rp30.000 is delivered BEFORE the worker retries the
// Rp80.000 event: the fact X30 is booked and today closes the hold X80 as counted. The limit
// then counts only Rp30.000: a manual refund of Rp70.000 fits, Rp80.000 + Rp70.000 = Rp150.000
// from Rp100.000.
//
// Rules pinned:
//   - after the smaller report the live-own hold of Rp80.000 is NOT resolved and an open hold
//     of at least Rp80.000 exists (checked right after delivery, before any worker retry);
//   - a manual refund of Rp70.000 is refused (409/422 at request, approve or settle);
//   - worst case out = max(reported, fact) + manual refunds <= Rp100.000;
//   - variant: fact X30 booked BEFORE the report X80 and R in flight (the duplicate path of the
//     same closer): a later X30 duplicate does not close the larger hold either;
//   - controls: hold Rp80.000 + report X/T Rp80.000 closes it (counted, fact X80);
//     hold Rp30.000 + report Rp30.000 closes it (the SO control "hold30 -> fact30").
//
// Assumptions (the brief does not fix them):
//   - The Rp80.000 report is delivered while R is in flight (a live-own hold) and is replayed
//     once (harness replayAll), as 1108 case D does; the worker is NOT run after R failed, so
//     the larger stored event is not re-processed before the smaller report (the SO: "sebelum
//     worker mengulang event X80"; `replayAll` later would force the Rp80.000 fact and drop
//     the premise). The delivery is a direct `h.deliver`.
//   - The SO calls the extra hold of R's failure `own_refund_failed_unverified`; here every
//     other open hold is closed `not_this_intent` through the HTTP resolver, whatever its reason
//     text.
//   - The variant (fact X30 first) may already be green: the larger report after an existing
//     fact becomes a conflict hold (1108 P1-2), which no closer counts. It pins that the guard
//     stays. The SO asks for this variant ("varian fact30 sudah ada sebelum hold80").
//   - "Refused" for a manual refund = 409/422 at request, approve or settle-by-hand (switch off:
//     approve answers 200/503 and the refund waits for finance).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1119-p1-2-liveown-hold-short-report.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  flags,
  holdById,
  installSwitchHooks,
  liveOwnWorld,
  maxOpen,
  recorderReport,
  tryManualOut,
} from "./refund-1119-support";

const h = createRefundHarness("1119p12");
installSwitchHooks(h, true);

const HOLD_IDR = 80_000;
const SMALL_IDR = 30_000;

async function deliverReport(
  code: Parameters<typeof recorderReport>[1],
  x: string,
  amountIdr: number,
) {
  const answered = await h.deliver(recorderReport(h, code, x, amountIdr));
  expect(
    answered.status,
    `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
}

describe("P1-2 (P1) a smaller report does not close a larger live-own hold", () => {
  it("1119-p1-2-01 live-own hold Rp80.000, switch off, then X/T Rp30.000 before the worker: the hold stays open in full, refund of Rp70.000 refused", async () => {
    const w = await liveOwnWorld(h, { hold: HOLD_IDR });
    flags.DOIT_REFUNDS_ENABLED = false;
    const calls = h.fake.calls.length;

    await deliverReport(w.code, w.x, SMALL_IDR);

    const row = await holdById(h, w.code.id, w.hold.id);
    expect(
      row.resolved_at,
      `the hold of Rp${HOLD_IDR} stays open after a smaller report (holds: ${JSON.stringify(await h.allHolds(w.code.id))}, facts: ${JSON.stringify(await h.providerRows(w.code.id))})`,
    ).toBeNull();
    expect(row.resolution, "not closed as counted").toBeNull();
    expect(row.amount_idr, "never lowered").toBe(w.hold.amount_idr);
    expect(
      await maxOpen(h, w.code.id),
      "an open hold of at least Rp80.000 counts",
    ).toBeGreaterThanOrEqual(HOLD_IDR);

    const probe = await tryManualOut(h, w.code.id, BILL_IDR - SMALL_IDR);
    expectRefused(probe, "p1-2-01");
    expectWorstCaseWithinPaid(HOLD_IDR, SMALL_IDR, [probe], "p1-2-01");
    expect(h.fake.calls, "nothing reached the provider").toHaveLength(calls);
  });

  it("1119-p1-2-02 the same with the switch still ON (closer is not a switch matter): hold stays open, refund of Rp70.000 refused", async () => {
    const w = await liveOwnWorld(h, { hold: HOLD_IDR });
    flags.DOIT_REFUNDS_ENABLED = true;

    await deliverReport(w.code, w.x, SMALL_IDR);

    const row = await holdById(h, w.code.id, w.hold.id);
    expect(
      row.resolved_at,
      `the hold stays open (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBeNull();
    const probe = await tryManualOut(h, w.code.id, BILL_IDR - SMALL_IDR);
    expectRefused(probe, "p1-2-02");
    expectWorstCaseWithinPaid(HOLD_IDR, SMALL_IDR, [probe], "p1-2-02");
  });

  it("1119-p1-2-03 variant: fact X30 booked before the report X80, R declined, then a duplicate X/T Rp30.000: an open hold of at least Rp80.000 stays, refund of Rp70.000 refused", async () => {
    const w = await liveOwnWorld(h, { hold: HOLD_IDR, factFirst: SMALL_IDR });
    flags.DOIT_REFUNDS_ENABLED = false;

    await deliverReport(w.code, w.x, SMALL_IDR);

    expect(
      await maxOpen(h, w.code.id),
      `an open hold of at least Rp80.000 stays (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBeGreaterThanOrEqual(HOLD_IDR);
    const row = await holdById(h, w.code.id, w.hold.id);
    expect(row.resolved_at, "the larger hold is not closed").toBeNull();
    const probe = await tryManualOut(h, w.code.id, BILL_IDR - SMALL_IDR);
    expectRefused(probe, "p1-2-03");
    expectWorstCaseWithinPaid(HOLD_IDR, SMALL_IDR, [probe], "p1-2-03");
  });

  it("1119-p1-2-04 control: hold Rp80.000 and a report X/T Rp80.000 (fact covers the hold): the hold closes as counted, fact X80 booked, Rp21.000 more refused", async () => {
    const w = await liveOwnWorld(h, { hold: HOLD_IDR });
    flags.DOIT_REFUNDS_ENABLED = false;

    await deliverReport(w.code, w.x, HOLD_IDR);

    expect(
      await h.providerRows(w.code.id),
      "premise: fact X Rp80.000 booked",
    ).toMatchObject([{ provider_refund_id: w.x, amount_idr: HOLD_IDR }]);
    expect(
      await holdById(h, w.code.id, w.hold.id),
      "a fact that covers the hold closes it as counted",
    ).toMatchObject({ resolution: "counted_against_intent" });
    const probe = await tryManualOut(h, w.code.id, BILL_IDR - HOLD_IDR + 1_000);
    expectRefused(probe, "p1-2-04");
    expectWorstCaseWithinPaid(HOLD_IDR, HOLD_IDR, [probe], "p1-2-04");
  });

  it("1119-p1-2-05 control: hold Rp30.000 and a report X/T Rp30.000 closes it as counted (SO control hold30 -> fact30), Rp71.000 is refused", async () => {
    const w = await liveOwnWorld(h, { hold: SMALL_IDR });
    flags.DOIT_REFUNDS_ENABLED = false;

    await deliverReport(w.code, w.x, SMALL_IDR);

    expect(
      await h.providerRows(w.code.id),
      "premise: fact X Rp30.000 booked",
    ).toMatchObject([{ provider_refund_id: w.x, amount_idr: SMALL_IDR }]);
    expect(
      await holdById(h, w.code.id, w.hold.id),
      "an equal fact closes the hold as counted",
    ).toMatchObject({ resolution: "counted_against_intent" });
    const probe = await tryManualOut(
      h,
      w.code.id,
      BILL_IDR - SMALL_IDR + 1_000,
    );
    expectRefused(probe, "p1-2-05");
    expectWorstCaseWithinPaid(SMALL_IDR, SMALL_IDR, [probe], "p1-2-05");
  });
});
