// legend-kt3t1 (round 3): replaying the create-payment request of a bill SPLIT
// PART that is already PAID. A guest's client may retry the same POST (same
// idempotency key, same payerSecret) after the verified callback paid the part.
// The answer must be the stored one, honest about the new state:
// status "paid", `paidAt` an ISO string, `redirectUrl` null (a paid code has no
// pay link), no provider reference in the body, and it parses with the shared
// `guestPaymentSchema` (paid <=> paidAt set; redirect only while pending).
//
// Fixed in 638d84f06 (closePayLinkIfNotPending). This test PASSES already: it
// guards the fix, it is not a fail-first test.
//
// Assumptions (also in the report)
// - Wire shape as in qr-va-940-kt3t1-guest-ewallet-card.test.ts: method
//   "ewallet", channel OV in `bankCode`, a hosted-page pay URL on the double.
// - A split part is paid by the verified callback (confirmPayment, the same
//   entry point the kt3t1 test uses) and its payment.paid event is delivered
//   to the order consumer, like payAndFire there.
// - The other part stays unpaid, so the order is NOT fully paid: it is not fired
//   (orders.fired_at stays null). That is what keeps the replay on the stored
//   answer path (a fully paid order is refused 409 by ensurePaymentLink, as
//   pinned in the kt3t1 test).
// - A replay before payment returns 2xx with the same intent and the pay URL
//   (pending is not hidden).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-969-kt3t1-split-replay.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { guestPaymentSchema } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import { intentRow } from "./qr-va-912-3p1-helpers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Offered = {
  method: GatewayPaymentMethod;
  enabled: boolean;
  channels: { code: string; name: string }[];
};

const ALL_ON = (): Offered[] => [
  { method: "qris", enabled: true, channels: [] },
  {
    method: "va",
    enabled: true,
    channels: [{ code: "BC", name: "BCA Virtual Account" }],
  },
  { method: "bank_transfer", enabled: false, channels: [] },
  {
    method: "ewallet",
    enabled: true,
    channels: [
      { code: "OV", name: "OVO" },
      { code: "DA", name: "DANA" },
    ],
  },
  {
    method: "card",
    enabled: true,
    channels: [{ code: "VC", name: "Credit Card" }],
  },
];

/** Duitku-like double: e-wallet and card hand back a hosted pay URL. */
class DuitkuLikeGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  reset() {
    this.created.length = 0;
  }
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    return ALL_ON();
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    return ALL_ON().find((entry) => entry.method === method)?.channels ?? [];
  }
  async createIntent(input: GatewayIntentRequest) {
    const providerRef = `KT3R-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const channel = ALL_ON()
      .find((entry) => entry.method === input.method)
      ?.channels.find((c) => c.code === input.channelCode);
    const instructions =
      input.method === "ewallet" || input.method === "card"
        ? {
            method: input.method,
            channelCode: input.channelCode ?? "VC",
            channelName: channel?.name ?? "Credit Card",
            paymentUrl: `https://pay.example.test/${providerRef}`,
          }
        : {
            method: "qris",
            qrPayload: `00020101021226KT3R${this.created.length}`,
            issuer: null,
          };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
}

let fx: HoldFixture;
const gw = new DuitkuLikeGateway();

