// (brief 1108, SO refund ronde 11 finding P1-1 = docs/qa/second-opinion-refund-ronde11-1107.md
// finding 1, P1, tier K "jangan sampai rugi"): red-first tests, written from that report,
// docs/briefs/1108-fix-refund-ronde11.md (CTO decision 1) and docs/briefs/1072-invarian.md
// (I1/I4/I7), with the pattern of refund-1101-f2-f3-switch-off-matched-hold.test.ts, not
// from the implementation.
//
// Rule under test (CTO decision 1, founder Q45: provider refunds are OFF in release 1):
// while the DOIT refund switch is off, EVERY signed refund success that matches a
// transaction of ours is hold-only, including the payment-object door (no key, no refund
// id; the payment id of the object is the transaction T), valid or invalid payload. One
// CONFLICT hold per stored event, then stop: no updater, no recorder, no fact, no journal
// event, no refund row, no change to R or to the intent.
//
// Scenario (SO): T paid Rp100.000, ONE refund R of Rp100.000 approved and waiting for
// finance (`payout_attempts = 0`, no provider ref), the switch off from the start. A signed
// `refund.succeeded` carries only the payment object:
//   invalid: { payment: { id: T, status: "refunded", amount: 100000, reference }, refund: { amount: "100000.0" } }
//   valid:   the same without the unreadable nested amount (or the flat payment object).
// Without a hold finance can still settle R by hand: Rp100.000 by the provider plus
// Rp100.000 by hand from a Rp100.000 payment.
//
// Rules pinned in every variant:
//   - after the event exactly ONE open hold exists with the conflict reason, no refund id,
//     worth at least the whole payment (Rp100.000);
//   - no provider fact, no `payment.provider_refunded` journal event, no outbox event of any
//     kind for the intent, no new refund row, the intent status is unchanged, the provider
//     is not asked; R stays approved with no provider ref and payout_attempts 0;
//   - settling R by hand is refused (not 200) while the hold is open, R stays approved;
//   - the same stored event delivered again, and a worker retry of it, add no hold row;
//   - a second envelope with the same payload leaves an open hold of the full value (the
//     row count is not pinned: per stored event);
//   - counted_against_intent on the conflict hold is refused 409 and leaves it open.
//
// Assumptions (the brief does not fix them):
//   - The payment object is built from the fake DOIT's payment of T (its reference is
//     whatever the fake assigned), with the nested and the flat shape (as
//     refund-1075-r3-matched-unproven-success.test.ts "r3-08").
//   - R is filed for the whole bill so a payment-object success is a plausible full refund
//     (the only shape the old fallback accepted). Approve answers 200 or 503 and R waits
//     for finance (as refund-1101-f2).
//   - "Intent unchanged" = payment_intents.status and no domain_event_outbox row whose
//     event text mentions the intent id appears.
//   - The two-connection test does not fix who wins: either the hold lands first and settle
//     is refused (R approved), or settle lands first (R completed by hand, no hold needed to
//     stop it); in both cases the event books no fact and no journal event and a conflict
//     hold of the full value is open.
//   - The switch-on control of this door is refund-1075-r3-matched-unproven-success.test.ts
//     (r3-08, unchanged); not repeated here.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1108-p1-1-switch-off-payment-object.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1108p11");

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them. The switch is OFF from the
// start in every test of this file; the fake port stays registered but fail-closed.
beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
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

type World = { code: Code; refundId: string; reference: string };

