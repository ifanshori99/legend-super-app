// (brief 1191 card 1 = legend-tbygu, tier K "jangan sampai rugi"): red-first tests, written
// from docs/briefs/1191-refund-hold-hardening.md and the sandbox event shapes of
// refund-1075-r3-matched-unproven-success.test.ts / payment-doit-refund-webhook.test.ts, on top
// of refund-1072-harness, not from the implementation.
//
// Rule under test: when the transaction is already CLOSED IN FULL by our own refund R (status
// `completed`), a later signed payment-object refund report that carries no refund id of its own
// (the payment id is not a refund id) and a NEW event id is the echo of R: no hold, no fact, no
// journal event, R untouched. An echo that cannot be shown to be only R stays an OPEN hold
// ("funds held is better than funds released"):
//  - the echo reports MORE than R recorded (exceeds R);
//  - the transaction is only partly closed by R (the echo may be a second refund);
//  - the echo is partial / its amount is unreadable (ambiguous).
//
// Today (base) the full-closure echo of a completed R files a CONFLICT hold at the second round
// (see 1075-r3-08 in refund-1075-r3-matched-unproven-success.test.ts: its round-2 expectation
// of "exactly one new hold" flips with this card; the engineer updates that test).
//
// Assumptions (the brief does not fix them):
//  - Event shape = payment object `{ ...payment, status, amount }` as in 1075-r3-08, delivered
//    as `refund.succeeded` (status "refunded") and as `payment.refunded` (`doit.eventFor`).
//  - "open hold" = at least one open refund_recon_holds row of the intent; reason text, amount and
//    kind are not pinned (except: a hold of an over-reporting echo is worth > 0).
//  - "held" is proven by the next refund of the remaining amount being refused (409/422, at
//    request or approve) and port.refund not being called again.
//  - A partial payment-object echo (`partially_refunded`, equal to R's amount) with R covering
//    only part of the bill is ambiguous: the payment id is not a refund id, so it is NOT proven
//    to be R, and it is held (brief: "Echo parsial/ambigu tetap hold").
//  - Cross-tenant: a second tenant with its own paid bill and NO refund of ours: its payment
//    echo is still held, and tenant A's closure by own refund neither suppresses it nor leaks
//    into it; an echo of A's payment delivered to B's URL changes nothing in A.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1191-a-echo-closed-by-own.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1191a");

// The active provider-refund path is off by default: switch it on, restore afterwards.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const PART_IDR = 30_000;
const REST_IDR = BILL_IDR - PART_IDR;

/** Payment-object report, no refund id of its own, NEW event id on every call. */
const paymentObjectEcho = (
  providerRef: string,
  opts: {
    type?: "refund.succeeded" | "payment.refunded";
    status?: string;
    amount?: unknown;
  } = {},
) => {
  const payment = h.doit.payments.get(providerRef);
  if (!payment) throw new Error(`premise: no fake DOIT payment ${providerRef}`);
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: opts.type ?? "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      ...payment,
      status: opts.status ?? "refunded",
      amount: opts.amount === undefined ? payment.amount : opts.amount,
    },
  };
};

async function paidBill() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  return code;
}

/** Snapshot of everything an echo must not change when it is only R's echo. */
async function snapshot(code: Code) {
  return {
    holds: (await h.allHolds(code.id)).length,
    facts: await h.providerRows(code.id),
    events: await h.refundEventsOfIntent(code.id),
    refunds: await h.refundRowCount(code.id),
  };
}

