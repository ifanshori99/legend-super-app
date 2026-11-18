// (brief 1108, SO refund ronde 11 finding P2 = docs/qa/second-opinion-refund-ronde11-1107.md
// finding 3, tier K "jangan sampai rugi"): red-first tests, written from that report,
// docs/briefs/1108-fix-refund-ronde11.md (CTO decision 3) and the pattern of
// refund-1101-f6-mismatch-no-id-one-hold.test.ts, not from the implementation.
//
// Rule under test (upgrade case): a mismatch report keyed R (R belongs to T1) that names
// ANOTHER transaction T2 and carries no refund id is one case per stored event. A build
// before 1103 keyed that hold by the stored event's own row id (`webhook_event_id` = the id
// of the `gateway_webhook_events` row). The current build keys it by a fixed identity. When
// the worker retries the SAME stored event E after an upgrade, it must find the hold the
// old build filed and use it, never open a second countable hold: finance could count both
// and book Rp60.000 and two journal events for one Rp30.000 report.
//
// Scenario (SO): T1 paid, R Rp30.000 completed (ref X), T2 paid. E = report keyed R, payment
// T2, no refund id, Rp30.000. H1 = the hold of E in the legacy key format. Worker retries E.
//
// Rules pinned:
//   - after the retry there is still exactly ONE hold row on T2 (the old one), none on T1;
//   - open H1: it is still the only open hold; resolved H1 (counted or not_this_intent):
//     nothing new opens;
//   - counted H1 (identity separate): the facts of T2 stay a single Rp30.000 and exactly one
//     `payment.provider_refunded` journal event exists for T2, also after the retry.
//
// Assumptions (the brief does not fix them):
//   - The legacy hold is built through the black box: the current build files H1 for E, then
//     the test rewrites H1's `webhook_event_id` to the stored event's row id (the key the
//     old build used, `013b83cec`). Column names come from the committed migration
//     0642_refund_recon_holds.sql. If the column is not what the old build used, the test's
//     premise assertion (`webhook_event_id` equals the stored row id) fails loudly.
//   - Worker retry of E is simulated as in refund-1101-f6 (event row put back as `failed`,
//     30 minutes old, then the harness worker runs), plus the same envelope delivered again.
//   - Counting H1 uses `identity: "separate"` (SO: "identity: separate"): no other fact of
//     T2 exists, so a single fact Rp30.000 is expected.
//   - (architect review) A NEW envelope E' of the same report arriving after the legacy hold
//     is a new stored event: the current build may file a hold for it. It must not be a
//     second COUNTABLE hold: every hold other than H1 must carry the conflict reason (finance
//     can close it only as not_this_intent, counted is refused 409), or H1 itself is raised.
//     Whichever the fix picks, the facts of T2 stay one Rp30.000 (or none) and at most one
//     journal event. This is pinned as "no countable second hold", not as a row count.
//   - Switch ON, as refund-1101-f6 (matched door active); the switch-off door files per
//     stored event and is covered in refund-1101-f2-f3 and refund-1108-p1-1.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1108-p2-legacy-hold-key-retry.test.ts" heavy pnpm test

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

const h = createRefundHarness("1108p2");

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

/** Report keyed R, payment T2, Rp30.000, no refund id. */
const envelope = (w: World) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
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

/**
 * E stored and held (H1), then H1 re-keyed to the stored event's row id: the state a build
 * before 1103 left behind. Returns the one hold row.
 */
async function legacyHold(w: World, event: ReturnType<typeof envelope>) {
  await send(event);
  const holds = await h.allHolds(w.t2.id);
  expect(
    holds,
    `premise: E filed exactly one hold on T2 (holds: ${JSON.stringify(holds)})`,
  ).toHaveLength(1);
  const stored = await h.owner.query<{ id: string }>(
    "SELECT id FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
    [h.tenantId, event.id],
  );
  expect(stored.rows, "premise: E is stored").toHaveLength(1);
  const rowId = stored.rows[0]!.id;
  const rekeyed = await h.owner.query<{ webhook_event_id: string }>(
    `UPDATE refund_recon_holds SET webhook_event_id = $3
      WHERE tenant_id = $1 AND id = $2
      RETURNING webhook_event_id`,
    [h.tenantId, holds[0]!.id, rowId],
  );
  expect(
    rekeyed.rows[0]?.webhook_event_id,
    "premise: H1 carries the legacy key (the stored event's row id)",
  ).toBe(rowId);
  return holds[0]!;
}

/** Retry of E after the upgrade: the worker on a failed row, then the same envelope again. */
async function retry(event: ReturnType<typeof envelope>) {
  await markFailed(event.id);
  await h.runWorker();
  await h.runWorker();
  await h.deliver(event);
  await h.runWorker();
}

