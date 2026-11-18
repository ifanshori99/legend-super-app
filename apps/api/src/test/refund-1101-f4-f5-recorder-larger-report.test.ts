// (brief 1103, SO refund ronde 10 findings F4 and F5 = refund 1101 F4/F5, P1, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde10-1101.md (findings 4 and 5),
// docs/briefs/1103-fix-refund-ronde10.md (CTO decision 2) and docs/briefs/1072-invarian.md
// (I7: a report larger than what was held is held in full), with the pattern of
// refund-1088-r1b-resolved-hold-larger-report.test.ts and refund-1063-c-anonymous-binding
// (anonymous facts), not from the implementation.
//
// Rule under test (CTO decision 2): the RECORDER door (`payment.refunded` carrying a
// provider refund id; refunds that finance pays by hand still reach it) must never keep a
// smaller hold when a LARGER report of the same identity arrives:
//   F4: an OPEN hold (anonymous-duplicate or live-own) is raised to the larger amount; it is
//       never lowered, and replays or a smaller report change nothing;
//   F5: a hold finance already closed `same_as_counted` does not swallow a larger report of
//       the same id; the larger report opens a new (surplus) hold of the full value (I7).
// Finance can still count a hold without refund id: nothing here blocks that.
//
// Scenarios (SO):
//   F4a: T Rp100.000, anonymous fact Rp30.000. Report X/T Rp30.000 -> hold; then X/T Rp80.000.
//   F4b: R Rp10.000 in flight. Report Z/T Rp30.000 -> hold; then Z/T Rp80.000.
//   F5 : anonymous fact Rp30.000; report X/T Rp30.000 held, finance resolves
//        `same_as_counted`; then X/T Rp80.000.
//
// Rules pinned:
//   - after the larger report an open hold of at least Rp80.000 exists (max over the open
//     holds of T), in both orders (small then big, big then small: never lowered);
//   - a refund of Rp40.000 (F4a, F5) or Rp20.000 (F4b) on T is refused (409/422 at request
//     or approve): with a hold of Rp80.000 nothing that large is left; the provider is not asked;
//   - no provider fact and no journal event is created by the reports (the facts stay the
//     single anonymous Rp30.000 / none);
//   - replays of the larger report and of the smaller one add no hold row once the larger
//     one is held; the identical smaller report after `same_as_counted` opens nothing
//     (control, F5);
//   - race (two connections): report and resolve in parallel end with the larger evidence
//     covered, either as an open hold >= Rp80.000 or as facts >= Rp80.000.
//
// Assumptions (the brief does not fix them):
//   - The flag state does not matter for these doors (SO: "tanpa flag aktif"); the file
//     leaves the switch at the harness default and uses the harness' legacy fake port to
//     build the premises, as refund-1063-c / 1072-a4.
//   - Anonymous fact = our refund that timed out and was then declined with no ref, counted
//     by finance (`declineWithoutRef` + `counted_against_intent`), as in 1072-a4.
//   - "Raised" = the same open hold grows, or an additional open hold covers the larger
//     amount; only "max open hold >= Rp80.000" and "no more rows after replays" are pinned,
//     not whether the old row is updated or a surplus row is added. The reason text is free.
//   - A hold on the first small report exists (the premise); its exact amount is "at least
//     the reported Rp30.000".
//   - The deposit-credit side (reservation fixtures) is not built here; the refund of T is
//     the proof that the remaining money is cut.
//   - The two-connection test is race-sensitive only before the fix: after the fix every
//     interleaving ends covered, so it cannot fail for timing.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1101-f4-f5-recorder-larger-report.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1101f45");

const A_IDR = 30_000;
const BIG_IDR = 80_000;
const newId = () => `rf_${randomBytes(6).toString("hex")}`;

/** T paid, one anonymous fact of Rp30.000 (own refund declined with no ref, counted). */
async function anonymousWorld(): Promise<Code> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const holdId = await h.declineWithoutRef(code, A_IDR);
  const counted = await h.resolveHold(holdId, "counted_against_intent");
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  expect(await h.factAmounts(code.id), "premise: anonymous fact").toEqual([
    A_IDR,
  ]);
  return code;
}

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

