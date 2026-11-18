// (brief 1090 "Keputusan CTO", SO refund ronde 9 finding 3 = refund 1088 R3, P2, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde9-1088.md (finding 3), docs/briefs/1072-invarian.md
// (I7/I8) and the pattern of refund-1077-r1-invalid-long-id.test.ts, not from the
// implementation.
//
// Rule under test (CTO decision): a signed refund report that carries NO refund id
// (and an unreadable or missing amount) is held under a FIXED identity derived from our
// refund R (the key `refund:<R>`), never from R's `providerRef`, which can appear later.
// One report = one hold, whatever happens to R in between and however the report is
// delivered again. Holds stored before the change keep deduplicating.
//
// Scenario (SO): R approved, already attempted (sent, the call timed out) but with
// `providerRef` NULL. Signed refund.succeeded keyed `refund:<R>`, payment T, no refund
// id, amount unreadable ('80000.0') or missing -> one hold (Rp100.000). A legit success
// with refund id X and the exact amount of R then completes R and stores providerRef = X.
// The SAME invalid report is delivered again with a new envelope id.
//
// Rules pinned:
//   - r3-01/02: the redelivery after providerRef = X opens NO second hold (still one row);
//   - r3-03/04: same, with the first hold already closed by finance (`not_this_intent`):
//     the redelivery reopens nothing, no new row;
//   - r3-05/06: worker retry of the SAME stored event after R got providerRef = X (the
//     process died after the hold committed and before the event was marked ignored):
//     no second hold;
//   - r3-07/08 (controls, green today): redelivery and worker retry while providerRef
//     is still NULL stay one hold; the legit success X of exact amount completes R;
//   - throughout: no fact booked by the invalid report, no `payment.provider_refunded`
//     journal event of its own, R completed Rp30.000 with ref X, the refund of the rest
//     is the only open money question.
//
// Assumptions (the brief does not fix them):
//   - The invalid report has no `id` in the refund object and no flat `refund_id`;
//     the key `refund:<R>` alone matches it to R (the SO scenario).
//   - "Attempted without providerRef" = the fake gateway threw on the payout of R
//     (harness `fake.enqueue("throw")`), R stays `approved` with a payout attempt.
//     The poller is never run in this file, so the fake provider cannot complete R
//     behind the test's back.
//   - The worker-retry seam (hold committed, event not yet marked ignored) is simulated
//     black-box: the stored event row is put back as `failed` (attempts 1, received 30
//     minutes ago), the state a worker retries (same pattern as
//     payment-recurring-reconcile.test.ts), then the harness worker runs.
//   - The legit success X arrives while the first hold is open and is expected to
//     complete R (the SO scenario); this is asserted as a premise.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1088-r3-no-refund-id-identity.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1088r3");

const R_IDR = 30_000;

type World = { code: Code; refundId: string; x: string };

/** T paid, R Rp30.000 approved, sent once (timeout), providerRef NULL. */
async function world(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const filed = await h.manualRefund(code.id, R_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  h.fake.enqueue("throw");
  const approved = await h.approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await h.refundRow(refundId);
  expect(row.provider_ref, "premise: no providerRef").toBeNull();
  expect(row.status, "premise: R not completed").toBe("approved");
  expect(row.payout_attempts, "premise: R was attempted").toBeGreaterThan(0);
  return { code, refundId, x: `rf_${randomBytes(6).toString("hex")}` };
}

/** The signed report without a refund id: keyed R, payment T, amount as given. */
const invalidReport = (w: World, amount: unknown, eventId?: string) => {
  const id = eventId ?? `evt_${randomBytes(8).toString("hex")}`;
  return {
    id,
    body: () => ({
      id,
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        object: "refund",
        idempotency_key: `refund:${w.refundId}`,
        payment_id: w.code.providerRef,
        status: "succeeded",
        ...(amount === undefined ? {} : { amount }),
      },
    }),
  };
};

/** The legit success of R: refund id X, exact amount of R, keyed R. */
const legitSuccess = (w: World) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    id: w.x,
    idempotency_key: `refund:${w.refundId}`,
    payment_id: w.code.providerRef,
    status: "succeeded",
    amount: R_IDR,
  },
});

