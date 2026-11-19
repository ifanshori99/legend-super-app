// (brief 1144 round 2, bead legend-om9q2, tier K "jangan sampai rugi"): red-first tests, written
// from the CTO rule in the scratchpad (1144-shared.md, "Putaran 2") on top of refund-1072-harness
// and refund-1119-support (pattern of refund-1144-a), not from the implementation.
//
// Rule under test (restrictive wins): the hold filed at minute 0 for a SMALLER echo X of our
// sent refund R is closed automatically only when R is FINAL and SUCCESSFUL (completed). While R
// is still `approved` the hold stays open (red at the head); if R then fails the hold stays open
// and finance is told by exactly ONE alert; no payout leaves beyond what the provider already
// paid.
//
// Scenario (as 1144-a): T paid Rp100.000, our refund R Rp60.000 sent (provider "pending", ref X);
// X is blanked while the echo (Rp50.000, refund id X) arrives, so the echo is held at minute 0;
// X is restored, the event aged past the 15 minute window and the worker retries.
//   - 1144-d-01/02 (i)   R still approved after the retry, switch on/off: hold stays open.
//   - 1144-d-03 (ii)  R then succeeds (own refund.succeeded of R, Rp60.000), switch on: the hold
//                     is closed once, no double count, replays change nothing, only the Rp40.000
//                     left is refundable by hand.
//   - 1144-d-05 (iii) R then fails (refund.failed of R), switch on: hold stays open, ONE finance
//                     alert in total, no extra payout call, manual refund above the room that
//                     the open hold leaves is refused.
//   - 1144-d-04/06    switch off, R's own refund.succeeded / refund.failed: R does NOT become
//                     final (switch-off rule of refund-1108-p1-1b: every signed refund event
//                     matching R is hold-only), so the echo hold stays open, no payout call,
//                     manual refused.
//
// Assumptions (the brief does not fix them):
//   - "R succeeded" = a signed refund.succeeded naming X with R's amount (Rp60.000), a new event
//     id; "R failed" = signed refund.failed carrying X, R's idempotency key and R's amount.
//   - Alert = notification titled "Refund penyedia tidak cocok dengan refund Legend", counted as
//     a delta since before the echo (max over recipients). For (i) at most one (the brief says
//     "plus one if announce promised it"); for (iii) exactly one in total, even if the retry
//     announced it earlier (no double).
//   - Switch off: R is sent while the switch is on, then the switch is turned off before the echo
//     and stays off through R's own webhook. A first run showed R stays `approved` then: that is
//     the existing switch-off rule (refund-1108-p1-1b), so with the switch off R is never final
//     and (ii)/(iii) only apply with the switch on. The off variants pin that the echo hold stays
//     open; their alert count is not pinned (R's own event files its own switch-off conflict
//     hold, which may be announced separately; 1144-e covers that alert).
//   - (ii): after closing, the room is paid - R = Rp40.000: that accepted by hand (settle when the
//     switch is off), one rupiah more refused.
//   - (iii): R failed frees R's Rp60.000 but the open hold still counts the Rp50.000 the provider
//     may have paid: a hand refund of the whole bill or of Rp60.000 must be refused (worst case
//     50.000 + 60.000 > paid).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1144-d-echo-closes-on-r-final.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  flags,
  installSwitchHooks,
  tryManualOut,
  type Probe,
} from "./refund-1119-support";

const h = createRefundHarness("1144d");
installSwitchHooks(h, true);

const R_IDR = 60_000;
const ECHO_IDR = 50_000;
const ROOM_IDR = BILL_IDR - R_IDR;
const ALERT_TITLE = "Refund penyedia tidak cocok dengan refund Legend";

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

const ageEvent = (eventId: string, minutes: number) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - ($3::int * interval '1 minute'),
            updated_at = now() - ($3::int * interval '1 minute')
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId, minutes],
  );

/**
 * T paid, R (Rp60.000) sent with ref X and still `approved`, the Rp50.000 echo held at minute 0,
 * then retried after the window. R is NOT touched afterwards: the caller decides how R ends.
 */
async function heldEchoOfApprovedR(switchOn: boolean) {
  flags.DOIT_REFUNDS_ENABLED = true;
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownPendingRefund(code, R_IDR);
  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId],
  );
  const alertsBefore = await unmatchedAlerts();
  flags.DOIT_REFUNDS_ENABLED = switchOn;
  const echo = h.refundSucceededEvent(code.providerRef, own.x, ECHO_IDR);
  expect([401, 403]).not.toContain((await h.deliver(echo)).status);
  const minute0 = await h.allHolds(code.id);
  const dump0 = JSON.stringify(minute0);
  expect(
    minute0.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
    `premise, minute 0: one open hold of the echo (${dump0})`,
  ).toEqual([[true, ECHO_IDR]]);
  expect(minute0[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);

  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId, own.x],
  );
  await ageEvent(echo.id, 30);
  await h.runWorker();
  await h.runWorker();
  expect(
    (await h.refundRow(own.refundId)).status,
    "premise: R is still in flight (approved), not final",
  ).not.toMatch(/^(completed|failed)$/);
  return { code, own, echo, holdId: minute0[0]!.id, alertsBefore };
}

