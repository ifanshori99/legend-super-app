// Fail-first test for legend-baz8i (docs/briefs/baz8i-strict-amount-hold.md):
// Duitku is a STRICT-amount provider. When a QRIS bill is paid with an amount
// other than the QR amount, `assertStrictAmount` parks the money. It must also
// tell the cashier who opened the QR (and supervisors/owners), exactly like the
// existing "hold refuses" path does, because the bill stays locked until a
// manager releases the hold (Q93, QH-13).
//
// Assumptions (the brief does not pin them):
// - The strict path is reached through `pollPendingGatewayIntents` with a
//   scripted gateway whose provider is "duitku" (webhook lost, poll finds paid).
// - A poll that throws CONFLICT 409 for the mismatch is acceptable; what is
//   judged is the resulting money state and the alert.
// - The alert is a `notifications` row for the user who opened the hold, with
//   the parked-funds title (`notifyOutletSupervisors` stores category
//   `edge_sync_conflict` for every supervisor alert; the title tells them apart).
// - The hold is never closed automatically: state stays open (or cancelling),
//   never "paid" / "released".
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  readBill,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const ALERT_TITLE = "Uang QRIS perlu dikembalikan";

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-strict-amount", { provider: "duitku" });
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function pollOnce() {
  try {
    return await pollPendingGatewayIntents(fx.context, new Date(), 50);
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    if (e?.code === "CONFLICT" && e?.status === 409) return null;
    throw error;
  }
}

/** Delivers every `payment.paid` outbox event of the intent, twice each. */
async function deliverPaidEvents(intentId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    await handlePosPaymentPaid(fx.context, event);
    await handlePosPaymentPaid(fx.context, event);
  }
}

/** Parked-funds alerts the user received (whole tenant, this category). */
async function alertCount(userId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 AND title = $3`,
    [fx.tenant.tenantId, userId, ALERT_TITLE],
  );
  return rows[0]!.n;
}

/** Sum of every `payment_unallocated_funds` row of the intent, in Rupiah. */
async function parkedTotal(intentId: string): Promise<number> {
  return (await unallocatedFunds(fx, intentId)).reduce(
    (sum, p) => sum + p.amountIdr,
    0,
  );
}

async function wrongAmountScenario(paidIdr: number) {
  const order = await newSubmittedOrder(fx, 0);
  const qr = await issueQris(fx, order.id);
  expect(qr.provider).toBe("duitku");
  expect(qr.amountIdr).toBe(33_000);
  const alertsBefore = await alertCount(fx.staff.userId);

  fx.gateway.script(qr.intentId, { rawStatus: "00", amountIdr: paidIdr });
  await pollOnce();
  await deliverPaidEvents(qr.intentId);
  return { order, qr, alertsBefore };
}

describe("legend-baz8i strict-amount QRIS hold", () => {
  it("legend-baz8i Rp 33.000 QR paid Rp 36.000: all parked once, bill stays locked, hold stays open, opener is alerted", async () => {
    const { order, qr, alertsBefore } = await wrongAmountScenario(36_000);

    // The whole payment is parked, exactly once.
    expect(
      (await unallocatedFunds(fx, qr.intentId)).map((p) => p.amountIdr),
    ).toEqual([36_000]);
    // Bill is not closed; hold is not closed automatically (Q93).
    expect((await readBill(fx, order.id)).totalIdr).toBe(33_000);
    const hold = await readHold(fx, order.id);
    expect(hold, "hold of the QR must exist").not.toBeNull();
    expect(["open", "cancelling"]).toContain(hold?.state);
    expect(hold?.closedAt).toBeNull();
    // The cashier who opened the QR is told the money is parked.
    expect(await alertCount(fx.staff.userId)).toBe(alertsBefore + 1);
    await assertInvariants(fx, order.id);
  });

  it("legend-baz8i Rp 33.000 QR paid Rp 30.000 (underpaid): all Rp 30.000 parked, opener alerted", async () => {
    const { order, qr, alertsBefore } = await wrongAmountScenario(30_000);

    expect(
      (await unallocatedFunds(fx, qr.intentId)).map((p) => p.amountIdr),
    ).toEqual([30_000]);
    const hold = await readHold(fx, order.id);
    expect(["open", "cancelling"]).toContain(hold?.state);
    expect(await alertCount(fx.staff.userId)).toBe(alertsBefore + 1);
    await assertInvariants(fx, order.id);
  });

  it("legend-baz8i the same wrong payment seen again (second poll, replayed events): one parked fund, one alert", async () => {
    const { order, qr, alertsBefore } = await wrongAmountScenario(36_000);
    expect(await alertCount(fx.staff.userId)).toBe(alertsBefore + 1);

    await pollOnce();
    await pollOnce();
    await deliverPaidEvents(qr.intentId);

    expect(
      (await unallocatedFunds(fx, qr.intentId)).map((p) => p.amountIdr),
    ).toEqual([36_000]);
    expect(await alertCount(fx.staff.userId)).toBe(alertsBefore + 1);
    await assertInvariants(fx, order.id);
  });

  it("legend-baz8i parked money is never booked as a payment: nothing captured, no refund, nobody paid more", async () => {
    const { order, qr } = await wrongAmountScenario(36_000);

    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    // Parked total equals what the provider reported, not 33.000 + 3.000.
    expect(await parkedTotal(qr.intentId)).toBe(36_000);
    expect((await readBill(fx, order.id)).totalIdr).toBe(33_000);
    await assertInvariants(fx, order.id);
  });
});
