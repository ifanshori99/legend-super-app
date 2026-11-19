// (brief 1144, bead legend-om9q2 P2, tier K "jangan sampai rugi"): red-first tests, written from
// the CTO decision in the scratchpad (1144-shared.md) on top of refund-1072-harness and
// refund-1119-support (pattern of refund-1139-d), not from the implementation.
//
// Rule under test: the hold filed on first processing (minute 0) of an echo X of our refund R
// (R already sent to the provider) is closed automatically ONLY when R (same refund id, same
// payment) covers the hold's value in full (R >= hold): R already counts that money. Anything
// else stays open (restrictive) and finance is told by exactly ONE alert.
//
// What the code does today (read in payment-webhook.service.ts, only to pick the cases): at
// minute 0 R's ref X is not stored yet, nothing matches, the echo is held (value X). On the
// retry R matches by refund id; an amount that differs from R's makes the updater refuse with
// 409 amount_mismatch (a smaller echo of a sent refund files no surplus hold), the row is
// ignored (REJECTED_CONFLICT) and nothing closes or announces the minute-0 hold.
//
// Scenario: T paid Rp100.000, our refund R of Rp60.000 sent (provider answered "pending", ref X).
// The webhook outruns the storing of X (blanked in SQL), so the echo is held at minute 0; X is
// restored, the event aged past the 15 minute window, the worker retries.
//   - 1144-a-01 echo Rp50.000 < R, switch on: hold closed (R counts Rp60.000), still ONE hold
//     row, the remaining Rp40.000 is refundable, one more rupiah is not (no double count).
//   - 1144-a-02 echo Rp70.000 > R, switch on: hold stays open, ONE finance alert, manual refused.
//   - 1144-a-03 echo naming ANOTHER payment (T2) than R's: the hold on T2 stays open, ONE alert,
//     manual refused.
//   - 1144-a-04/05 switch off (DOIT_REFUNDS_ENABLED false) for the smaller and the larger echo:
//     hold stays open, ONE alert, manual refused (the switch only restricts, never closes).
//
// Assumptions (the brief does not fix them):
//   - R is "sent" = approved with the provider answering pending; it counts against the room
//     (paid - R = Rp40.000) although it is not completed by the smaller echo.
//   - Alert = notification titled "Refund penyedia tidak cocok dengan refund Legend"; the
//     delta since before the echo is used (tests share one tenant); max over recipients.
//   - Switch off: R is sent while the switch is on (setup), then the switch is turned off
//     before the echo is delivered.
//   - 1144-a-03: the echo of R's id X names the payment of a second transaction T2 (paid
//     separately), so the hold lives on T2's intent with T2's payment ref (not R's).
//   - The "post-window retry ends in `retry`" card-3 case is NOT written: `retry` after
//     `force` only happens on a race (evidence moved to another intent) that HTTP cannot
//     reproduce; 1139-d-01/02 already pin the announce on the post-window pass.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1144-a-echo-smaller-hold.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  flags,
  installSwitchHooks,
  tryManualOut,
  type Probe,
} from "./refund-1119-support";

const h = createRefundHarness("1144a");
installSwitchHooks(h, true);

const R_IDR = 60_000;
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
 * T paid, our refund R (Rp60.000) sent with ref X, X blanked so the echo is held at minute 0.
 * `named` = the transaction whose payment id the echo names (default: R's own).
 */
async function heldEcho(opts: {
  echoIdr: number;
  switchOn: boolean;
  otherPayment?: boolean;
}) {
  flags.DOIT_REFUNDS_ENABLED = true;
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const t2: Code | null = opts.otherPayment ? await h.newCode(BILL_IDR) : null;
  if (t2) expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  const own = await h.ownPendingRefund(code, R_IDR);
  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId],
  );
  const held = t2 ?? code;
  const alertsBefore = await unmatchedAlerts();
  flags.DOIT_REFUNDS_ENABLED = opts.switchOn;
  const echo = h.refundSucceededEvent(held.providerRef, own.x, opts.echoIdr);
  expect([401, 403]).not.toContain((await h.deliver(echo)).status);
  const minute0 = await h.allHolds(held.id);
  const dump0 = JSON.stringify(minute0);
  expect(
    minute0.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
    `premise, minute 0: one open hold of the echo (${dump0})`,
  ).toEqual([[true, opts.echoIdr]]);
  expect(minute0[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);

  await h.owner.query(
    "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, own.refundId, own.x],
  );
  await ageEvent(echo.id, 30);
  await h.runWorker();
  await h.runWorker();
  return { code, held, own, alertsBefore };
}

