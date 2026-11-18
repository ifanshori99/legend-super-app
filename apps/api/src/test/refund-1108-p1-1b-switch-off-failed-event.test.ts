// (brief 1108, SO refund ronde 11 finding P1-1, failure half: the same switch-off rule for a
// signed `refund.failed` / refusal, tier K "jangan sampai rugi"): red-first tests, written
// from the P1-1 rule as stated in the task (while the DOIT refund switch is off, EVERY signed
// refund event that matches a refund of ours is hold-only, success or failure, every match
// kind, valid or invalid payload) and docs/briefs/1072-invarian.md (I1/I4/I7), with the
// pattern of refund-1108-p1-1-switch-off-payment-object.test.ts, not from the implementation.
//
// Rule under test (founder Q45: provider refunds are OFF in release 1): a signed failure
// that matches R by its key `refund:<R>`, by R's provider refund id, or by the payment
// object (the payment id is the transaction T) is NOT used to close R as failed. One
// CONFLICT hold per stored event, worth the whole payment (the DP credit stays cut by the
// full value), then stop: no updater, no recorder, no fact, no journal event, no refund
// row, no change to R or to the intent, no provider call.
//
// Two worlds (T paid Rp100.000, R of the whole bill):
//   "waiting":  switch off from the start, R approved and waiting for finance (no provider
//               ref, payout_attempts 0).
//   "in-flight": R sent while the switch was on (provider answered "pending" with ref X),
//               then the switch went off; R keeps its ref X and its status.
//
// Rules pinned in every variant:
//   - after the event exactly ONE open hold exists with the conflict reason, no refund id,
//     worth at least the whole payment (Rp100.000);
//   - no provider fact, no `payment.provider_refunded` journal event, no outbox event of any
//     kind for the intent, no new refund row, the intent status is unchanged, the provider
//     is not asked; R is exactly as before (never closed as failed);
//   - the same stored event delivered again (same event id), and a worker retry of it, add
//     no hold row;
//   - counted_against_intent on the conflict hold is refused 409 and leaves it open;
//   - waiting world only: settling R by hand is refused (not 200) while the hold is open.
//
// Assumptions (the brief does not fix them):
//   - "Valid" = a readable payload (`failure_code`, readable amount 100000 or no amount);
//     "invalid" = an unreadable amount "100000.0" (as the success tests).
//   - Payment-object failure shapes mirror the success ones of the p1-1 test (nested
//     `data.payment` and flat payment object, no key, no refund id) with payment status
//     "failed", built from the fake DOIT's payment of T. The spec does not define this shape
//     for failures; the rule says the gate holds the payment-object kind too.
//   - "DP stays cut in full" = the hold is worth at least the whole payment (Rp100.000).
//   - "One hold per stored event" is pinned for the same event id (replay, worker retry).
//     For a second envelope with another event id only "an open conflict hold of the full
//     value exists" is pinned, not the row count (as the p1-1 test).
//   - "R stays approved": in the waiting world R is approved/no ref/0 attempts; in the
//     in-flight world R must equal its row before the event and never be 'failed'.
//   - Worker retry of a stored event is simulated like the p1-1 test (event row put back as
//     `failed`, 30 minutes old, then the harness worker runs).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1108-p1-1b-switch-off-failed-event.test.ts" heavy pnpm test

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

const h = createRefundHarness("1108p11b");

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them. Each test starts with the
// switch OFF; the in-flight world flips it ON to send R and OFF again.
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

type World = {
  code: Code;
  refundId: string;
  reference: string;
  /** R's provider refund id: only in the in-flight world. */
  x: string | null;
  kind: "waiting" | "in-flight";
};

type RefundRow = Awaited<ReturnType<typeof h.refundRow>>;

/** T paid Rp100.000, switch off, R of the whole bill approved and waiting for finance. */
async function waitingWorld(): Promise<World> {
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
  return {
    code,
    refundId,
    reference: payment!.reference,
    x: null,
    kind: "waiting",
  };
}