beforeAll(async () => {
  fx = await holdFixture("qr-va-969-kt3t1-split-replay");
  // E-wallet has no PRD default route (fail closed): switch it on tenant-wide.
  for (const method of ["ewallet", "card"]) {
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')
       ON CONFLICT DO NOTHING`,
      [fx.tenant.tenantId, method],
    );
  }
  setPaymentGateway(gw); // after the fixture: it installs its own gateway
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

// ------------------------------------------------------------------- helpers

async function splitBill() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  expect(parts, "setup: two parts").toHaveLength(2);
  return { guest, order, parts };
}

const payPart = (
  guest: Awaited<ReturnType<typeof splitBill>>["guest"],
  partId: string,
  channel: string,
  idempotencyKey: string,
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: partId },
    method: "ewallet",
    bankCode: channel,
    payerSecret: secretFor(partId),
    idempotencyKey,
  });

async function intentMeta(intentId: string) {
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function paidEvents(intentId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/** The verified provider callback pays the intent; the order consumer hears it. */
async function payByCallback(intentId: string) {
  const meta = await intentMeta(intentId);
  await confirmPayment(
    fx.context,
    intentId,
    {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: meta.amount,
      providerRef: meta.provider_ref,
      at: new Date().toISOString(),
    } as Parameters<typeof confirmPayment>[2],
    { type: "system" },
    new Date(),
  );
  const events = await paidEvents(intentId);
  expect(events, "one payment.paid").toHaveLength(1);
  const context = fx.context as ScopedTenantContext;
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, events[0]!, tx, new Date()),
  );
  return meta;
}

// --------------------------------------------------------------------- tests

describe("legend-kt3t1 a replayed create request for a split part", () => {
  it("legend-kt3t1 replay of a PAID split part's e-wallet key: stored answer says paid, paidAt set, redirectUrl null, no provider reference, schema parses; the other part keeps the order open", async () => {
    gw.reset();
    const { guest, order, parts } = await splitBill();
    const [first, second] = parts as [
      (typeof parts)[number],
      (typeof parts)[number],
    ];
    const key = randomUUID();
    const created = await payPart(guest, first.id, "OV", key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const meta = await payByCallback(intentId);
    expect((await intentRow(fx.tenant.tenantId, intentId)).status).toBe("paid");
    // The other part is unpaid: the order is still awaiting payment, not fired.
    const { rows } = await owner.query<{ fired_at: Date | null }>(
      "SELECT fired_at FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(rows[0]!.fired_at, "order not fully paid: not fired").toBeNull();
    const { rows: partRows } = await owner.query<{ payment_intent_id: string }>(
      "SELECT payment_intent_id::text AS payment_intent_id FROM bill_splits WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, second.id],
    );
    expect(
      partRows[0]?.payment_intent_id ?? null,
      "setup: the other part has no code, it is unpaid",
    ).toBeNull();

    const replay = await payPart(guest, first.id, "OV", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data).toMatchObject({
      id: intentId,
      status: "paid",
      method: "ewallet",
      redirectUrl: null,
      target: { kind: "split", billSplitId: first.id },
    });
    expect(typeof replay.body.data.paidAt, "paidAt is an ISO string").toBe(
      "string",
    );
    expect(Number.isNaN(Date.parse(replay.body.data.paidAt))).toBe(false);
    const parsed = guestPaymentSchema.safeParse(replay.body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const text = JSON.stringify(replay.body);
    expect(text, "no pay URL in the answer").not.toContain("pay.example.test");
    expect(text, "no provider reference in the answer").not.toContain(
      meta.provider_ref,
    );
    expect(replay.body.data, "no providerRef field").not.toHaveProperty(
      "providerRef",
    );
    // The replay created nothing at the provider.
    expect(gw.created, "no second provider request").toHaveLength(1);
  });

  it("legend-kt3t1 replay of a split part's e-wallet key BEFORE payment: same pending intent, the pay URL is still shown", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const key = randomUUID();
    const created = await payPart(guest, parts[0]!.id, "OV", key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const replay = await payPart(guest, parts[0]!.id, "OV", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data).toMatchObject({
      id: created.body.data.id,
      status: "pending",
      method: "ewallet",
      paidAt: null,
    });
    expect(replay.body.data.redirectUrl).toBe(
      `https://pay.example.test/${gw.created[0]!.providerRef}`,
    );
    expect(guestPaymentSchema.safeParse(replay.body.data).success).toBe(true);
    expect(gw.created, "no second provider request").toHaveLength(1);
  });
});
