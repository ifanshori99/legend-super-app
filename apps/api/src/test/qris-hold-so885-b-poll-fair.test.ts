// legend-tqkbb (SO-885 B, review P2-1): migration 0405 has no backfill, so old
// `expired` intents with a provider reference and no final proof enter the poll.
// They must never delay a live (`pending`) code: the poll gives pending codes
// their own quota, processes ALL of them before any expired code, and keeps
// separate error and time budgets per kind.
//
// Assumptions:
// - Every bill is a guest VA order. Expired codes are made old and never
//   polled; the pending code was polled an hour ago, so a plain least-recently-
//   polled-first order would put every expired code in front of it.
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

async function age(expired: string[], pending: string[]) {
  for (const id of expired)
    await owner.query(
      `UPDATE payment_intents
          SET status='expired', created_at = now() - interval '3 hours',
              expires_at = now() - interval '2 hours', gateway_polled_at = NULL
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, id],
    );
  for (const id of pending)
    await owner.query(
      `UPDATE payment_intents
          SET created_at = now() - interval '10 minutes',
              gateway_polled_at = now() - interval '1 hour'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, id],
    );
}

async function statusOf(id: string) {
  const { rows } = await owner.query(
    `SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, id],
  );
  return rows[0].status as string;
}

describe("legend-tqkbb poll fairness between live and old expired codes", () => {
  it("tqkbb-8 a backlog of expired codes without final proof does not delay a live pending code (limit 1 still asks the pending one)", async () => {
    const x = await vaCode();
    const y = await vaCode();
    await age([x], [y]);

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

  it("tqkbb-9 three expired codes whose gateway read throws never stop a live pending code that paid from settling in the same run", async () => {
    const expired = [await vaCode(), await vaCode(), await vaCode()];
    const live = await vaCode();
    await age(expired, [live]);
    for (const id of expired) fx.gateway.script(id, { error: "5xx" });
    fx.gateway.script(live, { rawStatus: "00" });

    const result = await pollPendingGatewayIntents(fx.context, new Date());

    expect(
      await statusOf(live),
      "the pending code is processed before any expired code and settles",
    ).toBe("paid");
    expect(result.settled).toBeGreaterThanOrEqual(1);
    for (const id of expired)
      expect(
        fx.gateway.readsOf(id).length,
        "expired codes are still asked after the pending ones",
      ).toBeGreaterThan(0);
  });
});
