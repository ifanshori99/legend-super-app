// (brief 1072 "Ronde 7" R7-3 = SO 1075 finding 3 + legend-55up0, P1, tier K "jangan
// sampai rugi"): red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md
// (Ronde 7) and docs/qa/second-opinion-refund-ronde7-1075.md (finding 3), with the
// pattern of refund-1072-a1-matched-echo-hold.test.ts and the sandbox event shapes of
// payment-doit-refund-webhook.test.ts, not from the implementation.
//
// Rule under test (CTO decision, R7-3): a signed success webhook that is matched to
// our refund R by the key `refund:<R>` but cannot be proven to be the echo of R must
// become an OPEN hold ("funds held is better than funds released"):
//  - the refund id in the event (Y) differs from the ref X of R, amount equal or
//    smaller than R;
//  - the amount is unreadable (not canonical, missing).
// The exception stays: a payment-object `refund.succeeded` (no refund id of its own,
// the payment id is NOT a refund id) completes R and keeps the ref X. And the
// legitimate echo (same ref X, same amount) settles R without any hold.
//
// Scenario: transaction T Rp100.000 (a payment code without sales document), R of
// Rp30.000 with ref X. If Y is a real second refund the guest got Rp30.000 + Rp30.000;
// without a hold the finance could still settle Rp70.000 by hand (Rp130.000 > paid).
//
// Assumptions (the brief does not fix them):
//  - Event shape = the DOIT sandbox refund object: `{ object: "refund", id: Y,
//    idempotency_key: "refund:<R>", payment_id: T, amount, status: "succeeded" }`
//    (as in payment-doit-refund-webhook.test.ts). The matched door picks R by the key.
//  - "open hold" = at least one open refund_recon_holds row of the intent worth at
//    least the reported amount (for an unreadable amount: just an open hold). The
//    reason text, the provider_refund_id kind and the exact amount of the hold are
//    not pinned. "held" is proven by the next refund of Rp70.000 being refused
//    (409/422, at request or approve) and port.refund not being called again.
//  - R is not touched by the foreign Y: it keeps status, amount and provider_ref X
//    (a completed R stays completed; a pending R is NOT settled with Y's report).
//  - Replays (new event id, same evidence) never duplicate the hold: the number of
//    hold rows after round 1 equals the number after two more rounds.
//  - No fabricated journal: the number of `payment.provider_refunded` events does not
//    grow (the report is not booked as a fact on this path; hold only).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1075-r3-matched-unproven-success.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1075r3");

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

/** Sandbox refund object matched to R by its idempotency key. */
const keyedSuccess = (
  code: Code,
  refundId: string,
  providerRefundId: string,
  amount: unknown,
) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    id: providerRefundId,
    idempotency_key: `refund:${refundId}`,
    payment_id: code.providerRef,
    status: "succeeded",
    ...(amount === undefined ? {} : { amount }),
  },
});

/** Bill Rp100.000 paid; our refund R of Rp30.000 completed (or in flight), ref X. */
async function world(inFlight = false) {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = inFlight
    ? await h.ownPendingRefund(code, R_IDR)
    : await h.ownCompletedRefund(code, R_IDR);
  return { code, ...own };
}

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

/**
 * The report is held: after round 1 an open hold worth at least `atLeast` exists
 * (`null` = any open hold), replays add no hold row, R keeps its identity, no fact is
 * invented, and the rest of the bill is blocked.
 */
