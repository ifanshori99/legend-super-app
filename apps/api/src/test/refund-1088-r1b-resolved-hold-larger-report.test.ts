// (brief 1090, architect review of round 9, P2, tier K "jangan sampai rugi"):
// a mismatch hold that finance already resolved must not swallow a LATER, LARGER
// report of the same identity (same key, provider refund id Y, payment T2).
// Today the unique provider key hits the resolved row and nothing is held, so
// the deposit credit and a refund of T2 are open again: more than Rp100.000
// could leave a payment of Rp100.000. The conflict door already holds such a
// report (I7 "larger than held"); the mismatch door must do the same.
//
// Rules pinned:
//   - after `not_this_intent` on the Rp30.000 hold, a report of the same identity
//     with an unreadable amount (the whole payment, Rp100.000) or a readable
//     larger amount opens one new hold on T2 (>= the reported amount), T2 cannot
//     be refunded, the provider is not asked;
//   - replays of that report and a smaller report of the same identity add no hold;
//   - T1 is untouched.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1088-r1b-resolved-hold-larger-report.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1088r1b");

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

const R1_IDR = 30_000;
const NEXT_IDR = 70_000;

type World = { t1: Code; t2: Code; refundId: string; y: string };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, R1_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  return {
    t1,
    t2,
    refundId: own.refundId,
    y: `rf_${randomBytes(6).toString("hex")}`,
  };
}

/** One stored report (one envelope id) keyed to R1, refund Y, payment T2. */
const report = (w: World, amount: unknown) => {
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  return () => ({
    id: eventId,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      id: w.y,
      idempotency_key: `refund:${w.refundId}`,
      payment_id: w.t2.providerRef,
      status: "succeeded",
      ...(amount === undefined ? {} : { amount }),
    },
  });
};

describe("R1b (P2) a resolved mismatch hold does not swallow a later larger report of the same identity", () => {
  it.each([
    ["1088-r1b-01", "non-canonical '80000.0'", "80000.0", BILL_IDR],
    ["1088-r1b-02", "missing", undefined, BILL_IDR],
    ["1088-r1b-03", "readable 80000", "80000", 80_000],
  ] as Array<[string, string, unknown, number]>)(
    "%s Rp30.000 hold on T2 resolved not_this_intent, then the same key/Y/T2 with amount %s: a new open hold, T2 blocked, replays and a smaller report add nothing",
    async (id, _label, amount, heldIdr) => {
      const w = await world();
      const callsBefore = h.fake.calls.length;

      await h.replayAll(report(w, R1_IDR), 1);
      const first = await h.openOf(w.t2.id);
      expect(first, `${id} premise: one open hold`).toHaveLength(1);
      expect(first[0]!.amount_idr).toBe(R1_IDR);
      const resolved = await h.resolveHold(first[0]!.id, "not_this_intent");
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(await h.openOf(w.t2.id), `${id} premise: closed`).toHaveLength(0);

      const later = report(w, amount);
      await h.replayAll(later, 1);
      const open = await h.openOf(w.t2.id);
      const holds = JSON.stringify(await h.allHolds(w.t2.id));
      expect(open, `${id}: one new open hold (holds: ${holds})`).toHaveLength(
        1,
      );
      expect(
        open[0]!.amount_idr,
        `${id}: the new hold covers the larger report (holds: ${holds})`,
      ).toBeGreaterThanOrEqual(heldIdr);
      const rowsAfterFirst = (await h.allHolds(w.t2.id)).length;

      // Replays and a smaller report of the same identity: nothing more.
      await h.replayAll(later, 2);
      await h.replayAll(report(w, amount), 1);
      await h.replayAll(report(w, R1_IDR), 1);
      expect(
        (await h.allHolds(w.t2.id)).length,
        `${id}: no further hold (${JSON.stringify(await h.allHolds(w.t2.id))})`,
      ).toBe(rowsAfterFirst);
      expect(
        await h.openOf(w.t2.id),
        `${id}: still one open hold`,
      ).toHaveLength(1);

      const filed = await h.manualRefund(w.t2.id, NEXT_IDR);
      if (filed.status === 201) {
        const approved = await h.approveRefund(filed.body.data.id as string);
        expect(
          [409, 422],
          `${id}: approving ${NEXT_IDR} on T2: ${JSON.stringify(approved.body)}`,
        ).toContain(approved.status);
      } else {
        expect([409, 422], `${id}: requesting on T2`).toContain(filed.status);
      }
      expect(h.fake.calls, `${id}: nothing reached the provider`).toHaveLength(
        callsBefore,
      );
      expect(await h.allHolds(w.t1.id), `${id}: no hold on T1`).toHaveLength(0);
    },
  );
});
