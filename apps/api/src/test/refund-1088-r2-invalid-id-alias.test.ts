// (brief 1090 "Keputusan CTO", SO refund ronde 9 finding 2 = refund 1088 R2, P1, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde9-1088.md (finding 2), docs/briefs/1072-invarian.md
// (I1/I2/I7/I8/I10(a)) and the pattern of refund-1077-r1-invalid-long-id.test.ts,
// not from the implementation.
//
// Rule under test (CTO decision): the dedup domain of an "invalid report" placeholder
// hold is separate from provider refund ids. No literal provider refund id (not even
// `invalid:...` or the `invalid-h:<sha256>` form of a long id) may ever match, or be
// absorbed by, a placeholder hold. A real report with a literal id that equals an old
// placeholder is a NEW hold (restrictive). Today the placeholder is stored with kind
// `provider`, so a literal provider id H equal to the placeholder id of report L is
// treated as the "same evidence" and swallowed after finance closed the placeholder.
//
// Scenario (SO, exact): L = "L".repeat(93); H = invalid-h:<sha256(L)>
//   = invalid-h:1546a4c7fa72d07396a82cda00ccee3ab7a3e6ae4fa6b8948df7adedf245dc33.
// T Rp100.000; R completed Rp20.000 (ref X); R2 Rp80.000 approved, never sent (provider
// refunds off, the production state: no provider trace). Signed refund.succeeded keyed
// `refund:<R>`, refund id L, payment T, invalid amount -> a placeholder hold of
// Rp100.000. Finance closes it `not_this_intent`. Then a real, different refund
// arrives: keyed R, LITERAL provider id H, payment T, Rp60.000.
//
// Rules pinned:
//   - the real report is not absorbed: the evidence stays held or recorded (a new open
//     hold exists, or a provider fact H/T exists) - the count of holds + facts of T grows;
//   - the settle of R2 is refused (not 200), R2 stays approved (20.000 + 60.000 + 80.000
//     would leave more than the Rp100.000 paid);
//   - matched door (refund.succeeded keyed R) invents no fact and no journal event;
//   - the recorder door (`payment.refunded` carrying H and Rp60.000) may record a fact
//     (a real refund), but is never swallowed either;
//   - same for the short form: placeholder `invalid:<id>` of a short id L1, then a
//     literal provider id `invalid:<L1>`;
//   - controls: the same report L repeated stays ONE hold (open and after finance
//     closed it); lengths 92, 93 and 100 of L stay safe (no 5xx, one hold of Rp100.000).
//
// Assumptions (the brief does not fix them):
//   - The size of the new hold for the real report is not pinned beyond "at least the
//     report's Rp60.000" (matched door).
//   - Finance closes the placeholder with `not_this_intent` (the only legal way for a
//     conflict hold); a 200 is the premise of every case.
//   - "Refused" settle = anything but 200 (409 hold guard or 409/422 cap guard); R2
//     stays `approved` is the proof.
//   - The DP credit of the same payment is not built in this webhook door (needs
//     reservation and session fixtures; see refund-1088-r1 for a reservation-linked T2);
//     R2's settle plus the held/recorded evidence stand for "nothing more may go out".
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1088-r2-invalid-id-alias.test.ts" heavy pnpm test

import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import { resetPaymentRefundGateways } from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1088r2");

const R_IDR = 20_000;
const R2_IDR = 80_000;
const REAL_IDR = 60_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
// Matched suites exercise the active provider-refund path: the baseline is
// DOIT refunds on (off by default); each test restores it, afterAll restores the original.
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

/** The SO's long id and the placeholder id of its hold (from the report, not the code). */
const L = "L".repeat(93);
const H =
  "invalid-h:1546a4c7fa72d07396a82cda00ccee3ab7a3e6ae4fa6b8948df7adedf245dc33";

type World = { code: Code; refundId: string; x: string; r2: string };

/** T paid, R Rp20.000 completed (ref X), R2 Rp80.000 approved and waiting for finance. */
async function world(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(code, R_IDR);
  flags.DOIT_REFUNDS_ENABLED = false;
  resetPaymentRefundGateways();
  const filed = await h.manualRefund(code.id, R2_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const r2 = filed.body.data.id as string;
  const approved = await h.approveRefund(r2);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect((await h.refundRow(r2)).status, "premise: R2 waits for finance").toBe(
    "approved",
  );
  return { code, refundId: own.refundId, x: own.x, r2 };
}

/** Signed refund object keyed refund:<R>, refund id `id`, payment T, amount as given. */
const keyed = (w: World, id: string, amount?: unknown) => {
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  return () => ({
    id: eventId,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      id,
      idempotency_key: `refund:${w.refundId}`,
      payment_id: w.code.providerRef,
      status: "succeeded",
      ...(amount === undefined ? {} : { amount }),
    },
  });
};

/** Recorder door: the status object of T carrying refund id `id`. */
const recorder = (w: World, id: string, amountIdr: number) => () =>
  h.refundIdEvent(w.code.providerRef, id, amountIdr);

