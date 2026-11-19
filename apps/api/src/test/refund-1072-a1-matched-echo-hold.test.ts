// (brief 1072, A1 = SO ronde 6 finding 1, P1, tier K "jangan sampai rugi"):
// red-first tests, written from docs/briefs/1072-refund-ronde6-q45.md and
// docs/qa/second-opinion-refund-ronde6-1068.md (finding 1) with the 1063-a
// fixture as the pattern, not from the implementation.
//
// Scenario: transaction T (Rp100.000, a payment code without a sales document)
// has OUR refund R of Rp30.000 with provider ref X. The provider then sends a
// signed `refund.succeeded` for X/T with Rp80.000, a bigger amount than our
// record of R. The webhook finds R by its id, but the amount is wrong: R must
// not be settled with it (that rejection stays) AND the intent must be held,
// because the provider says X returned Rp80.000. Without a hold, a new refund of
// Rp70.000 reaches the provider and the guest receives Rp150.000 for Rp100.000.
//
// Assumptions (the brief does not fix them):
//  - "hold open" = one open refund_recon_holds row of the intent with
//    provider_refund_id X and amount Rp80.000 ("hold senilai laporan penyedia",
//    accepted by CTO/founder). The reason text is not pinned.
//  - "R stays Rp30.000" = the payment_refunds row keeps status and amount
//    (completed/30.000, or approved/30.000 for the in-flight case).
//  - "request / approve / payout of Rp70.000": the request is refused 409/422
//    right away, or (if filed) the approve call is refused 409/422; in both
//    cases the refund gateway is not called again and no second refund row
//    reaches the provider.
//  - The provider fact is not booked on the matched path (no fact row for the
//    Rp80.000 report): the hold is the memory of it. Not asserted either way;
//    only the total of money counted is bounded.
//  - Control A1-03 (recorder door, `payment.refunded` status object) already
//    files the hold today (SO: recorder holds a bigger echo); A1-03 pins that
//    both doors follow the same rule. Control A1-04 (same amount) has no hold.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1072-a1-matched-echo-hold.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env";
import { applyRefundProviderUpdate } from "../services/payment-refund.service.ts";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1072a1");

// This suite pins the ACTIVE path (automatic DOIT refunds on): a signed success
// on a matched refund is judged as an echo of our refund. With the switch off
// that door only files one conflict hold (1103), pinned in the 1101 f2/f3 and
// 1072-b suites. Registered after the harness hooks, so these run after them.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = false;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const R_IDR = 30_000;
const REPORTED_IDR = 80_000;
const NEXT_IDR = 70_000;

/** Bill Rp100.000 paid; our refund R of Rp30.000 completed (or in flight). */
async function world(inFlight = false) {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = inFlight
    ? await h.ownPendingRefund(code, R_IDR)
    : await h.ownCompletedRefund(code, R_IDR);
  return { code, ...own };
}

