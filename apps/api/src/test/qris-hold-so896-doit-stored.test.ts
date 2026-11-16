// legend-la1yk (SO-896, Codex P1): DOIT withdrawn from the plan stops NEW codes
// only. A DOIT QR that was already issued must still be reconciled: its signed
// webhook verifies (minting-integration secret fallback) and the poll can read
// its status (stored-intent credential loader), so a payment that arrives after
// the withdrawal is recorded and the hold closes. Nothing is minted again.
//
// Written from docs/briefs/896-qris-area-final-fix.md and
// docs/qa/second-opinion-qris-area-final.md (payment-doit.ts loader,
// payment-webhook.service.ts secret fallback).
//
// Assumptions:
// - The real DOIT gateway runs with its DEFAULT credential loaders (so the plan
//   check is the one under test); only `fetch` is faked, in memory.
// - "Withdrawn" = `doit` removed from `tenants.feature_flags.integrationProviders`;
//   the webhook secret cache is cleared as the integration screen does.
// - The journal is built from the `payment.paid` outbox event, so "one journal"
//   is asserted as one distinct `payment.paid` event plus one captured sum.
// - A refused new code answers an error status (>= 400) and creates no provider
//   payment; the exact status is not asserted.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createDoitGateway } from "../services/payment-doit.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  readHold,
  requestQris,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL_IDR = 33_000;
const apiKey = `doit-key-so896-${randomBytes(12).toString("hex")}`;
const secret = `whsec-so896-${randomBytes(16).toString("hex")}`;

type FakePayment = {
  id: string;
  status: "pending" | "paid";
  amount: number;
  rail: string | null;
  reference: string;
  qr_content: string | null;
  va_number: null;
  va_bank: null;
  hosted_url: string;
  return_url: null;
  provider: string;
  provider_ref: null;
  fee_amount: number;
  fee_payer: string;
  total_amount: number;
  expires_at: string;
  paid_at: string | null;
  metadata: null;
  created_at: string;
};

const payments = new Map<string, FakePayment>();
const calls: string[] = [];

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : String(input));
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url.pathname}`);
  const headers = new Headers(init?.headers);
  if (headers.get("authorization") !== `Bearer ${apiKey}`)
    return json(401, { error: { code: "unauthorized", message: "bad key" } });
  if (method === "GET" && url.pathname === "/v1/methods")
    return json(200, {
      environment: "sandbox",
      amount: null,
      data: [
        {
          code: "qris",
          label: "QRIS",
          rail: "qris",
          bank: null,
          fee_flat: 0,
          fee_pct: 0,
          fee_payer: "merchant",
          min_amount: null,
          max_amount: null,
          fee_amount: 0,
          total_amount: null,
          within_limits: true,
          limit: null,
        },
      ],
    });
  if (method === "POST" && url.pathname === "/v1/payments") {
    const body = JSON.parse(String(init?.body)) as {
      amount: number;
      rail: string;
      reference: string;
      expires_in: number;
    };
    const id = `dp_${randomBytes(8).toString("hex")}`;
    const created = new Date();
    const payment: FakePayment = {
      id,
      status: "pending",
      amount: body.amount,
      rail: body.rail,
      reference: body.reference,
      qr_content: "00020101021226610014ID.CO.DOIT.FAKE",
      va_number: null,
      va_bank: null,
      hosted_url: `https://pay.doit.id/p/${id}`,
      return_url: null,
      provider: "pjp",
      provider_ref: null,
      fee_amount: 0,
      fee_payer: "merchant",
      total_amount: body.amount,
      expires_at: new Date(
        created.getTime() + body.expires_in * 1000,
      ).toISOString(),
      paid_at: null,
      metadata: null,
      created_at: created.toISOString(),
    };
    payments.set(id, payment);
    return json(201, payment);
  }
  const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && found) {
    const payment = payments.get(decodeURIComponent(found[1]!));
    return payment ? json(200, payment) : json(404, { error: "not_found" });
  }
  return json(404, { error: "not_found" });
};

function settleAtDoit(id: string) {
  const payment = payments.get(id)!;
  payment.status = "paid";
  payment.paid_at = new Date().toISOString();
}

let fx: HoldFixture;
let webhookPath = "";
let integrationId = "";

async function setDoitInPlan(enabled: boolean) {
  await owner.query(
    enabled
      ? `UPDATE tenants
            SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                  coalesce(feature_flags->'integrationProviders', '[]'::jsonb) || '"doit"'::jsonb)
          WHERE id = $1
            AND NOT coalesce(feature_flags->'integrationProviders', '[]'::jsonb) ? 'doit'`
      : `UPDATE tenants
            SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                  coalesce(feature_flags->'integrationProviders', '[]'::jsonb) - 'doit')
          WHERE id = $1`,
    [fx.tenant.tenantId],
  );
  clearDoitWebhookSecretCache();
}

