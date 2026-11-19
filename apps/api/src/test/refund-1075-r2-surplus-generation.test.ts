// (brief 1072 "Ronde 7" R7-2 = SO 1075 finding 2, P1, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md (Ronde 7) and
// docs/qa/second-opinion-refund-ronde7-1075.md (finding 2), with the pattern of
// refund-1072-a1-matched-echo-hold.test.ts a1-10 / a1-11, not from the
// implementation.
//
// Scenario: transaction T Rp100.000, our refund R Rp30.000 completed with provider
// ref X (its echo X/T Rp30.000 is a fact). Signed report X/T Rp50.000 files a CONFLICT
// hold, finance closes it (not_this_intent). Signed report X/T Rp80.000 files a
// surplus hold, finance closes that too (not_this_intent). A NEW signed report X/T
// Rp90.000 is bigger than both closed holds and is not proven to be an echo of R:
// it must leave an OPEN hold again. Today it hits the permanent surplus hold id of
// the closed generation and vanishes, so a new refund of Rp70.000 passes the guard
// (if the provider is right: Rp90.000 + Rp70.000 > Rp100.000 paid).
//
// Rule under test (CTO, R7-2): every success report that is not proven an echo <=
// our refund always leaves an open hold, also after earlier holds were resolved;
// replays of the SAME evidence stay stable (no duplicated hold).
//
// Assumptions (the brief does not fix them):
//  - Steps 1-2 use the recorder door (`payment.refunded` status object, as a1-10 and
//    a1-11); the door of step 2 (the Rp80.000 surplus) and of step 3 (Rp90.000)
//    varies over both doors (recorder, matched `refund.succeeded`): four orders.
//  - "an open hold again" = exactly one open CONFLICT hold of the full Rp90.000
//    (restrictive, the F-P2 rule); its provider_refund_id and row id are not pinned.
//  - "the earlier holds stay closed and exactly one hold was added" = the number of
//    CONFLICT holds of the intent is 3 after the Rp90.000 report and its replays.
//  - "request / settle beyond is refused" = a new refund of Rp70.000 is refused 409/422
//    at request or approve and the refund gateway is not called again (same helper
//    as a1-*). The DP-credit variant of the SO is not covered here.
//  - Control r2-05: the legitimate echo of R (X/T Rp30.000, both doors) leaves no hold
//    and does not block the rest of the bill (a refund of Rp70.000 is allowed).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1075-r2-surplus-generation.test.ts" heavy pnpm test

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1075r2");

// The matched suites exercise the active provider-refund path: DOIT refunds
// are off by default, so switch them on here and restore the value afterwards.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const R_IDR = 30_000;
const NEXT_IDR = 70_000;
const CONFLICT = /HOLD_TRANSACTION_CONFLICT/i;

type Door = "recorder" | "matched";
const event = (door: Door, code: Code, x: string, amount: number) =>
  door === "recorder"
    ? h.refundIdEvent(code.providerRef, x, amount)
    : h.refundSucceededEvent(code.providerRef, x, amount);

/** Bill Rp100.000 paid; our refund R of Rp30.000 completed (ref X). */
async function world() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(code, R_IDR);
  return { code, ...own };
}

/** The echo fact of R (X/T Rp30.000 on the main transaction), as in a1-10. */
async function seedEchoFact(code: Code, x: string) {
  const evidence = await h.owner.query<{ id: string }>(
    "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
    [h.tenantId, code.id, code.providerRef],
  );
  await h.owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
    [
      h.tenantId,
      h.outletId,
      code.id,
      evidence.rows[0]!.id,
      x,
      code.providerRef,
      R_IDR,
    ],
  );
}

const conflictsOf = async (code: Code) =>
  (await h.allHolds(code.id)).filter((row) => CONFLICT.test(row.reason));
const openConflictsOf = async (code: Code) =>
  (await conflictsOf(code)).filter((row) => row.resolved_at === null);
const amountsOf = (rows: { amount_idr: number }[]) =>
  rows.map((row) => row.amount_idr);