/** T paid Rp100.000, switch off, R of the whole bill approved and waiting for finance. */
async function world(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const filed = await h.manualRefund(code.id, BILL_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  const approved = await h.approveRefund(refundId);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect(
    await h.refundRow(refundId),
    "premise: R waits for finance",
  ).toMatchObject({
    status: "approved",
    provider_ref: null,
    payout_attempts: 0,
  });
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows T").toBeDefined();
  return { code, refundId, reference: payment!.reference };
}

const paymentObject = (w: World, amount: number) => ({
  id: w.code.providerRef,
  status: "refunded",
  amount,
  reference: w.reference,
});

/** A signed refund success that carries only the payment object; a new envelope per call. */
type Shape = (w: World) => Record<string, unknown>;
const shapes: Array<[string, Shape]> = [
  [
    "invalid: nested payment + unreadable refund amount '100000.0' (SO scenario)",
    (w) => ({
      payment: paymentObject(w, BILL_IDR),
      refund: { amount: "100000.0" },
    }),
  ],
  [
    "valid: nested payment only",
    (w) => ({ payment: paymentObject(w, BILL_IDR) }),
  ],
  [
    "valid: nested payment + readable refund amount 100000",
    (w) => ({
      payment: paymentObject(w, BILL_IDR),
      refund: { amount: BILL_IDR },
    }),
  ],
  [
    "valid: flat payment object (r3-08 shape)",
    (w) => ({
      ...h.doit.payments.get(w.code.providerRef)!,
      status: "refunded",
      amount: BILL_IDR,
    }),
  ],
  [
    "invalid: flat payment object + unreadable refund amount",
    (w) => ({
      ...h.doit.payments.get(w.code.providerRef)!,
      status: "refunded",
      amount: BILL_IDR,
      refund: { amount: "100000.0" },
    }),
  ],
];

const envelope = (w: World, data: Shape, eventId?: string) => ({
  id: eventId ?? `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: data(w),
});

async function send(body: object) {
  const answered = await h.deliver(body);
  expect(
    answered.status,
    `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
  await h.runWorker();
}

/** The state of a stored event the worker retries: the process died before it was marked. */
const markFailed = (eventId: string) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );

/** Everything a hold-only event must not change. */
async function ledger(w: World) {
  const intent = await h.owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, w.code.id],
  );
  return {
    facts: await h.providerRows(w.code.id),
    providerEvents: await h.refundEventsOfIntent(w.code.id),
    outbox: await h.count(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
      [h.tenantId, w.code.id],
    ),
    refunds: await h.refundRowCount(w.code.id),
    intentStatus: intent.rows[0]?.status,
    fakeCalls: h.fake.calls.length,
  };
}

async function expectUntouched(
  w: World,
  before: Awaited<ReturnType<typeof ledger>>,
  label: string,
) {
  expect(
    await ledger(w),
    `${label}: no fact, journal or outbox event, refund, intent change or provider call`,
  ).toEqual(before);
  expect(
    await h.refundRow(w.refundId),
    `${label}: R is untouched`,
  ).toMatchObject({
    status: "approved",
    provider_ref: null,
    payout_attempts: 0,
  });
}

const openConflicts = async (w: World) =>
  (await h.openOf(w.code.id)).filter(
    (row) => row.reason === HOLD_TRANSACTION_CONFLICT_REASON,
  );