/** Deliver and let the worker run; the poller is never used here. */
async function send(body: object) {
  const answered = await h.deliver(body);
  expect(
    answered.status,
    `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
  ).toBeLessThan(500);
  await h.runWorker();
}

async function firstHold(w: World, amount: unknown) {
  const first = invalidReport(w, amount);
  await send(first.body());
  const holds = JSON.stringify(await h.allHolds(w.code.id));
  const open = await h.openOf(w.code.id);
  expect(open, `premise: one open hold (holds: ${holds})`).toHaveLength(1);
  expect(open[0]!.amount_idr, "premise: whole payment held").toBe(BILL_IDR);
  expect((await h.allHolds(w.code.id)).length).toBe(1);
  return { first, hold: open[0]! };
}

/** A legit success X of exact amount completes R and stores providerRef = X. */
async function completeWithX(w: World) {
  await send(legitSuccess(w));
  expect(
    await h.refundRow(w.refundId),
    `premise: the legit success completes R with ref X (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
  ).toMatchObject({
    status: "completed",
    provider_ref: w.x,
    amount_idr: String(R_IDR),
  });
  expect(
    (await h.allHolds(w.code.id)).length,
    "premise: the legit success adds no hold",
  ).toBe(1);
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

async function expectStillOneHold(w: World, label: string) {
  const holds = JSON.stringify(await h.allHolds(w.code.id));
  expect(
    (await h.allHolds(w.code.id)).length,
    `${label}: still ONE hold row in total (holds: ${holds})`,
  ).toBe(1);
}

const AMOUNTS = (base: number): Array<[string, string, unknown]> => [
  [`1088-r3-0${base}`, "non-canonical '80000.0'", "80000.0"],
  [`1088-r3-0${base + 1}`, "missing", undefined],
];

describe("R3 (P2) a report without a refund id keeps one fixed identity whatever R's providerRef becomes", () => {
  it.each(AMOUNTS(1))(
    "%s invalid report (amount %s) held, legit success X completes R, the invalid payload redelivered with a new envelope id: still ONE hold, no fact, no journal event",
    async (id, _label, amount) => {
      const w = await world();
      await firstHold(w, amount);
      await completeWithX(w);
      const facts = await h.providerRows(w.code.id);
      const events = await h.refundEventsOfIntent(w.code.id);

      await send(invalidReport(w, amount).body());
      await send(invalidReport(w, amount).body());
      await expectStillOneHold(w, id);
      expect(
        await h.openOf(w.code.id),
        `${id}: the first hold is the only open one`,
      ).toHaveLength(1);
      expect(await h.providerRows(w.code.id), `${id}: no fact`).toEqual(facts);
      expect(
        await h.refundEventsOfIntent(w.code.id),
        `${id}: no journal event`,
      ).toBe(events);
    },
  );

  it.each(AMOUNTS(3))(
    "%s same, with the first hold already closed by finance (not_this_intent): the redelivery (amount %s) reopens nothing, no new row",
    async (id, _label, amount) => {
      const w = await world();
      const { hold } = await firstHold(w, amount);
      await completeWithX(w);
      const resolved = await h.resolveHold(hold.id, "not_this_intent");
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(await h.openOf(w.code.id), "premise: nothing open").toHaveLength(
        0,
      );

      await send(invalidReport(w, amount).body());
      await expectStillOneHold(w, id);
      expect(
        await h.openOf(w.code.id),
        `${id}: identical evidence after the decision holds nothing again`,
      ).toHaveLength(0);
    },
  );

  it.each(AMOUNTS(5))(
    "%s worker retry of the SAME stored event (amount %s) after R got providerRef = X and the hold had committed: no second hold",
    async (id, _label, amount) => {
      const w = await world();
      const first = invalidReport(w, amount);
      await send(first.body());
      expect(await h.openOf(w.code.id), "premise: one hold").toHaveLength(1);
      await completeWithX(w);

      await markFailed(first.id);
      await h.runWorker();
      await h.runWorker();
      await expectStillOneHold(w, id);
      expect(
        await h.openOf(w.code.id),
        `${id}: the retry opens no second case`,
      ).toHaveLength(1);
    },
  );

  it("1088-r3-07 control: worker retry of the same stored event and a redelivery while providerRef is still NULL stay one hold; the legit success X afterwards completes R", async () => {
    const w = await world();
    const first = invalidReport(w, "80000.0");
    await send(first.body());
    expect(await h.openOf(w.code.id), "premise: one hold").toHaveLength(1);

    await markFailed(first.id);
    await h.runWorker();
    await send(invalidReport(w, "80000.0").body());
    await expectStillOneHold(w, "r3-07");
    expect(await h.refundRow(w.refundId)).toMatchObject({
      status: "approved",
      provider_ref: null,
    });

    await completeWithX(w);
  });
});
