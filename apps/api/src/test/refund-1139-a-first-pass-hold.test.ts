// (brief 1139, P1-1 of docs/qa/second-opinion-refund-ronde14-1134.md, tier K "jangan sampai
// rugi"): red-first tests, written from the CTO decision in the brief and the SO report, on
// top of refund-1072-harness and refund-1119-support (pattern of
// refund-1126-unmatched-hold.test.ts), not from the implementation.
//
// Rule under test: a signed refund success that maps to a Legend payment but matches NO
// refund R of ours is held ON FIRST PROCESSING. It must not wait for the 15 minute retry
// window: inside the window the provider's dashboard refund must already reduce the refund
// room, or finance could pay the guest twice. One hold per stored event (stable key), also
// when the event is retried or replayed. The retry may still match an R later.
//
// Scenario: T paid Rp100.000, no refund of ours; the provider refunded Rp60.000 from its
// dashboard (signed success). Finance then tries a manual refund of Rp100.000.
//
// Rules pinned:
//   - minute 0 (the event is delivered, received_at NOT moved back): exactly one open
//     conflict hold of Rp60.000 exists at once; nothing booked (no fact, journal, outbox,
//     refund row, intent change, provider call);
//   - a manual refund of Rp100.000 (request, approve or settle) is refused; out <= paid;
//   - same with the switch DOIT_REFUNDS_ENABLED off and on, for the flat and the payment
//     object shape;
//   - minute 14 (still inside the window) and after minute 15: the worker retries, still
//     ONE hold, nothing booked, replays of the same event add none;
//   - retry that later matches our refund R: the money is not counted twice.
//
// Assumptions (the brief does not fix them):
//   - Shapes: as 1126 (flat `{ payment_id, amount }`, and nested `data.payment` +
//     `data.refund.amount`). Neither carries a refund id of ours.
//   - Minute N = received_at/updated_at moved back N minutes and the event put back as
//     `failed` (what the retry worker picks up); minute 0 moves nothing.
//   - Late match: the webhook arrives before R's provider ref X is recorded (the ref is
//     blanked in SQL), is held at first pass; the ref is restored and the worker retries:
//     the event now matches R (the legitimate echo, same ref and amount, completes R). The
//     decision says the hold is then closed through the normal fact route. Assumed correct:
//     R completed, no hold still open, at most one hold row ever, our refunds + facts <=
//     paid. If the hold stays open the Rp30.000 is counted twice (R and hold).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1139-a-first-pass-hold.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
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

const h = createRefundHarness("1139a");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;
const R_IDR = 30_000;

type World = { code: Code; reference: string };
type Shape = (w: World, amountIdr: number) => Record<string, unknown>;

async function paidWorld(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows T").toBeDefined();
  return { code, reference: payment!.reference };
}

const paymentObjectShape: Shape = (w, amountIdr) => ({
  payment: {
    id: w.code.providerRef,
    status: amountIdr >= BILL_IDR ? "refunded" : "partially_refunded",
    amount: amountIdr,
    reference: w.reference,
  },
  refund: { amount: amountIdr },
});

const flatNoIdShape: Shape = (w, amountIdr) => ({
  payment_id: w.code.providerRef,
  amount: amountIdr,
});

const envelope = (data: Record<string, unknown>) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data,
});

/** Put the stored event back as the retry worker finds it, `minutes` after it was received. */
const ageEvent = (eventId: string, minutes: number) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - ($3::int * interval '1 minute'),
            updated_at = now() - ($3::int * interval '1 minute')
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId, minutes],
  );

