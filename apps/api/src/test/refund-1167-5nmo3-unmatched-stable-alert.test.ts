// (card legend-5nmo3, tier K "jangan sampai rugi"): red-first test written from the second opinion
// report docs/qa/second-opinion-refund-ronde17-1161.md (P2-1 and its test proposal, lines 15-30)
// and the 1144-e rule, on top of refund-1072-harness and refund-1119-support, not from the
// implementation.
//
// Rule under test: with the refund switch off, finance is told by ONE alert per provider refund id
// X, whatever path sends it. A report that was first announced as "unmatched" (it matched none of
// our refunds yet) and later matches our refund R must not make a second alert (the switched-off
// gate) with a different dedup identity. The hold stays open; no payout leaves.
//
//   - 5nmo3-01 T paid Rp100.000, R Rp60.000 sent (approved, X not yet stored on R), switch off for
//     the whole scenario. E1 `refund.succeeded` (refund id X, payment P, NO amount) -> hold at
//     minute 0, no alert. After the 15 minute window the worker retries E1: still unmatched ->
//     the unmatched alert is sent (the first alert). X is then stored on R; E2 with a NEW event
//     id, same X/P, still no amount, now matches R and reaches the switched-off gate. Worker
//     passes and replays of E2 follow. Total alerts (both titles) for X: ONE identity, one row per
//     recipient. Hold stays open, covers the full value, no new hold/payout from the later passes,
//     R is not completed by the switch-off gate, manual refund refused.
//
// Assumptions (the report does not fix them):
//   - "Amount missing" = the event data has no `amount` key. No idempotency key is sent.
//   - Alerts carry no refund id in their text. One alert = one identity (first segment of
//     notifications.dedupe_key, `<identity>:<user>:<category>`), one row per recipient, as in
//     refund-1144-e.
//   - The hold at minute 0 covers the full paid value (Rp100.000), as the report says; the final
//     check only requires the open value to cover it.
//   - E1 is aged to `failed` once (the worker's retry after the window, as in 1144-b/e); it is not
//     put back after that (the report: replay of E1 stops as duplicate after `ignored`).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1167-5nmo3-unmatched-stable-alert.test.ts" heavy pnpm test

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

const h = createRefundHarness("5nmo3");
installSwitchHooks(h, true);

const R_IDR = 60_000;
const ROOM_IDR = BILL_IDR - R_IDR;
const ALERT_TITLES = [
  "Refund penyedia ditahan, refund otomatis belum aktif",
  "Refund penyedia tidak cocok dengan refund Legend",
];

type Alert = { id: string; user_id: string; identity: string; title: string };

const refundAlerts = async (hh: RefundHarness): Promise<Alert[]> =>
  (
    await hh.owner.query<Alert>(
      `SELECT id::text AS id, user_id::text AS user_id, title,
              split_part(dedupe_key, ':', 1) AS identity
         FROM notifications
        WHERE tenant_id = $1 AND title = ANY($2::text[])
        ORDER BY created_at, id`,
      [hh.tenantId, ALERT_TITLES],
    )
  ).rows;

const alertsSince = async (hh: RefundHarness, before: Set<string>) =>
  (await refundAlerts(hh)).filter((alert) => !before.has(alert.id));

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

/** `refund.succeeded` for refund id X on payment P with the amount left out. */
const echoWithoutAmount = (paymentRef: string, x: string) => {
  const event = h.refundSucceededEvent(paymentRef, x, 0);
  delete (event.data as { amount?: number }).amount;
  return event;
};

describe("1167 switch off: one finance alert per refund id, unmatched then matched", () => {
  it("5nmo3-01 unmatched alert first, then X stored on R and a new event for X: exactly ONE alert identity in total, hold open, no payout", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const own = await h.ownPendingRefund(code, R_IDR);
    // X is not stored on R yet.
    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId],
    );
    const before = new Set((await refundAlerts(h)).map((alert) => alert.id));
    const callsAfterR = h.fake.calls.length;
    flags.DOIT_REFUNDS_ENABLED = false;

    // E1: minute 0. Held, finance not told yet.
    const e1 = echoWithoutAmount(code.providerRef, own.x);
    expect([401, 403]).not.toContain((await h.deliver(e1)).status);
    const minute0 = await h.allHolds(code.id);
    const dump0 = JSON.stringify(minute0);
    expect(
      minute0.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
      `premise, minute 0: one open hold of the full value (${dump0})`,
    ).toEqual([[true, BILL_IDR]]);
    expect(minute0[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
    expect(
      await alertsSince(h, before),
      "premise, minute 0: the first processing is silent",
    ).toHaveLength(0);

    // After the window X is still not stored on R: the worker's retry announces the hold.
    await ageEvent(h, e1.id, 30);
    await h.runWorker();
    await h.runWorker();
    const first = await alertsSince(h, before);
    expect(
      identitiesOf(first),
      `premise: the first alert exists before X is stored on R (${JSON.stringify(first)})`,
    ).toHaveLength(1);

    // X is stored on R. A NEW event id reports the same X/P (amount still missing).
    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId, own.x],
    );
    const e2 = echoWithoutAmount(code.providerRef, own.x);
    expect(e2.id).not.toBe(e1.id);
    expect([401, 403]).not.toContain((await h.deliver(e2)).status);
    const holdsAfterE2 = (await h.allHolds(code.id)).length;
    const callsAfterE2 = h.fake.calls.length;
    await h.runWorker();
    await h.replayAll(() => e2, 2);
    await ageEvent(h, e2.id, 40);
    await h.runWorker();
    await h.replayAll(() => e2, 1);

    // One alert for refund id X: one identity, one row per recipient.
    const sent = await alertsSince(h, before);
    const identities = identitiesOf(sent);
    expect(
      identities,
      `ONE alert identity (dedupe id) for refund ${own.x}, got ${identities.length} (${JSON.stringify(sent)})`,
    ).toHaveLength(1);
    const perRecipient = new Map<string, number>();
    for (const alert of sent)
      perRecipient.set(
        alert.user_id,
        (perRecipient.get(alert.user_id) ?? 0) + 1,
      );
    expect(
      Math.max(0, ...perRecipient.values()),
      `no recipient is told twice (${JSON.stringify(sent)})`,
    ).toBe(1);

    // The hold stays open and covers the full value; later passes add no hold and no payout.
    const holds = await h.allHolds(code.id);
    const dump = JSON.stringify(holds);
    const open = holds.filter((hold) => hold.resolved_at === null);
    expect(open.length, `the hold stays open (${dump})`).toBeGreaterThan(0);
    expect(
      Math.max(...open.map((hold) => hold.amount_idr)),
      `open value covers the full report (${dump})`,
    ).toBeGreaterThanOrEqual(BILL_IDR);
    expect(
      holds.length,
      `worker passes and replays of E2 add no hold (${dump})`,
    ).toBe(holdsAfterE2);
    expect(
      h.fake.calls.length,
      "no payout call from the switched-off gate or the later passes",
    ).toBe(callsAfterE2);
    expect(callsAfterE2, "no payout call when E2 first arrived").toBe(
      callsAfterR,
    );
    expect(
      (await h.refundRow(own.refundId)).status,
      "R is not completed by the switched-off gate",
    ).not.toBe("completed");

    // Manual money out stays refused.
    const probes: Probe[] = [];
    for (const amount of [BILL_IDR, ROOM_IDR]) {
      const probe = await tryManualOut(h, code.id, amount);
      probes.push(probe);
      expectRefused(probe, "5nmo3-01");
    }
    expectWorstCaseWithinPaid(BILL_IDR, 0, probes, "5nmo3-01");
  });
});
