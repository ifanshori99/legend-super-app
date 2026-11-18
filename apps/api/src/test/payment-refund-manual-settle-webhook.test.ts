// legend-xd2q: a refund finance settled by hand (completed, last_payout_error
// SETTLED_OUTSIDE_PROVIDER, no provider reference) that DOIT later reports as
// `succeeded` means the customer was paid twice. By the webhook convention of
// payment-doit-refund-webhook.test.ts (~:645) a contradiction is answered HTTP
// 200 with body status "ignored", the stored event gets last_error_code
// REJECTED_CONFLICT and a `payment.refund_provider_conflict` audit is written;
// nothing on the refund changes. Written
// from the architect brief (behaviour B, `contradicts`), not from the service
// code; may fail until the code lands.
//
// Separate from payment-refund-manual-settle.test.ts because it needs the signed
// DOIT webhook harness (same set-up as payment-doit-refund-webhook.test.ts).
//
// Assumptions:
// - The settled state is seeded straight into the table: it is exactly what the
//   settle endpoint leaves (status completed, marker, provider_ref NULL).
// - The conflict audit is `payment.refund_provider_conflict` on the refund (the
//   action the service already uses for a late `succeeded` on a failed refund).
// - Without an idempotency key the settled refund is found through the bill (the
//   fallback). An event whose data is only the refunded payment object (no refund
//   id, no key) applies at once. An event that also carries a refund id (plus a
//   `payment` object {id: the bill's provider_ref, reference: the bill id,
//   status: "refunded", amount}) stays retryable (failed, REFUND_UNMATCHED) for
//   15 minutes after received_at and only then reaches the conflict, on reprocess.
// - The fallback refuses when the bill has another non-failed refund (ambiguous).
// - A succeeded event WITH the key and a different amount than the refund is
//   still a conflict.
// - A refund.failed (with the key) on a settled refund is not a contradiction of
//   the money having left: it is processed, no conflict audit, refund unchanged.
// - A control: `refund.succeeded` for a refund completed by the provider itself
//   (no marker) is not a conflict (the existing replay/no-op behaviour); only the
//   status is asserted to be below 400.
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
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
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

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const PAID_IDR = 100_000;
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

beforeAll(async () => {
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
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await cleanupRows();
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
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

/** A completed refund: settled by hand (marker) or by the provider (no marker, a provider reference). */
async function seedCompletedRefund(settledByHand: boolean) {
  const { intentId, paymentId } = await seedPaidIntent();
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts,
                                  last_payout_error, completed_at, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian dibayar manual', 'completed', 'system:reservation', $5, now(),
             $6, 8, $7, now(), now())`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      randomUUID(),
      settledByHand ? null : `rf_${hex(6)}`,
      settledByHand ? SETTLED_OUTSIDE_PROVIDER : null,
    ],
  );
  return { refundId, intentId, paymentId };
}

/** A second, non-failed refund (approved, one attempt) on an existing bill. */
async function seedApprovedRefundOn(intentId: string) {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, last_payout_error, updated_at)
     VALUES ($1, $2, $3, $4, 20000, 'Pengembalian kedua', 'approved', 'system:reservation', $5, now(), 1, 'Error',
             now() - interval '2 hours')`,
    [refundId, tenantId, outletA, intentId, randomUUID()],
  );
  return refundId;
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

const flatRefund = (
  refundId: string,
  providerRefundId: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  object: "refund",
  id: providerRefundId,
  idempotency_key: `refund:${refundId}`,
  amount: 30_000,
  status,
  ...extra,
});

