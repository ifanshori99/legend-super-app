// Refund-only DOIT webhooks keep working after the integration that minted the
// payment was disabled (bead legend-gqv7, WS-05, PAY-02, PAY-04, TEN-01).
// Written from docs/briefs/788-shared-context.md ("gqv7"), not from the service
// code, following the set-up of payment-doit-refund-webhook.test.ts.
//
// Rule under test: a `refund.*` event without a payment reference (no
// data.reference) is matched to its refund by idempotency key (`refund:<uuid>`)
// or by the refund id DOIT gave earlier (provider_ref). The refund names the
// minting integration (via its payment), and the signature is still verified
// against THAT integration's secret, even when it is disabled. Money for an
// approved refund may already have left, so the closing event must land.
//
// Assumptions where the brief is silent:
// - "Refund-only" = the flat refund object carries `payment_id` (like the
//   events in payment-doit-refund-webhook.test.ts) but NO `reference` key, so
//   the minting integration can only be found through the refund itself.
//   (Without `payment_id` the event is ignored as REFUND_FACTS_INVALID.)
// - A refund the tenant does not know (unknown id, or an id that belongs to
//   another tenant) answers 401, as the brief states for "refund tak dikenal".
// - A replay of the same event id answers 200 with status "duplicate".
// - Rejected (401) deliveries store no row for their event id.
// - approved_by is a text column, but the refund view parses it as a UUID, so
//   the seeded approver is a random UUID (no real user needed).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
import { env } from "../config/env";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  setPaymentRefundGateway,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

const app = createApp();

// These suites exercise the active provider-refund path: DOIT refunds are off
// by default, so switch them on here and restore the value afterwards.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const PAID_IDR = 100_000;
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;

const apiKeyA = `doit-key-a-${randomBytes(12).toString("hex")}`;
const secretA = `whsec-a-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

const integrationIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const eventIds: string[] = [];
let integrationAId = "";

// A second tenant that owns a paid intent and an approved refund.
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const otherLink = randomUUID();
const otherIntent = randomUUID();
const otherRefund = randomUUID();

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");
const newEventId = () => `evt_${hex(8)}`;

// ---------------------------------------------------------------------------
// Fake DOIT: only gives the integration a base URL and records any call. A
// webhook must never call DOIT to pay.
// ---------------------------------------------------------------------------

class FakeDoit {
  readonly calls: string[] = [];
  private server: Server | null = null;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.calls.push(`${req.method} ${req.url}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "-" } }));
    });
    await new Promise<void>((accept) =>
      this.server!.listen(0, "127.0.0.1", accept),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((accept) =>
      this.server ? this.server.close(() => accept()) : accept(),
    );
  }
}

const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SeededIntent = { intentId: string; paymentId: string; amountIdr: number };

async function seedIntegration(webhookSecret: string): Promise<string> {
  const created = await upsertIntegration(
    tenantWide,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey: apiKeyA, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    tenantWide,
    created.id,
    { status: "active" },
    actor,
  );
  integrationIds.push(created.id);
  return created.id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  integrationAId = await seedIntegration(secretA);
  // The real adapter, as server.ts registers it (payment AND refund gateway).
  const adapter = createDoitGateway({
    loadCredentials: async () => ({
      integration: {
        id: integrationAId,
        outletId: null,
        config: { baseUrl: doit.baseUrl },
      },
      credentials: { apiKey: apiKeyA, webhookSecret: secretA },
    }),
  });
  setPaymentGateway(adapter);
  setPaymentRefundGateway(adapter as unknown as PaymentRefundPort);

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":["doit"]}', $3, $4)`,
    [
      otherTenant,
      `other-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHER', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
  await owner.query(
    "INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by) VALUES ($1, $2, $3, $4, 'Other', 100000, 100000, 100000, 'seed')",
    [otherLink, otherTenant, otherOutlet, randomBytes(32).toString("hex")],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $6)`,
    [
      otherIntent,
      otherTenant,
      otherOutlet,
      otherLink,
      `other-${otherIntent}`,
      `dp_${hex(8)}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, approved_by, decided_at, payout_attempts)
     VALUES ($1, $2, $3, $4, 100000, 'Other tenant refund', 'approved', 'other-requester', 'other-approver', now(), 1)`,
    [otherRefund, otherTenant, otherOutlet, otherIntent],
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    [...intentIds, otherIntent],
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    [...linkIds, otherLink],
  ]);
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]);
  await owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]);
  await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
  await doit.stop();
});

async function cleanupRows() {
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
    [tenantId, eventIds],
  );
  eventIds.length = 0;
}

/** The minting integration is switched off: the state under test. */
beforeEach(async () => {
  resetPaymentWebhookRateLimits();
  doit.calls.length = 0;
  await setIntegrationStatus(
    tenantWide,
    integrationAId,
    { status: "disabled" },
    actor,
  );
  clearDoitWebhookSecretCache();
});

afterEach(async () => {
  await setIntegrationStatus(
    tenantWide,
    integrationAId,
    { status: "active" },
    actor,
  );
  await cleanupRows();
  clearDoitWebhookSecretCache();
});

/** A settled DOIT bill minted by integration A. */
async function seedPaidIntent(): Promise<SeededIntent> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const paymentId = `dp_${hex(8)}`;
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [linkId, tenantId, outletA, hex(32), `DRD-${hex(4)}`, PAID_IDR, actor],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      PAID_IDR,
      `drd-${intentId}`,
      paymentId,
      integrationAId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, paymentId, PAID_IDR],
  );
  return { intentId, paymentId, amountIdr: PAID_IDR };
}

