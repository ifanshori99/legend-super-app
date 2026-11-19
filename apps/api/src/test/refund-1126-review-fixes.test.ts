// 1126 architect review (tier K "jangan sampai rugi"): red-first tests for the review fixes of
// the unmatched-success hold (`holdUnmatchedRefundSuccess` in payment-webhook.service.ts).
// The more restrictive rule wins.
//
// Shape of every event here: signed `refund.succeeded`, no key, a payment object whose status is
// outside the wire enum (`partially_refunded`: the facts reader cannot read it as a whole, so the
// event is no candidate and no provider-initiated refund can be recorded) naming the Legend
// payment, plus a refund object. It matches no refund of ours and reaches the unmatched hold.
//
//   P1-1  a refund id already booked is no replay unless the fact is of the SAME intent and
//         transaction and covers the reported amount; else the report is held:
//         (a) same id booked on ANOTHER intent -> hold; (b) fact Rp10.000, report Rp100.000 ->
//         hold of Rp100.000; (c) fact of the same intent and ref, Rp30.000 >= report Rp30.000 ->
//         no hold (control).
//   P2-1  a hold of that refund id that finance resolved does not swallow a bigger report: a
//         new open hold for the surplus.
//   P3-1  an UNKNOWN refund status is held; only a known pending or failed status is skipped.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1126-review-fixes.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";
import {
  flags,
  installSwitchHooks,
  newId,
  recorderReport,
} from "./refund-1119-support";

const h = createRefundHarness("1126r");
installSwitchHooks(h, true);

async function paidCode(): Promise<Code> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  return code;
}

/** Signed refund.succeeded naming `code`'s payment through an unreadable payment object. */
function unmatchedEvent(
  code: Code,
  refund: { id?: string; amount: number; status?: string },
) {
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows the payment").toBeDefined();
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      payment: {
        id: code.providerRef,
        status: "partially_refunded",
        amount: BILL_IDR,
        reference: payment!.reference,
      },
      refund: {
        ...(refund.id === undefined ? {} : { id: refund.id }),
        amount: refund.amount,
        ...(refund.status === undefined ? {} : { status: refund.status }),
      },
    },
  };
}

/** The stored event put back as `failed` 30 minutes old: the worker retries it past the window. */
async function deliverPastWindow(body: { id: string }) {
  const answered = await h.deliver(body);
  expect([401, 403]).not.toContain(answered.status);
  await h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, body.id],
  );
  await h.runWorker();
  await h.runWorker();
}

const bookFact = async (code: Code, refundId: string, amountIdr: number) => {
  await h.replayAll(() => recorderReport(h, code, refundId, amountIdr), 1);
  expect(
    (await h.providerRows(code.id)).map((row) => [
      row.provider_refund_id,
      row.amount_idr,
    ]),
    "premise: the fact is booked",
  ).toEqual([[refundId, amountIdr]]);
};

describe("1126 review fixes: the unmatched hold", () => {
  it("1126-r1a (P1-1) the same refund id booked on ANOTHER intent is no replay: the report on T1 is held", async () => {
    const t1 = await paidCode();
    const t2 = await paidCode();
    const x = newId();
    await bookFact(t2, x, 30_000);
    await deliverPastWindow(unmatchedEvent(t1, { id: x, amount: 30_000 }));
    const holds = await h.allHolds(t1.id);
    expect(holds, JSON.stringify(holds)).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      resolved_at: null,
      reason: HOLD_TRANSACTION_CONFLICT_REASON,
      amount_idr: 30_000,
      provider_refund_id: x,
    });
    expect(await h.providerRows(t1.id), "no fact on T1").toEqual([]);
  });

  it("1126-r1b (P1-1) a fact of Rp10.000 does not cover a report of Rp100.000 on the same id: held for Rp100.000", async () => {
    const t1 = await paidCode();
    const x = newId();
    await bookFact(t1, x, 10_000);
    await deliverPastWindow(unmatchedEvent(t1, { id: x, amount: BILL_IDR }));
    const open = await h.openOf(t1.id);
    expect(open.map((row) => row.amount_idr)).toEqual([BILL_IDR]);
    expect(open[0]?.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
    expect(
      await h.providerRows(t1.id),
      "the fact of Rp10.000 is not rewritten",
    ).toHaveLength(1);
  });

  it("1126-r1c (P1-1) control: a fact of the same intent and transaction that covers the report is a replay: no hold", async () => {
    const t1 = await paidCode();
    const x = newId();
    await bookFact(t1, x, 30_000);
    await deliverPastWindow(unmatchedEvent(t1, { id: x, amount: 30_000 }));
    expect(await h.allHolds(t1.id), "a replay of booked money").toEqual([]);
  });

  it("1126-r2 (P2-1) a hold of the refund id that finance resolved does not swallow a bigger report: a new open hold for Rp100.000", async () => {
    const t1 = await paidCode();
    const x = newId();
    await deliverPastWindow(unmatchedEvent(t1, { id: x, amount: 10_000 }));
    const first = await h.openOf(t1.id);
    expect(first.map((row) => row.amount_idr)).toEqual([10_000]);
    const resolved = await h.resolveHold(first[0]!.id, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(await h.openOf(t1.id), "premise: nothing open").toEqual([]);

    await deliverPastWindow(unmatchedEvent(t1, { id: x, amount: BILL_IDR }));
    const open = await h.openOf(t1.id);
    expect(
      open.map((row) => row.amount_idr),
      `the surplus is held (holds: ${JSON.stringify(await h.allHolds(t1.id))})`,
    ).toEqual([BILL_IDR]);
    expect(open[0]?.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
  });

  it("1126-r3 (P3-1) an UNKNOWN refund status is held; a known pending or failed one is not", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const unknown = await paidCode();
    await deliverPastWindow(
      unmatchedEvent(unknown, { amount: 60_000, status: "weird_status" }),
    );
    expect(
      (await h.openOf(unknown.id)).map((row) => row.amount_idr),
      "unknown status: held",
    ).toEqual([60_000]);

    for (const status of ["pending", "failed"]) {
      const code = await paidCode();
      await deliverPastWindow(unmatchedEvent(code, { amount: 60_000, status }));
      expect(await h.allHolds(code.id), `${status}: no hold`).toEqual([]);
    }
  });
});
