// (brief 1126, refund unmatched wajib hold, tier K "jangan sampai rugi"): red-first tests,
// written from docs/briefs/1126-refund-unmatched-hold.md (CTO decisions 1 and 2) and the
// docs/briefs/1072-invarian.md rules, on top of refund-1072-harness and refund-1119-support
// (pattern of refund-1108-p1-1-switch-off-payment-object.test.ts), not from the implementation.
//
// Rule under test (CTO decision 1): a signed refund success that names a Legend payment
// (a payment id or reference that maps to a payment) but matches NO refund R of ours (a
// payment object with no candidate R; a flat success without refund id) is held: ONE
// CONFLICT hold per stored event (stable key = the stored event's id, worth the whole
// reported amount), open in the finance queue, and nothing else: no fact, no journal event,
// no refund row, no provider call. A refund made in the provider's dashboard then reduces the
// refund room, so a manual refund cannot pay the guest twice.
// Decision 2: a payment that cannot be mapped at all: the event is stored and finance is
// alerted (existing pattern), NO hold.
//
// Scenario: T paid Rp100.000, no refund of ours on T at all, a signed success of Rp60.000.
//
// Rules pinned:
//   - exactly ONE hold on T: open, conflict reason, no refund id, amount Rp60.000, its
//     webhook_event_id is the id of the stored `gateway_webhook_events` row of the event;
//   - no fact, no `payment.provider_refunded` journal event, no outbox event, no refund row,
//     intent status unchanged, provider not asked;
//   - the same stored event delivered again and a worker retry add no hold row;
//   - finance's counted_against_intent on that conflict hold is refused 409 (it stays open);
//   - a manual refund of Rp60.000 (and anything above the remaining room of Rp40.000) is
//     refused at request, approve or settle; worst case out <= paid;
//   - switch off: same hold-only result (hold rule does not depend on the switch);
//   - unmappable payment: event stored, no hold, no fact, no refund (the finance alert is NOT
//     asserted, see the assumption below);
//   - table: reported amount + accepted manual refunds <= paid for the unmatched shapes.
//
// Assumptions (the brief does not fix them):
//   - "Past the retry window": an unmatched event is answered 5xx and retried for a while
//     (15 minutes, see refund-1108-p1-1b). Like the other 1108/1119 tests the stored event is
//     put back as `failed`, 30 minutes old, then the harness worker runs. Nothing is pinned
//     about the hold INSIDE the window (decision unclear: hold at once, or only after).
//   - Payment-object shape: nested `data.payment` + `data.refund.amount` (as 1108-p1-1). Flat
//     shape without refund id: `data = { payment_id, amount }`. Neither carries a key
//     `refund:<R>`.
//   - Hold amount = the reported amount (Rp60.000), not the whole payment (brief: "nilai
//     penuh laporan"). The conflict hold carries no refund id.
//   - Open conflict hold counted_against_intent -> 409 (as refund-1108-p1-1 and
//     refund-1072-a3): kept because the decision says "tanpa fact".
//   - The finance alert of decision 2 is not asserted: the harness only observes outlet
//     supervisor notifications, and an unmappable payment has no outlet (a first run showed
//     none arrives there). Who is alerted and where is a design question for the CTO.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1126-unmatched-hold.test.ts" heavy pnpm test

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

const h = createRefundHarness("1126a");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;

type World = { code: Code; reference: string };
type Shape = (w: World, amountIdr: number) => Record<string, unknown>;

async function paidWorld(): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const payment = h.doit.payments.get(code.providerRef);
  expect(payment, "premise: the fake DOIT knows T").toBeDefined();
  return { code, reference: payment!.reference };
}

/** Payment object, no candidate R: nested `payment` + readable `refund.amount`. */
const paymentObjectShape: Shape = (w, amountIdr) => ({
  payment: {
    id: w.code.providerRef,
    status: amountIdr >= BILL_IDR ? "refunded" : "partially_refunded",
    amount: amountIdr,
    reference: w.reference,
  },
  refund: { amount: amountIdr },
});

/** Flat success without refund id and without key. */
const flatNoIdShape: Shape = (w, amountIdr) => ({
  payment_id: w.code.providerRef,
  amount: amountIdr,
});

