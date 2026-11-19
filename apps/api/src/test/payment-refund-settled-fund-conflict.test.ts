// legend-kl46s: a FUND refund (payment_refunds.unallocated_fund_id) pays back the
// fund's evidence payment p2, not the intent's own payment p1. When finance
// settled such a refund by hand, a later DOIT `refund.succeeded` naming p2 must
// reach the same provider conflict as for an ordinary refund (legend-xd2q), not
// REFUND_UNMATCHED. A fund refund is never a candidate for an event naming p1
// (its source is p2). Same signed-webhook harness as
// payment-refund-manual-settle-webhook.test.ts.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { env } from "../config/env";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  setPaymentRefundGateway,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

import { paymentTestScope } from "./payment-test-scope";

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const actor = randomUUID();
const PAID_IDR = 100_000;
const FUND_IDR = 20_000;
const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";
const CONFLICT_ACTION = "payment.refund_provider_conflict";
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;

const apiKey = `doit-key-${randomBytes(12).toString("hex")}`;
const webhookSecret = `whsec-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

const integrationIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const eventIds: string[] = [];
let integrationId = "";
let doitServer: Server;
let doitBaseUrl = "";

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");

// 1108: these suites exercise the ACTIVE refund webhook path; with the switch off
// every matched refund event is hold-only (1101/1108 P1-1), so turn it on here.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

beforeAll(async () => {
  flags.DOIT_REFUNDS_ENABLED = true;
  await scope.seed(owner);
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The webhook path never calls DOIT for these events; the integration only
  // needs a reachable base URL.
  doitServer = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
  });
  await new Promise<void>((accept) =>
    doitServer.listen(0, "127.0.0.1", accept),
  );
  doitBaseUrl = `http://127.0.0.1:${(doitServer.address() as AddressInfo).port}`;

  const created = await upsertIntegration(
    tenantWide,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doitBaseUrl },
      credentials: { apiKey, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    tenantWide,
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  integrationIds.push(created.id);

  const adapter = createDoitGateway({
    loadCredentials: async () => ({
      integration: {
        id: integrationId,
        outletId: null,
        config: { baseUrl: doitBaseUrl },
      },
      credentials: { apiKey, webhookSecret },
    }),
  });
  setPaymentGateway(adapter);
  setPaymentRefundGateway(adapter as unknown as PaymentRefundPort);
});

afterAll(async () => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await cleanupRows();
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.end();
  await new Promise<void>((accept) => doitServer.close(() => accept()));
});

async function cleanupRows() {
  // 1075 I8: a success on a refund settled outside the provider is held.
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  // legend-30hfs: provider refunds recorded by an unmatched refund event.
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
    [tenantId, eventIds],
  );
  eventIds.length = 0;
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});
afterEach(async () => {
  await cleanupRows();
  clearDoitWebhookSecretCache();
});

/** A settled DOIT bill minted by the integration. */
async function seedPaidIntent() {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const paymentId = `dp_${hex(8)}`;
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [linkId, tenantId, outletA, hex(32), `MSW-${hex(4)}`, PAID_IDR, actor],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'partially_refunded', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      PAID_IDR,
      `msw-${intentId}`,
      paymentId,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, paymentId, PAID_IDR],
  );
  return { intentId, paymentId };
}

const backdate = (eventId: string, minutes: number) =>
  owner.query(
    `UPDATE gateway_webhook_events
       SET received_at = now() - make_interval(mins => $3),
           updated_at = now() - make_interval(mins => $3)
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId, minutes],
  );

const reprocess = () =>
  reprocessStoredWebhookEvents(webhookContext, new Date(), 100);

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    last_payout_error: string | null;
    failure_reason: string | null;
    completed_at: Date | null;
  }>(
    `SELECT status, provider_ref, last_payout_error, failure_reason, completed_at
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!;
}

async function conflictAudits(refundId: string) {
  const { rows } = await owner.query(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, refundId, CONFLICT_ACTION],
  );
  return rows;
}

async function eventRows(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows;
}

/** Provider refunds recorded for the intent (legend-30hfs). */
async function providerRefunds(intentId: string) {
  const { rows } = await owner.query<{
    amount_idr: string;
    provider_payment_ref: string;
    evidence_id: string | null;
  }>(
    `SELECT amount_idr, provider_payment_ref, evidence_id FROM payment_provider_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return rows.map((r) => ({
    amount: Number(r.amount_idr),
    payment: r.provider_payment_ref,
    evidence: r.evidence_id !== null,
  }));
}

async function fundProviderRefunded(fundId: string) {
  const { rows } = await owner.query<{ at: Date | null }>(
    "SELECT provider_refunded_at AS at FROM payment_unallocated_funds WHERE id = $1",
    [fundId],
  );
  return rows[0]?.at != null;
}

/** Deliver one signed refund event; `data` is the DOIT payload. */
function deliver(type: string, data: Record<string, unknown>) {
  const id = `evt_${hex(8)}`;
  eventIds.push(id);
  const raw = JSON.stringify({
    id,
    type,
    created_at: new Date().toISOString(),
    data,
  });
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", webhookSecret)
    .update(`${t}.${raw}`)
    .digest("hex");
  return {
    eventId: id,
    response: request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", `t=${t},v1=${mac}`)
      .send(raw),
  };
}

/**
 * A paid intent (own payment p1) with a fund backed by a second payment p2 and a
 * fund refund settled by hand (completed, marker, no provider ref).
 */
async function seedSettledFundRefund() {
  const { intentId, paymentId: p1 } = await seedPaidIntent();
  const p2 = `dp_${hex(8)}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletA, intentId, p2, FUND_IDR],
  );
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletA, intentId, evidence.rows[0]!.id, FUND_IDR],
  );
  const refundId = await insertFundRefund(intentId, fundId, true);
  return { refundId, intentId, fundId, p1, p2 };
}