/** The remaining amount cannot be refunded and nothing more reaches the guest. */
async function expectNextRefundBlocked(
  code: Code,
  amountIdr: number,
  callsBefore: number,
  label: string,
) {
  const filed = await h.manualRefund(code.id, amountIdr);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${amountIdr}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect(
      [409, 422],
      `${label}: requesting ${amountIdr}: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(h.fake.calls, `${label}: port.refund not called again`).toHaveLength(
    callsBefore,
  );
}

const openHoldsOf = (code: Code) => h.openOf(code.id);

const UNMATCHED_ALERT_TITLE =
  "Refund penyedia tidak cocok dengan refund Legend";
const unmatchedAlertRows = async () =>
  (
    await h.owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1 AND title = $2",
      [h.tenantId, UNMATCHED_ALERT_TITLE],
    )
  ).rows[0]!.n;

describe("legend-tbygu echo of a refund of ours that closed the transaction", () => {
  it("1191-a-01 R of Rp100.000 completed, payment-object `refund.succeeded` echoes with new event ids: no hold, no fact, no journal event, R untouched; replays add nothing", async () => {
    const code = await paidBill();
    const own = await h.ownCompletedRefund(code, BILL_IDR);
    const before = await snapshot(code);

    await h.replayAll(() => paymentObjectEcho(code.providerRef), 3);

    expect(
      await openHoldsOf(code),
      "the echo of a refund of ours that closed the bill files no hold",
    ).toEqual([]);
    expect(await snapshot(code), "nothing else changed").toEqual(before);
    expect(await h.refundRow(own.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(BILL_IDR),
      provider_ref: own.x,
    });
    await h.expectMoneyWithinPaid(code, "a-01");
    // Nothing is left to refund and nothing new is sent to the guest.
    await expectNextRefundBlocked(
      code,
      1_000,
      h.fake.calls.length,
      "bill fully refunded",
    );
  });

  it("1191-a-02 same with the status event `payment.refunded` (payment object, no refund id): no hold, nothing booked", async () => {
    const code = await paidBill();
    const own = await h.ownCompletedRefund(code, BILL_IDR);
    const before = await snapshot(code);

    await h.replayAll(
      () => paymentObjectEcho(code.providerRef, { type: "payment.refunded" }),
      3,
    );

    expect(await openHoldsOf(code), "no hold").toEqual([]);
    expect(await snapshot(code), "no fact, no event, no new refund").toEqual(
      before,
    );
    expect((await h.refundRow(own.refundId)).status).toBe("completed");
    await h.expectMoneyWithinPaid(code, "a-02");
  });

  it("1191-a-03 R in flight (pending, ref X): the first echo completes it; the echoes after it (new event ids) file no hold", async () => {
    const code = await paidBill();
    const own = await h.ownPendingRefund(code, BILL_IDR);
    const before = await snapshot(code);

    await h.replayAll(() => paymentObjectEcho(code.providerRef), 3);

    expect(await h.refundRow(own.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(BILL_IDR),
      provider_ref: own.x,
    });
    expect(
      await openHoldsOf(code),
      "the later echoes of a completed full refund are not conflicts",
    ).toEqual([]);
    expect(await snapshot(code), "no fact, no event").toEqual(before);
    await h.expectMoneyWithinPaid(code, "a-03");
  });
});

describe("legend-tbygu money: an echo that is more than our refund stays held", () => {
  it("1191-a-04 R of Rp100.000 completed, but the report says Rp150.000 (more than R recorded and more than paid): an open hold, no fact booked, nothing more can be refunded", async () => {
    const code = await paidBill();
    await h.ownCompletedRefund(code, BILL_IDR);
    const callsBefore = h.fake.calls.length;
    const factsBefore = await h.providerRows(code.id);

    await h.replayAll(
      () => paymentObjectEcho(code.providerRef, { amount: 150_000 }),
      2,
    );

    const open = await openHoldsOf(code);
    expect(
      open.length,
      `an echo above R must be held (${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBeGreaterThanOrEqual(1);
    expect(open.every((hold) => hold.amount_idr > 0)).toBe(true);
    expect(await h.providerRows(code.id), "no fact is guessed").toEqual(
      factsBefore,
    );
    await expectNextRefundBlocked(
      code,
      1_000,
      callsBefore,
      "over-reporting echo",
    );
    await h.expectMoneyWithinPaid(code, "a-04");
  });

  it("1191-a-05 R of Rp30.000 completed (bill not closed): a payment-object echo saying the whole bill is refunded stays an open hold; the other Rp70.000 cannot be refunded; no fact", async () => {
    const code = await paidBill();
    await h.ownCompletedRefund(code, PART_IDR);
    const callsBefore = h.fake.calls.length;
    const factsBefore = await h.providerRows(code.id);

    await h.replayAll(() => paymentObjectEcho(code.providerRef), 2);

    expect(
      (await openHoldsOf(code)).length,
      `${JSON.stringify(await h.allHolds(code.id))}`,
    ).toBeGreaterThanOrEqual(1);
    expect(await h.providerRows(code.id), "no fact").toEqual(factsBefore);
    await expectNextRefundBlocked(code, REST_IDR, callsBefore, "part closed");
    await h.expectMoneyWithinPaid(code, "a-05");
  });

  it("1191-a-06 ambiguous: R of Rp30.000 completed, a partial payment-object echo (partially_refunded, Rp30.000) with no refund id is not proven to be R: open hold; Rp70.000 stays refused", async () => {
    const code = await paidBill();
    await h.ownCompletedRefund(code, PART_IDR);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () =>
        paymentObjectEcho(code.providerRef, {
          status: "partially_refunded",
          amount: PART_IDR,
        }),
      2,
    );

    expect(
      (await openHoldsOf(code)).length,
      `${JSON.stringify(await h.allHolds(code.id))}`,
    ).toBeGreaterThanOrEqual(1);
    await expectNextRefundBlocked(code, REST_IDR, callsBefore, "partial echo");
    await h.expectMoneyWithinPaid(code, "a-06");
  });

  it("1191-a-07 ambiguous: R of Rp100.000 completed, the echo's amount is unreadable: it cannot be shown not to exceed R, so it stays an open hold", async () => {
    const code = await paidBill();
    await h.ownCompletedRefund(code, BILL_IDR);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () => paymentObjectEcho(code.providerRef, { amount: "seratus ribu" }),
      2,
    );

    expect(
      (await openHoldsOf(code)).length,
      `${JSON.stringify(await h.allHolds(code.id))}`,
    ).toBeGreaterThanOrEqual(1);
    await expectNextRefundBlocked(code, 1_000, callsBefore, "unreadable echo");
    await h.expectMoneyWithinPaid(code, "a-07");
  });
});

