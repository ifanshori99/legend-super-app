// legend-tqkbb (SO-885 B, review P2-1): migration 0629 has no backfill, so old
// `expired` intents with a provider reference and no final proof enter the poll.
// They must never delay a live (`pending`) code: the poll gives pending codes
// their own quota and processes them first.
//
// Assumptions:
// - Both bills are guest VA orders; X is made an old expired code never polled,
//   Y a pending code polled an hour ago. Old ordering (least recently polled
//   first, never-polled first) would pick X for a limit of 1.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-b-fair");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function vaCode() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const paid = await fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId: order.id },
    method: "va",
    bankCode: "bmri",
    idempotencyKey: randomUUID(),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return paid.body.data.id as string;
}

describe("legend-tqkbb poll fairness between live and old expired codes", () => {
  it("tqkbb-8 a backlog of expired codes without final proof does not delay a live pending code (limit 1 still asks the pending one)", async () => {
    const x = await vaCode();
    const y = await vaCode();
    await owner.query(
      `UPDATE payment_intents
          SET status='expired', created_at = now() - interval '3 hours',
              expires_at = now() - interval '2 hours', gateway_polled_at = NULL
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, x],
    );
    await owner.query(
      `UPDATE payment_intents
          SET created_at = now() - interval '10 minutes',
              gateway_polled_at = now() - interval '1 hour'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, y],
    );

    const readsY = fx.gateway.readsOf(y).length;
    const readsX = fx.gateway.readsOf(x).length;
    await pollPendingGatewayIntents(fx.context, new Date(), 1);

    expect(
      fx.gateway.readsOf(y).length,
      "the live pending code is asked first",
    ).toBeGreaterThan(readsY);
    expect(
      fx.gateway.readsOf(x).length,
      "the expired code has its own quota",
    ).toBeGreaterThan(readsX);
  });
});
