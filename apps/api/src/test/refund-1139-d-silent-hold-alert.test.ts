// (brief 1139, reviewer delta P2, tier K "jangan sampai rugi"): red-first tests.
//
// Rule under test: the hold filed on first processing (minute 0) is silent (finance is not told
// while our own refund may still match). Whatever happens on the pass after the retry window, a
// hold of that event that is STILL OPEN must reach finance: exactly ONE supervisor alert
// ("Refund penyedia tidak cocok dengan refund Legend"), never none, never two.
//
//   - 1139-d-01: the retry matches our refund R, but the hold is worth more than R (a second
//     report of the same refund id, Rp60.000, raised it): the hold stays open and is announced.
//   - 1139-d-02: the pass after the window books no fact (our refund of Rp100.000 already
//     completed, nothing is left): the hold stays open and is announced.
//
// Assumptions: the alert is read as the notification titled as above (all supervisors of the
// outlet; the delta of the count is used because tests share one tenant). The second report of
// 1139-d-01 is taken out of the worker (status set to processed) so that only the first event
// is retried.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1139-d-silent-hold-alert.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import { flags, installSwitchHooks } from "./refund-1119-support";

const h = createRefundHarness("1139d");
installSwitchHooks(h, true);

const ALERT_TITLE = "Refund penyedia tidak cocok dengan refund Legend";

/** Rows per recipient: one alert reaches every supervisor and owner once. */
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

async function expectOneOpenHoldAnnounced(
  codeId: string,
  amountIdr: number,
  alertsBefore: string,
  label: string,
) {
  const holds = await h.allHolds(codeId);
  const dump = JSON.stringify(holds);
  expect(holds, `${label}: one hold (${dump})`).toHaveLength(1);
  expect(holds[0]!.resolved_at, `${label}: still open (${dump})`).toBeNull();
  expect(holds[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
  expect(holds[0]!.amount_idr, `${label}: amount`).toBe(amountIdr);
  expect(
    await alertsSince(alertsBefore),
    `${label}: exactly one finance alert for the open hold`,
  ).toBe(1);
}

describe("1139 an open first-pass hold is announced on the pass after the window", () => {
  it("1139-d-01 the retry matches our refund R but the hold is larger than R: the hold stays open and finance is told once", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const own = await h.ownPendingRefund(code, 30_000);
    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId],
    );
    const alertsBefore = await unmatchedAlerts();
    const echo = h.refundSucceededEvent(code.providerRef, own.x, 30_000);
    expect([401, 403]).not.toContain((await h.deliver(echo)).status);
    const bigger = h.refundSucceededEvent(code.providerRef, own.x, 60_000);
    expect([401, 403]).not.toContain((await h.deliver(bigger)).status);
    await h.owner.query(
      "UPDATE gateway_webhook_events SET status = 'processed', processed_at = now() WHERE tenant_id = $1 AND event_id = $2",
      [h.tenantId, bigger.id],
    );
    const premise = await h.allHolds(code.id);
    expect(
      premise.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
      `premise: one open hold of Rp60.000, silent (${JSON.stringify(premise)})`,
    ).toEqual([[true, 60_000]]);
    expect(await alertsSince(alertsBefore)).toBe(0);

    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId, own.x],
    );
    await ageEvent(echo.id, 30);
    await h.runWorker();
    await h.runWorker();

    expect((await h.refundRow(own.refundId)).status, "R completed").toBe(
      "completed",
    );
    await expectOneOpenHoldAnnounced(code.id, 60_000, alertsBefore, "d-01");
  });

  it("1139-d-02 the pass after the window books no fact (a fact of Rp60.000 leaves too little room): the hold stays open and finance is told once", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    // A fact of Rp60.000 (other refund id) is on record: Rp40.000 are left.
    const first = h.refundIdEvent(
      code.providerRef,
      `rf_${randomBytes(6).toString("hex")}`,
      60_000,
    );
    expect([401, 403]).not.toContain((await h.deliver(first)).status);
    expect(
      (await h.providerRows(code.id)).map((fact) => fact.amount_idr),
      "premise: the fact of the first refund is booked",
    ).toEqual([60_000]);
    const alertsBefore = await unmatchedAlerts();
    const event = h.refundSucceededEvent(
      code.providerRef,
      `rf_${randomBytes(6).toString("hex")}`,
      60_000,
    );
    expect([401, 403]).not.toContain((await h.deliver(event)).status);
    const premise = await h.allHolds(code.id);
    expect(
      premise.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
      `premise: one open hold of Rp60.000 (${JSON.stringify(premise)})`,
    ).toEqual([[true, 60_000]]);

    await ageEvent(event.id, 30);
    await h.runWorker();
    await h.runWorker();

    expect(
      (await h.providerRows(code.id)).map((fact) => fact.amount_idr),
      "no second fact is booked (the report exceeds what is left)",
    ).toEqual([60_000]);
    await expectOneOpenHoldAnnounced(code.id, 60_000, alertsBefore, "d-02");
  });
});
