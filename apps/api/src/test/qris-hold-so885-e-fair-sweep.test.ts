// SO-885 (card F, legend-m8jax): the unpaid QR order sweep reads the oldest
// candidates first, so orders that stay kept (here: a fully paid bill whose
// refund failed) in front of the window starved abandoned orders behind them.
// The sweep now rotates a per-tenant cursor (like the payout recovery sweep,
// legend-la22h): the next round starts after the last order looked at and wraps
// to the oldest when the tail is short.
//
// Own tenant: no other awaiting_payment order is in front of the ones below.
import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  resetUnpaidQrSweepCursor,
  sweepUnpaidQrOrders,
} from "../services/qr-order-consumers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  ScriptedGateway,
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-f");
  const gw = new ScriptedGateway("doit");
  enableVaBank(gw);
  setPaymentGateway(gw);
});
beforeEach(() => resetUnpaidQrSweepCursor(fx.tenant.tenantId));
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** A guest order with one VA code, lapsed locally 10 minutes ago. */
async function codedOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const a = await fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId: order.id },
    method: "va",
    bankCode: "bmri",
    idempotencyKey: randomUUID(),
  });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const intentId = a.body.data.id as string;
  await owner.query(
    `UPDATE payment_intents SET status='expired', expires_at = now() - interval '10 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return { orderId: order.id as string, intentId };
}

/** Kept for good: the bill is fully paid and its refund failed. */
async function stuckOrder() {
  const o = await codedOrder();
  await confirmPayment(
    fx.context,
    o.intentId,
    {
      source: "verified_webhook",
      method: "va",
      amountIdr: 33_000,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    },
    { type: "system" },
    new Date(),
  );
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, 33000, 'Refund uji 885', 'failed', 'sweep-test'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, o.intentId],
  );
  return o;
}

async function statusOf(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2::uuid",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

const round = (limit: number) =>
  sweepUnpaidQrOrders(fx.context, new Date(Date.now() + 20 * 60_000), limit);

describe("SO-885 F: the unpaid QR order sweep is fair", () => {
  it("abandoned orders behind a full window of kept orders are still voided, in order, over several rounds", async () => {
    const stuck = [await stuckOrder(), await stuckOrder(), await stuckOrder()];
    const abandoned = [await codedOrder(), await codedOrder()];

    // Window of 2: [S1,S2] -> [S3,Z1] -> [Z2, wrap S1].
    expect((await round(2)).voided).toBe(0);
    expect(await statusOf(abandoned[0]!.orderId)).toBe("awaiting_payment");
    expect((await round(2)).voided).toBe(1);
    expect(await statusOf(abandoned[0]!.orderId)).toBe("voided");
    expect(await statusOf(abandoned[1]!.orderId)).toBe("awaiting_payment");
    expect((await round(2)).voided).toBe(1);
    expect(await statusOf(abandoned[1]!.orderId)).toBe("voided");

    for (const s of stuck)
      expect(await statusOf(s.orderId)).toBe("awaiting_payment");
  });

  it("a round after everything was looked at wraps to the oldest and changes nothing", async () => {
    const stuck = [await stuckOrder(), await stuckOrder()];
    for (let i = 0; i < 4; i += 1) expect((await round(1)).voided).toBe(0);
    for (const s of stuck)
      expect(await statusOf(s.orderId)).toBe("awaiting_payment");
    const late = await codedOrder();
    // The new order is behind the two kept ones: reached within two rounds.
    await round(1);
    await round(1);
    await round(1);
    expect(await statusOf(late.orderId)).toBe("voided");
  });
});