async function expectHoldForReport(code: Code, x: string, label: string) {
  const open = await h.openOf(code.id);
  expect
    .soft(
      open.filter((row) => row.provider_refund_id === x),
      `${label}: one open hold for X (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    )
    .toHaveLength(1);
  expect
    .soft(
      open.find((row) => row.provider_refund_id === x)?.amount_idr,
      `${label}: the hold is worth what the provider reported`,
    )
    .toBe(REPORTED_IDR);
}

/** The next refund of Rp70.000 is refused and nothing more is sent to the guest. */
async function expectNextRefundBlocked(
  code: Code,
  callsBefore: number,
  rowsBefore: number,
  label: string,
) {
  const filed = await h.manualRefund(code.id, NEXT_IDR);
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
  expect(h.fake.calls, `${label}: port.refund not called again`).toHaveLength(
    callsBefore,
  );
  const sent = await h.count(
    `SELECT count(*)::text AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref IS NOT NULL`,
    [h.tenantId, code.id],
  );
  expect(sent, `${label}: no second refund reached the provider`).toBe(
    rowsBefore,
  );
}

describe("A1 (P1) a matched refund.succeeded with a bigger amount than our refund holds the intent", () => {
  it("1072-a1-01 R completed Rp30.000/X; signed refund.succeeded X/T Rp80.000 and its replays: an open hold of Rp80.000 for X, R stays completed Rp30.000, a new refund of Rp70.000 is refused and nothing more is sent", async () => {
    const t = await world();
    const callsBefore = h.fake.calls.length;
    const sentRowsBefore = 1;

    const answered = await h.deliver(
      h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
    );
    expect(answered.status, "signed report not rejected").not.toBe(401);
    await h.pollLater().catch(() => null);
    await h.runWorker();
    await expectHoldForReport(t.code, t.x, "first report");

    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectHoldForReport(t.code, t.x, "after replays (no second hold)");

    expect.soft(await h.refundRow(t.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(R_IDR),
      provider_ref: t.x,
    });
    await expectNextRefundBlocked(t.code, callsBefore, sentRowsBefore, "A1-01");
    expect(h.fake.calls, "no payout beyond R").toHaveLength(callsBefore);
  });

  it("1072-a1-02 R approved with ref X (in flight, not completed); signed refund.succeeded X/T Rp80.000: an open hold of Rp80.000, R is NOT settled with the wrong amount (still approved, Rp30.000), a new refund of Rp70.000 is refused and nothing more is sent", async () => {
    const t = await world(true);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectHoldForReport(t.code, t.x, "A1-02");

    const row = await h.refundRow(t.refundId);
    expect
      .soft(row.status, "R is not settled with the wrong amount")
      .not.toBe("completed");
    expect.soft(row.amount_idr).toBe(String(R_IDR));
    await expectNextRefundBlocked(t.code, callsBefore, 1, "A1-02");
  });

  it("1072-a1-03 control, same rule on the recorder door: the status-object payment.refunded X/T Rp80.000 (R completed Rp30.000) also leaves one open hold of Rp80.000 for X, R stays Rp30.000, the next refund of Rp70.000 is refused", async () => {
    const t = await world();
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectHoldForReport(t.code, t.x, "A1-03");
    expect.soft((await h.refundRow(t.refundId)).status).toBe("completed");
    await expectNextRefundBlocked(t.code, callsBefore, 1, "A1-03");
  });

  it("1072-a1-04 control: R approved with ref X (Rp30.000), refund.succeeded X/T of the SAME amount Rp30.000 settles R (completed), files no hold, books no fact; replays add nothing", async () => {
    const t = await world(true);
    const factsBefore = await h.providerRows(t.code.id);
    const holdsBefore = (await h.allHolds(t.code.id)).length;
    const eventsBefore = await h.refundEventsOfIntent(t.code.id);
    const callsBefore = h.fake.calls.length;

    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, R_IDR),
      2,
    );

    expect((await h.refundRow(t.refundId)).status, "R settled").toBe(
      "completed",
    );
    expect(
      await h.allHolds(t.code.id),
      "the echo of our own refund files no hold",
    ).toHaveLength(holdsBefore);
    expect(await h.providerRows(t.code.id), "no fact").toEqual(factsBefore);
    expect(await h.refundEventsOfIntent(t.code.id), "no event").toBe(
      eventsBefore,
    );
    expect(h.fake.calls, "nothing sent").toHaveLength(callsBefore);
    await h.expectMoneyWithinPaid(t.code, "A1-04");
  });

  it("1072-a1-05 two doors, one hold: refund.succeeded X/T Rp80.000 (matched) then payment.refunded X/T Rp80.000 (recorder) leave exactly ONE open hold of Rp80.000 for X; replays add none", async () => {
    const t = await world();
    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
      1,
    );
    await expectHoldForReport(t.code, t.x, "A1-05 after the matched door");
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectHoldForReport(t.code, t.x, "A1-05 after the recorder door");
    expect(
      (await h.allHolds(t.code.id)).filter(
        (row) => row.provider_refund_id === t.x,
      ),
      "exactly one hold row for X, open or closed",
    ).toHaveLength(1);
    expect.soft((await h.refundRow(t.refundId)).status).toBe("completed");
  });

  it("1072-a1-06 reverse order: payment.refunded X/T Rp80.000 (recorder) then refund.succeeded X/T Rp80.000 (matched) leave exactly ONE open hold of Rp80.000 for X; replays add none", async () => {
    const t = await world();
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, REPORTED_IDR),
      1,
    );
    await expectHoldForReport(t.code, t.x, "A1-06 after the recorder door");
    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectHoldForReport(t.code, t.x, "A1-06 after the matched door");
    expect(
      (await h.allHolds(t.code.id)).filter(
        (row) => row.provider_refund_id === t.x,
      ),
      "exactly one hold row for X, open or closed",
    ).toHaveLength(1);
    expect.soft((await h.refundRow(t.refundId)).status).toBe("completed");
  });

  // R3 (brief 1072 "Fix review 1"): our refund R ended `failed` (it carries ref
  // X, the provider later reports X as succeeded). Assumption: a signed success
  // report is never dropped silently: either a provider fact for X is booked or
  // an open hold for X exists (the conservative minimum). Set up by flipping R to
  // `failed` straight in the database (the failure event of the provider is not
  // part of this scenario).
  async function failedRWorld() {
    const t = await world(true);
    const flipped = await h.owner.query(
      "UPDATE payment_refunds SET status = 'failed' WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, t.refundId],
    );
    expect(flipped.rowCount, "premise: R is failed").toBe(1);
    return t;
  }
  async function expectReportKept(
    code: Code,
    x: string,
    amount: number,
    label: string,
  ) {
    const facts = (await h.providerRows(code.id)).filter(
      (row) => row.provider_refund_id === x,
    );
    const open = (await h.openOf(code.id)).filter(
      (row) => row.provider_refund_id === x,
    );
    expect(
      facts.reduce((sum, row) => sum + row.amount_idr, 0) >= amount ||
        open.some((row) => row.amount_idr >= amount),
      `${label}: the success report X/T ${amount} is neither a fact nor an open hold (facts ${JSON.stringify(facts)}, holds ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toBe(true);
  }

  it("1072-a1-07 R failed (ref X, Rp30.000); signed refund.succeeded X/T of the same Rp30.000 is kept as a fact or an open hold, never lost; replays add nothing", async () => {
    const t = await failedRWorld();
    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, R_IDR),
      1,
    );
    await expectReportKept(t.code, t.x, R_IDR, "A1-07");
    const after = {
      facts: await h.providerRows(t.code.id),
      holds: (await h.allHolds(t.code.id)).length,
    };
    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, R_IDR),
      2,
    );
    expect(await h.providerRows(t.code.id), "replays add no fact").toEqual(
      after.facts,
    );
    expect((await h.allHolds(t.code.id)).length, "replays add no hold").toBe(
      after.holds,
    );
    await h.expectMoneyWithinPaid(t.code, "A1-07");
  });

  it("1072-a1-08 R failed (ref X, Rp30.000); signed refund.succeeded X/T Rp80.000 is kept as a fact or an open hold of at least Rp80.000, and a new refund of Rp70.000 is refused", async () => {
    const t = await failedRWorld();
    const callsBefore = h.fake.calls.length;
    await h.replayAll(
      () => h.refundSucceededEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    await expectReportKept(t.code, t.x, REPORTED_IDR, "A1-08");
    // The failed R still carries ref X: one refund row reached the provider.
    await expectNextRefundBlocked(t.code, callsBefore, 1, "A1-08");
  });
  // ---- F-P1 / F-P2 (brief "Fix architect akhir") ----------------------------------
  //
  // Assumptions (the brief does not fix them):
  //  - a1-09: "R sent without ref" = approve with a scripted provider timeout (R
  //    approved, provider_ref NULL). The matched door finds R by id, so once the
  //    first report is held, R gets the ref X by an UPDATE of payment_refunds (the
  //    way the late provider answer would store it). R fails through the
  //    provider-update feed (applyRefundProviderUpdate), the real "R failed" path.
  //  - "CONFLICT" = the hold reason contains HOLD_TRANSACTION_CONFLICT (as in a2).
  //  - a1-10: the old hold of the same key is a CONFLICT hold X/T of Rp50.000 (a fact
  //    X/T Rp30.000 of the echo of R is seeded, as in a2; the report X/T Rp50.000 is
  //    bigger than that fact) closed by finance as not_this_intent (the only
  //    resolution a conflict hold allows). A later report X/T Rp80.000 is bigger than
  //    the closed hold: the closed hold must not swallow it. The surplus hold has no
  //    provider refund id (null), is open and worth the FULL Rp80.000.
  const CONFLICT = /HOLD_TRANSACTION_CONFLICT/i;

  const tenantContext = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: h.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );

  it("1072-a1-09 R sent without ref, payment.refunded X/T Rp30.000 holds (live-own), refund.succeeded X Rp80.000 matches R and escalates the hold to Rp80.000 CONFLICT; R then fails and the replay of payment.refunded X/T Rp30.000 keeps that hold open at Rp80.000; a new refund of Rp70.000 is refused", async () => {
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const filed = await h.manualRefund(code.id, R_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    h.fake.enqueue("throw");
    expect((await h.approveRefund(refundId)).status).toBe(200);
    const sent = await h.refundRow(refundId);
    expect(sent.provider_ref, "premise: R was sent without a ref").toBeNull();
    expect(sent.status, "premise: R is live").toBe("approved");
    const x = `rf_${randomBytes(6).toString("hex")}`;

    // 1. the provider reports X/T Rp30.000 while R is live without ref: live-own hold.
    await h.replayAll(() => h.refundIdEvent(code.providerRef, x, R_IDR), 1);
    const first = (await h.openOf(code.id)).filter(
      (row) => row.provider_refund_id === x,
    );
    expect(
      first.map((row) => row.amount_idr),
      `premise: one open hold X of Rp30.000 (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toEqual([R_IDR]);

    // 2. R gets the ref X; the signed refund.succeeded X Rp80.000 matches R, wrong amount.
    const stored = await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, refundId, x],
    );
    expect(stored.rowCount, "premise: R carries the ref X").toBe(1);
    await h.replayAll(
      () => h.refundSucceededEvent(code.providerRef, x, REPORTED_IDR),
      1,
    );
    const conflictOf = async () =>
      (await h.allHolds(code.id)).filter(
        (row) => row.provider_refund_id === x && CONFLICT.test(row.reason),
      );
    const escalated = await conflictOf();
    expect(
      escalated.map((row) => [row.amount_idr, row.resolved_at === null]),
      `the hold of X is escalated to Rp80.000 CONFLICT and open (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toEqual([[REPORTED_IDR, true]]);

    // 3. R fails (the provider-update feed); a failed R must not close that hold.
    await applyRefundProviderUpdate(tenantContext(), {
      providerRef: x,
      status: "failed",
      code: "declined",
    }).catch(() => null);
    expect((await h.refundRow(refundId)).status, "premise: R failed").toBe(
      "failed",
    );
    expect(
      (await conflictOf()).map((row) => [
        row.amount_idr,
        row.resolved_at === null,
      ]),
      "after R failed the escalated hold is still open at Rp80.000",
    ).toEqual([[REPORTED_IDR, true]]);

    // 4. the replay of payment.refunded X/T Rp30.000 does not close or shrink it.
    const callsBefore = h.fake.calls.length;
    await h.replayAll(() => h.refundIdEvent(code.providerRef, x, R_IDR), 2);
    expect(
      (await conflictOf()).map((row) => [
        row.amount_idr,
        row.resolved_at === null,
      ]),
      `after the replays the hold is open at Rp80.000, none closed automatically (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toEqual([[REPORTED_IDR, true]]);
    await expectNextRefundBlocked(code, callsBefore, 1, "A1-09");
  });

  it("1072-a1-10 a closed conflict hold X/T Rp50.000 (not_this_intent) does not swallow a bigger report: signed X/T Rp80.000 files a new open CONFLICT hold of the full Rp80.000 with no provider refund id, a new refund of Rp70.000 is refused, replays keep exactly one such hold", async () => {
    const t = await world();
    // The echo fact of R (as in a2): X/T Rp30.000 on the main transaction.
    const evidence = await h.owner.query<{ id: string }>(
      "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
      [h.tenantId, t.code.id, t.code.providerRef],
    );
    await h.owner.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
      [
        h.tenantId,
        h.outletId,
        t.code.id,
        evidence.rows[0]!.id,
        t.x,
        t.code.providerRef,
        R_IDR,
      ],
    );
    const factsBefore = await h.providerRows(t.code.id);
    const conflictsOf = async () =>
      (await h.allHolds(t.code.id)).filter((row) => CONFLICT.test(row.reason));

    // 1. report X/T Rp50.000 (bigger than the fact): a CONFLICT hold, then finance closes it.
    const SMALL_IDR = 50_000;
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, SMALL_IDR),
      1,
    );
    const old = (await conflictsOf()).filter((row) => row.resolved_at === null);
    expect(
      old.map((row) => [row.provider_refund_id, row.amount_idr]),
      `premise: one open conflict hold X of Rp50.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[t.x, SMALL_IDR]]);
    const closed = await h.resolveHold(old[0]!.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await h.openOf(t.code.id), "premise: nothing open").toEqual([]);

    // 2. the bigger signed report X/T Rp80.000 and its replays.
    const callsBefore = h.fake.calls.length;
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, REPORTED_IDR),
      2,
    );
    const surplus = (await conflictsOf()).filter(
      (row) => row.resolved_at === null,
    );
    expect(
      surplus.map((row) => [row.provider_refund_id, row.amount_idr]),
      `exactly one open surplus conflict hold, no ref id, the FULL Rp80.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[null, REPORTED_IDR]]);
    expect(
      await conflictsOf(),
      "the closed hold stays closed and only one hold was added",
    ).toHaveLength(2);
    expect(await h.providerRows(t.code.id), "the fact is unchanged").toEqual(
      factsBefore,
    );
    await expectNextRefundBlocked(t.code, callsBefore, 1, "A1-10");
  });

  it("1072-a1-11 after a closed conflict hold X/T Rp50.000 (not_this_intent), signed X/T Rp80.000 files a surplus of Rp80.000; a later signed X/T Rp90.000 raises that SAME surplus to Rp90.000 (still one open surplus), a replay of Rp70.000 does not lower it, and a new refund of Rp70.000 is refused", async () => {
    const t = await world();
    // Assumption: "surplus" = the open CONFLICT hold without provider refund id
    // (as in a1-10). "the SAME surplus" = the same hold row id, raised in place.
    // The echo fact of R (as in a1-10): X/T Rp30.000 on the main transaction.
    const evidence = await h.owner.query<{ id: string }>(
      "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
      [h.tenantId, t.code.id, t.code.providerRef],
    );
    await h.owner.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
      [
        h.tenantId,
        h.outletId,
        t.code.id,
        evidence.rows[0]!.id,
        t.x,
        t.code.providerRef,
        R_IDR,
      ],
    );
    const factsBefore = await h.providerRows(t.code.id);
    const conflictsOf = async () =>
      (await h.allHolds(t.code.id)).filter((row) => CONFLICT.test(row.reason));
    const openSurplus = async () =>
      (await conflictsOf()).filter((row) => row.resolved_at === null);
    const shape = (rows: Awaited<ReturnType<typeof openSurplus>>) =>
      rows.map((row) => [row.provider_refund_id, row.amount_idr]);

    // 1. X/T Rp50.000 files a CONFLICT hold, finance closes it (not_this_intent).
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, 50_000),
      1,
    );
    const old = await openSurplus();
    expect(
      shape(old),
      `premise: one open conflict hold X of Rp50.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[t.x, 50_000]]);
    const closed = await h.resolveHold(old[0]!.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await h.openOf(t.code.id), "premise: nothing open").toEqual([]);

    // 2. signed X/T Rp80.000: one open surplus of the full Rp80.000.
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, REPORTED_IDR),
      1,
    );
    const first = await openSurplus();
    expect(
      shape(first),
      `one open surplus of Rp80.000, no ref id (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[null, REPORTED_IDR]]);
    const surplusId = first[0]!.id;

    // 3. signed X/T Rp90.000: the same surplus rises to Rp90.000, no second one.
    const callsBefore = h.fake.calls.length;
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, 90_000),
      2,
    );
    const raised = await openSurplus();
    expect(
      shape(raised),
      `still ONE open surplus, now Rp90.000 (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[null, 90_000]]);
    expect(raised[0]!.id, "it is the same hold row, raised in place").toBe(
      surplusId,
    );
    expect(
      await conflictsOf(),
      "the closed hold stays closed; only the one surplus was added",
    ).toHaveLength(2);

    // 4. a replay of the smaller X/T Rp70.000 does not lower the surplus.
    await h.replayAll(
      () => h.refundIdEvent(t.code.providerRef, t.x, NEXT_IDR),
      2,
    );
    const afterLower = await openSurplus();
    expect(
      shape(afterLower),
      `the surplus is not lowered by a smaller report (holds: ${JSON.stringify(await h.allHolds(t.code.id))})`,
    ).toEqual([[null, 90_000]]);
    expect(afterLower[0]!.id, "still the same hold row").toBe(surplusId);
    expect(await h.providerRows(t.code.id), "the fact is unchanged").toEqual(
      factsBefore,
    );

    // 5. a new refund that goes beyond is refused, nothing more is sent.
    await expectNextRefundBlocked(t.code, callsBefore, 1, "A1-11");
  });
});