async function expectHeld(
  t: { code: Code; refundId: string; x: string },
  makeEvent: () => object,
  atLeast: number | null,
  label: string,
  status: "completed" | "approved" = "completed",
) {
  const callsBefore = h.fake.calls.length;
  const eventsBefore = await h.refundEventsOfIntent(t.code.id);
  const factsBefore = await h.providerRows(t.code.id);

  await h.replayAll(makeEvent, 1);
  const open = await h.openOf(t.code.id);
  expect(
    atLeast === null
      ? open.length > 0
      : open.some((row) => row.amount_idr >= atLeast),
    `${label}: an open hold${atLeast === null ? "" : ` of at least ${atLeast}`} exists (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
  ).toBe(true);
  const holdsAfterFirst = (await h.allHolds(t.code.id)).length;

  await h.replayAll(makeEvent, 2);
  expect(
    (await h.allHolds(t.code.id)).length,
    `${label}: replays of the same evidence add no hold`,
  ).toBe(holdsAfterFirst);

  expect
    .soft(await h.refundRow(t.refundId), `${label}: R is not touched`)
    .toMatchObject({
      status,
      amount_idr: String(R_IDR),
      provider_ref: t.x,
    });
  expect(await h.providerRows(t.code.id), `${label}: no fact booked`).toEqual(
    factsBefore,
  );
  expect(
    await h.refundEventsOfIntent(t.code.id),
    `${label}: no fabricated provider-refund event`,
  ).toBe(eventsBefore);
  await expectNextRefundBlocked(t.code, callsBefore, label);
}

describe("R7-3 (P1) a matched success that is not provably the echo of our refund holds the intent", () => {
  it("1075-r3-01 R completed Rp30.000/X; signed refund.succeeded keyed refund:R but with refund id Y and the SAME amount Rp30.000: an open hold, R stays X/Rp30.000, replays add no hold, a new refund of Rp70.000 is refused", async () => {
    const t = await world();
    const y = `rf_${randomBytes(6).toString("hex")}`;
    await expectHeld(
      t,
      () => keyedSuccess(t.code, t.refundId, y, R_IDR),
      R_IDR,
      "r3-01",
    );
  });

  it("1075-r3-02 R completed Rp30.000/X; keyed refund:R, refund id Y, SMALLER amount Rp20.000: an open hold of at least Rp20.000, R stays, a new refund of Rp70.000 is refused", async () => {
    const t = await world();
    const y = `rf_${randomBytes(6).toString("hex")}`;
    await expectHeld(
      t,
      () => keyedSuccess(t.code, t.refundId, y, 20_000),
      20_000,
      "r3-02",
    );
  });

  it("1075-r3-03 R approved with ref X (in flight); keyed refund:R with refund id Y, amount Rp30.000: R is NOT settled with Y (still approved, ref X), an open hold, a new refund of Rp70.000 is refused", async () => {
    const t = await world(true);
    const y = `rf_${randomBytes(6).toString("hex")}`;
    await expectHeld(
      t,
      () => keyedSuccess(t.code, t.refundId, y, R_IDR),
      R_IDR,
      "r3-03",
      "approved",
    );
  });

  it.each([
    ["1075-r3-04", "non-canonical amount '80000.0'", "80000.0"],
    ["1075-r3-05", "text amount 'eighty thousand'", "eighty thousand"],
    ["1075-r3-06", "missing amount", undefined],
  ] as Array<[string, string, unknown]>)(
    "%s R completed Rp30.000/X; signed refund.succeeded for X/T with an unreadable amount (%s): an open hold (money held, not released), replays add no hold, a new refund of Rp70.000 is refused",
    async (_id, _label, amount) => {
      const t = await world();
      await expectHeld(
        t,
        () => ({
          id: `evt_${randomBytes(8).toString("hex")}`,
          type: "refund.succeeded",
          created_at: new Date().toISOString(),
          data: {
            refund_id: t.x,
            payment_id: t.code.providerRef,
            ...(amount === undefined ? {} : { amount }),
          },
        }),
        null,
        _id,
      );
    },
  );

  it("1075-r3-09 (P1) R completed Rp30.000/X; signed X/T success with an unreadable amount ('30000.0') is held (an open hold, the whole bill); finance resolves it not_this_intent; a valid signed X/T of Rp80.000 afterwards leaves an OPEN hold of Rp80.000 on X, a refund of Rp70.000 is refused, money out stays within the Rp100.000 paid", async () => {
    const t = await world();
    const callsBefore = h.fake.calls.length;
    const unreadable = () => ({
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        refund_id: t.x,
        payment_id: t.code.providerRef,
        amount: "30000.0",
      },
    });

    await h.replayAll(unreadable, 1);
    const first = await h.openOf(t.code.id);
    expect(
      first,
      `the unreadable report is held (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toHaveLength(1);
    expect(
      first[0]!.amount_idr,
      "an unreadable amount holds the whole bill",
    ).toBe(BILL_IDR);

    const resolved = await h.resolveHold(first[0]!.id, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(await h.openOf(t.code.id), "premise: nothing is open").toHaveLength(
      0,
    );

    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, 80_000),
      1,
    );
    const open = (await h.openOf(t.code.id)).filter(
      (row) => row.provider_refund_id === t.x,
    );
    expect(
      open,
      `a new valid report of Rp80.000 on X is held again, not swallowed by the resolved hold (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toHaveLength(1);
    expect(open[0]!.amount_idr).toBe(80_000);

    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, 80_000),
      2,
    );
    expect(
      (await h.openOf(t.code.id)).filter(
        (row) => row.provider_refund_id === t.x,
      ),
      "replays keep one open hold",
    ).toHaveLength(1);
    await expectNextRefundBlocked(t.code, callsBefore, "r3-09");
    expect(
      await h.count(
        `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM payment_refunds
          WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
        [h.tenantId, t.code.id],
      ),
      "completed money is only R",
    ).toBe(R_IDR);
  });

  it("1075-r3-10 (P3) R approved with NO provider ref (the provider call timed out); a signed success keyed refund:R carrying no refund id is not settled on trust: an open hold exists, R is not completed, a refund of Rp70.000 is refused and nothing more reaches the provider", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const filed = await h.manualRefund(code.id, R_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    h.fake.enqueue("throw");
    const approved = await h.approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const before = await h.refundRow(refundId);
    expect(before.provider_ref, "premise: R has no ref").toBeNull();
    expect(["completed", "failed"]).not.toContain(before.status);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () => ({
        id: `evt_${randomBytes(8).toString("hex")}`,
        type: "refund.succeeded",
        created_at: new Date().toISOString(),
        data: {
          object: "refund",
          idempotency_key: `refund:${refundId}`,
          payment_id: code.providerRef,
          status: "succeeded",
          amount: R_IDR,
        },
      }),
      1,
    );

    expect(
      (await h.openOf(code.id)).length,
      `an open hold exists (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThan(0);
    expect(
      (await h.refundRow(refundId)).status,
      "R is not settled by a success without any refund id",
    ).not.toBe("completed");
    const next = await h.manualRefund(code.id, NEXT_IDR);
    if (next.status === 201) {
      const answered = await h.approveRefund(next.body.data.id as string);
      expect(
        [409, 422],
        `approving ${NEXT_IDR}: ${JSON.stringify(answered.body)}`,
      ).toContain(answered.status);
    } else {
      expect(
        [409, 422],
        `requesting ${NEXT_IDR}: ${JSON.stringify(next.body)}`,
      ).toContain(next.status);
    }
    expect(h.fake.calls, "nothing more reached the provider").toHaveLength(
      callsBefore,
    );
  });

  it("1075-r3-07 control: the legitimate echo, keyed refund:R with the SAME ref X and amount Rp30.000, settles the in-flight R (completed, ref X) with no hold and no fact; replays add nothing; the rest of the bill can still be refunded", async () => {
    const t = await world(true);
    const holdsBefore = (await h.allHolds(t.code.id)).length;
    const factsBefore = await h.providerRows(t.code.id);
    const eventsBefore = await h.refundEventsOfIntent(t.code.id);

    await h.replayAll(() => keyedSuccess(t.code, t.refundId, t.x, R_IDR), 2);

    expect(await h.refundRow(t.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(R_IDR),
      provider_ref: t.x,
    });
    expect(
      await h.allHolds(t.code.id),
      "the echo of our own refund files no hold",
    ).toHaveLength(holdsBefore);
    expect(await h.providerRows(t.code.id), "no fact").toEqual(factsBefore);
    expect(await h.refundEventsOfIntent(t.code.id), "no event").toBe(
      eventsBefore,
    );
    const filed = await h.manualRefund(t.code.id, NEXT_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await h.expectMoneyWithinPaid(t.code, "r3-07");
  });

  it("1075-r3-08 control, payment-object fallback (legend-r7g2): refund.succeeded carrying only the payment object (its id is the PAYMENT id, no key, no refund id) completes the in-flight full refund R and keeps its ref X; no hold, no fact, replays add nothing", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    // Full refund (as in payment-doit-refund-webhook.test.ts "(b)"): the payment
    // object's amount is the whole bill.
    const own = await h.ownPendingRefund(code, BILL_IDR);
    const payment = h.doit.payments.get(code.providerRef);
    expect(payment, "premise: the fake DOIT knows the payment").toBeDefined();
    const holdsBefore = (await h.allHolds(code.id)).length;
    const factsBefore = await h.providerRows(code.id);
    const eventsBefore = await h.refundEventsOfIntent(code.id);

    await h.replayAll(
      () => ({
        id: `evt_${randomBytes(8).toString("hex")}`,
        type: "refund.succeeded",
        created_at: new Date().toISOString(),
        data: { ...payment!, status: "refunded", amount: BILL_IDR },
      }),
      2,
    );

    expect(await h.refundRow(own.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(BILL_IDR),
      provider_ref: own.x,
    });
    expect(
      await h.allHolds(code.id),
      "the payment id is not a refund id: no hold",
    ).toHaveLength(holdsBefore);
    expect(await h.providerRows(code.id), "no fact").toEqual(factsBefore);
    expect(await h.refundEventsOfIntent(code.id), "no event").toBe(
      eventsBefore,
    );
    await h.expectMoneyWithinPaid(code, "r3-08");
  });
});