describe("legend-tbygu another tenant", () => {
  it("1191-a-08 tenant A's bill closed by its own refund files no hold, while tenant B's bill (no refund of ours) with the same kind of echo is still held; A's echo delivered to B's URL changes nothing in A", async () => {
    const codeA = await paidBill();
    const ownA = await h.ownCompletedRefund(codeA, BILL_IDR);
    const billB = await h.other.paidBill(BILL_IDR);
    const beforeA = await snapshot(codeA);
    const echoA = () => paymentObjectEcho(codeA.providerRef);
    const echoB = () => paymentObjectEcho(billB.providerRef);

    await h.replayAll(echoA, 2);
    // Tenant B: nothing of ours closed this bill, so the same echo is a real conflict.
    for (let round = 0; round < 2; round += 1) {
      await h.other.deliver(billB.tenantId, echoB());
      await h.other
        .poll(billB.tenantId, new Date(Date.now() + 3 * 60 * 60_000))
        .catch(() => null);
    }
    // A's report arrives at B's URL: it names a payment B does not own.
    await h.other.deliver(billB.tenantId, echoA());

    expect(
      await openHoldsOf(codeA),
      "A: closed by its own refund, no hold",
    ).toEqual([]);
    expect(await snapshot(codeA), "A: nothing changed").toEqual(beforeA);
    expect((await h.refundRow(ownA.refundId)).status).toBe("completed");
    const holdsB = await h.other.holds(billB.tenantId, billB.intentId);
    expect(
      holdsB.filter((hold) => hold.resolved_at === null).length,
      `B: an echo with no refund of ours is held (${JSON.stringify(holdsB)})`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await h.count(
        "SELECT count(*)::text AS n FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id = $2",
        [h.tenantId, billB.intentId],
      ),
      "B's bill never produces a hold in A",
    ).toBe(0);
  });
});

