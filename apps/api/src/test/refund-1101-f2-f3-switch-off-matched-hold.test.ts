// (brief 1103, SO refund ronde 10 findings F2 and F3 = refund 1101 F2/F3, P1, tier K
// "jangan sampai rugi"; also the switch-off rule that closes F6's matched variants):
// red-first tests, written from docs/qa/second-opinion-refund-ronde10-1101.md (findings 2
// and 3), docs/briefs/1103-fix-refund-ronde10.md (CTO decision 1) and
// docs/briefs/1072-invarian.md (I1/I4/I7), with the pattern of
// refund-1088-r2-invalid-id-alias.test.ts, not from the implementation.
//
// Rule under test (CTO decision 1, founder Q45: provider refunds are OFF in release 1):
// while the DOIT refund switch is off, a signed success on the MATCHED door (matched by
// the key `refund:<R>`, by refund id, or after finance settled by hand; NOT the
// payment-object door) does not go through echo / made-up id / alias logic. Every stored
// event files one CONFLICT hold, with no refund id and the full value (the payment). A
// conflict hold closes only as `not_this_intent` and books NO fact, NO journal event,
// NO refund and NO provider call. So an old closed hold can never swallow a later report,
// whatever ids the reports carry.
//
// Scenarios:
//   F2: reports keyed R whose id is the literal `refund:<R>` and reports keyed R with no
//       refund id; finance closes the first, the second must still be held (both orders).
//   F3: a hold from a report that names the real provider id X of R (X is R's own ref) is
//       closed; a later report keyed R without a refund id must still be held.
//   off-*: the generic rule, also for an exact echo of R and for R settled by hand.
//
// Rules pinned in every case:
//   - the later (second) report leaves an OPEN hold worth at least the whole payment
//     (Rp100.000, "nilai penuh") on T, whatever the amount of the report;
//   - no provider fact, no `payment.provider_refunded` journal event, no new refund row;
//     R is untouched (completed Rp20.000 with ref X); the provider is not asked;
//   - settling R2 (Rp80.000, queued for finance) by hand is refused (not 200) while a
//     hold is open, and R2 stays approved;
//   - the same stored event delivered again or retried by the worker adds no hold row;
//   - counted_against_intent on the conflict hold is refused 409, not_this_intent is 200.
//
// Assumptions (the brief does not fix them):
//   - The switch is flipped OFF after R completed through the fake port (R completed
//     "before the switch went off", SO scenario); the fake port stays registered but
//     fail-closed (as refund-1088-r2). R2 then waits for finance (approve answers 200 or 503).
//   - "Full value" = at least the payment of T (Rp100.000), also for a readable amount or
//     an exact echo (CTO: `max(intent, evidence)`). The reason text is not pinned except
//     in `off-*`, where the open hold is the HOLD_TRANSACTION_CONFLICT_REASON row.
//   - Worker retry of a stored event is simulated like refund-1088-r3 (event row put back
//     as `failed`, 30 minutes old, then the harness worker runs).
//   - A second DIFFERENT envelope carrying the same payload files its own hold (per stored
//     event) or raises the open one; only "an open hold of the full value exists" is pinned
//     for it, not the row count.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1101-f2-f3-switch-off-matched-hold.test.ts" heavy pnpm test

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

const h = createRefundHarness("1101f2");

const R_IDR = 20_000;
const R2_IDR = 80_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them. Each test starts with the
// switch ON (to complete R) and flips it OFF itself.
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

type World = { code: Code; refundId: string; x: string; r2: string };

/** T paid, R Rp20.000 completed (ref X), switch OFF, R2 Rp80.000 approved and waiting. */
async function world(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(code, R_IDR);
  flags.DOIT_REFUNDS_ENABLED = false;
  const filed = await h.manualRefund(code.id, R2_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const r2 = filed.body.data.id as string;
  const approved = await h.approveRefund(r2);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect((await h.refundRow(r2)).status, "premise: R2 waits for finance").toBe(
    "approved",
  );
  return { code, refundId: own.refundId, x: own.x, r2 };
}

/** One stored report (fixed envelope id) keyed R, payment T; `id` omitted when undefined. */
const keyed = (w: World, id: string | undefined, amount?: unknown) => {
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  return {
    eventId,
    body: () => ({
      id: eventId,
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        object: "refund",
        ...(id === undefined ? {} : { id }),
        idempotency_key: `refund:${w.refundId}`,
        payment_id: w.code.providerRef,
        status: "succeeded",
        ...(amount === undefined ? {} : { amount }),
      },
    }),
  };
};