beforeAll(async () => {
  fx = await holdFixture("qris-hold-so896-doit-stored");
  webhookPath = `/api/webhooks/payments/doit/${fx.tenant.tenantId}`;
  await setDoitInPlan(true);
  const created = await upsertIntegration(
    fx.context,
    {
      outletId: null,
      provider: "doit",
      config: {},
      credentials: { apiKey, webhookSecret: secret },
    },
    fx.staff.userId,
  );
  await setIntegrationStatus(
    fx.context,
    created.id,
    { status: "active" },
    fx.staff.userId,
  );
  integrationId = created.id;
  // Real gateway, default (plan-checking) loaders; only the network is faked.
  setPaymentGateway(createDoitGateway({ fetch: fakeFetch }));
});

afterAll(async () => {
  await setDoitInPlan(true);
  setPaymentGateway(null);
  resetHoldPorts();
  await owner.end();
});

async function openCode() {
  await setDoitInPlan(true);
  const order = await newSubmittedOrder(fx);
  const qr = await issueQris(fx, order.id);
  expect(qr.provider).toBe("doit");
  expect(qr.providerRef).not.toBeNull();
  return { order, qr, providerRef: qr.providerRef! };
}

function signedDelivery(body: object) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return request(fx.app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", `t=${t},v1=${mac}`)
    .send(raw);
}

function paidEvent(providerRef: string) {
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.paid",
    created_at: new Date().toISOString(),
    data: { ...payments.get(providerRef)!, status: "paid" },
  };
}

async function evidenceCount(intentId: string) {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

/** The `payment.paid` events of the intent, delivered to the POS consumer as
 * the worker does (twice: a replay must not capture twice). */
async function deliverPaidEvents(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT DISTINCT ON (event_id) event FROM domain_event_outbox
      WHERE tenant_id=$1 AND event->>'name'='payment.paid'
        AND event->'payload'->>'intentId'=$2`,
    [fx.tenant.tenantId, intentId],
  );
  for (const row of rows)
    for (let i = 0; i < 2; i += 1)
      await handlePosPaymentPaid(
        fx.context,
        eventEnvelopeSchema.parse(row.event),
      );
  return rows.length;
}

async function expectSettledOnce(
  orderId: string,
  intentId: string,
  at = BILL_IDR,
) {
  expect(await intentStatus(intentId)).toBe("paid");
  expect(await evidenceCount(intentId)).toBe(1);
  expect(await deliverPaidEvents(intentId), "one payment.paid event").toBe(1);
  expect(await capturedIdr(fx, orderId)).toBe(at);
  const hold = await readHold(fx, orderId);
  expect(hold?.state).toBe("paid");
  expect(hold?.closeReason).toBe("provider_paid");
}

describe("legend-la1yk DOIT withdrawn from the plan: stored codes stay reconcilable", () => {
  it("la1yk-1 a new DOIT code is still refused after the withdrawal, and nothing is minted", async () => {
    await setDoitInPlan(false);
    const order = await newSubmittedOrder(fx);
    const mintsBefore = calls.filter((c) => c === "POST /v1/payments").length;

    const refused = await requestQris(fx, order.id);

    expect(
      refused.status,
      `new issuance must fail: ${JSON.stringify(refused.body)}`,
    ).toBeGreaterThanOrEqual(400);
    expect(calls.filter((c) => c === "POST /v1/payments").length).toBe(
      mintsBefore,
    );
  });

  it("la1yk-2 issue a QR, withdraw DOIT (secret cache cleared), a valid signed webhook verifies and settles once; the replay changes nothing", async () => {
    const { order, qr, providerRef } = await openCode();
    await setDoitInPlan(false);
    resetPaymentWebhookRateLimits();
    settleAtDoit(providerRef);
    const event = paidEvent(providerRef);

    const first = await signedDelivery(event);
    const replay = await signedDelivery(event);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe("processed");
    expect(replay.status).toBe(200);
    await expectSettledOnce(order.id, qr.intentId);
    expect(integrationId).not.toBe("");
  });

  it("la1yk-3 issue a QR, withdraw DOIT, the poll reads the stored intent as paid and settles once", async () => {
    const { order, qr, providerRef } = await openCode();
    await setDoitInPlan(false);
    settleAtDoit(providerRef);
    await owner.query(
      `UPDATE payment_intents SET gateway_polled_at = NULL, created_at = now() - interval '10 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );

    const first = await pollPendingGatewayIntents(fx.context, new Date(), 50);
    await pollPendingGatewayIntents(
      fx.context,
      new Date(Date.now() + 120_000),
      50,
    );

    expect(first.settled).toBeGreaterThanOrEqual(1);
    await expectSettledOnce(order.id, qr.intentId);
  });

  it("la1yk-4 withdrawn DOIT: a webhook signed with a WRONG secret is still rejected", async () => {
    const { order, qr, providerRef } = await openCode();
    await setDoitInPlan(false);
    resetPaymentWebhookRateLimits();
    settleAtDoit(providerRef);
    const raw = JSON.stringify(paidEvent(providerRef));
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", `wrong-${randomUUID()}`)
      .update(`${t}.${raw}`)
      .digest("hex");

    const response = await request(fx.app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", `t=${t},v1=${mac}`)
      .send(raw);

    expect(response.status).toBe(401);
    expect(await intentStatus(qr.intentId)).not.toBe("paid");
    expect(await evidenceCount(qr.intentId)).toBe(0);
    expect(await capturedIdr(fx, order.id)).toBe(0);
  });
});
