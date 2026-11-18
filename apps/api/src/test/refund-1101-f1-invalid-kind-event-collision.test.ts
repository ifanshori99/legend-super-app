// (brief 1103, SO refund ronde 10 finding F1 = refund 1101 F1, P1, tier K "jangan sampai
// rugi"): red-first tests, written from docs/qa/second-opinion-refund-ronde10-1101.md
// (finding 1), docs/briefs/1103-fix-refund-ronde10.md (CTO decision 3, fail-closed) and
// the pattern of refund-1072-a1-matched-echo-hold.test.ts, not from the implementation.
//
// Rule under test (CTO decision 3): a hold insert that collides on the unique event key,
// with NO row of the same kind/id found by the lookup, must never be dropped silently. It
// becomes an open CONFLICT hold under a fixed fail-closed key. Evidence must never get lost.
//
// How the collision is reached (black-box, no hash is computed by the test): the CURRENT
// code files a hold for the literal provider id X (kind `provider`) when a report of X on
// T is larger than our own refund R (as refund-1072-a1-01/03). Its event key is then
// derived from kind `provider` + X. Finance closes it `not_this_intent`; an owner-side
// UPDATE rewrites its kind to `invalid_report`, exactly what migration 0696 did to old
// rows (the event key stays). A later report of the SAME literal id X (new envelope id,
// smaller Rp60.000, so no "larger report" generation path applies) computes the same event
// key: the insert collides, the lookup by kind `provider` finds nothing (the row is now
// `invalid_report`), and the old code returned silently: no hold, no fact.
//
// Rules pinned:
//   - after the rewritten legacy hold is closed, a new report of X/T Rp60.000 leaves a NEW
//     OPEN hold on T worth at least Rp60.000, never nothing (recorder door and matched door);
//   - the old closed hold is untouched (still resolved, same amount, kind invalid_report);
//   - a refund of T is refused (409/422, at request or at approve), provider not asked;
//   - replays of the new report add no second hold;
//   - control: without the kind rewrite, an exact repeat adds no row (found by the lookup).
//
// Assumptions (the brief does not fix them):
//   - The hold the current code files for X/T Rp80.000 carries kind `provider` (its key is
//     built from that kind). If it does not, the premise assertion below fails and says so.
//   - The reason/code of the new CONFLICT hold is not pinned, only open + amount >= 60.000.
//   - "Refused" refund of T = 409 or 422 at the request or at the approve.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1101-f1-invalid-kind-event-collision.test.ts" heavy pnpm test

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1101f1");

const R_IDR = 30_000;
const LEGACY_IDR = 80_000;
const REAL_IDR = 60_000;
const NEXT_IDR = 70_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them. Switch ON: the matched
// door and the fake port are active (refund-1088 suites run this way after brief 1103).
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

type World = { t: Code; refundId: string; x: string };