/** Deliver one body and let the worker run; the poller is not needed here. */
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

/** Everything a conflict hold must not change. */
async function ledger(w: World) {
  return {
    facts: await h.providerRows(w.code.id),
    events: await h.refundEventsOfIntent(w.code.id),
    refunds: await h.refundRowCount(w.code.id),
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
    `${label}: no fact, journal event, refund or provider call`,
  ).toEqual(before);
  expect(
    await h.refundRow(w.refundId),
    `${label}: R is untouched`,
  ).toMatchObject({
    status: "completed",
    amount_idr: String(R_IDR),
    provider_ref: w.x,
  });
}

const openOfFullValue = async (w: World) =>
  (await h.openOf(w.code.id)).filter((row) => row.amount_idr >= BILL_IDR);

/** Settle of R2 is refused while a hold is open, R2 stays approved. */
async function expectSettleRefused(w: World, label: string) {
  const settled = await h.settleManually(w.r2, R2_IDR);
  expect(
    settled.status,
    `${label}: settle of R2 is refused: ${JSON.stringify(settled.body)}`,
  ).not.toBe(200);
  expect((await h.refundRow(w.r2)).status, `${label}: R2 stays approved`).toBe(
    "approved",
  );
}

/** First report held and closed by finance; the second must still be held. */
async function closedThenLater(
  id: string,
  w: World,
  firstId: string | undefined,
  secondId: string | undefined,
  amount: unknown,
) {
  const before = await ledger(w);
  const first = keyed(w, firstId, amount);
  await send(first.body());
  const open1 = await h.openOf(w.code.id);
  expect(
    open1,
    `${id} premise: one open hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
  ).toHaveLength(1);
  expect(
    open1[0]!.amount_idr,
    `${id} premise: the whole payment is held`,
  ).toBeGreaterThanOrEqual(BILL_IDR);
  const closed = await h.resolveHold(open1[0]!.id, "not_this_intent");
  expect(
    closed.status,
    `${id} premise: finance closes it: ${JSON.stringify(closed.body)}`,
  ).toBe(200);
  expect(await h.openOf(w.code.id), `${id} premise: nothing open`).toHaveLength(
    0,
  );

  const second = keyed(w, secondId, amount);
  await send(second.body());
  const holds = JSON.stringify(await h.allHolds(w.code.id));
  expect(
    await openOfFullValue(w),
    `${id}: the second report is held again, not swallowed by the closed one (holds: ${holds})`,
  ).toHaveLength(1);
  await expectUntouched(w, before, id);
  await expectSettleRefused(w, id);

  // The same stored event again, and a worker retry of it: no row more.
  const rows = (await h.allHolds(w.code.id)).length;
  await send(second.body());
  await markFailed(second.eventId);
  await h.runWorker();
  await h.runWorker();
  expect(
    (await h.allHolds(w.code.id)).length,
    `${id}: replay and worker retry of the same stored event add no hold row`,
  ).toBe(rows);
  await expectUntouched(w, before, `${id} after replays`);
}

describe("F2 (P1) a literal `refund:<R>` id and a report without refund id never absorb each other", () => {
  const amounts: Array<[string, unknown]> = [
    ["unreadable '80000.0'", "80000.0"],
    ["readable 80000", 80_000],
  ];
  for (const [label, amount] of amounts) {
    it(`1101-f2-01 literal id \`refund:<R>\` held and closed, then a report keyed R with no refund id (amount ${label}): held again`, async () => {
      const w = await world();
      await closedThenLater(
        "1101-f2-01",
        w,
        `refund:${w.refundId}`,
        undefined,
        amount,
      );
    });

    it(`1101-f2-02 reverse order: report with no refund id held and closed, then literal id \`refund:<R>\` (amount ${label}): held again`, async () => {
      const w = await world();
      await closedThenLater(
        "1101-f2-02",
        w,
        undefined,
        `refund:${w.refundId}`,
        amount,
      );
    });
  }
});

