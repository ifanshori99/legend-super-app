// (brief 1072 "Ronde 7b: I9", CTO decision 18 Nov, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md (Ronde 7b) with
// the pattern of refund-1075-r3-matched-unproven-success.test.ts, not from the
// implementation.
//
// Rule under test: a provider success that is SMALLER than our refund R is a
// legitimate echo of R only when R was really sent to the provider. An approved R
// that was never sent (the manual queue of Q45, refunds through the provider off)
// plus a provider success means the guest already got money; if finance then pays R
// by hand the guest is paid twice. So that success must leave an OPEN conflict hold,
// R stays queued, finance cannot settle R by hand, and no new refund is allowed.
//
// Scenario: transaction T Rp100.000, R of Rp30.000 approved with the provider refund
// switch OFF (never sent: no ref, no attempt), then a signed provider success of
// Rp20.000 arrives.
//
// Assumptions (the brief does not fix them):
//  - "Flag off" = `env.DOIT_REFUNDS_ENABLED = false` in the test process, with the
//    fake refund port registered (as refund-1072-b-doit-refunds-disabled.test.ts);
//    the flag is restored afterwards. "Sent" is observed through the stored refund:
//    approved, provider_ref null, payout_attempts 0, and the fake port never called.
//  - Event (a) = the DOIT sandbox refund object keyed `refund:<R>` with a provider
//    refund id Y of its own (as r3). Event (b) = the `payment.refunded` status object
//    (the recorder door) with a refund id Z, amount Rp20.000. For (b) the brief says
//    "when the path can reach R", so the expectation is the same as (a): an open hold.
//  - "open hold" = at least one open refund_recon_holds row of the intent worth at
//    least the reported amount. Reason text, id kind and exact amount are not pinned.
//  - "finance cannot settle R by hand" = settle-manually answers 409 or 422 and R
//    stays approved (not completed). "No new refund" = a refund of Rp70.000 is refused
//    (409/422, at request or approve) and the fake port is not called.
//  - Total money out stays within the Rp100.000 paid: our refunds not failed plus
//    provider facts (the harness' conservative net) <= Rp100.000.
//  - Replays (new event id and the identical event again) never add a hold row.
//  - Controls (flag ON, legacy fake port): R approved and really sent with ref X
//    (in flight, or completed), signed success carrying X with Rp20.000 is a normal
//    echo: no hold is filed and R is not failed.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1075-r4-unsent-smaller-success.test.ts" heavy pnpm test

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

const h = createRefundHarness("1075r4");

const R_IDR = 30_000;
const SMALLER_IDR = 20_000;
const NEXT_IDR = 70_000;

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

/** Sandbox refund object matched to R by its idempotency key. */
const keyedSuccess = (
  code: Code,
  refundId: string,
  providerRefundId: string,
  amount: number,
) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    id: providerRefundId,
    idempotency_key: `refund:${refundId}`,
    payment_id: code.providerRef,
    status: "succeeded",
    amount,
  },
});

/** Bill Rp100.000 paid; R of Rp30.000 approved but never sent (provider refunds off). */
async function unsentWorld() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const filed = await h.manualRefund(code.id, R_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  const approved = await h.approveRefund(refundId);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect(
    await h.refundRow(refundId),
    "premise: R is queued, never sent",
  ).toMatchObject({
    status: "approved",
    provider_ref: null,
    payout_attempts: 0,
    amount_idr: String(R_IDR),
  });
  expect(h.fake.calls, "premise: the port was never called").toHaveLength(0);
  return { code, refundId };
}