const holdsAndFacts = async (w: World) =>
  (await h.allHolds(w.code.id)).length +
  (await h.providerRows(w.code.id)).length;

/** The placeholder hold of an invalid-amount report `id` exists; finance closes it. */
async function placeholderThenResolve(w: World, id: string, label: string) {
  const deliver = keyed(w, id, "80000.0");
  const answered = await h.deliver(deliver());
  expect(
    answered.status,
    `${label}: no 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
  await h.runWorker();
  const open = await h.openOf(w.code.id);
  expect(
    open,
    `${label}: one placeholder hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
  ).toHaveLength(1);
  expect(open[0]!.amount_idr, `${label}: whole payment held`).toBe(BILL_IDR);
  const resolved = await h.resolveHold(open[0]!.id, "not_this_intent");
  expect(
    resolved.status,
    `${label}: finance closes the placeholder: ${JSON.stringify(resolved.body)}`,
  ).toBe(200);
  expect(await h.openOf(w.code.id), `${label}: nothing open`).toHaveLength(0);
  return deliver;
}

/** The real report must not be swallowed; R2 cannot be paid on top. */
async function expectNotAbsorbed(
  w: World,
  before: number,
  label: string,
  opts: { inventsNothing: boolean },
) {
  const holds = JSON.stringify(await h.allHolds(w.code.id));
  const facts = JSON.stringify(await h.providerRows(w.code.id));
  expect(
    await holdsAndFacts(w),
    `${label}: the real refund report is held or recorded, not absorbed by the old placeholder (holds: ${holds}; facts: ${facts})`,
  ).toBeGreaterThan(before);
  if (opts.inventsNothing) {
    expect(
      (await h.providerRows(w.code.id)).filter(
        (row) => row.provider_refund_id === H || row.amount_idr === REAL_IDR,
      ),
      `${label}: no invented provider fact`,
    ).toHaveLength(0);
  }
  const settled = await h.settleManually(w.r2, R2_IDR);
  expect(
    settled.status,
    `${label}: settle of R2 is refused: ${JSON.stringify(settled.body)}`,
  ).not.toBe(200);
  expect((await h.refundRow(w.r2)).status, `${label}: R2 stays approved`).toBe(
    "approved",
  );
  expect(
    await h.refundRow(w.refundId),
    `${label}: R is untouched`,
  ).toMatchObject({
    status: "completed",
    amount_idr: String(R_IDR),
    provider_ref: w.x,
  });
}