describe("legend-tbygu the skip never hides a doubt (architect xhigh)", () => {
  it("1191-a-09 bill closed by R, but the report's reference names ANOTHER intent: still held, and finance is told of the reference mismatch", async () => {
    const code = await paidBill();
    const referenced = await paidBill();
    await h.ownCompletedRefund(code, BILL_IDR);
    const alertsBefore = (await h.supervisorAlertRows()).length;
    const referencedBefore = await snapshot(referenced);
    const callsBefore = h.fake.calls.length;

    const echo = paymentObjectEcho(code.providerRef);
    const wrong = {
      ...echo,
      data: { ...echo.data, reference: referenced.id },
    };
    expect([401, 403]).not.toContain((await h.deliver(wrong)).status);
    // The retry window passes; the worker replays the stored payload.
    await h.owner.query(
      `UPDATE gateway_webhook_events
          SET status = 'failed', last_error_code = 'REFUND_UNMATCHED', attempts = 1,
              received_at = now() - interval '30 minutes',
              updated_at = now() - interval '30 minutes'
        WHERE tenant_id = $1 AND event_id = $2`,
      [h.tenantId, wrong.id],
    );
    await h.runWorker();
    await h.runWorker();

    expect(
      (await openHoldsOf(code)).length,
      `${JSON.stringify(await h.allHolds(code.id))}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await h.supervisorAlertRows()).length,
      "the reference-mismatch alert still reaches finance",
    ).toBeGreaterThan(alertsBefore);
    expect(
      await snapshot(referenced),
      "the intent the reference names is untouched",
    ).toEqual(referencedBefore);
    await expectNextRefundBlocked(
      code,
      1_000,
      callsBefore,
      "reference mismatch",
    );
    await h.expectMoneyWithinPaid(code, "a-09");
  });

  it("1191-a-10 echo inside the retry window while no refund of ours is final (silent hold), then R completes and the event is retried after the window: the open hold is announced once, not skipped", async () => {
    const code = await paidBill();
    const own = await h.ownCompletedRefund(code, BILL_IDR);
    // R is not final when the echo arrives: it matches nothing, so the report is held, silently.
    await h.owner.query(
      "UPDATE payment_refunds SET status = 'failed' WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId],
    );
    const alertsBefore = Number(await unmatchedAlertRows());
    const echo = paymentObjectEcho(code.providerRef);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    const premise = await h.allHolds(code.id);
    expect(
      premise.filter((hold) => hold.resolved_at === null),
      `premise: one open silent hold (${JSON.stringify(premise)})`,
    ).toHaveLength(1);
    expect(
      Number(await unmatchedAlertRows()) - alertsBefore,
      "premise: nothing told inside the window",
    ).toBe(0);

    await h.owner.query(
      "UPDATE payment_refunds SET status = 'completed' WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId],
    );
    await h.owner.query(
      `UPDATE gateway_webhook_events
          SET status = 'failed', last_error_code = 'REFUND_UNMATCHED', attempts = 1,
              received_at = now() - interval '30 minutes',
              updated_at = now() - interval '30 minutes'
        WHERE tenant_id = $1 AND event_id = $2`,
      [h.tenantId, echo.id],
    );
    await h.runWorker();
    await h.runWorker();

    const holds = await h.allHolds(code.id);
    expect(
      holds.filter((hold) => hold.resolved_at === null),
      `the hold stays open (${JSON.stringify(holds)})`,
    ).toHaveLength(1);
    expect(
      Number(await unmatchedAlertRows()) - alertsBefore,
      "finance is told of the open hold once (one alert per recipient)",
    ).toBeGreaterThanOrEqual(1);
  });
});