describe("legend-xd2q PAY-04 DOIT reports a refund that finance already settled by hand", () => {
  it("PAY-04 refund.succeeded on a manually settled refund is ignored as REJECTED_CONFLICT, audits a conflict and changes nothing", async () => {
    const { refundId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);
    expect(before).toMatchObject({
      status: "completed",
      provider_ref: null,
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
    });

    const sent = deliver(
      "refund.succeeded",
      flatRefund(refundId, `rf_${hex(6)}`, "succeeded", {
        payment_id: paymentId,
      }),
    );
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 an event that is only the refunded payment object (no refund id, no key) reaches the conflict at once", async () => {
    const { refundId, intentId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver("refund.succeeded", {
      id: paymentId,
      reference: intentId,
      status: "refunded",
      amount: PAID_IDR,
    });
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 an event with a refund id but no key stays retryable for 15 minutes, then reaches the conflict on reprocess", async () => {
    const { refundId, intentId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver("refund.succeeded", {
      object: "refund",
      id: `rf_${hex(6)}`,
      amount: 30_000,
      status: "succeeded",
      payment: {
        id: paymentId,
        reference: intentId,
        status: "refunded",
        amount: PAID_IDR,
      },
    });
    await sent.response;

    // Fresh: the refund may still be unknown to us, so DOIT keeps resending.
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);

    // Inside the window it stays retryable.
    await backdate(sent.eventId, 5);
    await reprocess();
    expect((await eventRows(sent.eventId))[0]?.status).toBe("failed");
    expect(await conflictAudits(refundId)).toHaveLength(0);

    // After 15 minutes (16 here) the settled refund is the only candidate.
    await backdate(sent.eventId, 16);
    await reprocess();

    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 legend-0yd1 the sandbox's flat event (refund_id + payment_id, no payment object) reaches the conflict after 15 minutes", async () => {
    const { refundId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver("refund.succeeded", {
      amount: 30_000,
      refund_id: `rf_${hex(6)}`,
      payment_id: paymentId,
    });
    await sent.response;

    // Fresh: the refund id may still be storing, so DOIT keeps resending.
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);

    await backdate(sent.eventId, 16);
    await reprocess();

    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 legend-0yd1 a flat event naming another payment_id never reaches the settled refund", async () => {
    const { refundId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver("refund.succeeded", {
      amount: 30_000,
      refund_id: `rf_${hex(6)}`,
      payment_id: `dp_${hex(8)}`,
    });
    await sent.response;
    await backdate(sent.eventId, 16);
    await reprocess();

    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 when the bill has another non-failed refund the fallback is ambiguous: no conflict on the settled refund", async () => {
    const { refundId, intentId, paymentId } = await seedCompletedRefund(true);
    const otherId = await seedApprovedRefundOn(intentId);
    const before = await refundRow(refundId);
    const otherBefore = await refundRow(otherId);

    const sent = deliver("refund.succeeded", {
      id: paymentId,
      reference: intentId,
      status: "refunded",
      amount: PAID_IDR,
    });
    await sent.response;

    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
    expect(await refundRow(otherId)).toEqual(otherBefore);

    // Same for an event that carries a refund id, once its 15 minutes passed.
    const withId = deliver("refund.succeeded", {
      object: "refund",
      id: `rf_${hex(6)}`,
      amount: 30_000,
      status: "succeeded",
      payment: {
        id: paymentId,
        reference: intentId,
        status: "refunded",
        amount: PAID_IDR,
      },
    });
    await withId.response;
    await backdate(withId.eventId, 16);
    await reprocess();
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
    expect(await refundRow(otherId)).toEqual(otherBefore);
  });

  it("PAY-04 refund.succeeded with the key but a different amount than the refund is still a conflict", async () => {
    const { refundId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver(
      "refund.succeeded",
      flatRefund(refundId, `rf_${hex(6)}`, "succeeded", {
        amount: 25_000,
        payment_id: paymentId,
      }),
    );
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 refund.failed on a manually settled refund is processed: no conflict audit, the refund is unchanged", async () => {
    const { refundId, paymentId } = await seedCompletedRefund(true);
    const before = await refundRow(refundId);

    const sent = deliver(
      "refund.failed",
      flatRefund(refundId, `rf_${hex(6)}`, "failed", {
        failure_code: "insufficient_funds",
        payment_id: paymentId,
      }),
    );
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
    expect(before.status).toBe("completed");
  });

  it("PAY-04 refund.succeeded on a refund the provider itself completed is not a conflict", async () => {
    const { refundId, paymentId } = await seedCompletedRefund(false);
    const before = await refundRow(refundId);

    const sent = deliver(
      "refund.succeeded",
      flatRefund(refundId, before.provider_ref!, "succeeded", {
        payment_id: paymentId,
      }),
    );
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(await conflictAudits(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toEqual(before);
  });
});