type World = Awaited<ReturnType<typeof heldEchoOfApprovedR>>;

const rSucceeded = (w: World) =>
  h.refundSucceededEvent(w.code.providerRef, w.own.x, R_IDR);

const rFailed = (w: World) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.failed",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    id: w.own.x,
    idempotency_key: `refund:${w.own.refundId}`,
    amount: R_IDR,
    payment_id: w.code.providerRef,
    status: "failed",
    failure_code: "declined",
  },
});

async function openHoldCount(w: World) {
  return (await h.openOf(w.code.id)).length;
}

async function deliverOk(body: { id: string }) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
}

describe("1144 round 2: the hold of a smaller echo closes only when R is final and successful", () => {
  for (const [n, switchOn] of [
    ["01", true],
    ["02", false],
  ] as const) {
    it(`1144-d-${n} (i) R still approved after the post-window retry, switch ${switchOn ? "on" : "off"}: the hold of the Rp50.000 echo stays open, at most one alert, manual refused`, async () => {
      const w = await heldEchoOfApprovedR(switchOn);
      const label = `1144-d-${n}`;

      const holds = await h.allHolds(w.code.id);
      const dump = JSON.stringify(holds);
      const open = holds.filter((hold) => hold.resolved_at === null);
      expect(
        open.map((hold) => hold.id),
        `${label}: the echo hold stays open while R is approved (${dump})`,
      ).toContain(w.holdId);
      expect(
        Math.max(...open.map((hold) => hold.amount_idr)),
        `${label}: open value covers the echo (${dump})`,
      ).toBeGreaterThanOrEqual(ECHO_IDR);
      expect(
        await alertsSince(w.alertsBefore),
        `${label}: no more than one finance alert`,
      ).toBeLessThanOrEqual(1);

      // More passes and replays change nothing: still open.
      await h.runWorker();
      await h.replayAll(() => w.echo, 2);
      expect(
        (await h.openOf(w.code.id)).map((hold) => hold.id),
        `${label}: still open after later passes and replays`,
      ).toContain(w.holdId);
      expect(
        await alertsSince(w.alertsBefore),
        `${label}: later passes add no second alert`,
      ).toBeLessThanOrEqual(1);

      const probes: Probe[] = [];
      for (const amount of [BILL_IDR, ROOM_IDR]) {
        const probe = await tryManualOut(h, w.code.id, amount);
        probes.push(probe);
        expectRefused(probe, label);
      }
      expectWorstCaseWithinPaid(ECHO_IDR, 0, probes, label);
    });
  }

  {
    const n = "03";
    it(`1144-d-${n} (ii) R then succeeds, switch on: the hold is closed once, no double count, replays change nothing, only Rp40.000 refundable`, async () => {
      const w = await heldEchoOfApprovedR(true);
      const label = `1144-d-${n}`;
      expect(
        await openHoldCount(w),
        `${label}: premise, the hold is open before R succeeds`,
      ).toBeGreaterThan(0);

      const success = rSucceeded(w);
      await deliverOk(success);
      await h.runWorker();
      await h.runWorker();

      const row = await h.refundRow(w.own.refundId);
      expect(row.status, `${label}: R completed`).toBe("completed");
      const holds = await h.allHolds(w.code.id);
      const dump = JSON.stringify(holds);
      expect(holds, `${label}: never a second hold row (${dump})`).toHaveLength(
        1,
      );
      expect(
        holds[0]!.resolved_at,
        `${label}: closed, R (final success) counts the money (${dump})`,
      ).not.toBeNull();
      expect(await openHoldCount(w), `${label}: nothing open`).toBe(0);
      const closedAt = holds[0]!.resolved_at;
      await h.expectMoneyWithinPaid(w.code, `${label} no double count`);
      expect(
        await h.ourRefundedIdr(w.code.id),
        `${label}: R is counted once`,
      ).toBe(R_IDR);
      const alertsAtClose = await alertsSince(w.alertsBefore);
      expect(
        alertsAtClose,
        `${label}: no more than one alert`,
      ).toBeLessThanOrEqual(1);

      // Replays of R's success and the echo: closed once, nothing new.
      await h.replayAll(() => success, 2);
      await h.replayAll(() => w.echo, 1);
      const again = await h.allHolds(w.code.id);
      expect(
        again.map((hold) => [hold.id, hold.resolved_at]),
        `${label}: the same single closed hold after replays`,
      ).toEqual([[holds[0]!.id, closedAt]]);
      expect(
        await alertsSince(w.alertsBefore),
        `${label}: replays add no alert`,
      ).toBe(alertsAtClose);
      await h.expectMoneyWithinPaid(w.code, `${label} after replays`);

      // Room = paid 100.000 - R 60.000: not blocked, not more.
      const rest = await tryManualOut(h, w.code.id, ROOM_IDR);
      expect(rest.accepted, `${label}: ${JSON.stringify(rest)}`).toBe(true);
      const over = await tryManualOut(h, w.code.id, 1_000);
      expectRefused(over, `${label} above the room`);
      expectWorstCaseWithinPaid(R_IDR, R_IDR, [rest, over], label);
    });
  }

  {
    const n = "05";
    it(`1144-d-${n} (iii) R then fails (refund.failed), switch on: the hold stays open, exactly one finance alert, no extra payout, manual refused`, async () => {
      const w = await heldEchoOfApprovedR(true);
      const label = `1144-d-${n}`;
      const refundsBefore = await h.refundRowCount(w.code.id);

      const failure = rFailed(w);
      await deliverOk(failure);
      await h.runWorker();
      await h.runWorker();
      await h.replayAll(() => failure, 2);
      await ageEvent(w.echo.id, 40);
      await h.runWorker();

      expect(
        (await h.refundRow(w.own.refundId)).status,
        `${label}: R failed`,
      ).toBe("failed");
      const holds = await h.allHolds(w.code.id);
      const dump = JSON.stringify(holds);
      const echoHold = holds.find((hold) => hold.id === w.holdId);
      expect(
        echoHold?.resolved_at,
        `${label}: the echo hold stays open (${dump})`,
      ).toBeNull();
      const open = holds.filter((hold) => hold.resolved_at === null);
      expect(
        Math.max(...open.map((hold) => hold.amount_idr)),
        `${label}: open value covers the echo (${dump})`,
      ).toBeGreaterThanOrEqual(ECHO_IDR);
      expect(
        await alertsSince(w.alertsBefore),
        `${label}: exactly one finance alert in total`,
      ).toBe(1);

      // No payout beyond what the provider already paid: nothing sent, no refund row added.
      const callsAfterFailure = h.fake.calls.length;
      await h.runWorker();
      await h.replayAll(() => w.echo, 1);
      expect(
        h.fake.calls.length,
        `${label}: no extra payout call after R failed`,
      ).toBe(callsAfterFailure);
      expect(
        await h.refundRowCount(w.code.id),
        `${label}: no refund row is added`,
      ).toBe(refundsBefore);

      const probes: Probe[] = [];
      for (const amount of [BILL_IDR, R_IDR]) {
        const probe = await tryManualOut(h, w.code.id, amount);
        probes.push(probe);
        expectRefused(probe, label);
      }
      expectWorstCaseWithinPaid(ECHO_IDR, 0, probes, label);
    });
  }

  for (const [n, kind] of [
    ["04", "succeeded"],
    ["06", "failed"],
  ] as const) {
    it(`1144-d-${n} switch off, R's own refund.${kind}: R is not final (switch-off rule), the echo hold stays open, no payout call, manual refused`, async () => {
      const w = await heldEchoOfApprovedR(false);
      const label = `1144-d-${n}`;
      const callsBefore = h.fake.calls.length;
      const refundsBefore = await h.refundRowCount(w.code.id);

      const event = kind === "succeeded" ? rSucceeded(w) : rFailed(w);
      await deliverOk(event);
      await h.runWorker();
      await h.runWorker();
      await h.replayAll(() => event, 1);

      expect(
        (await h.refundRow(w.own.refundId)).status,
        `${label}: switch off, R's own event does not make R final`,
      ).not.toMatch(/^(completed|failed)$/);
      const holds = await h.allHolds(w.code.id);
      const dump = JSON.stringify(holds);
      expect(
        holds.find((hold) => hold.id === w.holdId)?.resolved_at,
        `${label}: the echo hold stays open while R is not final (${dump})`,
      ).toBeNull();
      expect(
        h.fake.calls.length,
        `${label}: nothing reached the provider`,
      ).toBe(callsBefore);
      expect(
        await h.refundRowCount(w.code.id),
        `${label}: no refund row is added`,
      ).toBe(refundsBefore);

      const probes: Probe[] = [];
      for (const amount of [BILL_IDR, ROOM_IDR]) {
        const probe = await tryManualOut(h, w.code.id, amount);
        probes.push(probe);
        expectRefused(probe, label);
      }
      expectWorstCaseWithinPaid(ECHO_IDR, 0, probes, label);
    });
  }
});
