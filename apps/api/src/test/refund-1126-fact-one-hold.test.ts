// (brief 1126 decision 3 = finding P3-4 of docs/briefs/1119, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1126-refund-unmatched-hold.md and the 1119 rule
// (a hold is closed as counted only when the facts of that refund id cover its nominal), on
// top of refund-1072-harness and refund-1119-support, not from the implementation.
//
// Rule under test: ONE provider fact closes ONE hold. Coverage is computed per hold; a fact
// already used to close another hold is not counted again. Otherwise finance, giving the same
// refund id X to two different holds, would "cover" both with the single fact X of Rp80.000
// and the refund limit would drop by Rp80.000 instead of Rp160.000.
//
// Scenario: T1 paid with our refunds R1 and R2 (Rp10.000 each, completed). T2 paid Rp100.000
// with ONE fact X/T2 of Rp80.000 (recorder report `payment.refunded`). Two signed success
// reports keyed R1 and R2 name T2 with no refund id of their own and Rp80.000: two different
// anonymous mismatch holds on T2 (the key of such a hold is R + owner + T2, refund 1101-f6),
// Rp80.000 each. Finance counts the first with id X, then the second with the same id X.
//
// Rules pinned:
//   - counting the first hold: 200, no second fact (the fact X is the only row, Rp80.000);
//   - counting the second hold with the same id X: 409 (the fact is already used), the hold
//     stays open at Rp80.000, no fact or journal event is added;
//   - finance keeps an exit: not_this_intent closes the second hold (200);
//   - a manual refund of Rp21.000 is refused, and worst case (the report is real) the larger
//     of fact and open hold + manual refunds that passed <= paid.
//
// Assumptions (the brief does not fix them):
//   - Error code of "fact already used": only status 409 is pinned (the brief names none).
//   - "Total keluar (fact + manual + open hold) <= paid" cannot hold literally: the fact X
//     (Rp80.000) and the open second hold (Rp80.000, a claim over the same money) already
//     add to Rp160.000. Worst case is read like refund-1119: max(fact, open hold) + manual
//     refunds that passed <= paid. See the report for the design question.
//   - Both holds are anonymous (no refund id), which is what lets finance supply X.
//     "Rp80.000 each" is asserted as a premise, so a red run cannot come from the setup.
//   - The fact X is booked first (as refund-1119 `mismatchWorld`), the holds after it.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1126-fact-one-hold.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
  type HoldRow,
} from "./refund-1072-harness";
import {
  OWN_IDR,
  expectRefused,
  expectWorstCaseWithinPaid,
  holdById,
  installSwitchHooks,
  maxOpen,
  newId,
  recorderReport,
  tryManualOut,
} from "./refund-1119-support";

const h = createRefundHarness("1126b");
installSwitchHooks(h, true);

const FACT_IDR = 80_000;

/** Signed success keyed to R of T1 that names T2, no refund id of its own. New envelope per call. */
const anonymousMismatch =
  (t2: Code, refundId: string, amountIdr: number) => () => ({
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      idempotency_key: `refund:${refundId}`,
      payment_id: t2.providerRef,
      status: "succeeded",
      amount: amountIdr,
    },
  });

type World = { t2: Code; x: string; first: HoldRow; second: HoldRow };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const r1 = await h.ownCompletedRefund(t1, OWN_IDR);
  const r2 = await h.ownCompletedRefund(t1, OWN_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  const x = newId();

  await h.replayAll(() => recorderReport(h, t2, x, FACT_IDR), 1);
  expect(
    await h.providerRows(t2.id),
    `premise: the one fact X Rp${FACT_IDR} of T2 (holds: ${JSON.stringify(await h.allHolds(t2.id))})`,
  ).toMatchObject([{ provider_refund_id: x, amount_idr: FACT_IDR }]);

  await h.replayAll(anonymousMismatch(t2, r1.refundId, FACT_IDR), 1);
  await h.replayAll(anonymousMismatch(t2, r2.refundId, FACT_IDR), 1);
  const open = await h.openOf(t2.id);
  expect(
    open.map((row) => [row.amount_idr, row.provider_refund_id]),
    `premise: two different anonymous holds of Rp${FACT_IDR} on T2 (holds: ${JSON.stringify(await h.allHolds(t2.id))})`,
  ).toEqual([
    [FACT_IDR, null],
    [FACT_IDR, null],
  ]);
  expect(
    await h.providerRows(t2.id),
    "premise: the holds booked no fact",
  ).toHaveLength(1);
  return { t2, x, first: open[0]!, second: open[1]! };
}

describe("1126 P3-4 one fact closes one hold", () => {
  it("1126-p34-01 two holds of Rp80.000 and one fact Rp80.000 under the same id X: counted works on the first (200), the second is refused 409 and stays open, the fact is not reused, out stays within paid", async () => {
    const w = await world();

    const countedFirst = await h.resolveHold(
      w.first.id,
      "counted_against_intent",
      w.x,
    );
    expect(
      countedFirst.status,
      `the first hold is covered by the fact: ${JSON.stringify(countedFirst.body)}`,
    ).toBe(200);
    expect((await holdById(h, w.t2.id, w.first.id)).resolution).toBe(
      "counted_against_intent",
    );
    const facts = await h.providerRows(w.t2.id);
    expect(facts, "counting books no second fact").toMatchObject([
      { provider_refund_id: w.x, amount_idr: FACT_IDR },
    ]);
    const events = await h.refundEventsOfIntent(w.t2.id);

    const countedSecond = await h.resolveHold(
      w.second.id,
      "counted_against_intent",
      w.x,
    );
    expect(
      countedSecond.status,
      `the fact X is already used by the first hold: ${JSON.stringify(countedSecond.body)}`,
    ).toBe(409);
    const second = await holdById(h, w.t2.id, w.second.id);
    expect(second.resolved_at, "the second hold stays open").toBeNull();
    expect(second.amount_idr, "the second hold is not lowered").toBe(FACT_IDR);
    expect(
      await h.providerRows(w.t2.id),
      "the refused counted books no fact",
    ).toEqual(facts);
    expect(
      await h.refundEventsOfIntent(w.t2.id),
      "no journal event from the refused counted",
    ).toBe(events);

    // Total out: the fact and the open claim are the same money at worst; no manual refund
    // may add to it beyond what was paid.
    const probe = await tryManualOut(h, w.t2.id, BILL_IDR - FACT_IDR + 1_000);
    expectRefused(probe, "p34-01");
    expectWorstCaseWithinPaid(
      await maxOpen(h, w.t2.id),
      await h.factTotal(w.t2.id),
      [probe],
      "p34-01",
    );
  });

  it("1126-p34-02 the second hold keeps an exit: not_this_intent closes it (200) and books nothing", async () => {
    const w = await world();
    const counted = await h.resolveHold(
      w.first.id,
      "counted_against_intent",
      w.x,
    );
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const refused = await h.resolveHold(
      w.second.id,
      "counted_against_intent",
      w.x,
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const facts = await h.providerRows(w.t2.id);

    const closed = await h.resolveHold(w.second.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await holdById(h, w.t2.id, w.second.id)).resolution).toBe(
      "not_this_intent",
    );
    expect(await h.providerRows(w.t2.id), "no fact booked").toEqual(facts);
  });
});