describe("P1-1 (P1) while the switch is off the payment-object door is hold-only", () => {
  for (const [label, shape] of shapes) {
    it(`1108-p1-1-01 ${label}: one conflict hold of the full value, R and intent untouched, settle refused, replays add no row`, async () => {
      const w = await world();
      const before = await ledger(w);
      const first = envelope(w, shape);
      await send(first);

      const holds = JSON.stringify(await h.allHolds(w.code.id));
      const conflicts = await openConflicts(w);
      expect(
        conflicts,
        `one open conflict hold (holds: ${holds})`,
      ).toHaveLength(1);
      expect(
        conflicts[0]!.amount_idr,
        "the whole payment is held",
      ).toBeGreaterThanOrEqual(BILL_IDR);
      expect(
        conflicts[0]!.provider_refund_id,
        "the conflict hold carries no refund id",
      ).toBeNull();
      await expectUntouched(w, before, "first event");

      // Settling by hand would pay the guest a second time: refused while the hold is open.
      const settled = await h.settleManually(w.refundId, BILL_IDR);
      expect(
        settled.status,
        `settle is refused: ${JSON.stringify(settled.body)}`,
      ).not.toBe(200);
      await expectUntouched(w, before, "after refused settle");

      // The same stored event again, and a worker retry of it: no row more.
      const rows = (await h.allHolds(w.code.id)).length;
      await h.replayAll(() => first, 2);
      await markFailed(first.id);
      await h.runWorker();
      await h.runWorker();
      expect(
        (await h.allHolds(w.code.id)).length,
        "replay and worker retry of the same stored event add no hold row",
      ).toBe(rows);
      await expectUntouched(w, before, "after replays");

      // Counting a conflict hold is refused, it stays open.
      const counted = await h.resolveHold(
        conflicts[0]!.id,
        "counted_against_intent",
      );
      expect(
        counted.status,
        `counted on a conflict hold: ${JSON.stringify(counted.body)}`,
      ).toBe(409);
      expect(
        (await h.openOf(w.code.id)).some((row) => row.id === conflicts[0]!.id),
        "refused counted leaves it open",
      ).toBe(true);
      await expectUntouched(w, before, "after refused counted");
    });
  }

  it("1108-p1-1-02 a second envelope with the same payload (new event id) is held too: an open conflict hold of the full value, nothing booked", async () => {
    const w = await world();
    const before = await ledger(w);
    const [, shape] = shapes[0]!;
    await send(envelope(w, shape));
    expect(await openConflicts(w), "premise: held").toHaveLength(1);

    await send(envelope(w, shape));
    const conflicts = await openConflicts(w);
    expect(
      conflicts.some((row) => row.amount_idr >= BILL_IDR),
      `an open conflict hold of the full value (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBe(true);
    await expectUntouched(w, before, "second envelope");
    const settled = await h.settleManually(w.refundId, BILL_IDR);
    expect(settled.status, JSON.stringify(settled.body)).not.toBe(200);
  });

  it("1108-p1-1-03 the valid variant never completes R, never touches the intent and never publishes payment.refunded", async () => {
    const w = await world();
    const before = await ledger(w);
    const [, shape] = shapes[1]!;
    await h.replayAll(() => envelope(w, shape), 2);

    await expectUntouched(w, before, "valid payment-object success");
    expect(
      (await openConflicts(w)).length,
      "held, not silently ignored",
    ).toBeGreaterThanOrEqual(1);
    expect(
      await h.ourRefundedIdr(w.code.id),
      "our refunds not failed stay within what was paid",
    ).toBeLessThanOrEqual(BILL_IDR);
  });

  it("1108-p1-1-04 two connections: the invalid event and finance's settle at the same time never book a fact or a journal event, and a conflict hold of the full value ends open", async () => {
    const w = await world();
    const before = await ledger(w);
    const [, shape] = shapes[0]!;
    const event = envelope(w, shape);

    const [delivered, settled] = await Promise.all([
      h.deliver(event),
      h.settleManually(w.refundId, BILL_IDR),
    ]);
    expect(delivered.status, JSON.stringify(delivered.body)).toBeLessThan(500);
    expect(settled.status, JSON.stringify(settled.body)).toBeLessThan(500);
    await h.runWorker();
    await h.runWorker();
    await h.replayAll(() => event, 1);

    const after = await ledger(w);
    expect(after.facts, "no fact booked").toEqual(before.facts);
    expect(after.providerEvents, "no provider-refund journal event").toBe(
      before.providerEvents,
    );
    expect(after.fakeCalls, "the provider is not asked").toBe(before.fakeCalls);
    expect(after.refunds, "no refund row added").toBe(before.refunds);
    expect(
      (await h.refundRow(w.refundId)).status,
      "settle won (completed by hand) or the hold won (approved), nothing else",
    ).toBe(settled.status === 200 ? "completed" : "approved");
    expect(
      (await openConflicts(w)).some((row) => row.amount_idr >= BILL_IDR),
      `an open conflict hold of the full value (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBe(true);
    expect(
      await h.ourRefundedIdr(w.code.id),
      "never more than was paid",
    ).toBeLessThanOrEqual(BILL_IDR);
  });
});