/** The larger report is held in full, replays and the smaller report add nothing. */
async function expectRaised(
  code: Code,
  id: string,
  label: string,
  facts: number[],
  callsBefore: number,
  eventsBefore: number,
) {
  const holds = JSON.stringify(await h.allHolds(code.id));
  expect(
    await maxOpen(code.id),
    `${label}: an open hold covers the larger report (holds: ${holds})`,
  ).toBeGreaterThanOrEqual(BIG_IDR);
  expect(await h.factAmounts(code.id), `${label}: no fact booked`).toEqual(
    facts,
  );
  expect(
    await h.refundEventsOfIntent(code.id),
    `${label}: no journal event`,
  ).toBe(eventsBefore);

  const rows = (await h.allHolds(code.id)).length;
  await h.replayAll(report(code, id, BIG_IDR), 2);
  await h.replayAll(report(code, id, A_IDR), 1);
  expect(
    (await h.allHolds(code.id)).length,
    `${label}: replays of the larger and of the smaller report add no hold row`,
  ).toBe(rows);
  expect(
    await maxOpen(code.id),
    `${label}: never lowered by a smaller report`,
  ).toBeGreaterThanOrEqual(BIG_IDR);
  expect(h.fake.calls, `${label}: nothing reached the provider`).toHaveLength(
    callsBefore,
  );
}