/** Bill Rp100.000 paid; our refund R of Rp30.000 completed with provider ref X. */
async function world(): Promise<World> {
  const t = await h.newCode(BILL_IDR);
  expect((await h.paid(t, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t, R_IDR);
  return { t, refundId: own.refundId, x: own.x };
}

type Door = "recorder" | "matched";
const reportOf = (w: World, door: Door, amountIdr: number) => () =>
  door === "recorder"
    ? h.refundIdEvent(w.t.providerRef, w.x, amountIdr)
    : h.refundSucceededEvent(w.t.providerRef, w.x, amountIdr);

/**
 * The legacy hold: filed by the current code for X/T Rp80.000, closed by finance, then
 * (rewrite = true) its kind rewritten as migration 0696 did. The event key stays.
 */
async function legacyClosedHold(
  w: World,
  id: string,
  door: Door,
  rewrite: boolean,
) {
  await h.replayAll(reportOf(w, door, LEGACY_IDR), 1);
  const open = await h.openOf(w.t.id);
  expect(
    open.filter((row) => row.provider_refund_id === w.x),
    `${id} premise: one open hold for X (holds: ${JSON.stringify(await h.allHolds(w.t.id))})`,
  ).toHaveLength(1);
  const hold = open.find((row) => row.provider_refund_id === w.x)!;
  expect(hold.amount_idr, `${id} premise: hold worth Rp80.000`).toBe(
    LEGACY_IDR,
  );
  expect(
    hold.provider_refund_id_kind,
    `${id} premise: the current code files this hold under kind provider`,
  ).toBe("provider");
  const resolved = await h.resolveHold(hold.id, "not_this_intent");
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  if (rewrite) {
    // What migration 0696 did: kind changed, event key left as it was.
    await h.owner.query(
      `UPDATE refund_recon_holds SET provider_refund_id_kind = 'invalid_report'
        WHERE tenant_id = $1 AND id = $2`,
      [h.tenantId, hold.id],
    );
  }
  expect(await h.openOf(w.t.id), `${id} premise: nothing open`).toHaveLength(0);
  return (await h.allHolds(w.t.id)).find((row) => row.id === hold.id)!;
}

async function expectRefundRefused(intentId: string, label: string) {
  const filed = await h.manualRefund(intentId, NEXT_IDR);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${NEXT_IDR}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect([409, 422], `${label}: requesting ${NEXT_IDR}`).toContain(
      filed.status,
    );
  }
}

describe("F1 (P1) a report whose hold event key collides with a pre-0696 hold is never dropped", () => {
  it.each([
    ["1101-f1-01", "recorder", "payment.refunded"],
    ["1101-f1-02", "matched", "refund.succeeded"],
  ] as Array<[string, Door, string]>)(
    "%s %s door: legacy hold of X (Rp80.000) closed and its kind rewritten to invalid_report, then %s X/T Rp60.000: a NEW open hold on T worth at least Rp60.000, the old row untouched, T cannot be refunded, replays add no hold",
    async (id, door) => {
      const w = await world();
      const legacy = await legacyClosedHold(w, id, door, true);
      const callsBefore = h.fake.calls.length;

      const real = reportOf(w, door, REAL_IDR);
      await h.replayAll(real, 1);
      const open = await h.openOf(w.t.id);
      const holds = JSON.stringify(await h.allHolds(w.t.id));
      expect(
        open,
        `${id}: the report is held, not dropped (holds: ${holds})`,
      ).toHaveLength(1);
      expect(
        open[0]!.id,
        `${id}: the open hold is a new row, not the legacy one`,
      ).not.toBe(legacy.id);
      expect(
        open[0]!.amount_idr,
        `${id}: the hold covers at least the reported Rp60.000 (holds: ${holds})`,
      ).toBeGreaterThanOrEqual(REAL_IDR);

      const old = (await h.allHolds(w.t.id)).find(
        (row) => row.id === legacy.id,
      )!;
      expect(
        old.resolved_at,
        `${id}: the legacy hold stays closed`,
      ).not.toBeNull();
      expect(old.amount_idr).toBe(legacy.amount_idr);
      expect(old.provider_refund_id_kind).toBe("invalid_report");

      await expectRefundRefused(w.t.id, id);
      expect(h.fake.calls, `${id}: nothing reached the provider`).toHaveLength(
        callsBefore,
      );

      // Replays (new envelope ids) add no second hold.
      const rows = (await h.allHolds(w.t.id)).length;
      await h.replayAll(real, 2);
      await h.replayAll(reportOf(w, door, REAL_IDR), 1);
      expect(
        (await h.allHolds(w.t.id)).length,
        `${id}: replays add no hold row`,
      ).toBe(rows);
      expect(await h.openOf(w.t.id), `${id}: still one open hold`).toHaveLength(
        1,
      );
    },
  );

  it("1101-f1-03 control: without the kind rewrite, the same smaller report after finance closed the hold is found by the lookup and adds no row; nothing reopens", async () => {
    const w = await world();
    await legacyClosedHold(w, "f1-03", "recorder", false);
    const rows = (await h.allHolds(w.t.id)).length;

    await h.replayAll(reportOf(w, "recorder", REAL_IDR), 2);
    expect(
      (await h.allHolds(w.t.id)).length,
      "f1-03: identical identity after the decision adds no row",
    ).toBe(rows);
    expect(await h.openOf(w.t.id), "f1-03: nothing reopened").toHaveLength(0);
  });
});
