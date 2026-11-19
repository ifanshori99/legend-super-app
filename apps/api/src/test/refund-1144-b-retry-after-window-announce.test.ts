// (brief 1144, card 3, tier K "jangan sampai rugi"): tests for the retry that comes AFTER the
// 15 minute window, written from the 1139 decision (hold on first processing is silent; an
// open hold is told to finance exactly once) and on top of refund-1072-harness and
// refund-1119-support, not from the implementation.
//
// Rule under test: a signed refund success that maps to a Legend payment but matches no refund
// of ours is held on first processing (minute 0) and finance is NOT told yet (our own refund may
// still match). When the worker retries it after the window and it still matches nothing (the
// pass ends in `retry`, the row is marked failed), the hold is STILL OPEN, so finance gets
// exactly ONE supervisor alert ("Refund penyedia tidak cocok dengan refund Legend"). Later
// passes and replays add no second alert, no second hold, no fact, no refund. If finance closed
// the hold before, there is nothing to announce: no alert.
//
//   - 1144-b-01: flat success, switch on, hold open: one alert after the window, none more later.
//   - 1144-b-02: same with the switch off.
//   - 1144-b-03: payment object shape (data.payment + data.refund.amount), switch on.
//   - 1144-b-04: finance closed the hold (not_this_intent) before the retry: no alert at all.
//
// Assumptions (the brief does not fix them):
//   - How the `retry` outcome is produced: this file does not read the service code. The pass
//     after the window of an event that maps to T but matches no R of ours is what ends in
//     `retry` (same setup as 1139-a-06). If that pass turns out to end otherwise, the tests
//     still pin the user-visible rule (one alert, hold open, nothing booked).
//   - Minute N = received_at/updated_at moved back N minutes and the event put back as
//     `failed` (what the retry worker picks up), as in 1139.
//   - The alert is read as the notification titled as above, counted per recipient as a delta
//     (tests share one tenant), as in 1139-d.
//   - 1144-b-04: closing the hold with not_this_intent leaves the closed hold the only hold of
//     the event (one hold per stored event, stable key): the retry makes no new one.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1144-b-retry-after-window-announce.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";
import { flags, installSwitchHooks } from "./refund-1119-support";

// 1144-b-05 only: the recorder's `retry` that survives `force` is a race inside the service
// (the evidence of the payment moves to another intent between the read and the lock), which
// HTTP cannot reproduce. The recorder alone is forced to answer `retry` while `forceRetry` is
// set; everything else (webhook, worker, holds, alerts, DB) is the real code.
const recorder = vi.hoisted(() => ({ forceRetry: false }));
vi.mock("../services/payment-provider-partial-refund", async (original) => {
  const actual =
    await original<
      typeof import("../services/payment-provider-partial-refund")
    >();
  return {
    ...actual,
    recordProviderRefundInTx: (
      ...args: Parameters<typeof actual.recordProviderRefundInTx>
    ) =>
      recorder.forceRetry
        ? Promise.resolve({ status: "retry" as const })
        : actual.recordProviderRefundInTx(...args),
  };
});

const h = createRefundHarness("1144b");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;
const ALERT_TITLE = "Refund penyedia tidak cocok dengan refund Legend";

type World = { code: Code; reference: string };
type Shape = (w: World, amountIdr: number) => Record<string, unknown>;

const flatNoIdShape: Shape = (w, amountIdr) => ({
  payment_id: w.code.providerRef,
  amount: amountIdr,
});

const paymentObjectShape: Shape = (w, amountIdr) => ({
  payment: {
    id: w.code.providerRef,
    status: amountIdr >= BILL_IDR ? "refunded" : "partially_refunded",
    amount: amountIdr,
    reference: w.reference,
  },
  refund: { amount: amountIdr },
});

const envelope = (data: Record<string, unknown>) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data,
});

async function paidWorld(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows T").toBeDefined();
  return { code, reference: payment!.reference };
}