describe("F4 (P1) an open hold is raised by a larger report of the same identity at the recorder door", () => {
  it("1101-f4-01 anonymous fact Rp30.000: report X/T Rp30.000 is held, then X/T Rp80.000 raises the hold to at least Rp80.000; a refund of Rp40.000 is refused", async () => {
    const code = await anonymousWorld();
    const callsBefore = h.fake.calls.length;
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const x = newId();

    await h.replayAll(report(code, x, A_IDR), 1);
    const first = await h.openOf(code.id);
    expect(
      first,
      `premise: one open hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toHaveLength(1);
    expect(first[0]!.amount_idr).toBeGreaterThanOrEqual(A_IDR);

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectRaised(code, x, "f4-01", [A_IDR], callsBefore, eventsBefore);
    await expectRefundRefused(code.id, 40_000, "f4-01");
    expect(h.fake.calls, "f4-01: nothing reached the provider").toHaveLength(
      callsBefore,
    );
  });

  it("1101-f4-02 reverse order: X/T Rp80.000 first, then X/T Rp30.000: the hold is never lowered", async () => {
    const code = await anonymousWorld();
    const callsBefore = h.fake.calls.length;
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const x = newId();

    await h.replayAll(report(code, x, BIG_IDR), 1);
    await h.replayAll(report(code, x, A_IDR), 1);
    await expectRaised(code, x, "f4-02", [A_IDR], callsBefore, eventsBefore);
    await expectRefundRefused(code.id, 40_000, "f4-02");
  });

  it("1101-f4-03 live-own: our refund R Rp10.000 in flight, report Z/T Rp30.000 is held, then Z/T Rp80.000 raises it to at least Rp80.000; a refund of Rp20.000 is refused", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    // Our refund R "in flight" = approved, sent, timed out with NO provider ref
    // (payout_attempts 1): only then is a provider report held as live-own. A
    // `pending` answer stores ref X, so R is no longer in flight and a report
    // of another id Z would simply be booked.
    const filed = await h.manualRefund(code.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    h.fake.enqueue("throw");
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const callsBefore = h.fake.calls.length;
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const z = newId();

    await h.deliver(report(code, z, A_IDR)());
    expect(
      (await h.openOf(code.id)).length,
      `premise: the first report is held (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThanOrEqual(1);

    await h.deliver(report(code, z, BIG_IDR)());
    expect(
      await maxOpen(code.id),
      `f4-03: an open hold covers the larger report (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThanOrEqual(BIG_IDR);
    const rows = (await h.allHolds(code.id)).length;
    for (let round = 0; round < 2; round += 1)
      await h.deliver(report(code, z, BIG_IDR)());
    await h.deliver(report(code, z, A_IDR)());
    expect(
      (await h.allHolds(code.id)).length,
      "f4-03: replays add no hold row",
    ).toBe(rows);
    expect(await maxOpen(code.id)).toBeGreaterThanOrEqual(BIG_IDR);
    expect(
      await h.refundEventsOfIntent(code.id),
      "f4-03: no journal event from the reports",
    ).toBe(eventsBefore);
    await expectRefundRefused(code.id, 20_000, "f4-03");
    expect(
      h.fake.calls,
      "f4-03: nothing more reached the provider",
    ).toHaveLength(callsBefore);
  });

  it("1101-f4-04 two connections: X/T Rp30.000 and X/T Rp80.000 delivered at the same time end with an open hold of at least Rp80.000 and not more than one row per envelope", async () => {
    const code = await anonymousWorld();
    const x = newId();
    const small = h.refundIdEvent(code.providerRef, x, A_IDR);
    const big = h.refundIdEvent(code.providerRef, x, BIG_IDR);

    const answers = await Promise.all([h.deliver(small), h.deliver(big)]);
    for (const answer of answers)
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    await h.runWorker();
    await h.replayAll(() => big, 1);

    expect(
      await maxOpen(code.id),
      `f4-04: covered (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThanOrEqual(BIG_IDR);
    expect(await h.factAmounts(code.id), "f4-04: no fact booked").toEqual([
      A_IDR,
    ]);
    expect((await h.allHolds(code.id)).length).toBeLessThanOrEqual(3);
  });
});

describe("F5 (P1) a hold closed same_as_counted does not swallow a larger report of the same id", () => {
  it("1101-f5-01 anonymous fact Rp30.000, X/T Rp30.000 held and resolved same_as_counted, then X/T Rp80.000: a new open hold of at least Rp80.000, no fact, a refund of Rp40.000 refused; replays add nothing", async () => {
    const code = await anonymousWorld();
    const x = newId();
    await h.replayAll(report(code, x, A_IDR), 1);
    const open = await h.openOf(code.id);
    expect(
      open,
      `premise: one open hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toHaveLength(1);
    const same = await h.sameAsCounted(open[0]!.id);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(await h.openOf(code.id), "premise: nothing open").toHaveLength(0);
    const facts = await h.factAmounts(code.id);
    expect(facts, "premise: still the anonymous fact").toEqual([A_IDR]);
    const eventsBefore = await h.refundEventsOfIntent(code.id);
    const callsBefore = h.fake.calls.length;

    // Control: the identical smaller report is a replay and opens nothing.
    const rowsBefore = (await h.allHolds(code.id)).length;
    await h.replayAll(report(code, x, A_IDR), 2);
    expect(
      (await h.allHolds(code.id)).length,
      "f5-01 control: the same Rp30.000 report after same_as_counted adds no hold",
    ).toBe(rowsBefore);
    expect(await h.openOf(code.id)).toHaveLength(0);

    // The larger report is not "the same evidence".
    await h.replayAll(report(code, x, BIG_IDR), 1);
    await expectRaised(code, x, "f5-01", facts, callsBefore, eventsBefore);
    await expectRefundRefused(code.id, 40_000, "f5-01");
  });

  it("1101-f5-02 two connections: resolving the Rp30.000 hold same_as_counted while X/T Rp80.000 arrives ends with the Rp80.000 covered, as an open hold or as facts", async () => {
    const code = await anonymousWorld();
    const x = newId();
    await h.replayAll(report(code, x, A_IDR), 1);
    const open = await h.openOf(code.id);
    expect(open, "premise: one open hold").toHaveLength(1);
    const big = h.refundIdEvent(code.providerRef, x, BIG_IDR);

    const [resolved, delivered] = await Promise.all([
      h.sameAsCounted(open[0]!.id),
      h.deliver(big),
    ]);
    expect(
      [200, 409, 422],
      `f5-02: resolve answer ${JSON.stringify(resolved.body)}`,
    ).toContain(resolved.status);
    expect(delivered.status, JSON.stringify(delivered.body)).toBeLessThan(500);
    await h.runWorker();
    await h.replayAll(() => big, 1);

    const covered = Math.max(
      await maxOpen(code.id),
      await h.factTotal(code.id),
    );
    expect(
      covered,
      `f5-02: Rp80.000 is held or booked (holds: ${JSON.stringify(await h.allHolds(code.id))}; facts: ${JSON.stringify(await h.factAmounts(code.id))})`,
    ).toBeGreaterThanOrEqual(BIG_IDR);
  });
});