async function insertFundRefund(
  intentId: string,
  fundId: string | null,
  settledByHand: boolean,
) {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, unallocated_fund_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, last_payout_error,
                                  completed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Kembalikan kelebihan bayar', $7, 'system:test', $8, now(), $9, $10,
             $11, now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      fundId,
      FUND_IDR,
      settledByHand ? "completed" : "approved",
      randomUUID(),
      settledByHand ? 8 : 1,
      settledByHand ? SETTLED_OUTSIDE_PROVIDER : "Error",
      settledByHand ? new Date() : null,
    ],
  );
  return refundId;
}

/** Deliver a flat sandbox success, then age it past the 15 minute retry window. */
async function deliverFlatAged(paymentId: string, amount: number) {
  const sent = deliver("refund.succeeded", {
    amount,
    refund_id: `rf_${hex(6)}`,
    payment_id: paymentId,
  });
  await sent.response;
  await backdate(sent.eventId, 16);
  await reprocess();
  return sent.eventId;
}

describe("legend-kl46s DOIT reports a fund refund that finance settled by hand", () => {
  it("an event naming the fund's payment p2 reaches the provider conflict and changes nothing", async () => {
    const { refundId, p2 } = await seedSettledFundRefund();
    const before = await refundRow(refundId);
    expect(before).toMatchObject({
      status: "completed",
      provider_ref: null,
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
    });

    const eventId = await deliverFlatAged(p2, FUND_IDR);

    expect(await eventRows(eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
    // 1075 I8: paying twice is possible, so the intent stays held.
    const { rows: holds } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM refund_recon_holds WHERE payment_intent_id = (SELECT payment_intent_id FROM payment_refunds WHERE id = $1) AND resolved_at IS NULL",
      [refundId],
    );
    expect(Number(holds[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it("two live refunds on p2 are ambiguous: no conflict, nothing changes", async () => {
    // One live refund per fund (payment_refunds_unallocated_fund_live_uq), so the
    // second live refund is an ordinary one on another intent whose own payment
    // is p2 (a flat event names no intent).
    const { refundId, intentId, fundId, p2 } = await seedSettledFundRefund();
    const { intentId: otherIntentId } = await seedPaidIntent();
    await owner.query(
      "UPDATE payment_intents SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, otherIntentId, p2],
    );
    const otherId = await insertFundRefund(otherIntentId, null, false);
    const before = await refundRow(refundId);
    const otherBefore = await refundRow(otherId);

    const eventId = await deliverFlatAged(p2, FUND_IDR);

    // legend-30hfs: no refund of ours matches, so it is the provider's own
    // refund of p2, recorded against the intent whose evidence p2 is.
    expect(await eventRows(eventId)).toEqual([
      expect.objectContaining({ status: "processed", last_error_code: null }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
    expect(await refundRow(otherId)).toEqual(otherBefore);
    expect(await providerRefunds(intentId)).toEqual([
      { amount: FUND_IDR, payment: p2, evidence: true },
    ]);
    expect(
      await providerRefunds(otherIntentId),
      "never the other intent",
    ).toEqual([]);
    // The fund p2 backs is blocked: it can never be refunded again.
    expect(await fundProviderRefunded(fundId)).toBe(true);
  });

  it("an event naming the intent's own payment p1 never matches the fund refund (its source is p2)", async () => {
    const { refundId, intentId, fundId, p1 } = await seedSettledFundRefund();
    const before = await refundRow(refundId);

    const eventId = await deliverFlatAged(p1, FUND_IDR);

    // legend-30hfs: recorded as the provider's own partial refund of p1 (the
    // intent's own payment), never as the fund refund.
    expect(await eventRows(eventId)).toEqual([
      expect.objectContaining({ status: "processed", last_error_code: null }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
    expect(await providerRefunds(intentId)).toEqual([
      { amount: FUND_IDR, payment: p1, evidence: true },
    ]);
    expect(await fundProviderRefunded(fundId), "p2's fund is not p1").toBe(
      false,
    );
  });

  it("an event naming another payment never matches the fund refund", async () => {
    const { refundId } = await seedSettledFundRefund();
    const before = await refundRow(refundId);

    const eventId = await deliverFlatAged(`dp_${hex(8)}`, FUND_IDR);

    expect(await eventRows(eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
  });
});