describe("R2 (P1) a literal provider id equal to an invalid-report placeholder id is never absorbed", () => {
  it("1088-r2-00 premise of the SO witness: H is invalid-h: + sha256(L) of the 93-character id", () => {
    expect(L).toHaveLength(93);
    expect(H).toBe(`invalid-h:${createHash("sha256").update(L).digest("hex")}`);
    expect(H).toHaveLength(74);
  });

  it("1088-r2-01 matched door: placeholder of L closed not_this_intent, then the real refund keyed R with literal id H and Rp60.000 is held (new hold), settle of R2 refused, no invented fact or journal event", async () => {
    const w = await world();
    await placeholderThenResolve(w, L, "r2-01");
    const factsBefore = await h.providerRows(w.code.id);
    const eventsBefore = await h.refundEventsOfIntent(w.code.id);
    const before = await holdsAndFacts(w);

    const real = keyed(w, H, REAL_IDR);
    await h.replayAll(real, 1);
    const open = await h.openOf(w.code.id);
    expect(
      open,
      `r2-01: a new open hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toHaveLength(1);
    expect(
      open[0]!.amount_idr,
      "r2-01: the hold covers at least the reported Rp60.000",
    ).toBeGreaterThanOrEqual(REAL_IDR);
    await expectNotAbsorbed(w, before, "r2-01", { inventsNothing: true });
    expect(await h.providerRows(w.code.id), "r2-01: no fact").toEqual(
      factsBefore,
    );
    expect(
      await h.refundEventsOfIntent(w.code.id),
      "r2-01: no journal event",
    ).toBe(eventsBefore);

    // Replays of the real report (same event id) add no second hold.
    const holdsAfter = (await h.allHolds(w.code.id)).length;
    await h.replayAll(real, 2);
    expect(
      (await h.allHolds(w.code.id)).length,
      "r2-01: replays add no hold",
    ).toBe(holdsAfter);
    // The switch is off in this world (1103): the same report under a new
    // event id is a new event, one more hold of at least the reported amount.
    await h.replayAll(keyed(w, H, REAL_IDR), 1);
    expect(
      (await h.allHolds(w.code.id)).length,
      "r2-01: a new event id adds exactly one hold",
    ).toBe(holdsAfter + 1);
    const openAfterNew = await h.openOf(w.code.id);
    expect(openAfterNew, "r2-01: both holds open").toHaveLength(2);
    for (const row of openAfterNew) {
      expect(
        row.amount_idr,
        "r2-01: each hold covers at least the reported Rp60.000",
      ).toBeGreaterThanOrEqual(REAL_IDR);
    }
    expect(await h.providerRows(w.code.id), "r2-01: still no fact").toEqual(
      factsBefore,
    );
    expect(
      await h.refundEventsOfIntent(w.code.id),
      "r2-01: still no journal event",
    ).toBe(eventsBefore);
    const settled = await h.settleManually(w.r2, R2_IDR);
    expect(
      settled.status,
      `r2-01: settle of R2 stays refused: ${JSON.stringify(settled.body)}`,
    ).not.toBe(200);
  });

  it("1088-r2-02 recorder door: placeholder of L closed, then `payment.refunded` carrying the literal id H and Rp60.000 is recorded or held, never absorbed; settle of R2 refused", async () => {
    const w = await world();
    await placeholderThenResolve(w, L, "r2-02");
    const before = await holdsAndFacts(w);

    await h.replayAll(recorder(w, H, REAL_IDR), 1);
    await expectNotAbsorbed(w, before, "r2-02", { inventsNothing: false });
  });

  it("1088-r2-03 short form: placeholder `invalid:<id>` of a short id closed, then the literal provider id `invalid:<id>` with Rp60.000 (matched door) is held, settle of R2 refused", async () => {
    const w = await world();
    const short = "L".repeat(20);
    await placeholderThenResolve(w, short, "r2-03");
    const before = await holdsAndFacts(w);

    await h.replayAll(keyed(w, `invalid:${short}`, REAL_IDR), 1);
    const open = await h.openOf(w.code.id);
    expect(
      open,
      `r2-03: a new open hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toHaveLength(1);
    expect(open[0]!.amount_idr).toBeGreaterThanOrEqual(REAL_IDR);
    await expectNotAbsorbed(w, before, "r2-03", { inventsNothing: true });
  });

  it("1088-r2-04 short form, recorder door: literal id `invalid:<id>` with Rp60.000 is recorded or held, never absorbed", async () => {
    const w = await world();
    const short = "L".repeat(20);
    await placeholderThenResolve(w, short, "r2-04");
    const before = await holdsAndFacts(w);

    await h.replayAll(recorder(w, `invalid:${short}`, REAL_IDR), 1);
    await expectNotAbsorbed(w, before, "r2-04", { inventsNothing: false });
  });

  it("1088-r2-05 the literal id alone (placeholder still OPEN, not closed): a real report with id H and Rp60.000 is not swallowed either (a second hold or a fact), settle of R2 refused", async () => {
    const w = await world();
    const first = await h.deliver(keyed(w, L, "80000.0")());
    expect(first.status).toBeLessThan(500);
    await h.runWorker();
    expect(await h.openOf(w.code.id), "premise: placeholder open").toHaveLength(
      1,
    );
    const before = await holdsAndFacts(w);

    await h.replayAll(keyed(w, H, REAL_IDR), 1);
    await expectNotAbsorbed(w, before, "r2-05", { inventsNothing: true });
  });

  describe("controls: the same invalid report L stays one hold, lengths 92, 93 and 100 stay safe", () => {
    for (const n of [92, 93, 100] as const) {
      it(`1088-r2-control-${n} id of ${n} chars: one hold of Rp100.000, repeated reports add none (also after finance closed it), no 5xx`, async () => {
        const w = await world();
        const id = "L".repeat(n);
        const report = keyed(w, id, "80000.0");
        const answered = await h.deliver(report());
        expect(
          answered.status,
          `no 5xx: ${JSON.stringify(answered.body)}`,
        ).toBeLessThan(500);
        await h.runWorker();
        const open = await h.openOf(w.code.id);
        expect(
          open,
          `one open hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
        ).toHaveLength(1);
        expect(open[0]!.amount_idr).toBe(BILL_IDR);

        // Same event id: a replay. The switch is off in this world (1103), so
        // the same report under a new event id is a new event: one more hold.
        await h.replayAll(report, 2);
        expect(
          (await h.allHolds(w.code.id)).length,
          "replays of L (same event id) add no hold",
        ).toBe(1);
        await h.replayAll(keyed(w, id, "80000.0"), 1);
        const afterNew = await h.openOf(w.code.id);
        expect(
          afterNew,
          `a new event id of L adds exactly one open hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
        ).toHaveLength(2);
        for (const row of afterNew) expect(row.amount_idr).toBe(BILL_IDR);

        for (const row of afterNew) {
          const resolved = await h.resolveHold(row.id, "not_this_intent");
          expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
        }
        await h.replayAll(report, 1);
        expect(
          (await h.allHolds(w.code.id)).length,
          "after finance closed them, the same event of L reopens nothing",
        ).toBe(2);
        expect(await h.openOf(w.code.id)).toHaveLength(0);
        expect(await h.providerRows(w.code.id), "no fact").toHaveLength(0);
      });
    }
  });
});