const envelope = (data: Record<string, unknown>, id?: string) => ({
  id: id ?? `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data,
});

/** The state of a stored event the worker retries, past the retry window. */
const markFailed = (eventId: string) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );

/** Webhook row of an event id (the stored event). */
async function storedEvent(eventId: string) {
  const { rows } = await h.owner.query<{
    id: string;
    signature_valid: boolean;
    status: string;
  }>(
    `SELECT id, signature_valid, status FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );
  return rows;
}

/**
 * Deliver, then let the retry window pass (the worker retries the stored event). The first
 * answer may be 5xx inside the window (the provider resends); only a rejected signature is
 * a setup error.
 */
async function deliverPastWindow(body: { id: string }) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
  expect(
    await storedEvent(body.id),
    "premise: the signed event is stored",
  ).toHaveLength(1);
  await markFailed(body.id);
  await h.runWorker();
  await h.runWorker();
}

/** Everything a hold-only event must not change. */
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

/** The ONE conflict hold of the stored event: full reported value, keyed by the event. */
async function expectOneConflictHold(
  w: World,
  eventId: string,
  amountIdr: number,
  label: string,
) {
  const holds = await h.allHolds(w.code.id);
  const dump = JSON.stringify(holds);
  expect(
    holds,
    `${label}: exactly ONE hold on T (holds: ${dump})`,
  ).toHaveLength(1);
  const hold = holds[0]!;
  expect(hold.resolved_at, `${label}: the hold is open (${dump})`).toBeNull();
  expect(hold.reason, `${label}: conflict reason`).toBe(
    HOLD_TRANSACTION_CONFLICT_REASON,
  );
  expect(hold.amount_idr, `${label}: the full reported value`).toBe(amountIdr);
  expect(hold.provider_refund_id, `${label}: no refund id`).toBeNull();
  const stored = await storedEvent(eventId);
  const { rows } = await h.owner.query<{ webhook_event_id: string }>(
    "SELECT webhook_event_id FROM refund_recon_holds WHERE tenant_id = $1 AND id = $2",
    [h.tenantId, hold.id],
  );
  expect(
    rows[0]?.webhook_event_id,
    `${label}: the hold key is the stored event id`,
  ).toBe(stored[0]?.id);
  return hold;
}

async function unmatchedHoldScenario(
  label: string,
  shape: Shape,
  switchOn: boolean,
) {
  flags.DOIT_REFUNDS_ENABLED = switchOn;
  const w = await paidWorld();
  const before = await ledger(w);
  const first = envelope(shape(w, REPORT_IDR));
  await deliverPastWindow(first);

  const hold = await expectOneConflictHold(w, first.id, REPORT_IDR, label);
  expect(
    await ledger(w),
    `${label}: no fact, journal or outbox event, refund, intent change or provider call`,
  ).toEqual(before);

  // The same stored event again and a worker retry of it: no row more, nothing booked.
  await h.replayAll(() => first, 2);
  await markFailed(first.id);
  await h.runWorker();
  await h.runWorker();
  await expectOneConflictHold(
    w,
    first.id,
    REPORT_IDR,
    `${label} after replays`,
  );
  expect(await ledger(w), `${label}: replays book nothing`).toEqual(before);

  // Finance cannot count a conflict hold into a fact it does not have.
  const counted = await h.resolveHold(hold.id, "counted_against_intent");
  expect(
    counted.status,
    `${label}: counted on a conflict hold: ${JSON.stringify(counted.body)}`,
  ).toBe(409);
  expect(
    (await h.openOf(w.code.id)).map((row) => row.id),
    `${label}: refused counted leaves it open`,
  ).toEqual([hold.id]);

  // The remaining room is Rp40.000: the report's Rp60.000 may not be paid out a second time.
  const probes: Probe[] = [];
  for (const amount of [REPORT_IDR, BILL_IDR - REPORT_IDR + 1_000]) {
    const probe = await tryManualOut(h, w.code.id, amount);
    expectRefused(probe, label);
    probes.push(probe);
  }
  expectWorstCaseWithinPaid(REPORT_IDR, 0, probes, label);
  return w;
}