/** T paid, R sent while the switch was on (pending, ref X), then the switch goes off. */
async function inFlightWorld(): Promise<World> {
  flags.DOIT_REFUNDS_ENABLED = true;
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownPendingRefund(code, BILL_IDR);
  flags.DOIT_REFUNDS_ENABLED = false;
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows T").toBeDefined();
  return {
    code,
    refundId: own.refundId,
    reference: payment!.reference,
    x: own.x,
    kind: "in-flight",
  };
}

const eventId = () => `evt_${randomBytes(8).toString("hex")}`;

/** Refund object keyed R and/or carrying R's provider id; a new envelope per call. */
const refundObject = (
  w: World,
  opts: { key: boolean; id: string | null | "made-up"; amount?: unknown },
) => ({
  object: "refund",
  ...(opts.id === null
    ? {}
    : {
        id:
          opts.id === "made-up"
            ? `rf_${randomBytes(6).toString("hex")}`
            : opts.id,
      }),
  ...(opts.key ? { idempotency_key: `refund:${w.refundId}` } : {}),
  payment_id: w.code.providerRef,
  status: "failed",
  failure_code: "declined",
  ...(opts.amount === undefined ? {} : { amount: opts.amount }),
});

const failedPaymentObject = (w: World) => ({
  id: w.code.providerRef,
  status: "failed",
  amount: BILL_IDR,
  reference: w.reference,
});

type Shape = (w: World) => Record<string, unknown>;
type Variant = { label: string; world: "waiting" | "in-flight"; shape: Shape };

const variants: Variant[] = [
  {
    label: "key refund:<R>, valid payload (failure_code), waiting",
    world: "waiting",
    shape: (w) => refundObject(w, { key: true, id: null }),
  },
  {
    label: "key refund:<R>, invalid payload (amount '100000.0'), waiting",
    world: "waiting",
    shape: (w) => refundObject(w, { key: true, id: null, amount: "100000.0" }),
  },
  {
    label: "key refund:<R> + made-up refund id, valid amount 100000, waiting",
    world: "waiting",
    shape: (w) =>
      refundObject(w, { key: true, id: "made-up", amount: BILL_IDR }),
  },
  {
    label: "payment object nested, valid, waiting",
    world: "waiting",
    shape: (w) => ({ payment: failedPaymentObject(w) }),
  },
  {
    label: "payment object nested + unreadable refund amount, waiting",
    world: "waiting",
    shape: (w) => ({
      payment: failedPaymentObject(w),
      refund: { amount: "100000.0" },
    }),
  },
  {
    label: "payment object flat, valid, waiting",
    world: "waiting",
    shape: (w) => ({
      ...h.doit.payments.get(w.code.providerRef)!,
      status: "failed",
      amount: BILL_IDR,
    }),
  },
  {
    label: "R's own refund id X (no key), valid payload, in-flight",
    world: "in-flight",
    shape: (w) => refundObject(w, { key: false, id: w.x, amount: BILL_IDR }),
  },
  {
    label:
      "R's own refund id X (no key), invalid payload (amount '100000.0'), in-flight",
    world: "in-flight",
    shape: (w) => refundObject(w, { key: false, id: w.x, amount: "100000.0" }),
  },
  {
    label: "key refund:<R> + id X, valid payload, in-flight",
    world: "in-flight",
    shape: (w) => refundObject(w, { key: true, id: w.x }),
  },
  {
    label: "key refund:<R> without refund id, invalid payload, in-flight",
    world: "in-flight",
    shape: (w) => refundObject(w, { key: true, id: null, amount: "100000.0" }),
  },
  {
    label: "payment object nested, valid, in-flight",
    world: "in-flight",
    shape: (w) => ({ payment: failedPaymentObject(w) }),
  },
];

const buildWorld = (kind: Variant["world"]) =>
  kind === "waiting" ? waitingWorld() : inFlightWorld();

