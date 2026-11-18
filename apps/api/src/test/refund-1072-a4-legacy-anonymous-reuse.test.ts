// (brief 1072, A4 = SO ronde 6 finding 4, P2, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md and
// docs/qa/second-opinion-refund-ronde6-1068.md (finding 4) with the 1063-c
// fixture as the pattern, not from the implementation.
//
// Scenario (legacy data from before migration 0679, which added the nullable
// refund_recon_holds.matched_fact_id): bill Rp100.000 paid; two anonymous facts
// A Rp10.000 and B Rp20.000 on it. The provider's report P1 (Rp10.000) was
// resolved `same_as_counted` BEFORE 0679, so A was used as its partner only
// implicitly: the resolved hold has matched_fact_id NULL. Now the provider
// reports P2 (Rp30.000), the final amount of refund B, and finance picks
// `same_as_counted`. A is already used: B (20.000) is the partner and only the
// difference Rp10.000 may be booked. Today A (10.000) is chosen again and a
// surplus of Rp20.000 is booked: facts total Rp50.000 for a real refund of
// Rp40.000, and the net balance is too small.
//
// Assumptions (the brief does not fix them):
//  - "pre-0679 data" is simulated with an owner-side UPDATE that sets
//    refund_recon_holds.matched_fact_id = NULL on the hold of P1 after it was
//    resolved (column named in the brief), the rest of the row stays.
//  - Outcome of resolving P2 (brief 1072 I5, tightened): 422, the hold stays
//    open and the facts stay A + B (Rp30.000, none bound). A top-up is no longer
//    accepted for legacy data; the control A4-02 (binding intact) still tops up.
//  - Anonymous facts are those created by counting own refunds that failed with
//    no ref (1063-c `declineWithoutRef`); P1 and P2 are held as holds with their
//    ids while unbound anonymous facts exist (1055-a G1-01, 1063-c premise).
//  - Control A4-02: the same flow with the binding of P1 INTACT (new data)
//    already ends in (a); it must keep doing so.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1072-a4-legacy-anonymous-reuse.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1072a4");

const A_IDR = 10_000;
const B_IDR = 20_000;
const P2_IDR = 30_000;
const REAL_TOTAL = A_IDR + P2_IDR; // A 10k + refund B of 30k = Rp40.000
const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;

/** Bill paid; anonymous facts A (10k) and B (20k); report P1 (10k) held. */
async function world() {
  const code: Code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);

  const h1 = await h.declineWithoutRef(code, A_IDR);
  const countedA = await h.resolveHold(h1, "counted_against_intent");
  expect(countedA.status, JSON.stringify(countedA.body)).toBe(200);
  const h2 = await h.declineWithoutRef(code, B_IDR);
  const countedB = await h.resolveHold(
    h2,
    "counted_against_intent",
    undefined,
    "separate",
  );
  expect(countedB.status, JSON.stringify(countedB.body)).toBe(200);
  expect(
    (await h.factAmounts(code.id)).sort((a, b) => a - b),
    "premise: anonymous facts A 10k and B 20k",
  ).toEqual([A_IDR, B_IDR]);

  const p1 = newRefundId();
  await h.replayAll(() => h.refundIdEvent(code.providerRef, p1, A_IDR));
  const holdP1 = (await h.openOf(code.id)).find(
    (row) => row.provider_refund_id === p1,
  );
  expect(
    holdP1,
    `premise: P1 waits as a hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toBeDefined();
  return { code, p1, holdP1: holdP1!.id };
}

/** P2 (30k) is reported and waits as a hold. */
async function reportP2(code: Code) {
  const p2 = newRefundId();
  await h.replayAll(() => h.refundIdEvent(code.providerRef, p2, P2_IDR));
  const hold = (await h.openOf(code.id)).find(
    (row) => row.provider_refund_id === p2,
  );
  expect(
    hold,
    `premise: P2 waits as a hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toBeDefined();
  return hold!.id;
}

/** Brief I5: with an unbound legacy same_as_counted hold, the pick is refused 422, nothing is guessed. */
async function expectRefused(
  code: Code,
  holdId: string,
  status: number,
  label: string,
) {
  expect.soft(status, `${label}: refused 422`).toBe(422);
  expect
    .soft(
      (await h.openOf(code.id)).some((row) => row.id === holdId),
      `${label}: a refused resolve leaves the hold open`,
    )
    .toBe(true);
  expect
    .soft(
      (await h.factAmounts(code.id)).sort((a, b) => a - b),
      `${label}: facts stay A and B, none bound`,
    )
    .toEqual([A_IDR, B_IDR]);
  expect
    .soft(await h.factTotal(code.id), `${label}: facts total <= ${REAL_TOTAL}`)
    .toBeLessThanOrEqual(REAL_TOTAL);
}

describe("A4 (P2) a legacy resolved hold without binding must not let a used anonymous fact be paired again", () => {
  it("1072-a4-01 pre-0679 data: P1=10k resolved same_as_counted with matched_fact_id NULL, then P2=30k same_as_counted: the pick is refused 422 (A is not used twice), total facts <= Rp40.000, a second resolve and replays add nothing more", async () => {
    const t = await world();
    const first = await h.sameAsCounted(t.holdP1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(
      await h.factAmounts(t.code.id).then((a) => a.sort((x, y) => x - y)),
      "premise: P1 settled against an anonymous fact, nothing booked",
    ).toEqual([A_IDR, B_IDR]);
    // Simulate legacy data: the pairing was never bound.
    const reset = await h.owner.query(
      "UPDATE refund_recon_holds SET matched_fact_id = NULL WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, t.holdP1],
    );
    expect(reset.rowCount, "premise: the legacy hold exists").toBe(1);

    const holdP2 = await reportP2(t.code);
    const second = await h.sameAsCounted(holdP2);
    await expectRefused(t.code, holdP2, second.status, "A4-01");

    const factsAfter = await h.providerRows(t.code.id);
    const again = await h.sameAsCounted(holdP2);
    expect(again.status, "a second resolve is refused 422 again").toBe(422);
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.p1, A_IDR),
      1,
    );
    expect(
      await h.providerRows(t.code.id),
      "a second resolve and replays book nothing more",
    ).toEqual(factsAfter);
    expect(
      await h.factTotal(t.code.id),
      "total facts never above the real Rp40.000",
    ).toBeLessThanOrEqual(REAL_TOTAL);
  });

  it("1072-a4-02 control, new data (binding intact): P1=10k same_as_counted binds A, then P2=30k same_as_counted pairs B and books only the top-up of 10k: facts A 10k, B 20k, 10k; total Rp40.000", async () => {
    const t = await world();
    const first = await h.sameAsCounted(t.holdP1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const bound = (await h.allHolds(t.code.id)).find(
      (row) => row.id === t.holdP1,
    );
    expect(bound?.matched_fact_id, "premise: P1 is bound to A").toBeTruthy();

    const holdP2 = await reportP2(t.code);
    const second = await h.sameAsCounted(holdP2);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(
      (await h.factAmounts(t.code.id)).sort((a, b) => a - b),
      "A, B and the top-up of 10k",
    ).toEqual([A_IDR, A_IDR, B_IDR]);
    expect(await h.factTotal(t.code.id)).toBe(REAL_TOTAL);
  });
});