describe("1126 a signed refund success that matches no refund of ours is held, not dropped", () => {
  it("1126-01 payment object without candidate R (switch on, Rp60.000 of Rp100.000): one conflict hold keyed by the stored event, nothing booked, replays add none, manual refund of Rp60.000 refused", async () => {
    await unmatchedHoldScenario("1126-01", paymentObjectShape, true);
  });

  it("1126-02 flat success without refund id naming the Legend payment: the same one conflict hold, nothing booked, manual refund refused", async () => {
    await unmatchedHoldScenario("1126-02", flatNoIdShape, true);
  });

  it("1126-03 payment that cannot be mapped: both shapes are stored but NO hold, no fact, no refund", async () => {
    const w = await paidWorld();
    const unknownRef = `dp_unknown_${randomBytes(8).toString("hex")}`;
    const holdsBefore = await h.count(
      "SELECT count(*)::text AS n FROM refund_recon_holds WHERE tenant_id = $1",
      [h.tenantId],
    );
    const factsBefore = await h.count(
      "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE tenant_id = $1",
      [h.tenantId],
    );
    const refundsBefore = await h.count(
      "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1",
      [h.tenantId],
    );
    const before = await ledger(w);

    const nested = envelope({
      payment: {
        id: unknownRef,
        status: "partially_refunded",
        amount: REPORT_IDR,
        reference: `RUNKNOWN-${randomBytes(4).toString("hex")}`,
      },
      refund: { amount: REPORT_IDR },
    });
    const flat = envelope({ payment_id: unknownRef, amount: REPORT_IDR });
    await deliverPastWindow(nested);
    await deliverPastWindow(flat);

    expect(
      await h.count(
        "SELECT count(*)::text AS n FROM refund_recon_holds WHERE tenant_id = $1",
        [h.tenantId],
      ),
      "no hold for a payment Legend does not know",
    ).toBe(holdsBefore);
    expect(
      await h.count(
        "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE tenant_id = $1",
        [h.tenantId],
      ),
      "no fact",
    ).toBe(factsBefore);
    expect(
      await h.count(
        "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1",
        [h.tenantId],
      ),
      "no refund row",
    ).toBe(refundsBefore);
    expect(await ledger(w), "the paid payment T is untouched").toEqual(before);
  });

  it("1126-04 control: switch off keeps the same hold-only result (one conflict hold, nothing booked, manual refund refused)", async () => {
    await unmatchedHoldScenario("1126-04", paymentObjectShape, false);
  });

  // Table: the money bound over the unmatched shapes. Reported amount + manual refunds that
  // were let through must stay within what was paid.
  const table: Array<[string, Shape, number]> = [
    ["payment object Rp60.000", paymentObjectShape, 60_000],
    ["flat no refund id Rp60.000", flatNoIdShape, 60_000],
    ["payment object Rp100.000 (all)", paymentObjectShape, BILL_IDR],
    ["flat no refund id Rp30.000", flatNoIdShape, 30_000],
  ];
  for (const [name, shape, reported] of table) {
    it(`1126-05 table, ${name}: reported + manual refunds that pass <= paid, an open hold of the report exists`, async () => {
      flags.DOIT_REFUNDS_ENABLED = true;
      const w = await paidWorld();
      const sent = envelope(shape(w, reported));
      await deliverPastWindow(sent);
      const open = await h.openOf(w.code.id);
      expect(
        open.map((row) => row.amount_idr),
        `premise: the report is held (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
      ).toEqual([reported]);

      const probes: Probe[] = [];
      const over = await tryManualOut(
        h,
        w.code.id,
        BILL_IDR - reported + 1_000,
      );
      expectRefused(over, `1126-05 ${name} above the room`);
      probes.push(over);
      if (reported < BILL_IDR)
        probes.push(await tryManualOut(h, w.code.id, BILL_IDR - reported));
      expectWorstCaseWithinPaid(
        reported,
        await h.factTotal(w.code.id),
        probes,
        `1126-05 ${name}`,
      );
      await h.expectMoneyWithinPaid(w.code, `1126-05 ${name}`);
    });
  }
});