describe("F3 (P1) a hold that named X never covers a later report without refund id", () => {
  it("1101-f3-01 hold of an invalid report that names X (R's own provider id) closed not_this_intent, then an invalid report keyed R with no refund id: held again, settle of R2 refused", async () => {
    const w = await world();
    await closedThenLater("1101-f3-01", w, w.x, undefined, "80000.0");
  });

  it("1101-f3-02 same with a readable amount on both reports", async () => {
    const w = await world();
    await closedThenLater("1101-f3-02", w, w.x, undefined, 80_000);
  });

  it("1101-f3-03 control: ONE report without refund id stays one hold on worker retry and on redelivery of the same stored event", async () => {
    const w = await world();
    const first = keyed(w, undefined, "80000.0");
    await send(first.body());
    expect(await h.openOf(w.code.id), "premise: one hold").toHaveLength(1);

    await markFailed(first.eventId);
    await h.runWorker();
    await h.runWorker();
    await send(first.body());
    expect(
      (await h.allHolds(w.code.id)).length,
      "f3-03: still one hold row",
    ).toBe(1);
  });
});

describe("off: the matched door while the switch is off files conflict holds only", () => {
  it("1101-off-01 an exact echo of R (id X, Rp20.000, keyed R) is held as a conflict of the full value, not treated as an echo; counted is refused 409, not_this_intent closes it; no fact, no journal event, no refund", async () => {
    const w = await world();
    const before = await ledger(w);
    const echo = keyed(w, w.x, R_IDR);
    await send(echo.body());

    const conflicts = (await h.openOf(w.code.id)).filter(
      (row) => row.reason === HOLD_TRANSACTION_CONFLICT_REASON,
    );
    expect(
      conflicts,
      `off-01: one open conflict hold (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
    ).toHaveLength(1);
    expect(
      conflicts[0]!.amount_idr,
      "off-01: the full value is held",
    ).toBeGreaterThanOrEqual(BILL_IDR);
    expect(
      conflicts[0]!.provider_refund_id,
      "off-01: the conflict hold carries no refund id",
    ).toBeNull();
    await expectUntouched(w, before, "off-01");
    await expectSettleRefused(w, "off-01");

    const rows = (await h.allHolds(w.code.id)).length;
    await h.replayAll(echo.body, 2);
    expect(
      (await h.allHolds(w.code.id)).length,
      "off-01: the same stored event adds no row",
    ).toBe(rows);

    const counted = await h.resolveHold(
      conflicts[0]!.id,
      "counted_against_intent",
    );
    expect(
      counted.status,
      `off-01: counted on a conflict hold: ${JSON.stringify(counted.body)}`,
    ).toBe(409);
    expect(
      (await h.allHolds(w.code.id)).find((row) => row.id === conflicts[0]!.id)!
        .resolved_at,
      "off-01: refused counted leaves it open",
    ).toBeNull();
    await expectUntouched(w, before, "off-01 after refused counted");

    const closed = await h.resolveHold(conflicts[0]!.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await expectUntouched(w, before, "off-01 after not_this_intent");
  });

  it("1101-off-02 R settled by hand by finance (switch off from the start), then a signed success keyed R with a provider id: one open conflict hold, no fact, no journal event, R stays completed, the provider is not asked", async () => {
    flags.DOIT_REFUNDS_ENABLED = false;
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const filed = await h.manualRefund(code.id, 30_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    expect([200, 503]).toContain((await h.approveRefund(refundId)).status);
    const settled = await h.settleManually(refundId, 30_000);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await h.refundRow(refundId)).status).toBe("completed");
    const facts = await h.providerRows(code.id);
    const events = await h.refundEventsOfIntent(code.id);
    const calls = h.fake.calls.length;

    const success = {
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "refund.succeeded",
      created_at: new Date().toISOString(),
      data: {
        object: "refund",
        id: `rf_${randomBytes(6).toString("hex")}`,
        idempotency_key: `refund:${refundId}`,
        payment_id: code.providerRef,
        status: "succeeded",
        amount: 30_000,
      },
    };
    await send(success);
    const open = await h.openOf(code.id);
    expect(
      open,
      `off-02: one open hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toHaveLength(1);
    expect(open[0]!.amount_idr).toBeGreaterThanOrEqual(BILL_IDR);
    expect(await h.providerRows(code.id), "off-02: no fact").toEqual(facts);
    expect(
      await h.refundEventsOfIntent(code.id),
      "off-02: no journal event",
    ).toBe(events);
    expect((await h.refundRow(refundId)).status).toBe("completed");
    expect(h.fake.calls, "off-02: nothing reached the provider").toHaveLength(
      calls,
    );
  });
});