const envelope = (w: World, shape: Shape, id: string = eventId()) => ({
  id,
  type: "refund.failed",
  created_at: new Date().toISOString(),
  data: shape(w),
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
const markFailed = (id: string) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, id],
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
  refundBefore: RefundRow,
  label: string,
) {
  expect(
    await ledger(w),
    `${label}: no fact, journal or outbox event, refund, intent change or provider call`,
  ).toEqual(before);
  const row = await h.refundRow(w.refundId);
  expect(row, `${label}: R is exactly as before`).toEqual(refundBefore);
  expect(row.status, `${label}: R is never closed as failed`).not.toBe(
    "failed",
  );
  expect(row.status, `${label}: R is never completed by the event`).not.toBe(
    "completed",
  );
}

const openConflicts = async (w: World) =>
  (await h.openOf(w.code.id)).filter(
    (row) => row.reason === HOLD_TRANSACTION_CONFLICT_REASON,
  );

describe("P1-1b (P1) while the switch is off a signed refund.failed is hold-only", () => {
  variants.forEach((variant, index) => {
    const nn = String(index + 1).padStart(2, "0");
    it(`1108-p1-1b-${nn} ${variant.label}: one conflict hold of the full value, R and intent untouched, replays add no row`, async () => {
      const w = await buildWorld(variant.world);
      const before = await ledger(w);
      const refundBefore = await h.refundRow(w.refundId);
      const first = envelope(w, variant.shape);
      await send(first);

      const holds = JSON.stringify(await h.allHolds(w.code.id));
      const conflicts = await openConflicts(w);
      expect(
        conflicts,
        `one open conflict hold (holds: ${holds})`,
      ).toHaveLength(1);
      expect(
        conflicts[0]!.amount_idr,
        "the whole payment is held (DP stays cut in full)",
      ).toBeGreaterThanOrEqual(BILL_IDR);
      expect(
        conflicts[0]!.provider_refund_id,
        "the conflict hold carries no refund id",
      ).toBeNull();
      await expectUntouched(w, before, refundBefore, "first event");

      if (w.kind === "waiting") {
        // Settling by hand would pay the guest while a hold is open: refused.
        const settled = await h.settleManually(w.refundId, BILL_IDR);
        expect(
          settled.status,
          `settle is refused: ${JSON.stringify(settled.body)}`,
        ).not.toBe(200);
        await expectUntouched(w, before, refundBefore, "after refused settle");
      }

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
      expect(
        await openConflicts(w),
        "still exactly one open conflict hold",
      ).toHaveLength(1);
      await expectUntouched(w, before, refundBefore, "after replays");

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
      await expectUntouched(w, before, refundBefore, "after refused counted");
    });
  });

  it("1108-p1-1b-12 a second failure envelope (new event id) is held too: an open conflict hold of the full value, nothing booked, R not failed", async () => {
    const w = await waitingWorld();
    const before = await ledger(w);
    const refundBefore = await h.refundRow(w.refundId);
    const shape = variants[0]!.shape;
    await send(envelope(w, shape));
    expect(await openConflicts(w), "premise: held").toHaveLength(1);

    await send(envelope(w, shape));
    const conflicts = await openConflicts(w);
    expect(
      conflicts.some((row) => row.amount_idr >= BILL_IDR),
      `an open conflict hold of the full value (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBe(true);
    await expectUntouched(w, before, refundBefore, "second envelope");
    const settled = await h.settleManually(w.refundId, BILL_IDR);
    expect(settled.status, JSON.stringify(settled.body)).not.toBe(200);
  });

  it("1108-p1-1b-13 a failure then a success event for the same R are both held: no fact, no journal event, R untouched, money within paid", async () => {
    const w = await waitingWorld();
    const before = await ledger(w);
    const refundBefore = await h.refundRow(w.refundId);

    await send(envelope(w, variants[0]!.shape));
    await send({
      id: eventId(),
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        ...refundObject(w, { key: true, id: "made-up", amount: BILL_IDR }),
        status: "succeeded",
      },
    });

    expect(
      (await openConflicts(w)).some((row) => row.amount_idr >= BILL_IDR),
      `an open conflict hold of the full value (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toBe(true);
    await expectUntouched(w, before, refundBefore, "failure then success");
    await h.expectMoneyWithinPaid(w.code, "failure then success");
  });
});