/** The next refund of Rp70.000 is refused and nothing more is sent to the guest. */
async function expectNextRefundBlocked(
  code: Code,
  callsBefore: number,
  label: string,
) {
  const filed = await h.manualRefund(code.id, NEXT_IDR);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${NEXT_IDR}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect(
      [409, 422],
      `${label}: requesting ${NEXT_IDR}: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(h.fake.calls, `${label}: port.refund not called again`).toHaveLength(
    callsBefore,
  );
  const sent = await h.count(
    `SELECT count(*)::text AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref IS NOT NULL`,
    [h.tenantId, code.id],
  );
  expect(sent, `${label}: no second refund reached the provider`).toBe(1);
}

describe("R7-2 (P1) a bigger report after a closed surplus always leaves an open hold again", () => {
  it.each([
    ["1075-r2-01", "recorder", "recorder"],
    ["1075-r2-02", "recorder", "matched"],
    ["1075-r2-03", "matched", "recorder"],
    ["1075-r2-04", "matched", "matched"],
  ] as Array<[string, Door, Door]>)(
    "%s Rp50.000 hold closed, surplus Rp80.000 (%s door) closed, then signed X/T Rp90.000 (%s door): one open CONFLICT hold of Rp90.000, replays do not duplicate it, the closed holds stay closed, a new refund of Rp70.000 is refused",
    async (_id, door80, door90) => {
      const t = await world();
      await seedEchoFact(t.code, t.x);
      const factsBefore = await h.providerRows(t.code.id);

      // 1. X/T Rp50.000 (bigger than the echo fact): a CONFLICT hold, finance closes it.
      await h.replayAll(() => event("recorder", t.code, t.x, 50_000), 1);
      const first = await openConflictsOf(t.code);
      expect(
        amountsOf(first),
        `premise: one open conflict hold of Rp50.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
      ).toEqual([50_000]);
      const closedFirst = await h.resolveHold(first[0]!.id, "not_this_intent");
      expect(closedFirst.status, JSON.stringify(closedFirst.body)).toBe(200);
      expect(await h.openOf(t.code.id), "premise: nothing open").toEqual([]);

      // 2. X/T Rp80.000: a surplus hold of Rp80.000, finance closes it as well.
      await h.replayAll(() => event(door80, t.code, t.x, 80_000), 1);
      const second = await openConflictsOf(t.code);
      expect(
        amountsOf(second),
        `premise: one open surplus conflict hold of Rp80.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
      ).toEqual([80_000]);
      const closedSecond = await h.resolveHold(
        second[0]!.id,
        "not_this_intent",
      );
      expect(closedSecond.status, JSON.stringify(closedSecond.body)).toBe(200);
      expect(await h.openOf(t.code.id), "premise: nothing open again").toEqual(
        [],
      );
      expect(
        await conflictsOf(t.code),
        "premise: two closed conflict holds so far",
      ).toHaveLength(2);

      // 3. A NEW signed report X/T Rp90.000 and its replays.
      const callsBefore = h.fake.calls.length;
      await h.replayAll(() => event(door90, t.code, t.x, 90_000), 1);
      const afterFirst = await openConflictsOf(t.code);
      expect(
        amountsOf(afterFirst),
        `the Rp90.000 report leaves one open CONFLICT hold of the full Rp90.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
      ).toEqual([90_000]);

      await h.replayAll(() => event(door90, t.code, t.x, 90_000), 2);
      expect(
        amountsOf(await openConflictsOf(t.code)),
        "replays of the same evidence keep ONE open hold of Rp90.000",
      ).toEqual([90_000]);
      expect(
        await conflictsOf(t.code),
        "the two earlier holds stay closed and exactly one hold was added",
      ).toHaveLength(3);
      expect(
        (await conflictsOf(t.code)).filter((row) => row.resolved_at !== null),
        "only the two earlier holds are closed",
      ).toHaveLength(2);
      expect(await h.providerRows(t.code.id), "the fact is unchanged").toEqual(
        factsBefore,
      );

      // 4. nothing beyond may be paid while the hold is open.
      await expectNextRefundBlocked(t.code, callsBefore, "R7-2");
    },
  );

  it("1075-r2-05 control: the legitimate echo X/T Rp30.000 of R (both doors, replays) leaves no hold, and the rest of the bill (Rp70.000) can still be refunded", async () => {
    const t = await world();
    const holdsBefore = (await h.allHolds(t.code.id)).length;

    await h.replayAll(() => event("recorder", t.code, t.x, R_IDR), 2);
    await h.replayAll(() => event("matched", t.code, t.x, R_IDR), 2);
    expect(
      await h.allHolds(t.code.id),
      "an echo of our own refund files no hold",
    ).toHaveLength(holdsBefore);
    expect((await h.refundRow(t.refundId)).status).toBe("completed");

    const filed = await h.manualRefund(t.code.id, NEXT_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await h.expectMoneyWithinPaid(t.code, "r2-05");
  });
});
