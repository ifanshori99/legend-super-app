// (brief 1144, putaran 2, second opinion ronde 16 P2-1, tier K "jangan sampai rugi"): red-first
// tests, written from the CTO decision (scratchpad 1144-shared.md) and the SO report
// (docs/qa/second-opinion-refund-ronde16-1153.md, P2-1 and its test proposal), on top of
// refund-1072-harness and refund-1119-support (pattern of refund-1144-a/b), not from the
// implementation.
//
// Rule under test: with the refund switch off (DOIT_REFUNDS_ENABLED false) a provider refund
// report that matches our refund R is held (hold at minute 0, kept open, restrictive). Finance is
// told by ONE alert whose dedup identity is stable per (tenant, integration, refund id) across
// retries: the post-window retry and later worker passes or replays add no second alert, whatever
// the alert type ("Refund penyedia ditahan, refund otomatis belum aktif" or "Refund penyedia
// tidak cocok dengan refund Legend"). Today the retry sends BOTH titles (two alerts with
// different dedup ids for one report). The hold itself must not disappear to reduce the count.
//
//   - 1144-e-01 echo Rp50.000 of R Rp60.000, switch off, post-window retry, worker run several
//     times, replays: total alerts of both titles = 1; hold open; manual refund refused.
//   - 1144-e-02 same with echo Rp70.000 (> R).
//   - 1144-e-03 a DIFFERENT refund id (second R, same tenant) alerts on its own: +1 each, the
//     second is not swallowed by the first.
//   - NOT written: another tenant's report. Two harnesses in one file break each other (the
//     fake DOIT fetch is global: "No fake DOIT payment ..."), so tenant isolation of the alert
//     identity needs its own file or harness support.
//
// Assumptions (the brief does not fix them):
//   - Alerts carry no refund id in their text. "One alert per refund id" = the alerts created
//     since before that refund's echo (scenarios run one after the other in one tenant), counted
//     by their dedup identity (first segment of notifications.dedupe_key, `<identity>:<user>:
//     <category>`): exactly ONE identity, one row per recipient. Two alerts of different type
//     for the same report show up as two identities (red at head: two identities).
//   - Setup as in 1144-a: R sent with the switch on, its provider ref blanked so the echo is held
//     at minute 0, the ref restored, the event aged past the 15 minute window, then the worker
//     retries; the switch is off from the echo onward.
//   - The "refund id" is the provider refund id X of R (R's own ref); a second R has another X.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1144-e-switchoff-alert-dedup.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type RefundHarness,
} from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  flags,
  installSwitchHooks,
  tryManualOut,
  type Probe,
} from "./refund-1119-support";

const h = createRefundHarness("1144e");
installSwitchHooks(h, true);

const R_IDR = 60_000;
const ROOM_IDR = BILL_IDR - R_IDR;
const ALERT_TITLES = [
  "Refund penyedia ditahan, refund otomatis belum aktif",
  "Refund penyedia tidak cocok dengan refund Legend",
];

type Alert = { id: string; user_id: string; identity: string };

/**
 * The refund alerts of the tenant (both titles). The alert carries no refund id in its text; its
 * identity is the first segment of `dedupe_key` ("<identity>:<user>:<category>"), the stable
 * dedup id the CTO decision is about. One identity = one alert (one row per recipient).
 */
const refundAlerts = async (hh: RefundHarness): Promise<Alert[]> =>
  (
    await hh.owner.query<Alert>(
      `SELECT id::text AS id, user_id::text AS user_id,
              split_part(dedupe_key, ':', 1) AS identity
         FROM notifications
        WHERE tenant_id = $1 AND title = ANY($2::text[])
        ORDER BY created_at, id`,
      [hh.tenantId, ALERT_TITLES],
    )
  ).rows;

/** The alerts created since `before` (a snapshot of ids): those of the refund under test. */
const alertsSince = async (hh: RefundHarness, before: Set<string>) =>
  (await refundAlerts(hh)).filter((alert) => !before.has(alert.id));

const snapshot = async (hh: RefundHarness) =>
  new Set((await refundAlerts(hh)).map((alert) => alert.id));

const identitiesOf = (alerts: Alert[]) => [
  ...new Set(alerts.map((alert) => alert.identity)),
];