async function storedEventRowId(eventId: string) {
  const { rows } = await h.owner.query<{ id: string }>(
    `SELECT id FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );
  return rows.map((row) => row.id);
}

/** Minute 0: deliver and do NOT move received_at back. Only a rejected signature is a setup error. */
async function deliverNow(body: { id: string }) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
  expect(
    await storedEventRowId(body.id),
    "premise: the signed event is stored",
  ).toHaveLength(1);
}

async function ledger(w: World) {
  const intent = await h.owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, w.code.id],
  );
  return {
    facts: await h.providerRows(w.code.id),
    providerEvents: await h.refundEventsOfIntent(w.code.id),
    outbox: await h.count(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
      [h.tenantId, w.code.id],
    ),
    refunds: await h.refundRowCount(w.code.id),
    intentStatus: intent.rows[0]?.status,
    fakeCalls: h.fake.calls.length,
  };
}

/** The ONE open conflict hold of the stored event, worth the full report. */
async function expectOneConflictHold(
  w: World,
  eventId: string,
  amountIdr: number,
  label: string,
) {
  const holds = await h.allHolds(w.code.id);
  const dump = JSON.stringify(holds);
  expect(holds, `${label}: exactly ONE hold on T (${dump})`).toHaveLength(1);
  const hold = holds[0]!;
  expect(hold.resolved_at, `${label}: the hold is open (${dump})`).toBeNull();
  expect(hold.reason, `${label}: conflict reason`).toBe(
    HOLD_TRANSACTION_CONFLICT_REASON,
  );
  expect(hold.amount_idr, `${label}: the full reported value`).toBe(amountIdr);
  const { rows } = await h.owner.query<{ webhook_event_id: string }>(
    "SELECT webhook_event_id FROM refund_recon_holds WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, hold.id],
  );
  expect(
    [rows[0]?.webhook_event_id],
    `${label}: the hold key is the stored event`,
  ).toEqual(await storedEventRowId(eventId));
  return hold;
}

/** The dashboard refund of Rp60.000 is real: another Rp100.000 out is refused. */
async function expectManualRefused(w: World, label: string) {
  const probes: Probe[] = [];
  for (const amount of [BILL_IDR, BILL_IDR - REPORT_IDR + 1_000]) {
    const probe = await tryManualOut(h, w.code.id, amount);
    expectRefused(probe, label);
    probes.push(probe);
  }
  expectWorstCaseWithinPaid(REPORT_IDR, 0, probes, label);
}

async function firstPassHold(label: string, shape: Shape, switchOn: boolean) {
  flags.DOIT_REFUNDS_ENABLED = switchOn;
  const w = await paidWorld();
  const before = await ledger(w);
  const first = envelope(shape(w, REPORT_IDR));
  await deliverNow(first);

  await expectOneConflictHold(w, first.id, REPORT_IDR, `${label} minute 0`);
  expect(
    await ledger(w),
    `${label}: hold only, nothing booked or sent`,
  ).toEqual(before);

  await h.replayAll(() => first, 2);
  await expectOneConflictHold(w, first.id, REPORT_IDR, `${label} replays`);
  await expectManualRefused(w, label);
  return { w, first };
}

describe("1139 P1-1 a mapped refund success that matches no refund of ours is held on first processing", () => {
  it("1139-a-01 flat success, switch on, minute 0: one conflict hold at once, nothing booked, replays add none, manual Rp100.000 refused", async () => {
    await firstPassHold("1139-a-01", flatNoIdShape, true);
  });

  it("1139-a-02 flat success, switch off, minute 0: the same hold, manual Rp100.000 refused", async () => {
    await firstPassHold("1139-a-02", flatNoIdShape, false);
  });

  it("1139-a-03 payment object, switch on, minute 0: the same hold, manual Rp100.000 refused", async () => {
    await firstPassHold("1139-a-03", paymentObjectShape, true);
  });

  it("1139-a-04 payment object, switch off, minute 0: the same hold, manual Rp100.000 refused", async () => {
    await firstPassHold("1139-a-04", paymentObjectShape, false);
  });

  for (const switchOn of [true, false]) {
    it(`1139-a-05 minute 14 (inside the window, switch ${switchOn ? "on" : "off"}): the worker retry keeps ONE hold, nothing booked, manual Rp100.000 refused`, async () => {
      flags.DOIT_REFUNDS_ENABLED = switchOn;
      const w = await paidWorld();
      const before = await ledger(w);
      const first = envelope(flatNoIdShape(w, REPORT_IDR));
      await deliverNow(first);
      await ageEvent(first.id, 14);
      await h.runWorker();
      await h.runWorker();
      await expectOneConflictHold(w, first.id, REPORT_IDR, "minute 14");
      expect(await ledger(w), "minute 14: nothing booked or sent").toEqual(
        before,
      );
      await expectManualRefused(w, "minute 14");
    });

    it(`1139-a-06 after minute 15 (switch ${switchOn ? "on" : "off"}): the retry makes no second hold, nothing counted twice, manual Rp100.000 refused`, async () => {
      flags.DOIT_REFUNDS_ENABLED = switchOn;
      const w = await paidWorld();
      const before = await ledger(w);
      const first = envelope(flatNoIdShape(w, REPORT_IDR));
      await deliverNow(first);
      await expectOneConflictHold(w, first.id, REPORT_IDR, "minute 0");
      await ageEvent(first.id, 30);
      await h.runWorker();
      await h.runWorker();
      await ageEvent(first.id, 40);
      await h.runWorker();
      await expectOneConflictHold(w, first.id, REPORT_IDR, "after minute 15");
      expect(await ledger(w), "after minute 15: nothing booked").toEqual(
        before,
      );
      await expectManualRefused(w, "after minute 15");
    });
  }

  it("1139-a-07 the retry later matches our refund R (fact route): the hold is closed, R completes, the money is not counted twice", async () => {
    flags.DOIT_REFUNDS_ENABLED = true;
    const code = await h.newCode(BILL_IDR);
    expect((await h.paid(code, BILL_IDR)).status).toBe(200);
    const own = await h.ownPendingRefund(code, R_IDR);
    // The webhook outruns the recording of R's ref X: nothing matches at first processing.
    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = NULL WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId],
    );
    const echo = h.refundSucceededEvent(code.providerRef, own.x, R_IDR);
    await deliverNow(echo);
    const held = await h.allHolds(code.id);
    expect(
      held,
      `premise: held on first processing, once (${JSON.stringify(held)})`,
    ).toHaveLength(1);

    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId, own.x],
    );
    await ageEvent(echo.id, 30);
    await h.runWorker();
    await h.runWorker();

    const holds = await h.allHolds(code.id);
    const dump = JSON.stringify(holds);
    expect(holds.length, `at most one hold row ever (${dump})`).toBeLessThan(2);
    expect(
      holds.filter((hold) => hold.resolved_at === null),
      `the hold is closed once R is matched, not counted next to R (${dump})`,
    ).toHaveLength(0);
    expect(
      (await h.refundRow(own.refundId)).status,
      "R completed by its echo",
    ).toBe("completed");
    await h.expectMoneyWithinPaid(code, "1139-a-07");
  });
});
