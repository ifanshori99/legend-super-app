// (brief 1084 "Keputusan CTO", SO ronde 8 finding 3 = refund 1077 R3, P2, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde8-1077.md (finding 3), docs/briefs/1072-invarian.md
// (I4: a conflict hold closes only as `not_this_intent`) and the pattern of
// refund-1075-r4-unsent-smaller-success.test.ts (K3 case, r4-08) and
// refund-1072-a3-conflict-hold-no-counted.test.ts, not from the implementation.
//
// Rule under test (CTO decision): the conflict hold that a whole-transaction report
// (`payment.refunded`, status `refunded`, no refund id of its own) leaves on top of an
// R that finance settled by hand has a legal way out: finance may close it as
// `not_this_intent` (same permission and audit as any other hold resolve, payment.reconcile),
// once. `counted_against_intent` stays refused (409): no counted/binding fact on a
// conflict hold, so no money is opened beyond what is proven. Today both answers are
// refusals (not_this_intent answers 422 "synthetic"), so the reconciliation can never
// be closed through the API.
//
// Scenario: T Rp100.000, provider refunds off. R is approved (never sent) and then
// settled BY HAND, either the whole bill (Rp100.000) or a part (Rp30.000). The full
// status object of T (`refunded`) arrives: an open HOLD_TRANSACTION_CONFLICT hold.
//
// Rules pinned:
//   - counted_against_intent (plain) on that hold: 409, hold stays open, no fact;
//   - not_this_intent: 200, the hold closes with resolution `not_this_intent`, one audit
//     row is written;
//   - a second resolve is not 200 (409) and writes no second audit row;
//   - a replay of the whole-transaction report afterwards does not reopen a hold
//     (no new hold row, none open);
//   - refund rows, provider fact rows and journal events are the same before and after
//     the resolve and the replay (the resolve moves no money).
//
// Assumptions (the brief does not fix them):
//   - "R manual full and partial" = two cases, R of Rp100.000 and of Rp30.000, both
//     settled through settle-manually (channel bank_transfer, the harness default; the
//     SO names provider_dashboard, the harness does not expose it).
//   - The conflict hold is the open row with reason HOLD_TRANSACTION_CONFLICT_REASON.
//   - "Same permission as other hold resolve" = the harness' staff client with
//     payment.reconcile; the 403 / 401 guard is covered by refund-1025-d-resolve-hold.
//   - Audit is counted tenant-wide (audit_logs), as in refund-1025-d-resolve-hold.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1077-r3-synthetic-full-conflict-resolve.test.ts" heavy pnpm test

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";

const h = createRefundHarness("1077r3");

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

// Registered after the harness hooks, so these run after them.
beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
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

const auditCount = () =>
  h.count("SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1", [
    h.tenantId,
  ]);

/** Everything the resolve must not change. */
async function ledger(intentId: string) {
  return {
    refunds: (
      await h.owner.query(
        `SELECT id, status, amount_idr::text AS amount_idr, provider_ref
           FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2
          ORDER BY id`,
        [h.tenantId, intentId],
      )
    ).rows,
    facts: await h.providerRows(intentId),
    events: await h.refundEventsOfIntent(intentId),
  };
}

describe("R3 (P2) the synthetic full-refund conflict hold can be closed as not_this_intent, once", () => {
  it.each([
    ["1077-r3-01", "whole bill", BILL_IDR],
    ["1077-r3-02", "part of the bill", 30_000],
  ] as Array<[string, string, number]>)(
    "%s R settled by hand (%s), then the full `refunded` status arrives: counted_against_intent is refused 409, not_this_intent closes the hold once with an audit row, the replay does not reopen it, refund/fact/journal rows are unchanged",
    async (id, _label, rIdr) => {
      const code = await h.newCode(BILL_IDR);
      expect((await h.paid(code, BILL_IDR)).status).toBe(200);
      const filed = await h.manualRefund(code.id, rIdr);
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const refundId = filed.body.data.id as string;
      expect([200, 503]).toContain((await h.approveRefund(refundId)).status);
      expect(
        (await h.refundRow(refundId)).status,
        "premise: R queued, never sent",
      ).toBe("approved");
      const settled = await h.settleManually(refundId, rIdr);
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect((await h.refundRow(refundId)).status).toBe("completed");

      const full = () => h.doit.eventFor(code.providerRef, "refunded");
      await h.replayAll(full, 1);
      const conflicts = (await h.openOf(code.id)).filter(
        (row) => row.reason === HOLD_TRANSACTION_CONFLICT_REASON,
      );
      expect(
        conflicts,
        `${id} premise: one open conflict hold (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
      ).toHaveLength(1);
      const holdId = conflicts[0]!.id;
      const before = await ledger(code.id);

      // counted_against_intent stays refused.
      const counted = await h.resolveHold(holdId, "counted_against_intent");
      expect(
        counted.status,
        `${id}: counted on a conflict hold: ${JSON.stringify(counted.body)}`,
      ).toBe(409);
      const stillOpen = (await h.allHolds(code.id)).find(
        (row) => row.id === holdId,
      )!;
      expect(
        stillOpen.resolved_at,
        `${id}: refused counted leaves it open`,
      ).toBeNull();
      expect(stillOpen.matched_fact_id, `${id}: no fact bound`).toBeNull();

      // not_this_intent closes it, once, with an audit row.
      const auditBefore = await auditCount();
      const resolved = await h.resolveHold(holdId, "not_this_intent");
      expect(
        resolved.status,
        `${id}: not_this_intent closes the conflict hold: ${JSON.stringify(resolved.body)}`,
      ).toBe(200);
      const closed = (await h.allHolds(code.id)).find(
        (row) => row.id === holdId,
      )!;
      expect(closed.resolved_at, `${id}: hold is closed`).not.toBeNull();
      expect(closed.resolution).toBe("not_this_intent");
      expect(
        await auditCount(),
        `${id}: the resolve writes an audit row`,
      ).toBeGreaterThan(auditBefore);
      const auditAfterFirst = await auditCount();

      // A second resolve is a conflict and changes nothing.
      const again = await h.resolveHold(holdId, "not_this_intent");
      expect(
        again.status,
        `${id}: a second resolve is refused: ${JSON.stringify(again.body)}`,
      ).toBe(409);
      expect(await auditCount(), `${id}: no second audit row`).toBe(
        auditAfterFirst,
      );

      // The same report again does not reopen the reconciliation.
      const holdsAfterResolve = (await h.allHolds(code.id)).length;
      await h.replayAll(full, 2);
      expect(
        await h.openOf(code.id),
        `${id}: replay does not reopen a hold`,
      ).toHaveLength(0);
      expect(
        (await h.allHolds(code.id)).length,
        `${id}: replay adds no hold row`,
      ).toBe(holdsAfterResolve);

      expect(
        await ledger(code.id),
        `${id}: refund, fact and journal rows unchanged by resolve and replay`,
      ).toEqual(before);
      expect(h.fake.calls, `${id}: nothing reached the provider`).toHaveLength(
        0,
      );
    },
  );
});