/** Alerts per recipient (one alert reaches every supervisor and owner once). */
const unmatchedAlerts = async () =>
  JSON.stringify(
    (
      await h.owner.query<{ user_id: string; n: string }>(
        `SELECT user_id::text AS user_id, count(*)::text AS n FROM notifications
          WHERE tenant_id = $1 AND title = $2 GROUP BY user_id ORDER BY user_id`,
        [h.tenantId, ALERT_TITLE],
      )
    ).rows,
  );

/** How many alerts were sent since `before`: the most any recipient received. */
const alertsSince = async (before: string) => {
  const was = new Map(
    (JSON.parse(before) as { user_id: string; n: string }[]).map((row) => [
      row.user_id,
      Number(row.n),
    ]),
  );
  const now = JSON.parse(await unmatchedAlerts()) as {
    user_id: string;
    n: string;
  }[];
  return Math.max(
    0,
    ...now.map((row) => Number(row.n) - (was.get(row.user_id) ?? 0)),
  );
};

/** Put the stored event back as the retry worker finds it, `minutes` after it was received. */
const ageEvent = (eventId: string, minutes: number) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - ($3::int * interval '1 minute'),
            updated_at = now() - ($3::int * interval '1 minute')
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId, minutes],
  );

/** Everything the retry must leave alone. */
async function ledger(w: World) {
  return {
    facts: await h.providerRows(w.code.id),
    providerEvents: await h.refundEventsOfIntent(w.code.id),
    outbox: await h.count(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
      [h.tenantId, w.code.id],
    ),
    refunds: await h.refundRowCount(w.code.id),
    fakeCalls: h.fake.calls.length,
  };
}

/** Minute 0: deliver the event, do NOT move received_at back. */
async function deliverNow(body: { id: string }) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
}

async function oneHold(w: World, label: string) {
  const holds = await h.allHolds(w.code.id);
  const dump = JSON.stringify(holds);
  expect(holds, `${label}: exactly ONE hold on T (${dump})`).toHaveLength(1);
  expect(holds[0]!.reason, `${label}: conflict reason`).toBe(
    HOLD_TRANSACTION_CONFLICT_REASON,
  );
  expect(holds[0]!.amount_idr, `${label}: the full reported value`).toBe(
    REPORT_IDR,
  );
  return holds[0]!;
}

async function openHoldThenRetryAfterWindow(
  label: string,
  shape: Shape,
  switchOn: boolean,
) {
  flags.DOIT_REFUNDS_ENABLED = switchOn;
  const w = await paidWorld();
  const alertsBefore = await unmatchedAlerts();
  const first = envelope(shape(w, REPORT_IDR));
  await deliverNow(first);

  // Minute 0: hold is open and silent.
  const held = await oneHold(w, `${label} minute 0`);
  expect(held.resolved_at, `${label}: open at minute 0`).toBeNull();
  expect(
    await alertsSince(alertsBefore),
    `${label}: no alert at minute 0 (silent hold)`,
  ).toBe(0);
  const booked = await ledger(w);

  // The pass after the window: still unmatched, so the hold is announced once.
  await ageEvent(first.id, 30);
  await h.runWorker();
  expect(
    await alertsSince(alertsBefore),
    `${label}: exactly one finance alert after the window`,
  ).toBe(1);

  // Worker again, a later pass and replays of the same event: no second alert.
  await h.runWorker();
  await ageEvent(first.id, 40);
  await h.runWorker();
  await h.replayAll(() => first, 2);
  await ageEvent(first.id, 50);
  await h.runWorker();
  expect(
    await alertsSince(alertsBefore),
    `${label}: replays and later passes add no alert`,
  ).toBe(1);

  const after = await oneHold(w, `${label} after replays`);
  expect(after.id, `${label}: the same hold`).toBe(held.id);
  expect(after.resolved_at, `${label}: the hold stays open`).toBeNull();
  expect(await ledger(w), `${label}: no fact, refund or call is added`).toEqual(
    booked,
  );
}

