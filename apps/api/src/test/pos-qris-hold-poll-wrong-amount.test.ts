// Fail-first regression test for legend-eh9i4 card A1 (docs/briefs/sub-codex-money.md):
// the status-check POLL must obey the same QRIS hold rule as the webhook.
//
// QH-13 (pos-qris-hold-anomaly.test.ts, decided by the founder): a payment
// whose amount differs from the QR does not close the hold. The WHOLE amount is
// parked as unallocated money, nothing is captured, the bill stays locked.
//
// Scenario: bill Rp 33.000, QR Rp 33.000, the webhook is lost, the provider
// later answers the poll with "paid" for Rp 36.000. Today the poll path skips
// the hold check: it captures Rp 33.000 and parks only the Rp 3.000 difference.
//
// Assumptions (the brief does not pin them):
// - The poll is `pollPendingGatewayIntents`; its `payment.paid` outbox events
//   are then delivered to the POS consumer (twice, a replay must change
//   nothing), exactly as `payNotice` does for webhooks.
// - "Parked" = one `payment_unallocated_funds` row of Rp 36.000 for the intent.
// - A poll that throws a CONFLICT for the mismatch is acceptable (the webhook
//   path throws 409 too); what is judged is the money state afterwards.
// - Money proof: captured 0 (outlet never credited the wrong QR), parked
//   exactly once (36.000, not 33.000 + 3.000), no refund row created, hold not
//   "paid", bill still owes 33.000, and a second poll parks nothing more.
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

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-poll-wrong-amount");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** Delivers every `payment.paid` outbox event of the intent, twice each. */
async function deliverPaidEvents(intentId: string): Promise<number> {
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
  return rows.length;
}

/** A poll that throws CONFLICT for the mismatch is fine; anything else fails. */
async function pollOnce() {
  try {
    return await pollPendingGatewayIntents(fx.context, new Date(), 50);
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    if (e?.code === "CONFLICT" && e?.status === 409) return null;
    throw error;
  }
}

describe("legend-eh9i4 A1 poll with a wrong amount", () => {
  it("legend-eh9i4 poll finds paid Rp 36.000 for a Rp 33.000 QR: all Rp 36.000 is parked, nothing is captured, the bill stays locked", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(33_000);

    // Webhook lost: the provider only tells the poll that the QR was paid 36.000.
    fx.gateway.script(qr.intentId, { rawStatus: "00", amountIdr: 36_000 });
    await pollOnce();
    await deliverPaidEvents(qr.intentId);

    // Outlet is not credited for a payment that does not match the QR.
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    // The whole payment is parked, once: not 33.000 + 3.000.
    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked.map((p) => p.amountIdr)).toEqual([36_000]);
    // Nobody is paid back automatically either.
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    // QH-13: the wrong amount does not close the hold; the bill still owes 33.000.
    const hold = await readHold(fx, order.id);
    expect(hold, "hold of the QR must exist").not.toBeNull();
    expect(hold?.state).not.toBe("paid");
    expect((await readBill(fx, order.id)).totalIdr).toBe(33_000);

    // A second poll and a replay park nothing more.
    await pollOnce();
    await deliverPaidEvents(qr.intentId);
    expect(
      (await unallocatedFunds(fx, qr.intentId)).map((p) => p.amountIdr),
    ).toEqual([36_000]);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });
});
