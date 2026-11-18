// (brief 1084 "Keputusan CTO", SO ronde 8 finding 2 = refund 1077 R2, P1, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde8-1077.md (finding 2), docs/briefs/1072-invarian.md
// (I3/I8) and the pattern of refund-1075-r3-matched-unproven-success.test.ts, not
// from the implementation.
//
// Rule under test (CTO decision): a signed refund report that names OUR refund R1 (by
// key) but a payment T2 of another intent, with an unreadable amount, must hold the
// WHOLE payment of the intent that owns T2 (Rp100.000), never the amount of R1 (a
// refund of another transaction). The rule limits payment: the guest may already have
// got Rp80.000 back from T2.
//
// Scenario: tenant and signer are the same. T1 Rp100.000 with R1 Rp30.000 completed
// (ref X1). T2 is another paid payment of Rp100.000 (the "DP", never refunded). Signed
// refund.succeeded keyed `refund:<R1>`, refund id Y, payment_id T2, amount unreadable
// ('80000.0') or missing.
//
// Rules pinned:
//   - one open hold on T2's intent worth exactly Rp100.000 (not Rp30.000);
//   - T2 cannot be refunded or applied any more: a refund of Rp70.000 on T2's intent is
//     refused (409/422 at request or at approve), nothing reaches the provider;
//   - replays (new event id, poller, worker) add no hold, no fact, no journal event;
//   - T1 is unaffected by T2's hold: no open hold on T1, R1 untouched, a refund of
//     the remaining Rp70.000 on T1 is still accepted and completes.
//
// Assumptions (the brief does not fix them):
//   - T2 is a payment-code intent of the same tenant and integration (the harness'
//     DOIT tenant). The DP credit read / transfer of a reservation-linked T2 needs the
//     reservation and session fixtures of the seeded tenant, which this webhook door
//     cannot use (see header of refund-1075-r1-hold-atomic-race); "DP credit zero,
//     apply Rp70.000 rejected" is observed through the refund of Rp70.000 on T2 being
//     refused, the same hold guard the credit apply reads. DP credit is it.todo.
//   - A hold of Rp30.000 (R1's amount) leaves Rp70.000 of T2 open, so the refund of
//     Rp70.000 is accepted today: that is the red.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1077-r2-mismatch-unreadable-amount.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1077r2");

const R1_IDR = 30_000;
const NEXT_IDR = 70_000;

type World = { t1: Code; t2: Code; refundId: string; x1: string };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, R1_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  expect(await h.allHolds(t1.id), "premise: no hold on T1").toHaveLength(0);
  expect(await h.allHolds(t2.id), "premise: no hold on T2").toHaveLength(0);
  return { t1, t2, refundId: own.refundId, x1: own.x };
}

/** Keyed to R1, a refund id Y of its own, payment T2. */
const mismatch = (w: World, amount: unknown) => {
  // A replay is the same stored event delivered again (worker retry, resend):
  // one event id and one provider refund id per report.
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  const refundIdY = `rf_${randomBytes(6).toString("hex")}`;
  return () => ({
    id: eventId,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      id: refundIdY,
      idempotency_key: `refund:${w.refundId}`,
      payment_id: w.t2.providerRef,
      status: "succeeded",
      ...(amount === undefined ? {} : { amount }),
    },
  });
};

describe("R2 (P1) refund of another transaction with an unreadable amount holds the whole payment of the owner intent", () => {
  it.each([
    ["1077-r2-01", "non-canonical '80000.0'", "80000.0"],
    ["1077-r2-02", "text 'eighty thousand'", "eighty thousand"],
    ["1077-r2-03", "missing", undefined],
  ] as Array<[string, string, unknown]>)(
    "%s R1 on T1, report keyed R1 but for T2, amount %s: one open hold of the whole Rp100.000 on T2, refund of Rp70.000 on T2 refused, replays add nothing, T1 unaffected",
    async (id, _label, amount) => {
      const w = await world();
      const factsT1 = await h.providerRows(w.t1.id);
      const factsT2 = await h.providerRows(w.t2.id);
      const eventsT1 = await h.refundEventsOfIntent(w.t1.id);
      const eventsT2 = await h.refundEventsOfIntent(w.t2.id);
      const callsBefore = h.fake.calls.length;

      const report = mismatch(w, amount);
      await h.replayAll(report, 1);

      const open = await h.openOf(w.t2.id);
      const holds = JSON.stringify(await h.allHolds(w.t2.id));
      expect(open, `${id}: one open hold on T2 (holds: ${holds})`).toHaveLength(
        1,
      );
      expect(
        open[0]!.amount_idr,
        `${id}: the whole payment of T2 is held, not R1's amount (holds: ${holds})`,
      ).toBe(BILL_IDR);
      const holdsAfterFirst = (await h.allHolds(w.t2.id)).length;

      await h.replayAll(report, 2);
      expect(
        (await h.allHolds(w.t2.id)).length,
        `${id}: replays add no hold (${JSON.stringify(await h.allHolds(w.t2.id))})`,
      ).toBe(holdsAfterFirst);
      expect(
        await h.openOf(w.t2.id),
        `${id}: still one open hold`,
      ).toHaveLength(1);
      expect(await h.providerRows(w.t2.id), `${id}: no fact on T2`).toEqual(
        factsT2,
      );
      expect(
        await h.refundEventsOfIntent(w.t2.id),
        `${id}: no journal event on T2`,
      ).toBe(eventsT2);

      // T2 cannot be refunded or spent any more.
      const filed = await h.manualRefund(w.t2.id, NEXT_IDR);
      if (filed.status === 201) {
        const approved = await h.approveRefund(filed.body.data.id as string);
        expect(
          [409, 422],
          `${id}: approving ${NEXT_IDR} on T2: ${JSON.stringify(approved.body)}`,
        ).toContain(approved.status);
      } else {
        expect(
          [409, 422],
          `${id}: requesting ${NEXT_IDR} on T2: ${JSON.stringify(filed.body)}`,
        ).toContain(filed.status);
      }
      expect(h.fake.calls, `${id}: nothing reached the provider`).toHaveLength(
        callsBefore,
      );

      // T1 is not touched by T2's hold.
      expect(await h.allHolds(w.t1.id), `${id}: no hold on T1`).toHaveLength(0);
      expect(await h.providerRows(w.t1.id), `${id}: no fact on T1`).toEqual(
        factsT1,
      );
      expect(
        await h.refundEventsOfIntent(w.t1.id),
        `${id}: no event on T1`,
      ).toBe(eventsT1);
      expect(
        await h.refundRow(w.refundId),
        `${id}: R1 untouched`,
      ).toMatchObject({
        status: "completed",
        amount_idr: String(R1_IDR),
        provider_ref: w.x1,
      });
      const rest = await h.manualRefund(w.t1.id, NEXT_IDR);
      expect(
        rest.status,
        `${id}: T1 still refundable: ${JSON.stringify(rest.body)}`,
      ).toBe(201);
      const restApproved = await h.approveRefund(rest.body.data.id as string);
      expect(
        restApproved.status,
        `${id}: T1 refund of the rest completes: ${JSON.stringify(restApproved.body)}`,
      ).toBe(200);
    },
  );

  it.todo(
    "1077-r2-04 DP credit read and transfer of a reservation-linked T2 are zero after the report, the credit apply of Rp70.000 is rejected, both lock orders (needs reservation and session fixtures in the DOIT-integration tenant; see header)",
  );
});
