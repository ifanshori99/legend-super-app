// legend-tqkbb (SO-885 B, P1 VA): a VA the provider never answered final stays
// collectible. The local 24 hour poll window may change what the guest sees,
// but it is not proof that the code is dead: it neither opens a replacement
// code (VA -> QR, VA -> VA, a changed split) nor takes the code out of the poll.
// A code is dead only when the provider answers final (expired / failed) or the
// money was reconciled.
//
// Assumptions:
// - Refusal is HTTP 409 (ORDER_CODE_ACTIVE / SPLIT_CODE_ACTIVE / SPLIT_LOCKED);
//   only the 409 is asserted, the body is quoted in the failure message.
// - "Past the window" = the code lapsed 25 hours ago and the poll ran with the
//   provider still answering `pending` (or failing); that is when the old poll
//   marked the intent `expired` locally and dropped it.
// - "Exactly one payment" = A settles the bill once, no unallocated funds, no
//   refund, and no second intent was created on the bill's link.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  GATEWAY_POLL_WINDOW_MS,
  confirmPayment,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { newPayerSecret, secretFor } from "./payer-secret-helpers.ts";
import {
  holdFixture,
  refundsOfIntent,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL_IDR = 33_000;
const HOUR = 60 * 60_000;

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-b-va");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

async function guestOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  return { guest, order };
}

function payWhole(
  guest: Guest,
  orderId: string,
  method: "qris" | "va",
  idempotencyKey: string = randomUUID(),
) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey,
  });
}

function payPart(
  guest: Guest,
  partId: string,
  method: "qris" | "va",
  secret: string = secretFor(partId),
) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: partId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    payerSecret: secret,
    idempotencyKey: randomUUID(),
  });
}

function splitInto(guest: Guest) {
  return fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
}

/** The code lapsed 25 hours ago: past the 24 hour poll window. */
async function lapseBeyondWindow(intentId: string) {
  await owner.query(
    `UPDATE payment_intents
        SET created_at = now() - interval '26 hours',
            expires_at = now() - interval '25 hours'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
}

function poll(now: Date) {
  return pollPendingGatewayIntents(fx.context, now, 200);
}

async function intentsOfLink(orderId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT i.id::text AS id FROM payment_intents i
       JOIN orders o ON o.tenant_id=i.tenant_id AND o.payment_link_id=i.payment_link_id
      WHERE i.tenant_id=$1 AND o.id=$2`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.map((row) => row.id);
}

async function intentsOfPart(partId: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id::text AS id FROM payment_intents WHERE tenant_id=$1 AND bill_split_id=$2",
    [fx.tenant.tenantId, partId],
  );
  return rows.map((row) => row.id);
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

/** The provider payment of `intentId` as a verified webhook, delivered twice to
 * the QR order consumer as the worker does. */
async function payAndDeliver(
  intentId: string,
  amountIdr: number,
  method: "qris" | "va" = "va",
) {
  await confirmPayment(
    fx.context,
    intentId,
    {
      source: "verified_webhook",
      method,
      amountIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    },
    { type: "system" },
    new Date(),
  );
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    for (let i = 0; i < 2; i += 1)
      await withTenant(db, fx.context, (tx) =>
        deliverOrderPaymentEvent(fx.context, event, tx, new Date()),
      );
  }
}

