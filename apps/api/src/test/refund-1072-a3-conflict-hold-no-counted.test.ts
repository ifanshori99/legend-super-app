// (brief 1072, A3 = SO ronde 6 finding 3, P2, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md and
// docs/qa/second-opinion-refund-ronde6-1068.md (finding 3) with the 1063-a /
// 1063-c fixtures as the pattern, not from the implementation.
//
// Rule (CTO decision, release 1): a HOLD_TRANSACTION_CONFLICT hold may ONLY be
// closed as `not_this_intent` (the money stays held). `counted_against_intent`
// (any identity, including `same_as_counted`) must be refused, whatever facts
// exist on the intent.
//
// Scenario: one intent with transactions T1 (the paid bill), T2 and T3 (extra
// payments, fully parked as unallocated funds). A refund of T2's fund (Rp20.000)
// was sent without a reference, declined, and finance counted it: an anonymous
// fact of Rp20.000 on T2, no open hold. OUR refund of T1 (Rp20.000) completes
// with ref X. The provider reports X for T2 (Rp20.000): X is our refund of
// ANOTHER transaction, so a conflict hold is filed. Finance then tries to
// close it as counted / same_as_counted. That must not release T3's guard.
//
// Assumptions (the brief does not fix them):
//  - A resolve of a conflict hold as counted is refused with HTTP 409 (brief I4:
//    the hold only closes `not_this_intent`). T3's fund refund keeps 409/422.
//  - "hold and binding unchanged" = the hold row stays open (resolved_at NULL,
//    resolution NULL) with matched_fact_id NULL, and the rows of
//    payment_provider_refunds are identical before and after.
//  - "fund T3 stays blocked" = resolving T3's fund with `refund` is refused
//    409/422 right away, or (if filed) the approve is refused 409/422; the
//    refund gateway is not called in both cases.
//  - The conflict hold is matched by the text HOLD_TRANSACTION_CONFLICT
//    (case-insensitive), as in 1063-a.
//  - Control A3-03: `not_this_intent` still closes the conflict hold (200), books
//    no fact and leaves the anonymous fact as it was.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1072-a3-conflict-hold-no-counted.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
  type Extra,
} from "./refund-1072-harness";

const h = createRefundHarness("1072a3");

const CONFLICT = /HOLD_TRANSACTION_CONFLICT/i;
const T2_IDR = 20_000;
const OWN_IDR = 20_000;

type World = {
  code: Code;
  t2: Extra;
  t3: Extra;
  fund2: string;
  fund3: string;
  x: string;
  conflictHoldId: string;
};