/** Finance cannot pay R by hand and no new refund of the rest of the bill is allowed. */
async function expectNothingMoreCanBePaid(
  t: { code: Code; refundId: string },
  label: string,
) {
  const settled = await h.settleManually(t.refundId, R_IDR);
  expect(
    [409, 422],
    `${label}: settling R by hand is refused: ${JSON.stringify(settled.body)}`,
  ).toContain(settled.status);
  expect(
    (await h.refundRow(t.refundId)).status,
    `${label}: R is not settled`,
  ).toBe("approved");

  const filed = await h.manualRefund(t.code.id, NEXT_IDR);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${NEXT_IDR}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect(
      [409, 422],
      `${label}: requesting ${NEXT_IDR}: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(h.fake.calls, `${label}: nothing reached the provider`).toHaveLength(
    0,
  );
  await h.expectMoneyWithinPaid(t.code, label);
}

/** The report left an open hold worth at least `atLeast`, R untouched, nothing more payable. */
async function expectHeldAndBlocked(
  t: { code: Code; refundId: string },
  makeEvent: () => object,
  label: string,
) {
  await h.replayAll(makeEvent, 1);
  const open = await h.openOf(t.code.id);
  expect(
    open.some((row) => row.amount_idr >= SMALLER_IDR),
    `${label}: an open hold of at least ${SMALLER_IDR} exists (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
  ).toBe(true);
  const holdsAfterFirst = (await h.allHolds(t.code.id)).length;

  await h.replayAll(makeEvent, 2);
  expect(
    (await h.allHolds(t.code.id)).length,
    `${label}: replays of the same evidence add no hold`,
  ).toBe(holdsAfterFirst);

  expect(
    await h.refundRow(t.refundId),
    `${label}: R is not touched`,
  ).toMatchObject({
    status: "approved",
    provider_ref: null,
    payout_attempts: 0,
    amount_idr: String(R_IDR),
  });
  await expectNothingMoreCanBePaid(t, label);
}

describe("I9 (P1) a smaller provider success is an echo only when R was really sent", () => {
  it("1075-r4-01 (a) flag off, R Rp30.000 approved and never sent; signed refund.succeeded keyed refund:R with its own refund id and Rp20.000: an open hold, R stays approved, settling R by hand is refused, a refund of Rp70.000 is refused, money out stays within Rp100.000", async () => {
    const t = await unsentWorld();
    const y = `rf_${randomBytes(6).toString("hex")}`;
    await expectHeldAndBlocked(
      t,
      () => keyedSuccess(t.code, t.refundId, y, SMALLER_IDR),
      "r4-01",
    );
  });

  it("1075-r4-02 (b) flag off, R Rp30.000 approved and never sent; signed payment.refunded (recorder door) with refund id Z and Rp20.000: an open hold, R stays approved, settling R by hand is refused, a refund of Rp70.000 is refused", async () => {
    const t = await unsentWorld();
    const z = `rf_${randomBytes(6).toString("hex")}`;
    await expectHeldAndBlocked(
      t,
      () => h.refundIdEvent(t.code.providerRef, z, SMALLER_IDR),
      "r4-02",
    );
  });

  it("1075-r4-03 (c) the same keyed Rp20.000 success delivered again and again (identical event, then fresh event ids, poller and worker): exactly one open hold, R still approved and unsettled", async () => {
    const t = await unsentWorld();
    const y = `rf_${randomBytes(6).toString("hex")}`;
    const same = keyedSuccess(t.code, t.refundId, y, SMALLER_IDR);

    await h.deliver(same);
    await h.deliver(same);
    await h.pollLater().catch(() => null);
    await h.runWorker();
    await h.replayAll(
      () => keyedSuccess(t.code, t.refundId, y, SMALLER_IDR),
      2,
    );

    const open = await h.openOf(t.code.id);
    expect(
      open,
      `exactly one open hold after all replays (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toHaveLength(1);
    expect(open[0]!.amount_idr).toBeGreaterThanOrEqual(SMALLER_IDR);
    expect((await h.refundRow(t.refundId)).status).toBe("approved");
    await h.expectMoneyWithinPaid(t.code, "r4-03");
  });

  it("1075-r4-04 control (premise): flag off, R approved and never sent, no provider report: finance settles R by hand (200) and R is completed", async () => {
    const t = await unsentWorld();
    const settled = await h.settleManually(t.refundId, R_IDR);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await h.refundRow(t.refundId)).status).toBe("completed");
    expect(h.fake.calls, "settled by hand: nothing sent").toHaveLength(0);
    await h.expectMoneyWithinPaid(t.code, "r4-04");
  });

  it("1075-r4-08 (K3) flag off, R Rp30.000 approved, never sent, then settled BY HAND (completed outside the provider); signed payment.refunded status object for the WHOLE bill (Rp100.000, no refund id) arrives: it is still counted as ours but leaves an open conflict hold of at least Rp30.000 (the by-hand money; the hold may be larger, restrictive), replays add no hold, a refund of Rp70.000 is refused", async () => {
    const t = await unsentWorld();
    const settled = await h.settleManually(t.refundId, R_IDR);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await h.refundRow(t.refundId)).status).toBe("completed");

    const full = () => h.doit.eventFor(t.code.providerRef, "refunded");
    await h.replayAll(full, 1);
    const open = await h.openOf(t.code.id);
    expect(
      open.some(
        (row) =>
          row.reason === HOLD_TRANSACTION_CONFLICT_REASON &&
          row.amount_idr >= R_IDR,
      ),
      `r4-08: an open HOLD_TRANSACTION_CONFLICT hold of at least the by-hand R (${R_IDR}) exists (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toBe(true);
    const holdsAfterFirst = (await h.allHolds(t.code.id)).length;

    await h.replayAll(full, 2);
    expect(
      (await h.allHolds(t.code.id)).length,
      "r4-08: replays add no hold",
    ).toBe(holdsAfterFirst);
    expect((await h.refundRow(t.refundId)).status).toBe("completed");

    const filed = await h.manualRefund(t.code.id, NEXT_IDR);
    expect(
      [409, 422],
      `r4-08: requesting ${NEXT_IDR}: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
    expect(h.fake.calls, "r4-08: nothing reached the provider").toHaveLength(0);
    await h.expectMoneyWithinPaid(t.code, "r4-08");
  });

  // B-1 control (architect finding on I9), real behaviour observed on the fixed
  // services. Wrong order = report first, then settle: r4-02 holds it and refuses the
  // settle. Right order = finance settles R by hand FIRST (R completed, no ref), then
  // a partial `payment.refunded` (Rp30.000, its own refund id Z, not the whole bill)
  // arrives. Observed: the report is booked as the provider's own fact (one row, Z,
  // Rp30.000, one provider-refunded event, counted against the bill) and NO hold is
  // filed: the by-hand money and the provider money add up to Rp60.000, within the
  // Rp100.000 paid, so nothing is left open. K1 needs an unsent approved R (R is
  // completed), K2 and K3 need a matching ref or a whole-bill report.
  it("1075-r4-09 control (B-1 right order): flag off, R settled by hand FIRST, then a signed payment.refunded Rp30.000 with its own refund id (not the whole bill): booked as one provider fact of Rp30.000, no hold filed, replays add nothing, R stays completed, money out (Rp60.000) stays within Rp100.000", async () => {
    const t = await unsentWorld();
    const settled = await h.settleManually(t.refundId, R_IDR);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const z = `rf_${randomBytes(6).toString("hex")}`;
    const report = () => h.refundIdEvent(t.code.providerRef, z, R_IDR);

    await h.replayAll(report, 1);
    expect(
      await h.allHolds(t.code.id),
      "r4-09: no hold: the report fits within what was paid",
    ).toHaveLength(0);
    const facts = await h.providerRows(t.code.id);
    expect(facts, "r4-09: one foreign fact").toHaveLength(1);
    expect(facts[0]).toMatchObject({
      provider_refund_id: z,
      amount_idr: R_IDR,
    });
    const events = await h.refundEventsOfIntent(t.code.id);
    expect(events).toBe(1);

    await h.replayAll(report, 2);
    expect(
      await h.allHolds(t.code.id),
      "r4-09: replays add no hold",
    ).toHaveLength(0);
    expect(
      await h.providerRows(t.code.id),
      "r4-09: replays add no fact",
    ).toEqual(facts);
    expect(await h.refundEventsOfIntent(t.code.id)).toBe(events);
    expect((await h.refundRow(t.refundId)).status).toBe("completed");
    expect(
      (await h.ourRefundedIdr(t.code.id)) + (await h.factTotal(t.code.id)),
    ).toBe(2 * R_IDR);
  });

  it("1075-r4-10 (L1) T Rp100.000; R1 Rp30.000 settled BY HAND; R2 Rp50.000 sent and live with ref X2 (approved, in flight); signed payment.refunded status object for the WHOLE bill (Rp100.000, no refund id): the hold stays at least Rp70.000 (the live R2 plus by-hand R1 are not swallowed by a smaller hold), replays add no hold, R1 stays completed and R2 is not failed", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);

    // R1: queued with provider refunds off, then paid by hand.
    const filed1 = await h.manualRefund(code.id, R_IDR);
    expect(filed1.status, JSON.stringify(filed1.body)).toBe(201);
    const r1 = filed1.body.data.id as string;
    expect([200, 503]).toContain((await h.approveRefund(r1)).status);
    const settled = await h.settleManually(r1, R_IDR);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await h.refundRow(r1)).status, "premise: R1 settled by hand").toBe(
      "completed",
    );

    // R2: really sent (provider refunds on), left in flight with ref X2.
    flags.DOIT_REFUNDS_ENABLED = true;
    setPaymentRefundGateway(h.fake);
    const r2 = await h.ownPendingRefund(code, 50_000);
    flags.DOIT_REFUNDS_ENABLED = false;

    const full = () => h.doit.eventFor(code.providerRef, "refunded");
    await h.replayAll(full, 1);
    const open = await h.openOf(code.id);
    expect(
      open.some((row) => row.amount_idr >= 70_000),
      `r4-10: an open hold of at least 70000 exists (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBe(true);
    const holdsAfterFirst = (await h.allHolds(code.id)).length;

    await h.replayAll(full, 2);
    expect(
      (await h.allHolds(code.id)).length,
      "r4-10: replays add no hold",
    ).toBe(holdsAfterFirst);
    expect(
      (await h.openOf(code.id)).some((row) => row.amount_idr >= 70_000),
      "r4-10: the big hold is still open after replays",
    ).toBe(true);
    expect((await h.refundRow(r1)).status).toBe("completed");
    expect((await h.refundRow(r2.refundId)).status).not.toBe("failed");
  });

  it("1075-r4-11 (L2) flag off, R Rp30.000 still PENDING (requested, not yet approved); signed payment.refunded Rp20.000 (a dashboard refund, own refund id) arrives: an open hold of at least Rp20.000, approving R is refused, settling R by hand is refused, R stays pending, replays add no hold", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const filed = await h.manualRefund(code.id, R_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    expect((await h.refundRow(refundId)).status, "premise: R is pending").toBe(
      "pending",
    );
    const z = `rf_${randomBytes(6).toString("hex")}`;
    const report = () => h.refundIdEvent(code.providerRef, z, SMALLER_IDR);

    await h.replayAll(report, 1);
    expect(
      (await h.openOf(code.id)).some((row) => row.amount_idr >= SMALLER_IDR),
      `r4-11: an open hold of at least ${SMALLER_IDR} exists (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBe(true);
    const holdsAfterFirst = (await h.allHolds(code.id)).length;

    await h.replayAll(report, 2);
    expect(
      (await h.allHolds(code.id)).length,
      "r4-11: replays add no hold",
    ).toBe(holdsAfterFirst);

    const approved = await h.approveRefund(refundId);
    expect(
      [409, 422],
      `r4-11: approving R is refused: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
    const settled = await h.settleManually(refundId, R_IDR);
    expect(
      [409, 422],
      `r4-11: settling R by hand is refused: ${JSON.stringify(settled.body)}`,
    ).toContain(settled.status);
    expect((await h.refundRow(refundId)).status, "r4-11: R stays pending").toBe(
      "pending",
    );
    expect(h.fake.calls, "r4-11: nothing reached the provider").toHaveLength(0);
  });

  describe("controls: R really sent to the provider (flag on)", () => {
    beforeEach(() => {
      flags.DOIT_REFUNDS_ENABLED = true;
      setPaymentRefundGateway(h.fake);
    });

    it("1075-r4-05 control: R approved and in flight with provider ref X; signed success keyed refund:R carrying X with Rp20.000 is a legitimate echo: no hold is filed and R is not failed", async () => {
      const code = await h.newCode(BILL_IDR);
      expect((await h.paid(code, BILL_IDR)).status).toBe(200);
      const own = await h.ownPendingRefund(code, R_IDR);
      const holdsBefore = (await h.allHolds(code.id)).length;

      await h.replayAll(
        () => keyedSuccess(code, own.refundId, own.x, SMALLER_IDR),
        2,
      );

      expect(
        await h.allHolds(code.id),
        "an echo of our sent refund files no hold",
      ).toHaveLength(holdsBefore);
      expect(await h.openOf(code.id)).toHaveLength(0);
      const row = await h.refundRow(own.refundId);
      expect(row.status).not.toBe("failed");
      expect(row.provider_ref).toBe(own.x);
      await h.expectMoneyWithinPaid(code, "r4-05");
    });

    it("1075-r4-06 control: R completed through the provider with ref X; signed success keyed refund:R carrying X with Rp20.000 is a legitimate echo: no hold is filed, R stays completed with ref X", async () => {
      const code = await h.newCode(BILL_IDR);
      expect((await h.paid(code, BILL_IDR)).status).toBe(200);
      const own = await h.ownCompletedRefund(code, R_IDR);
      const holdsBefore = (await h.allHolds(code.id)).length;

      await h.replayAll(
        () => keyedSuccess(code, own.refundId, own.x, SMALLER_IDR),
        2,
      );

      expect(
        await h.allHolds(code.id),
        "an echo of our completed refund files no hold",
      ).toHaveLength(holdsBefore);
      expect(await h.openOf(code.id)).toHaveLength(0);
      expect(await h.refundRow(own.refundId)).toMatchObject({
        status: "completed",
        provider_ref: own.x,
        amount_idr: String(R_IDR),
      });
      await h.expectMoneyWithinPaid(code, "r4-06");
    });

    it("1075-r4-07 (K2) R sent with ref X, then settled BY HAND (provider lookup said failed, so R is completed outside the provider, ref X kept); signed payment.refunded for X/T Rp30.000 is NOT an echo of R: an open hold of at least Rp30.000, R stays completed, replays add no hold, a refund of Rp70.000 is refused, money out stays within Rp100.000", async () => {
      const code = await h.newCode(BILL_IDR);
      expect((await h.paid(code, BILL_IDR)).status).toBe(200);
      const own = await h.ownPendingRefund(code, R_IDR);
      // Settling a traced refund by hand needs the provider to say it failed.
      h.fake.setStatus(`refund:${own.refundId}`, {
        status: "failed",
        providerRef: own.x,
        code: "declined",
      });
      // A live traced refund is settled by the provider lookup (409
      // REFUND_AT_PROVIDER). By hand is only for a stuck one: as in
      // refund-1072-b-doit-refunds-disabled.test.ts (R1), stamp R as stuck with
      // attempts and polls spent and the flag off.
      await h.owner.query(
        `UPDATE payment_refunds
            SET payout_attempts = 8, payout_pending_polls = 3,
                last_payout_error = 'MANUAL_RECONCILIATION',
                updated_at = now() - interval '2 hours'
          WHERE tenant_id = $1 AND id = $2`,
        [h.tenantId, own.refundId],
      );
      flags.DOIT_REFUNDS_ENABLED = false;
      const settled = await h.settleManually(own.refundId, R_IDR);
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect(
        await h.refundRow(own.refundId),
        "premise: R settled by hand",
      ).toMatchObject({
        status: "completed",
        provider_ref: own.x,
        amount_idr: String(R_IDR),
      });
      const callsBefore = h.fake.calls.length;
      const holdsBefore = (await h.allHolds(code.id)).length;

      const report = () => h.refundIdEvent(code.providerRef, own.x, R_IDR);
      await h.replayAll(report, 1);
      const open = await h.openOf(code.id);
      expect(
        open.some((row) => row.amount_idr >= R_IDR),
        `r4-07: the report is held, not swallowed as the echo of the by-hand R (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
      ).toBe(true);
      const holdsAfterFirst = (await h.allHolds(code.id)).length;
      expect(holdsAfterFirst).toBeGreaterThan(holdsBefore);

      await h.replayAll(report, 2);
      expect(
        (await h.allHolds(code.id)).length,
        "r4-07: replays add no hold",
      ).toBe(holdsAfterFirst);
      expect((await h.refundRow(own.refundId)).status).toBe("completed");

      const filed = await h.manualRefund(code.id, NEXT_IDR);
      if (filed.status === 201) {
        const approved = await h.approveRefund(filed.body.data.id as string);
        expect(
          [409, 422],
          `r4-07: approving ${NEXT_IDR}: ${JSON.stringify(approved.body)}`,
        ).toContain(approved.status);
      } else {
        expect(
          [409, 422],
          `r4-07: requesting ${NEXT_IDR}: ${JSON.stringify(filed.body)}`,
        ).toContain(filed.status);
      }
      expect(
        h.fake.calls,
        "r4-07: nothing more reached the provider",
      ).toHaveLength(callsBefore);
      await h.expectMoneyWithinPaid(code, "r4-07");
    });
  });
});
