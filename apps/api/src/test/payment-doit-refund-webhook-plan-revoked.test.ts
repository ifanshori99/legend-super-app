// A DOIT refund already in flight keeps reconciling after the provider was
// withdrawn from the tenant's plan (bead legend-797 / second opinion finding P2,
// WS-05, PAY-02, PAY-04, TEN-01). Written from docs/qa/second-opinion-doit-refund.md
// and the platform-integration contract ("removing the provider from the plan
// stops NEW payments, never the reconciliation of money already in flight"),
// following the set-up of payment-doit-refund-webhook-disabled.test.ts.
//
// State under test: the minting integration is disabled AND `doit` is removed
// from tenants.feature_flags.integrationProviders, the secret cache is empty.
// Rule: a validly signed refund.* webhook without a payment reference, and the
// refund status poll, still find the minting integration through the stored
// refund/intent and close the refund exactly once. New payments stay blocked.
//
// Assumptions where the docs are silent:
// - Refund-only = flat refund object with `payment_id` but no `reference`.
// - The same rule applies with `reference` = payment intent id (stored-intent
//   path named in the finding).
// - Unknown / other-tenant refund = 401; replay = 200 "duplicate"; rejected
//   deliveries store no event row.
// - "Poll" = gateway.getRefundStatus with the DEFAULT by-id credential loader
//   (no loadCredentialsById injected), answering from a fake DOIT payment.
// - A new payment through the default active loader must fail and must not
//   reach DOIT; with the plan intact the same call does reach DOIT (control).
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
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  setPaymentRefundGateway,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import {
  loadActiveIntegrationCredentials,
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

const app = createApp();
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
let otherIntegrationId = "";

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");
const newEventId = () => `evt_${hex(8)}`;

// ---------------------------------------------------------------------------
// Fake DOIT: only gives the integration a base URL and records any call. A
// webhook must never call DOIT to pay.
// ---------------------------------------------------------------------------

class FakeDoit {
  readonly calls: string[] = [];
  /** Payments DOIT would return on GET /v1/payments/:id. */
  readonly payments = new Map<string, Record<string, unknown>>();
  private server: Server | null = null;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.calls.push(`${req.method} ${req.url}`);
      const hit = /^\/v1\/payments\/([^/?]+)$/.exec(req.url ?? "");
      const found = req.method === "GET" && hit && this.payments.get(hit[1]!);
      if (found) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }
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

async function seedIntegration(
  webhookSecret: string,
  options: {
    context?: ScopedTenantContext;
    outletId?: string | null;
    apiKey?: string;
  } = {},
): Promise<string> {
  const context = options.context ?? tenantWide;
  const created = await upsertIntegration(
    context,
    {
      outletId: (options.outletId ?? null) as OutletId | null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey: options.apiKey ?? apiKeyA, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(context, created.id, { status: "active" }, actor);
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
  // The other tenant runs DOIT too, with the SAME webhook secret as this
  // tenant, and its intent is minted on that integration: a refund key leaked
  // across tenants would then find a minting integration and a matching secret,
  // so only the tenant binding keeps it out.
  otherIntegrationId = await seedIntegration(secretA, {
    context: establishScopedTenantContext(
      establishTenantContext({
        tenantId: otherTenant,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    apiKey: `doit-key-other-${hex(8)}`,
  });
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $6, $7)`,
    [
      otherIntent,
      otherTenant,
      otherOutlet,
      otherLink,
      `other-${otherIntent}`,
      `dp_${hex(8)}`,
      otherIntegrationId,
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
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
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

let providersBefore: unknown = null;

async function revokeDoitFromPlan() {
  await owner.query(
    "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', '[]'::jsonb) WHERE id = $1",
    [tenantId],
  );
  clearDoitWebhookSecretCache();
}

async function restorePlan() {
  await owner.query(
    "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1",
    [tenantId, JSON.stringify(providersBefore ?? ["doit"])],
  );
  clearDoitWebhookSecretCache();
}

/** The state under test: integration disabled, `doit` withdrawn from the plan. */
beforeEach(async () => {
  resetPaymentWebhookRateLimits();
  doit.calls.length = 0;
  doit.payments.clear();
  const { rows } = await owner.query<{ providers: unknown }>(
    "SELECT feature_flags->'integrationProviders' AS providers FROM tenants WHERE id = $1",
    [tenantId],
  );
  providersBefore = rows[0]?.providers ?? ["doit"];
  await setIntegrationStatus(
    tenantWide,
    integrationAId,
    { status: "disabled" },
    actor,
  );
  await revokeDoitFromPlan();
});

afterEach(async () => {
  await restorePlan();
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

const succeededEvent = (
  intent: SeededIntent,
  match: { refundId: string } | { providerRef: string },
  extra: Record<string, unknown> = {},
) =>
  refundEvent(
    "refund.succeeded",
    refundOnly(match, {
      status: "succeeded",
      payment_id: intent.paymentId,
      ...extra,
    }),
  );

describe("PAY-04 a refund-only webhook still closes the refund after doit left the plan", () => {
  it("PAY-04 refund.succeeded matched by idempotency key is accepted, stored and completes the refund once", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = succeededEvent(intent, { refundId });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    const done = await refundRow(refundId);
    expect(done).toMatchObject({ status: "completed", failure_reason: null });
    expect(done.completed_at).not.toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(await eventRows(body.id)).toEqual([
      { status: "processed", signature_valid: true },
    ]);
    expect(await refundCount(intent.intentId)).toBe(1);
    // The webhook never pays: DOIT already did.
    expect(doit.calls).toEqual([]);
  });

  it("PAY-04 refund.succeeded matched by the refund id DOIT gave earlier completes the refund", async () => {
    const intent = await seedPaidIntent();
    const knownRef = `rf_${hex(6)}`;
    const refundId = await seedRefund(intent, knownRef);
    const body = succeededEvent(intent, { providerRef: knownRef });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(await eventRows(body.id)).toEqual([
      { status: "processed", signature_valid: true },
    ]);
  });

  it("PAY-04 refund.succeeded that carries the payment intent as reference completes the refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = succeededEvent(
      intent,
      { refundId },
      { reference: intent.intentId },
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await intentStatus(intent.intentId)).toBe("refunded");
  });

  it("PAY-04 refund.failed fails the refund as provider_declined and the bill stays paid", async () => {
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
    const body = succeededEvent(intent, { refundId });
    expect((await deliver(body)).body).toEqual({
      received: true,
      status: "processed",
    });
    const done = await refundRow(refundId);

    const replay = await deliver(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, status: "duplicate" });
    const after = await refundRow(refundId);
    expect(after.status).toBe("completed");
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
    expect(await refundCount(intent.intentId)).toBe(1);
    expect(await eventRows(body.id)).toHaveLength(1);
    expect(doit.calls).toEqual([]);
  });
});

describe("PAY-04 an event verified by another integration with the same secret still closes the refund after doit left the plan", () => {
  // Assumption (the docs are silent on two integrations sharing a secret):
  // verification is by secret, so a delivery may be verified by integration B
  // while the refund's payment was minted on integration A. The refund must
  // still close, because A's secret equals the one that signed, even though the
  // plan no longer lists doit. To get B to verify, a process that cached the
  // tenant's secrets (60 s TTL) before the plan change keeps serving B; the
  // plan is then withdrawn WITHOUT clearing that cache (another API instance or
  // the worker behaves exactly like this).
  it("PAY-04 refund.succeeded verified by integration B, payment minted on A, completes the refund once", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    await restorePlan();
    const integrationBId = await seedIntegration(secretA, {
      outletId: outletA,
      apiKey: `doit-key-b-${hex(8)}`,
    });
    try {
      // A stays disabled (beforeEach), so only B is an active secret holder.
      // A harmless signed event fills the secret cache with B.
      const warmUp = refundEvent("customer.created", {});
      expect((await deliver(warmUp)).status).toBe(200);
      expect(await eventRows(warmUp.id)).toHaveLength(1);
      const { rows: warm } = await owner.query<{ integration_id: string }>(
        "SELECT integration_id FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
        [tenantId, warmUp.id],
      );
      expect(warm[0]?.integration_id).toBe(integrationBId);

      // Withdraw doit from the plan behind the cache's back.
      await owner.query(
        "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', '[]'::jsonb) WHERE id = $1",
        [tenantId],
      );
      const body = succeededEvent(intent, { refundId });

      const response = await deliver(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, status: "processed" });
      const { rows: stored } = await owner.query<{ integration_id: string }>(
        "SELECT integration_id FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
        [tenantId, body.id],
      );
      expect(stored[0]?.integration_id).toBe(integrationBId);
      expect((await refundRow(refundId)).status).toBe("completed");
      expect(await intentStatus(intent.intentId)).toBe("refunded");
      expect(await refundCount(intent.intentId)).toBe(1);
      expect(doit.calls).toEqual([]);
    } finally {
      await setIntegrationStatus(
        tenantWide,
        integrationBId,
        { status: "disabled" },
        actor,
      );
    }
  });
});

describe("PAY-02 and TEN-01 the webhook is still authenticated and tenant-bound after doit left the plan", () => {
  it("PAY-02 a bad signature is refused with 401 and changes nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = succeededEvent(intent, { refundId });

    const response = await deliver(body, `whsec-wrong-${hex(8)}`);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await eventRows(body.id)).toEqual([]);
  });

  it("PAY-02 an unknown refund id is refused with 401 even with the right secret", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent);
    const body = succeededEvent(intent, { refundId: randomUUID() });

    const response = await deliver(body);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await eventRows(body.id)).toEqual([]);
  });

  it("TEN-01 another tenant's refund key signed with this tenant's secret is refused with 401 and left alone", async () => {
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

describe("PAY-04 the refund status poll still reconciles after doit left the plan", () => {
  /** The default by-id loader: no loadCredentialsById injected. */
  const pollGateway = () =>
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationAId,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey: apiKeyA, webhookSecret: secretA },
      }),
    }) as unknown as PaymentRefundPort;

  function statusFor(intent: SeededIntent, providerRef: string | null) {
    return {
      context: tenantWide,
      idempotencyKey: `refund:${randomUUID()}`,
      providerRef,
      signal: new AbortController().signal,
      paymentIntentId: intent.intentId,
      paymentProviderRef: intent.paymentId,
      integrationId: integrationAId,
      outletId: outletA,
      amountIdr: intent.amountIdr,
    };
  }

  it("PAY-04 getRefundStatus reads DOIT with the minting integration and reports the refund as succeeded", async () => {
    const intent = await seedPaidIntent();
    doit.payments.set(intent.paymentId, {
      id: intent.paymentId,
      status: "refunded",
      amount: intent.amountIdr,
      rail: "qris",
      reference: intent.intentId,
      fee_amount: 0,
      fee_payer: "merchant",
      total_amount: intent.amountIdr,
      created_at: "2026-11-08T10:00:00.000Z",
    });
    const knownRef = `rf_${hex(6)}`;

    const result = await pollGateway().getRefundStatus(
      statusFor(intent, knownRef),
    );

    expect(result).toEqual({ status: "succeeded", providerRef: knownRef });
    expect(doit.calls).toEqual([`GET /v1/payments/${intent.paymentId}`]);
  });
});

describe("PAY-05 new payments stay blocked once doit left the plan", () => {
  it("PAY-05 the loader for new work refuses the provider and createIntent never reaches DOIT", async () => {
    // The platform refuses to switch a withdrawn provider on, so make the
    // integration active (the worst case for new work) straight in the table.
    await owner.query(
      "UPDATE tenant_integrations SET status = 'active' WHERE id = $1",
      [integrationAId],
    );
    clearDoitWebhookSecretCache();
    expect(
      await loadActiveIntegrationCredentials(tenantWide, "doit", outletA),
    ).toBeNull();

    await expect(
      createDoitGateway({}).createIntent({
        context: tenantWide,
        provider: "doit",
        outletId: outletA,
        intentId: randomUUID(),
        method: "qris",
        channelCode: null,
        amountIdr: PAID_IDR,
        idempotencyKey: `idem-${hex(12)}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(doit.calls).toEqual([]);
  });

  it("PAY-05 control: with doit in the plan and the integration active, new work finds the credentials", async () => {
    await restorePlan();
    await setIntegrationStatus(
      tenantWide,
      integrationAId,
      { status: "active" },
      actor,
    );
    clearDoitWebhookSecretCache();

    const found = await loadActiveIntegrationCredentials(
      tenantWide,
      "doit",
      outletA,
    );

    expect(found?.integration.id).toBe(integrationAId);
  });
});