/** The T1/T2/T3 state up to the open conflict hold X/T2. */
async function world(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const second = await h.addParkedExtra(code, T2_IDR);
  const third = await h.addParkedExtra(code, BILL_IDR);

  // Refund of T2's fund: sent, no reference, declined; finance counts it.
  const filed = await h.resolveFund(second.fundId, "refund");
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  const fundRefund = await h.owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [h.tenantId, second.fundId],
  );
  const known = new Set((await h.allHolds(code.id)).map((row) => row.id));
  const holdId = await h.declineFiledWithoutRef(
    code,
    known,
    fundRefund.rows[0]!.id,
  );
  const counted = await h.resolveHold(holdId, "counted_against_intent");
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  expect(
    await h.factAmounts(code.id),
    "premise: one anonymous fact of Rp20.000",
  ).toEqual([T2_IDR]);
  expect((await h.openOf(code.id)).length, "premise: no open hold left").toBe(
    0,
  );

  // Our refund of T1 completes with ref X.
  const own = await h.ownCompletedRefund(code, OWN_IDR);

  // The provider reports X for T2.
  await h.replayAll(
    () => h.refundIdEvent(second.extra.providerRef, own.x, T2_IDR),
    1,
  );
  const conflicts = (await h.openOf(code.id)).filter(
    (row) =>
      CONFLICT.test(row.reason) &&
      row.provider_refund_id === own.x &&
      row.provider_payment_ref === second.extra.providerRef,
  );
  expect(
    conflicts,
    `premise: one open conflict hold X/T2 (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toHaveLength(1);
  return {
    code,
    t2: second.extra,
    t3: third.extra,
    fund2: second.fundId,
    fund3: third.fundId,
    x: own.x,
    conflictHoldId: conflicts[0]!.id,
  };
}

async function snapshot(w: World) {
  return {
    facts: await h.providerRows(w.code.id),
    holds: await h.allHolds(w.code.id),
    events: await h.refundEventsOfIntent(w.code.id),
  };
}

/** T3's money stays held: no refund of its fund reaches the provider. */
async function expectFundT3Blocked(w: World, callsBefore: number) {
  const filed = await h.resolveFund(w.fund3, "refund");
  if (filed.status === 200) {
    const row = await h.owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [h.tenantId, w.fund3],
    );
    const approved = await h.approveRefund(row.rows[0]!.id);
    expect(
      [409, 422],
      `approving T3's fund refund: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect(
      [409, 422],
      `T3's fund refund: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(h.fake.calls, "port.refund not called for T3").toHaveLength(
    callsBefore,
  );
}

describe("A3 (P2) a conflict hold is never closed as counted / same_as_counted", () => {
  it("1072-a3-01 same_as_counted on the conflict hold X/T2 is refused 409: the hold stays open and unbound, no fact is added or changed, fund T3 stays blocked", async () => {
    const w = await world();
    const before = await snapshot(w);
    const callsBefore = h.fake.calls.length;

    const attempt = await h.sameAsCounted(w.conflictHoldId);
    expect(
      attempt.status,
      `same_as_counted on a conflict hold: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}`,
    ).toBe(409);

    const after = await snapshot(w);
    const hold = after.holds.find((row) => row.id === w.conflictHoldId)!;
    expect.soft(hold.resolved_at, "the hold stays open").toBeNull();
    expect.soft(hold.resolution).toBeNull();
    expect.soft(hold.matched_fact_id, "no anonymous fact is bound").toBeNull();
    expect.soft(after.facts, "fact rows unchanged").toEqual(before.facts);
    expect.soft(after.events, "no journal event").toBe(before.events);
    await expectFundT3Blocked(w, callsBefore);
  });

  it("1072-a3-02 counted_against_intent without identity and with identity `separate` on the conflict hold are refused 409 too: hold open, facts unchanged, fund T3 stays blocked; a replay of the report changes nothing", async () => {
    const w = await world();
    const before = await snapshot(w);
    const callsBefore = h.fake.calls.length;

    const plain = await h.resolveHold(
      w.conflictHoldId,
      "counted_against_intent",
    );
    expect(
      plain.status,
      `counted without identity: HTTP ${plain.status} ${JSON.stringify(plain.body)}`,
    ).toBe(409);
    const separate = await h.resolveHold(
      w.conflictHoldId,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(
      separate.status,
      `counted with identity separate: HTTP ${separate.status} ${JSON.stringify(separate.body)}`,
    ).toBe(409);

    await h.replayAll(() => h.refundIdEvent(w.t2.providerRef, w.x, T2_IDR), 1);
    const after = await snapshot(w);
    expect
      .soft(
        after.holds.find((row) => row.id === w.conflictHoldId)?.resolved_at,
        "the hold stays open",
      )
      .toBeNull();
    expect.soft(after.facts).toEqual(before.facts);
    expect.soft(after.events).toBe(before.events);
    await expectFundT3Blocked(w, callsBefore);
  });

  it("1072-a3-03 control (CTO decision): not_this_intent closes the conflict hold (200) without booking a fact; the anonymous fact stays as it was", async () => {
    const w = await world();
    const before = await snapshot(w);

    const resolved = await h.resolveHold(w.conflictHoldId, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const after = await snapshot(w);
    const hold = after.holds.find((row) => row.id === w.conflictHoldId)!;
    expect(hold.resolved_at).not.toBeNull();
    expect(hold.resolution).toBe("not_this_intent");
    expect(after.facts, "no fact booked, none removed").toEqual(before.facts);
    expect(after.events).toBe(before.events);
  });
});