describe("legend-tqkbb VA without provider proof keeps its code collectible", () => {
  it("tqkbb-1 whole-order VA A pending past the poll window: VA -> QR, VA -> VA and a split are refused; A is still polled; A pays once and no B is issued", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = fx.gateway.requests.length;

    await lapseBeyondWindow(aId);
    const t0 = new Date();
    fx.gateway.script(aId, { rawStatus: "01" });
    await poll(t0);
    // Still no proof, and the poll keeps asking after the window.
    const readsAfterWindow = fx.gateway.readsOf(aId).length;
    await poll(new Date(t0.getTime() + 2 * HOUR));
    await poll(new Date(t0.getTime() + 4 * HOUR));
    expect(
      fx.gateway.readsOf(aId).length,
      "the poll must keep asking the provider about A",
    ).toBeGreaterThan(readsAfterWindow);

    const qr = await payWhole(guest, order.id, "qris");
    expect(qr.status, `VA -> QR: ${JSON.stringify(qr.body)}`).toBe(409);
    const va = await payWhole(guest, order.id, "va");
    expect(va.status, `VA -> VA: ${JSON.stringify(va.body)}`).toBe(409);
    const split = await splitInto(guest);
    expect(split.status, `change split: ${JSON.stringify(split.body)}`).toBe(
      409,
    );
    expect(fx.gateway.requests.length, "no code at the provider").toBe(
      requestsBefore,
    );
    expect(await intentsOfLink(order.id)).toEqual([aId]);

    // The guest pays A: one payment settles the bill.
    await payAndDeliver(aId, BILL_IDR);
    expect(await orderStatus(order.id)).not.toBe("awaiting_payment");
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
    expect(await intentsOfLink(order.id)).toEqual([aId]);
  });

  it("tqkbb-2 the provider is unreachable through the window: A stays collectible, replacement refused, poll continues", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = fx.gateway.requests.length;

    await lapseBeyondWindow(aId);
    const t0 = new Date();
    fx.gateway.script(aId, { error: "timeout" });
    await poll(t0);
    const reads = fx.gateway.readsOf(aId).length;
    await poll(new Date(t0.getTime() + 2 * HOUR));
    expect(fx.gateway.readsOf(aId).length).toBeGreaterThan(reads);

    const qr = await payWhole(guest, order.id, "qris");
    expect(qr.status, JSON.stringify(qr.body)).toBe(409);
    const va = await payWhole(guest, order.id, "va");
    expect(va.status, JSON.stringify(va.body)).toBe(409);
    expect(fx.gateway.requests.length).toBe(requestsBefore);

    // The provider comes back and says A was paid all along (lost webhook):
    // the poll settles it once.
    fx.gateway.script(aId, { status: "paid" });
    await poll(new Date(t0.getTime() + 4 * HOUR));
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
    expect(await intentsOfLink(order.id)).toEqual([aId]);
  });

  it("tqkbb-3 the provider answers final (expired) after the window: the replacement opens and settles the bill once", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;

    await lapseBeyondWindow(aId);
    const t0 = new Date();
    fx.gateway.script(aId, { rawStatus: "01" });
    await poll(t0);
    expect((await payWhole(guest, order.id, "qris")).status).toBe(409);

    fx.gateway.script(aId, { status: "expired" });
    await poll(new Date(t0.getTime() + 2 * HOUR));
    const { rows } = await owner.query<{ provider_final_at: Date | null }>(
      "SELECT provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, aId],
    );
    expect(rows[0]!.provider_final_at, "final proof recorded").not.toBeNull();

    const qr = await payWhole(guest, order.id, "qris");
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    const bId = qr.body.data.id as string;
    expect(bId).not.toBe(aId);
    await payAndDeliver(bId, BILL_IDR, "qris");
    expect(await orderStatus(order.id)).not.toBe("awaiting_payment");
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
  });

  it("tqkbb-4 split part VA A pending past the window: VA -> VA (same payer or another guest) and a changed split are refused; A pays once, no B", async () => {
    const { guest, order } = await guestOrder();
    const split = await splitInto(guest);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as { id: string; amountIdr: number }[];
    const part = parts[0]!;
    const a = await payPart(guest, part.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = fx.gateway.requests.length;

    await lapseBeyondWindow(aId);
    const t0 = new Date();
    fx.gateway.script(aId, { rawStatus: "01" });
    await poll(t0);
    const reads = fx.gateway.readsOf(aId).length;
    await poll(new Date(t0.getTime() + 2 * HOUR));
    expect(fx.gateway.readsOf(aId).length).toBeGreaterThan(reads);

    const again = await payPart(guest, part.id, "va");
    expect(again.status, `VA -> VA: ${JSON.stringify(again.body)}`).toBe(409);
    const qr = await payPart(guest, part.id, "qris");
    expect(qr.status, `VA -> QR: ${JSON.stringify(qr.body)}`).toBe(409);
    const other = await payPart(guest, part.id, "va", newPayerSecret());
    expect(other.status, `another guest: ${JSON.stringify(other.body)}`).toBe(
      409,
    );
    const resplit = await splitInto(guest);
    expect(
      resplit.status,
      `change split: ${JSON.stringify(resplit.body)}`,
    ).toBe(409);
    expect(fx.gateway.requests.length, "no code at the provider").toBe(
      requestsBefore,
    );
    expect(await intentsOfPart(part.id)).toEqual([aId]);

    await payAndDeliver(aId, part.amountIdr);
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
    expect(await intentsOfPart(part.id)).toEqual([aId]);
    expect(await orderStatus(order.id)).toBe("awaiting_payment");
  });

  it("tqkbb-5 split part: after the provider answers final (failed), the part takes a new code", async () => {
    const { guest } = await guestOrder();
    const split = await splitInto(guest);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const part = (
      split.body.data.splits as { id: string; amountIdr: number }[]
    )[0]!;
    const a = await payPart(guest, part.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;

    await lapseBeyondWindow(aId);
    const t0 = new Date();
    fx.gateway.script(aId, { rawStatus: "01" });
    await poll(t0);
    expect((await payPart(guest, part.id, "va")).status).toBe(409);

    fx.gateway.script(aId, { status: "failed" });
    await poll(new Date(t0.getTime() + 2 * HOUR));
    const next = await payPart(guest, part.id, "va");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data.id).not.toBe(aId);
  });

  it("tqkbb-7 the provider says PAID but the confirmation is refused (untrusted): no final proof, A stays collectible and in the poll, replacement refused", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "va");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = fx.gateway.requests.length;

    // The lifecycle refuses a gateway_status confirmation for this intent
    // (a method the gateway cannot prove): UNTRUSTED_CONFIRMATION.
    await owner.query(
      `UPDATE payment_intents SET method='cash',
              created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId],
    );
    fx.gateway.script(aId, { status: "paid" });
    const t0 = new Date();
    await poll(t0);
    const reads = fx.gateway.readsOf(aId).length;
    expect(reads).toBeGreaterThan(0);
    // Restore the method so the guest views and requests below parse.
    await owner.query(
      "UPDATE payment_intents SET method='va' WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, aId],
    );

    const { rows } = await owner.query<{ provider_final_at: Date | null }>(
      "SELECT provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, aId],
    );
    expect(
      rows[0]!.provider_final_at,
      "a refused paid is not final",
    ).toBeNull();

    const qr = await payWhole(guest, order.id, "qris");
    expect(qr.status, JSON.stringify(qr.body)).toBe(409);
    const va = await payWhole(guest, order.id, "va");
    expect(va.status, JSON.stringify(va.body)).toBe(409);
    expect(fx.gateway.requests.length).toBe(requestsBefore);

    await poll(new Date(t0.getTime() + 2 * HOUR));
    expect(
      fx.gateway.readsOf(aId).length,
      "A is still in the poll",
    ).toBeGreaterThan(reads);
  });

  it("tqkbb-6 the poll window constant is still 24 hours (the test lapses 25)", () => {
    expect(GATEWAY_POLL_WINDOW_MS).toBe(24 * HOUR);
  });
});