describe("1144 an open first-pass hold is announced once when the retry after the window ends in retry", () => {
  it("1144-b-01 flat success, switch on: no alert at minute 0, exactly ONE finance alert after the window, replays add none, hold stays open, nothing booked", async () => {
    await openHoldThenRetryAfterWindow("1144-b-01", flatNoIdShape, true);
  });

  it("1144-b-02 flat success, switch off: the same single alert, hold stays open", async () => {
    await openHoldThenRetryAfterWindow("1144-b-02", flatNoIdShape, false);
  });

  it("1144-b-03 payment object shape, switch on: the same single alert, hold stays open", async () => {
    await openHoldThenRetryAfterWindow("1144-b-03", paymentObjectShape, true);
  });

  it("1144-b-04 finance already closed the hold: the retry after the window sends no alert and books nothing", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const w = await paidWorld();
    const alertsBefore = await unmatchedAlerts();
    const first = envelope(flatNoIdShape(w, REPORT_IDR));
    await deliverNow(first);
    const held = await oneHold(w, "1144-b-04 minute 0");
    expect(held.resolved_at, "premise: open at minute 0").toBeNull();

    const closed = await h.resolveHold(held.id, "not_this_intent");
    expect(
      closed.status,
      `premise: finance closes the hold: ${JSON.stringify(closed.body)}`,
    ).toBe(200);
    expect(
      (await h.openOf(w.code.id)).map((row) => row.id),
      "premise: no hold is open any more",
    ).toEqual([]);
    const booked = await ledger(w);

    await ageEvent(first.id, 30);
    await h.runWorker();
    await h.runWorker();
    await h.replayAll(() => first, 2);

    expect(
      await alertsSince(alertsBefore),
      "1144-b-04: nothing open, so nothing to announce",
    ).toBe(0);
    expect(
      (await h.openOf(w.code.id)).map((row) => row.id),
      "1144-b-04: still no open hold",
    ).toEqual([]);
    const holds = await h.allHolds(w.code.id);
    expect(
      holds.map((hold) => hold.id),
      "1144-b-04: the closed hold is the only one (no new hold from the retry)",
    ).toEqual([held.id]);
    expect(await ledger(w), "1144-b-04: nothing booked or sent").toEqual(
      booked,
    );
  });
  it("1144-b-05 readable provider refund (refund id, payment, amount), the pass after the window ends in retry: exactly ONE finance alert, later passes and replays add none, hold stays open, row stays failed", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const w = await paidWorld();
    const alertsBefore = await unmatchedAlerts();
    const first = h.refundSucceededEvent(
      w.code.providerRef,
      `rf_ext_${randomBytes(6).toString("hex")}`,
      REPORT_IDR,
    );
    await deliverNow(first);

    // Minute 0: the hold is open and silent.
    const held = await oneHold(w, "1144-b-05 minute 0");
    expect(held.resolved_at, "1144-b-05: open at minute 0").toBeNull();
    expect(
      await alertsSince(alertsBefore),
      "1144-b-05: no alert at minute 0 (silent hold)",
    ).toBe(0);
    const booked = await ledger(w);

    // After the window the recorder asks for a retry even with `force`.
    recorder.forceRetry = true;
    try {
      await ageEvent(first.id, 30);
      await h.runWorker();
      expect(
        await alertsSince(alertsBefore),
        "1144-b-05: exactly one finance alert after the window",
      ).toBe(1);

      await h.runWorker();
      await ageEvent(first.id, 40);
      await h.runWorker();
      await h.replayAll(() => first, 2);
      await ageEvent(first.id, 50);
      await h.runWorker();
      expect(
        await alertsSince(alertsBefore),
        "1144-b-05: replays and later passes add no alert",
      ).toBe(1);
    } finally {
      recorder.forceRetry = false;
    }

    const after = await oneHold(w, "1144-b-05 after replays");
    expect(after.id, "1144-b-05: the same hold").toBe(held.id);
    expect(after.resolved_at, "1144-b-05: the hold stays open").toBeNull();
    const status = await h.owner.query<{ status: string }>(
      "SELECT status FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
      [h.tenantId, first.id],
    );
    expect(status.rows[0]?.status, "1144-b-05: the row stays failed").toBe(
      "failed",
    );
    expect(
      await ledger(w),
      "1144-b-05: no fact, refund or call is added",
    ).toEqual(booked);
  });
});