/** The hold stays open, finance is told once, manual money out is refused. */
async function expectHeldAndAnnounced(
  w: Awaited<ReturnType<typeof heldEcho>>,
  echoIdr: number,
  label: string,
) {
  const holds = await h.allHolds(w.held.id);
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
  expect(
    await alertsSince(w.alertsBefore),
    `${label}: exactly one finance alert`,
  ).toBe(1);
  const probes: Probe[] = [];
  for (const amount of [BILL_IDR, ROOM_IDR]) {
    const probe = await tryManualOut(h, w.held.id, amount);
    probes.push(probe);
    expectRefused(probe, label);
  }
  expectWorstCaseWithinPaid(echoIdr, 0, probes, label);
}

describe("1144 P2 an echo of our sent refund: the first-pass hold closes only when R covers it fully", () => {
  it("1144-a-01 echo Rp50.000 of R Rp60.000 (switch on): hold at minute 0, closed after the window, no double count, Rp40.000 refundable", async () => {
    const w = await heldEcho({ echoIdr: 50_000, switchOn: true });

    const holds = await h.allHolds(w.code.id);
    const dump = JSON.stringify(holds);
    expect(holds, `never a second hold row (${dump})`).toHaveLength(1);
    expect(
      holds[0]!.resolved_at,
      `closed: R (Rp60.000) already counts the Rp50.000 (${dump})`,
    ).not.toBeNull();
    expect(await h.openOf(w.code.id)).toHaveLength(0);

    // Room = paid 100.000 - R 60.000 = 40.000: not blocked, not more.
    const rest = await tryManualOut(h, w.code.id, ROOM_IDR);
    expect(rest.accepted, JSON.stringify(rest)).toBe(true);
    const over = await tryManualOut(h, w.code.id, 1_000);
    expectRefused(over, "1144-a-01 above the room");
    expectWorstCaseWithinPaid(R_IDR, R_IDR, [rest, over], "1144-a-01");
  });

  it("1144-a-02 echo Rp70.000 of R Rp60.000 (switch on): hold stays open, one finance alert, manual refused", async () => {
    const w = await heldEcho({ echoIdr: 70_000, switchOn: true });
    await expectHeldAndAnnounced(w, 70_000, "1144-a-02");
  });

  it("1144-a-03 echo of R's id naming another payment (T2): the hold on T2 stays open, one finance alert, manual refused", async () => {
    const w = await heldEcho({
      echoIdr: 50_000,
      switchOn: true,
      otherPayment: true,
    });
    await expectHeldAndAnnounced(w, 50_000, "1144-a-03");
  });

  it("1144-a-04 echo Rp50.000 of R Rp60.000, switch OFF: hold stays open, one finance alert, manual refused", async () => {
    const w = await heldEcho({ echoIdr: 50_000, switchOn: false });
    await expectHeldAndAnnounced(w, 50_000, "1144-a-04");
  });

  it("1144-a-05 echo Rp70.000 of R Rp60.000, switch OFF: hold stays open, one finance alert, manual refused", async () => {
    const w = await heldEcho({ echoIdr: 70_000, switchOn: false });
    await expectHeldAndAnnounced(w, 70_000, "1144-a-05");
  });
});