const ageEvent = (hh: RefundHarness, eventId: string, minutes: number) =>
  hh.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - ($3::int * interval '1 minute'),
            updated_at = now() - ($3::int * interval '1 minute')
      WHERE tenant_id = $1 AND event_id = $2`,
    [hh.tenantId, eventId, minutes],
  );

/**
 * T paid, our refund R (Rp60.000) sent with ref X (switch on), X blanked, the switch turned off,
 * the echo of X held at minute 0; X restored, event aged, worker retries (and again, and replays).
 */
async function heldEchoSwitchOff(echoIdr: number) {
  flags.DOIT_REFUNDS_ENABLED = true;
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownPendingRefund(code, R_IDR);
  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId],
  );
  const before = await snapshot(h);
  flags.DOIT_REFUNDS_ENABLED = false;
  const echo = h.refundSucceededEvent(code.providerRef, own.x, echoIdr);
  expect([401, 403]).not.toContain((await h.deliver(echo)).status);
  const minute0 = await h.allHolds(code.id);
  const dump0 = JSON.stringify(minute0);
  expect(
    minute0.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
    `premise, minute 0: one open hold of the echo (${dump0})`,
  ).toEqual([[true, echoIdr]]);
  expect(minute0[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);

  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId, own.x],
  );
  await ageEvent(h, echo.id, 30);
  await h.runWorker();
  await h.runWorker();
  // Later passes and replays of the same event.
  await ageEvent(h, echo.id, 40);
  await h.runWorker();
  await h.replayAll(() => echo, 2);
  await ageEvent(h, echo.id, 50);
  await h.runWorker();
  return { code, own, before, echoId: echo.id };
}

/** Exactly one alert in total, the hold stays open, manual money out is refused. */
async function expectOneAlertHoldOpen(
  w: Awaited<ReturnType<typeof heldEchoSwitchOff>>,
  echoIdr: number,
  label: string,
) {
  const sent = await alertsSince(h, w.before);
  const identities = identitiesOf(sent);
  expect(
    identities,
    `${label}: ONE alert identity (dedupe id) for this refund, got ${identities.length} (${JSON.stringify(sent)})`,
  ).toHaveLength(1);
  const perRecipient = new Map<string, number>();
  for (const alert of sent)
    perRecipient.set(alert.user_id, (perRecipient.get(alert.user_id) ?? 0) + 1);
  expect(
    Math.max(0, ...perRecipient.values()),
    `${label}: no recipient is told twice (${JSON.stringify(sent)})`,
  ).toBe(1);
  const holds = await h.allHolds(w.code.id);
  const dump = JSON.stringify(holds);
  const open = holds.filter((hold) => hold.resolved_at === null);
  expect(
    open.length,
    `${label}: the hold stays open (${dump})`,
  ).toBeGreaterThan(0);
  expect(
    Math.max(...open.map((hold) => hold.amount_idr)),
    `${label}: open value covers the echo (${dump})`,
  ).toBeGreaterThanOrEqual(echoIdr);
  const probes: Probe[] = [];
  for (const amount of [BILL_IDR, ROOM_IDR]) {
    const probe = await tryManualOut(h, w.code.id, amount);
    probes.push(probe);
    expectRefused(probe, label);
  }
  expectWorstCaseWithinPaid(echoIdr, 0, probes, label);
}

describe("1144 P2 switch off: one finance alert per refund id across retries", () => {
  it("1144-e-01 echo Rp50.000 of R Rp60.000, switch off, post-window retry + repeated worker + replays: exactly ONE alert in total, hold open", async () => {
    const w = await heldEchoSwitchOff(50_000);
    await expectOneAlertHoldOpen(w, 50_000, "1144-e-01");
  });

  it("1144-e-02 echo Rp70.000 of R Rp60.000, switch off, same retries: exactly ONE alert in total, hold open", async () => {
    const w = await heldEchoSwitchOff(70_000);
    await expectOneAlertHoldOpen(w, 70_000, "1144-e-02");
  });

  it("1144-e-03 a different refund id in the same tenant alerts on its own (one each, not swallowed)", async () => {
    const tenantBefore = await snapshot(h);
    const first = await heldEchoSwitchOff(50_000);
    await expectOneAlertHoldOpen(first, 50_000, "1144-e-03 first refund");
    const second = await heldEchoSwitchOff(70_000);
    await expectOneAlertHoldOpen(second, 70_000, "1144-e-03 second refund");
    expect(
      first.own.x,
      "premise: the two refunds have different provider ids",
    ).not.toBe(second.own.x);
    const identities = identitiesOf(await alertsSince(h, tenantBefore));
    expect(
      identities,
      "1144-e-03: two refund ids, two distinct alert identities (not swallowed)",
    ).toHaveLength(2);
  });
});