describe("P2 (P2) a retried stored event finds the hold filed under the legacy key", () => {
  it("1108-p2-01 H1 open with the legacy key: the worker retry of E opens no second hold; H1 stays the one open hold; no fact, no journal event", async () => {
    const w = await world();
    const event = envelope(w);
    const h1 = await legacyHold(w, event);

    await retry(event);

    const holds = await h.allHolds(w.t2.id);
    expect(
      holds.map((row) => row.id),
      `one hold row, the old one (holds: ${JSON.stringify(holds)})`,
    ).toEqual([h1.id]);
    expect(await h.openOf(w.t2.id), "H1 is still open").toHaveLength(1);
    expect(await h.providerRows(w.t2.id), "no fact on T2").toEqual([]);
    expect(await h.refundEventsOfIntent(w.t2.id), "no journal event").toBe(0);
    expect(await h.allHolds(w.t1.id), "no hold on T1").toHaveLength(0);
  });

  it("1108-p2-02 H1 counted (identity separate) before the retry: the retry opens no second countable hold, the facts of T2 stay one Rp30.000 and one journal event", async () => {
    const w = await world();
    const event = envelope(w);
    const h1 = await legacyHold(w, event);
    const counted = await h.resolveHold(
      h1.id,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(
      await h.factAmounts(w.t2.id),
      "premise: one fact Rp30.000 from H1",
    ).toEqual([R_IDR]);
    expect(
      await h.refundEventsOfIntent(w.t2.id),
      "premise: one journal event",
    ).toBe(1);

    await retry(event);

    const holds = await h.allHolds(w.t2.id);
    expect(
      holds.map((row) => row.id),
      `still only H1, no second hold to count again (holds: ${JSON.stringify(holds)})`,
    ).toEqual([h1.id]);
    expect(await h.openOf(w.t2.id), "nothing open").toHaveLength(0);
    expect(await h.factAmounts(w.t2.id), "one fact of Rp30.000").toEqual([
      R_IDR,
    ]);
    expect(await h.refundEventsOfIntent(w.t2.id), "one journal event").toBe(1);
    await h.expectMoneyWithinPaid(w.t2, "p2-02");
  });

  it("1108-p2-03 H1 closed not_this_intent before the retry: the retry opens nothing", async () => {
    const w = await world();
    const event = envelope(w);
    const h1 = await legacyHold(w, event);
    const closed = await h.resolveHold(h1.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    await retry(event);

    const holds = await h.allHolds(w.t2.id);
    expect(
      holds.map((row) => row.id),
      `still only H1 (holds: ${JSON.stringify(holds)})`,
    ).toEqual([h1.id]);
    expect(await h.openOf(w.t2.id), "nothing reopened").toHaveLength(0);
    expect(await h.providerRows(w.t2.id), "no fact on T2").toEqual([]);
    expect(await h.refundEventsOfIntent(w.t2.id), "no journal event").toBe(0);
  });

  /** E' (new envelope, same report) after the legacy hold: no second countable hold. */
  async function expectNoSecondCountable(
    w: World,
    h1Id: string,
    facts: number[],
    events: number,
    label: string,
  ) {
    const holds = await h.allHolds(w.t2.id);
    const others = holds.filter((row) => row.id !== h1Id);
    for (const other of others)
      expect(
        other.reason,
        `${label}: a hold besides H1 is a conflict hold, never countable (holds: ${JSON.stringify(holds)})`,
      ).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
    for (const other of others.filter((row) => row.resolved_at === null)) {
      const counted = await h.resolveHold(
        other.id,
        "counted_against_intent",
        undefined,
        "separate",
      );
      expect(
        counted.status,
        `${label}: counting it is refused: ${JSON.stringify(counted.body)}`,
      ).toBe(409);
    }
    expect(await h.factAmounts(w.t2.id), `${label}: facts of T2`).toEqual(
      facts,
    );
    expect(
      await h.refundEventsOfIntent(w.t2.id),
      `${label}: journal events of T2`,
    ).toBe(events);
    expect(await h.allHolds(w.t1.id), `${label}: no hold on T1`).toHaveLength(
      0,
    );
    await h.expectMoneyWithinPaid(w.t2, label);
  }

  it("1108-p2-04 H1 open with the legacy key, then a NEW envelope E' of the same report: no second countable hold, no fact, no journal event", async () => {
    const w = await world();
    const h1 = await legacyHold(w, envelope(w));

    await send(envelope(w));
    await h.replayAll(() => envelope(w), 1);

    await expectNoSecondCountable(w, h1.id, [], 0, "p2-04");
  });

  it("1108-p2-05 H1 counted (separate) with the legacy key, then a NEW envelope E': no second countable hold, the facts stay one Rp30.000 and one journal event", async () => {
    const w = await world();
    const h1 = await legacyHold(w, envelope(w));
    const counted = await h.resolveHold(
      h1.id,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(await h.factAmounts(w.t2.id), "premise: one fact").toEqual([R_IDR]);

    await send(envelope(w));
    await h.replayAll(() => envelope(w), 1);

    await expectNoSecondCountable(w, h1.id, [R_IDR], 1, "p2-05");
  });

  it("1108-p2-06 H1 closed not_this_intent with the legacy key, then a NEW envelope E': no second countable hold, no fact, no journal event", async () => {
    const w = await world();
    const h1 = await legacyHold(w, envelope(w));
    const closed = await h.resolveHold(h1.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    await send(envelope(w));
    await h.replayAll(() => envelope(w), 1);

    await expectNoSecondCountable(w, h1.id, [], 0, "p2-06");
  });
});
