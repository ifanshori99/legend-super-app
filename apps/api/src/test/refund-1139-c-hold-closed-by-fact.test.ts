// (brief 1139, architect delta review P2-1, tier K "jangan sampai rugi"): red-first test of the
// normal shape of a provider-initiated refund: refund id X + payment id P + amount, matching no
// refund of ours.
//
// Rule under test: the hold filed on first processing (minute 0) limits the refund room until
// the fact of X is booked after the 15 minute window. Once the fact of X (>= the hold's value)
// is on record it limits later refunds by itself, so the hold must be closed: otherwise the
// same Rp60.000 is counted twice (fact and hold) and the guest's remaining Rp40.000 stays
// blocked for good.
//
// Scenario: T paid Rp100.000, the provider refunded Rp60.000 from its dashboard (signed success
// with refund id, payment id and amount).
//   - minute 0: one open conflict hold of Rp60.000, manual Rp100.000 refused, nothing booked;
//   - after the window: fact X = Rp60.000 booked once, the hold is closed, not counted twice:
//     a manual refund of the remaining Rp40.000 goes through, anything above it is refused,
//     total out <= paid.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1139-c-hold-closed-by-fact.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  installSwitchHooks,
  tryManualOut,
} from "./refund-1119-support";

const h = createRefundHarness("1139c");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;

describe("1139 P2-1 the first-pass hold is closed once the fact of its refund is booked", () => {
  it("1139-c-01 refund id + payment id + amount: held at minute 0, fact booked after the window, hold closed, the remaining Rp40.000 is refundable", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const refundId = `rf_${randomBytes(6).toString("hex")}`;
    const event = h.refundSucceededEvent(
      code.providerRef,
      refundId,
      REPORT_IDR,
    );
    const answered = await h.deliver(event);
    expect([401, 403]).not.toContain(answered.status);

    const held = await h.allHolds(code.id);
    const dump = JSON.stringify(held);
    expect(held, `minute 0: exactly one hold (${dump})`).toHaveLength(1);
    expect(held[0]!.resolved_at, `minute 0: open (${dump})`).toBeNull();
    expect(held[0]!.reason).toBe(HOLD_TRANSACTION_CONFLICT_REASON);
    expect(held[0]!.amount_idr).toBe(REPORT_IDR);
    expect(await h.providerRows(code.id), "minute 0: no fact yet").toHaveLength(
      0,
    );
    expectRefused(
      await tryManualOut(h, code.id, BILL_IDR),
      "1139-c-01 minute 0",
    );

    await h.owner.query(
      `UPDATE gateway_webhook_events
          SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
              received_at = now() - interval '30 minutes',
              updated_at = now() - interval '30 minutes'
        WHERE tenant_id = $1 AND event_id = $2`,
      [h.tenantId, event.id],
    );
    await h.runWorker();
    await h.runWorker();

    const facts = await h.providerRows(code.id);
    expect(
      facts.map((fact) => fact.amount_idr),
      "the fact of X is booked once",
    ).toEqual([REPORT_IDR]);
    const after = await h.allHolds(code.id);
    const afterDump = JSON.stringify(after);
    expect(
      after,
      `still one hold row, never a second (${afterDump})`,
    ).toHaveLength(1);
    expect(
      after[0]!.resolved_at,
      `the hold is closed: the fact limits refunds on its own (${afterDump})`,
    ).not.toBeNull();

    // Room is Rp40.000 (paid 100.000 - fact 60.000): not blocked, not more.
    const rest = await tryManualOut(h, code.id, BILL_IDR - REPORT_IDR);
    expect(rest.accepted, JSON.stringify(rest)).toBe(true);
    const over = await tryManualOut(h, code.id, 1_000);
    expectRefused(over, "1139-c-01 above the room");
    expectWorstCaseWithinPaid(
      REPORT_IDR,
      REPORT_IDR,
      [rest, over],
      "1139-c-01",
    );
  });
});