/** An approved refund of the whole payment, already sent to DOIT once. */
async function seedRefund(
  intent: SeededIntent,
  providerRef: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian DOIT', 'approved', 'system:reservation', $7, now(), $6, 1, now() - interval '2 hours')`,
    [
      id,
      tenantId,
      outletA,
      intent.intentId,
      intent.amountIdr,
      providerRef,
      actor,
    ],
  );
  return id;
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
    provider_ref: string | null;
    completed_at: Date | null;
  }>(
    `SELECT status, failure_reason, provider_ref, completed_at
     FROM payment_refunds WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function refundCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_refunds WHERE payment_intent_id = $1",
    [intentId],
  );
  return Number(rows[0]!.n);
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]?.status;
}

async function eventRows(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    signature_valid: boolean;
  }>(
    `SELECT status, signature_valid FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

function refundEvent(type: string, data: Record<string, unknown>) {
  const id = newEventId();
  eventIds.push(id);
  return { id, type, created_at: new Date().toISOString(), data };
}

/** Refund-only: the refund's own fields and payment_id, no `reference`. */
const refundOnly = (
  match: { refundId: string } | { providerRef: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  object: "refund",
  id: "providerRef" in match ? match.providerRef : `rf_${hex(6)}`,
  ...("refundId" in match
    ? { idempotency_key: `refund:${match.refundId}` }
    : {}),
  amount: PAID_IDR,
  ...extra,
});

function signatureHeader(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

function deliver(body: object, secret: string = secretA) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw, secret))
    .send(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PAY-04 a refund-only webhook from a disabled integration still closes the refund", () => {
  it("PAY-04 refund.succeeded matched by idempotency key is accepted, stored and completes the refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const data = refundOnly(
      { refundId },
      { status: "succeeded", payment_id: intent.paymentId },
    );
    const body = refundEvent("refund.succeeded", data);

    const response = await deliver(body);
    console.log(
      "DIAG",
      response.status,
      JSON.stringify(response.body),
      JSON.stringify(
        (
          await owner.query(
            "SELECT status, last_error_code, signature_valid FROM gateway_webhook_events WHERE tenant_id=$1 AND event_id=$2",
            [tenantId, body.id],
          )
        ).rows,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    const done = await refundRow(refundId);
    expect(done).toMatchObject({
      status: "completed",
      failure_reason: null,
      provider_ref: data.id,
    });
    expect(done.completed_at).not.toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(await eventRows(body.id)).toEqual([
      { status: "processed", signature_valid: true },
    ]);
    // The webhook never pays: DOIT already did.
    expect(doit.calls).toEqual([]);
  });

  it("PAY-04 refund.succeeded matched by the refund id DOIT gave earlier is accepted and completes the refund", async () => {
    const intent = await seedPaidIntent();
    const knownRef = `rf_${hex(6)}`;
    const refundId = await seedRefund(intent, knownRef);
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { providerRef: knownRef },
        { status: "succeeded", payment_id: intent.paymentId },
      ),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await eventRows(body.id)).toEqual([
      { status: "processed", signature_valid: true },
    ]);
  });

  it("PAY-04 refund.failed from a disabled integration fails the refund as provider_declined and the bill stays paid", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = refundEvent(
      "refund.failed",
      refundOnly(
        { refundId },
        {
          status: "failed",
          failure_code: "insufficient_funds",
          payment_id: intent.paymentId,
        },
      ),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 a replay of the same event is a duplicate and never refunds twice", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { refundId },
        { status: "succeeded", payment_id: intent.paymentId },
      ),
    );
    expect((await deliver(body)).body.status).toBe("processed");
    const done = await refundRow(refundId);

    const replay = await deliver(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, status: "duplicate" });
    const after = await refundRow(refundId);
    expect(after.status).toBe("completed");
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
    expect(await refundCount(intent.intentId)).toBe(1);
    expect(await eventRows(body.id)).toHaveLength(1);
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(doit.calls).toEqual([]);
  });
});

describe("PAY-04 control: the same refund-only webhook from an active integration", () => {
  it("PAY-04 refund.succeeded is accepted and completes the refund while the integration is active", async () => {
    await setIntegrationStatus(
      tenantWide,
      integrationAId,
      { status: "active" },
      actor,
    );
    clearDoitWebhookSecretCache();
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { refundId },
        { status: "succeeded", payment_id: intent.paymentId },
      ),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect((await refundRow(refundId)).status).toBe("completed");
  });
});

describe("PAY-02 a refund-only webhook from a disabled integration is still authenticated", () => {
  it("PAY-02 a bad signature is refused with 401 and changes nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { refundId },
        { status: "succeeded", payment_id: intent.paymentId },
      ),
    );

    const response = await deliver(body, `whsec-wrong-${hex(8)}`);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await eventRows(body.id)).toEqual([]);
  });

  it("PAY-02 an unknown refund id is refused with 401 even with the right secret", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { refundId: randomUUID() },
        { status: "succeeded", payment_id: intent.paymentId },
      ),
    );

    const response = await deliver(body);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await eventRows(body.id)).toEqual([]);
  });
});

describe("TEN-01 a refund of another tenant is never reachable through this tenant's webhook", () => {
  it("TEN-01 another tenant's refund key signed with this tenant's secret is refused with 401 and leaves that refund alone", async () => {
    const body = refundEvent(
      "refund.succeeded",
      refundOnly(
        { refundId: otherRefund },
        { status: "succeeded", payment_id: `dp_${hex(8)}` },
      ),
    );

    const response = await deliver(body);

    expect(response.status).toBe(401);
    expect(await refundRow(otherRefund)).toMatchObject({
      status: "approved",
      completed_at: null,
    });
    expect(await intentStatus(otherIntent)).toBe("paid");
    expect(await eventRows(body.id)).toEqual([]);
  });
});
