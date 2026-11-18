// (brief 1103, SO refund ronde 10 finding F6 = refund 1101 F6, P2, tier K "jangan sampai
// rugi"): red-first tests, written from docs/qa/second-opinion-refund-ronde10-1101.md
// (finding 6), docs/briefs/1103-fix-refund-ronde10.md (CTO decision 1, last bullet: the
// mismatch hold gets a fixed key = hash of R + owning intent + T2) and the pattern of
// refund-1088-r3-no-refund-id-identity.test.ts, not from the implementation.
//
// Rule under test: a signed refund report keyed R (R belongs to T1) that names ANOTHER
// transaction T2 and carries no refund id of its own is ONE case, however many envelopes
// carry it. The identity of that hold is fixed (R, owner T1, T2), not the id of the stored
// event. Two holds for one report would let finance count both (the second as "separate"),
// booking Rp60.000 and two journal events for a single Rp30.000 report.
//
// Scenario (SO): T1 paid, R Rp30.000 completed (ref X), T2 paid. Report keyed R, payment T2,
// no refund id, Rp30.000, delivered in two envelopes with different ids.
//
// Rules pinned:
//   - two envelopes with the same payload: exactly ONE hold row on T2 (also when they race
//     on two connections, and after the poller and worker passed);
//   - a worker retry of a stored event adds no row;
//   - no provider fact and no `payment.provider_refunded` journal event on T2, none on T1;
//   - control: two reports that are provably different refunds (different provider ids Y1
//     and Y2, same key, same T2) stay two holds.
//
// Assumptions (the brief does not fix them):
//   - Run with the switch ON (matched door active, as refund-1088-r1b after brief 1103); the
//     switch-off door files conflict holds per stored event and is covered in
//     refund-1101-f2-f3-switch-off-matched-hold.test.ts.
//   - A readable amount is used (Rp30.000, as the SO), not the unreadable one of 1088-r3.
//   - "Provably different" = different provider refund ids; the amount may be equal.
//   - The hold sits on T2 (the transaction named by the payment object), as in 1088-r1b; none
//     is expected on T1.
//   - The control counts rows on T2: exactly one per distinct provider id.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1101-f6-mismatch-no-id-one-hold.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1101f6");

const R_IDR = 30_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them.
beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
  resetPaymentRefundGateways();
  registerPaymentRefundGateway(h.fake);
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
  setPaymentRefundGateway(null);
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

type World = { t1: Code; t2: Code; refundId: string };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, R_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  return { t1, t2, refundId: own.refundId };
}

/** Report keyed R, payment T2, Rp30.000; refund id only when given. New envelope each call. */
const envelope = (w: World, providerRefundId?: string) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    ...(providerRefundId === undefined ? {} : { id: providerRefundId }),
    idempotency_key: `refund:${w.refundId}`,
    payment_id: w.t2.providerRef,
    status: "succeeded",
    amount: R_IDR,
  },
});

async function send(body: object) {
  const answered = await h.deliver(body);
  expect(
    answered.status,
    `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
  await h.runWorker();
}

const markFailed = (eventId: string) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );

async function expectOneCase(w: World, label: string) {
  expect(
    (await h.allHolds(w.t2.id)).length,
    `${label}: ONE hold row on T2 (holds: ${JSON.stringify(await h.allHolds(w.t2.id))})`,
  ).toBe(1);
  expect(await h.providerRows(w.t2.id), `${label}: no fact on T2`).toEqual([]);
  expect(
    await h.refundEventsOfIntent(w.t2.id),
    `${label}: no journal event on T2`,
  ).toBe(0);
  expect(await h.allHolds(w.t1.id), `${label}: no hold on T1`).toHaveLength(0);
}

describe("F6 (P2) a mismatch report without refund id is one case, whatever the envelope", () => {
  it("1101-f6-01 the same payload in two different envelopes (sequential, with poller and worker rounds): one hold row on T2, no fact, no journal event", async () => {
    const w = await world();
    await send(envelope(w));
    expect((await h.openOf(w.t2.id)).length, "premise: held").toBe(1);
    await send(envelope(w));
    await h.replayAll(() => envelope(w), 1);
    await expectOneCase(w, "f6-01");
  });

  it("1101-f6-02 worker retry of a stored event after the hold committed, then a second envelope: still one hold row", async () => {
    const w = await world();
    const first = envelope(w);
    await send(first);
    expect((await h.openOf(w.t2.id)).length, "premise: held").toBe(1);

    await markFailed(first.id);
    await h.runWorker();
    await h.runWorker();
    await send(envelope(w));
    await expectOneCase(w, "f6-02");
  });

  it("1101-f6-03 two connections: two envelopes of the same payload at the same time: one hold row", async () => {
    const w = await world();
    const answers = await Promise.all([
      h.deliver(envelope(w)),
      h.deliver(envelope(w)),
    ]);
    for (const answer of answers)
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    await h.runWorker();
    await h.runWorker();
    await expectOneCase(w, "f6-03");
  });

  it("1101-f6-04 after finance closed the hold not_this_intent, another envelope of the same payload opens nothing", async () => {
    const w = await world();
    await send(envelope(w));
    const open = await h.openOf(w.t2.id);
    expect(open, "premise: one open hold").toHaveLength(1);
    const closed = await h.resolveHold(open[0]!.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    await send(envelope(w));
    await h.replayAll(() => envelope(w), 1);
    await expectOneCase(w, "f6-04");
    expect(await h.openOf(w.t2.id), "f6-04: nothing reopened").toHaveLength(0);
  });

  it("1101-f6-05 control: two reports with different provider ids Y1 and Y2 (same key, same T2, same amount) stay two holds", async () => {
    const w = await world();
    const y1 = `rf_${randomBytes(6).toString("hex")}`;
    const y2 = `rf_${randomBytes(6).toString("hex")}`;
    await send(envelope(w, y1));
    await send(envelope(w, y2));
    await h.replayAll(() => envelope(w, y1), 1);

    const holds = await h.allHolds(w.t2.id);
    expect(
      holds.length,
      `f6-05: one hold per distinct refund id (holds: ${JSON.stringify(holds)})`,
    ).toBe(2);
    expect(await h.providerRows(w.t2.id), "f6-05: no fact on T2").toEqual([]);
  });
});
