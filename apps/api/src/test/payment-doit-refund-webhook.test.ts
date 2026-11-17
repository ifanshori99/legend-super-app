// DOIT refund results over the wire: signed `refund.*` webhooks and the sweep
// poll close an approved refund, never pay twice and never break the quarantine
// (bead legend-0ogy, WS-05, PAY-04, PAY-02, TEN-01). Written from
// docs/briefs/sub-doit-refund.md (slices B, C, D), not from the service code.
//
// Setup: a fake DOIT is a real http server on 127.0.0.1 and the real DOIT
// adapter talks to it (`createDoitGateway`, registered as payment AND refund
// gateway, as server.ts/worker-main.ts do). Refunds and paid intents are seeded
// straight into PostgreSQL (pattern of payment-refund-approval.test.ts), the
// intents carry the DOIT payment id (`provider_ref`) and the integration that
// minted them (`gateway_integration_id`). Webhooks are signed like DOIT does
// (`PayBridge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + raw)>`).
//
// Assumptions where the brief is silent:
// - The refund webhook `data` is built as the brief's parser describes:
//   `{ object: "refund", id, idempotency_key, amount, status }` (flat), or
//   `{ refund: {...} }` (nested), or a full payment object (path c).
// - An unmatched refund event answers 500 like UNKNOWN_REFERENCE does ("any
//   event that ends failed answers 500", payment-webhook-api.test.ts), so DOIT
//   resends; the test asserts the stored row, not the failed row's error code.
// - The cross-integration refusal writes an audit row whose action starts with
//   `payment.webhook.` and whose `maskedChanges.after.eventId` names the event
//   (same shape as the existing integration_mismatch audit).
// - A fully refunded payment ends `refunded` (refund = whole payment amount;
//   all seeded refunds cover the whole 100.000 payment unless stated).
// - A refund is "quarantined" when it is `approved` with last_payout_error
//   PAYOUT_QUARANTINED (legacy approval without a supervisor).
// - The brief's "two candidates" cannot be seeded: payment_refunds.provider_ref
//   is unique per tenant. Ambiguity is tested with another non-failed refund.
// - The sweep's lookup after an unknown outcome is a GET payment; a first
//   attempt (payout_attempts 0, no providerRef) sends one POST refund.
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
import { sweepApprovedRefundPayouts } from "../services/payment-refund.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const actor = randomUUID();
const PAID_IDR = 100_000;
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;

// Fake credentials: they must never appear in an audit row.
const apiKeyA = `doit-key-a-${randomBytes(12).toString("hex")}`;
const secretA = `whsec-a-${randomBytes(16).toString("hex")}`;
const secretB = `whsec-b-${randomBytes(16).toString("hex")}`;

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
const refundIds: string[] = [];
const eventIds: string[] = [];
let integrationAId = "";
let supervisorUserId = "";

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");
const newEventId = () => `evt_${hex(8)}`;

// ---------------------------------------------------------------------------
// Fake DOIT server: GET payment, POST refund, every call recorded
// ---------------------------------------------------------------------------

type FakePayment = {
  id: string;
  status: string;
  amount: number;
  reference: string;
};
type RecordedCall = {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
};

class FakeDoit {
  readonly payments = new Map<string, FakePayment>();
  readonly calls: RecordedCall[] = [];
  /** When set, POST refund answers this body (200) instead of a matching refund: a foreign answer. */
  refundAnswer:
    ((paymentId: string, input: { amount: number }) => unknown) | null = null;
  private readonly refundsByKey = new Map<string, unknown>();
  private server: Server | null = null;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
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

  setPayment(
    intent: SeededIntent,
    status: string,
    amount: number = intent.amountIdr,
  ): void {
    this.payments.set(intent.paymentId, {
      id: intent.paymentId,
      status,
      amount,
      reference: intent.intentId,
    });
  }

  /** POST `.../refunds` calls aimed at this payment. */
  refundPostsFor(paymentId: string): RecordedCall[] {
    return this.calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/v1/payments/${paymentId}/refunds`,
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    this.calls.push({
      method: req.method ?? "",
      path: url.pathname,
      idempotencyKey: (req.headers["idempotency-key"] as string) ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
    if (req.headers.authorization !== `Bearer ${apiKeyA}`)
      return send(401, {
        error: { code: "unauthorized", message: "Invalid API key" },
      });

    const refundPath = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(url.pathname);
    if (req.method === "POST" && refundPath) {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (this.refundAnswer)
        return send(
          200,
          this.refundAnswer(
            decodeURIComponent(refundPath[1]!),
            JSON.parse(raw) as { amount: number },
          ),
        );
      const known = this.refundsByKey.get(key);
      if (known) return send(200, known);
      const input = JSON.parse(raw) as { amount: number };
      // Sandbox shape (legend-r7g2): DOIT names the payment in `payment_id`.
      const refund = {
        id: `rf_${hex(8)}`,
        payment_id: decodeURIComponent(refundPath[1]!),
        status: "succeeded",
        amount: input.amount,
      };
      this.refundsByKey.set(key, refund);
      return send(200, refund);
    }
    const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && found) {
      const payment = this.payments.get(decodeURIComponent(found[1]!));
      return payment
        ? send(200, payment)
        : send(404, {
            error: { code: "payment_not_found", message: "not found" },
          });
    }
    return send(404, { error: { code: "not_found", message: "not found" } });
  }
}

const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedIntegration(
  outletId: OutletId | null,
  webhookSecret: string,
): Promise<string> {
  const created = await upsertIntegration(
    tenantWide,
    {
      outletId,
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

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  // Integration A (tenant-wide) mints every seeded intent; B is another
  // account of the same tenant with its own webhook secret.
  integrationAId = await seedIntegration(null, secretA);
  await seedIntegration(outletB, secretB);

  // A finance + supervisor approver so seeded `approved` refunds pass the
  // payout re-validation (same set-up as payment-refund-approval.test.ts).
  const client = agent(app);
  await signUp(client, "DOIT refund approver");
  const session = await client.get("/api/auth/get-session");
  supervisorUserId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, supervisorUserId, await roleIdOf("finance")],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, supervisorUserId, await roleIdOf("supervisor"), outletA],
  );

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
});

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await cleanupRows();
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, supervisorUserId],
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
  await doit.stop();
});

/** Refunds and webhook rows of one test never leak into the next one. */
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
  refundIds.length = 0;
  eventIds.length = 0;
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  doit.calls.length = 0;
  doit.payments.clear();
  doit.refundAnswer = null;
});
afterEach(async () => {
  await cleanupRows();
  clearDoitWebhookSecretCache();
});

type SeededIntent = {
  intentId: string;
  paymentId: string;
  amountIdr: number;
};

/** A settled DOIT bill minted by integration A. */
async function seedPaidIntent(amountIdr = PAID_IDR): Promise<SeededIntent> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const paymentId = `dp_${hex(8)}`;
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [linkId, tenantId, outletA, hex(32), `DRF-${hex(4)}`, amountIdr, actor],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      amountIdr,
      `drf-${intentId}`,
      paymentId,
      integrationAId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, paymentId, amountIdr],
  );
  return { intentId, paymentId, amountIdr };
}

type RefundSeed = {
  id?: string;
  amountIdr?: number;
  status?: "approved" | "pending" | "failed";
  providerRef?: string | null;
  attempts?: number;
  lastPayoutError?: string | null;
  /** The approver; a supervisor by default (not quarantined). */
  approvedBy?: string;
};

async function seedRefund(
  intent: SeededIntent,
  seed: RefundSeed = {},
): Promise<string> {
  const id = seed.id ?? randomUUID();
  refundIds.push(id);
  const status = seed.status ?? "approved";
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts,
                                  last_payout_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian DOIT', $6, $7, $8, $9, $10, $11, $12, now() - interval '2 hours')`,
    [
      id,
      tenantId,
      outletA,
      intent.intentId,
      seed.amountIdr ?? intent.amountIdr,
      status,
      "system:reservation",
      status === "pending" ? null : (seed.approvedBy ?? supervisorUserId),
      status === "pending" ? null : new Date(),
      seed.providerRef ?? null,
      seed.attempts ?? 0,
      seed.lastPayoutError ?? null,
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
    last_payout_error: string | null;
  }>(
    `SELECT status, failure_reason, provider_ref, completed_at, last_payout_error
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
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
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows;
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
const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

type RefundData = Record<string, unknown>;

function refundEvent(
  type: string,
  data: RefundData,
  id: string = newEventId(),
) {
  eventIds.push(id);
  return { id, type, created_at: new Date().toISOString(), data };
}

/** Flat refund object as the brief's parser reads it (`data.object` "refund"). */
const flatRefund = (
  refundId: string,
  amountIdr: number,
  extra: RefundData = {},
): RefundData => ({
  object: "refund",
  id: `rf_${hex(6)}`,
  idempotency_key: `refund:${refundId}`,
  amount: amountIdr,
  ...extra,
});

/** A full DOIT payment object as `data` (path c). */
const paymentData = (
  intent: SeededIntent,
  status: string,
  amountIdr: number,
): RefundData => ({
  id: intent.paymentId,
  status,
  amount: amountIdr,
  reference: intent.intentId,
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
// refund.succeeded / refund.failed matched by idempotency key (path a)
// ---------------------------------------------------------------------------

describe("PAY-04 a signed refund webhook closes the refund", () => {
  it("PAY-04 refund.succeeded with the idempotency key completes the refund; a replay is a duplicate", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const data = flatRefund(refundId, intent.amountIdr, {
      payment_id: intent.paymentId,
      status: "succeeded",
    });
    const body = refundEvent("refund.succeeded", data);

    const response = await deliver(body);

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
      expect.objectContaining({ status: "processed" }),
    ]);

    const replay = await deliver(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, status: "duplicate" });
    const after = await refundRow(refundId);
    expect(after.status).toBe("completed");
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
    // The webhook never pays: DOIT already did.
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 refund.failed with the idempotency key fails the refund as provider_declined and frees the amount", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.failed",
      flatRefund(refundId, intent.amountIdr, {
        payment_id: intent.paymentId,
        status: "failed",
        failure_code: "insufficient_funds",
      }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
    // The money never left: the bill stays paid.
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 the refund object may be nested under data.refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent("refund.succeeded", {
      refund: {
        id: `rf_${hex(6)}`,
        idempotency_key: `refund:${refundId}`,
        amount: intent.amountIdr,
        status: "succeeded",
      },
      payment_id: intent.paymentId,
    });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
  });

  it("PAY-04 without an idempotency key the refund id DOIT gave earlier finds the refund (path b)", async () => {
    const intent = await seedPaidIntent();
    const knownRef = `rf_${hex(6)}`;
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: knownRef,
    });
    const other = await seedPaidIntent();
    const otherRefundId = await seedRefund(other, {
      attempts: 1,
      providerRef: `rf_${hex(6)}`,
    });
    const body = refundEvent("refund.succeeded", {
      object: "refund",
      id: knownRef,
      amount: intent.amountIdr,
      payment_id: intent.paymentId,
      status: "succeeded",
    });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
    expect((await refundRow(otherRefundId)).status).toBe("approved");
  });

  it("PAY-04 a refund.failed that contradicts an already completed refund is ignored as REJECTED_CONFLICT", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const first = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );
    expect((await deliver(first)).body.status).toBe("processed");
    const done = await refundRow(refundId);

    const body = refundEvent(
      "refund.failed",
      flatRefund(refundId, intent.amountIdr, {
        payment_id: intent.paymentId,
        failure_code: "late_decline",
      }),
    );
    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    const after = await refundRow(refundId);
    expect(after).toMatchObject({ status: "completed", failure_reason: null });
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
  });

  it("PAY-04 other refund event types stay ignored and change nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.created",
      flatRefund(refundId, intent.amountIdr, {
        payment_id: intent.paymentId,
        status: "succeeded",
      }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  it("PAY-02 a refund event with a bad signature is refused with 401 and changes nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );

    const response = await deliver(body, `whsec-wrong-${hex(8)}`);

    expect(response.status).toBe(401);
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await eventRows(body.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Only the integration that minted the payment may close its refund
// ---------------------------------------------------------------------------

describe("TEN-01 the verifying integration must be the one that minted the payment", () => {
  it("TEN-01 a refund event signed with another integration's secret is ignored, audited and changes no refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );

    const response = await deliver(body, secretB);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      failure_reason: null,
      completed_at: null,
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFERENCE_MISMATCH",
      }),
    ]);
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' LIKE 'payment.webhook.%'
         AND event->'maskedChanges'->'after'->>'eventId' = $2`,
      [tenantId, body.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secretA);
    expect(serialized).not.toContain(secretB);

    // The minting integration's own, fresh delivery still closes it.
    const good = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );
    expect((await deliver(good)).body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Events that match no refund (path d)
// ---------------------------------------------------------------------------

describe("PAY-03 a refund event that matches no refund is retried for 15 minutes, then ignored", () => {
  it("PAY-03 an unmatched refund event is stored failed (DOIT resends) and touches no refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(randomUUID(), intent.amountIdr, {
        payment_id: intent.paymentId,
      }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500);
    expect((await eventRows(body.id))[0]?.status).toBe("failed");
    expect((await refundRow(refundId)).status).toBe("approved");

    // Inside the window it stays failed for the next retry.
    await backdate(body.id, 5);
    await reprocess();
    expect((await eventRows(body.id))[0]?.status).toBe("failed");
  });

  it("PAY-03 an event that overtook its refund settles it on retry once the refund is known", async () => {
    const intent = await seedPaidIntent();
    const refundId = randomUUID();
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );
    expect((await deliver(body)).status).toBe(500);

    await seedRefund(intent, { id: refundId, attempts: 1 });
    await backdate(body.id, 10);
    await reprocess();

    expect((await refundRow(refundId)).status).toBe("completed");
    expect((await eventRows(body.id))[0]?.status).toBe("processed");
  });

  it("PAY-03 an event still unmatched after 15 minutes is ignored as REFUND_UNMATCHED", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    // A payment id no intent or evidence of this tenant carries.
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(randomUUID(), intent.amountIdr, {
        payment_id: `dp_${hex(8)}`,
      }),
    );
    expect((await deliver(body)).status).toBe(500);

    await backdate(body.id, 20);
    await reprocess();

    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  it("PAY-03 legend-30hfs an unmatched success naming our payment, after 15 minutes, is recorded as the provider's own refund and blocks our payout", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(randomUUID(), intent.amountIdr, {
        payment_id: intent.paymentId,
      }),
    );
    expect((await deliver(body)).status).toBe(500);

    await backdate(body.id, 20);
    await reprocess();

    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({ status: "processed", last_error_code: null }),
    ]);
    // Our refund is not completed by someone else's refund.
    expect((await refundRow(refundId)).status).toBe("approved");
    // The money went back to the payer: recorded once against this intent...
    const { rows: recorded } = await owner.query<{
      amount_idr: string;
      provider_refund_id: string;
    }>(
      `SELECT amount_idr, provider_refund_id FROM payment_provider_refunds
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenantId, intent.intentId],
    );
    expect(
      recorded.map((r) => [r.provider_refund_id, Number(r.amount_idr)]),
    ).toEqual([[body.data.id, intent.amountIdr]]);
    const { rows: stamped } = await owner.query<{ at: Date | null }>(
      "SELECT provider_refunded_after_paid_at AS at FROM payment_intents WHERE id = $1",
      [intent.intentId],
    );
    expect(stamped[0]?.at, "the paid intent is flagged").not.toBeNull();
    // ...and our own refund of the same money is never paid out on top.
    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [refundId],
    );
    await sweep();
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
    expect((await refundRow(refundId)).status).not.toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// legend-0yd1: the flat refund.succeeded the DOIT sandbox really sends
// `{ amount, refund_id, payment_id }` (no refund object, no key, no payment)
// ---------------------------------------------------------------------------

describe("legend-0yd1 PAY-04 the sandbox's flat refund.succeeded closes the refund", () => {
  it("PAY-04 refund_id finds the approved refund holding that provider ref and completes it", async () => {
    const intent = await seedPaidIntent();
    const knownRef = `rf_${hex(6)}`;
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: knownRef,
    });
    const body = refundEvent("refund.succeeded", {
      amount: intent.amountIdr,
      refund_id: knownRef,
      payment_id: intent.paymentId,
    });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      provider_ref: knownRef,
    });
    expect(await intentStatus(intent.intentId)).toBe("refunded");
  });

  it("PAY-04 a payment_id that is not the refund's payment is a REFERENCE_MISMATCH and changes nothing", async () => {
    const intent = await seedPaidIntent();
    const knownRef = `rf_${hex(6)}`;
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: knownRef,
    });
    const body = refundEvent("refund.succeeded", {
      amount: intent.amountIdr,
      refund_id: knownRef,
      payment_id: `dp_${hex(8)}`,
    });

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFERENCE_MISMATCH",
      }),
    ]);
    expect((await refundRow(refundId)).status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Path c: a refund.succeeded that carries only the refunded payment object
// ---------------------------------------------------------------------------

describe("PAY-04 refund.succeeded carrying only the payment object (path c)", () => {
  it("PAY-04 exactly one approved candidate with the payment's id and the same amount is completed", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: intent.paymentId,
    });
    // A failed earlier refund of the same bill does not count as another.
    await seedRefund(intent, { status: "failed", amountIdr: 20_000 });
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", intent.amountIdr),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      provider_ref: intent.paymentId,
    });
    expect(await intentStatus(intent.intentId)).toBe("refunded");
  });

  // Two refunds cannot share a provider_ref (unique index), so a second
  // "candidate" is a second approved refund of the bill whose payout has not
  // got DOIT's id yet: it is another non-failed refund, hence ambiguous.
  it("PAY-04 a second approved refund of the same bill makes the event ambiguous: no refund changes", async () => {
    const intent = await seedPaidIntent();
    const first = await seedRefund(intent, {
      attempts: 1,
      providerRef: intent.paymentId,
    });
    const second = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", intent.amountIdr),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500); // unmatched, DOIT resends
    expect((await refundRow(first)).status).toBe("approved");
    expect((await refundRow(second)).status).toBe("approved");
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 another open refund on the same bill makes the event ambiguous: no refund changes", async () => {
    const intent = await seedPaidIntent();
    const candidate = await seedRefund(intent, {
      attempts: 1,
      amountIdr: 50_000,
      providerRef: intent.paymentId,
    });
    const other = await seedRefund(intent, {
      status: "pending",
      amountIdr: 50_000,
    });
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", 50_000),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500);
    expect((await refundRow(candidate)).status).toBe("approved");
    expect((await refundRow(other)).status).toBe("pending");
  });

  it("PAY-04 an amount that differs from the candidate's changes nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: intent.paymentId,
    });
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", intent.amountIdr - 1),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500);
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  it("PAY-04 refund.failed with a payment object never fails a refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: intent.paymentId,
    });
    const body = refundEvent(
      "refund.failed",
      paymentData(intent, "refunded", intent.amountIdr),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      failure_reason: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Codex 117 Run B (sub-brief 175, P2): refund object with `reference`, and the
// payment-object path against a refund whose providerRef is DOIT's refund id
// ---------------------------------------------------------------------------

describe("PAY-04 refund webhooks with real sandbox identities (Codex 117 Run B)", () => {
  // (a) Assumption: `refund.failed` carries the refund object flat, with
  // `reference` = the payment intent id (as the sandbox does). `object:
  // "refund"` wins over `reference`: it must not be read as a payment object.
  it("PAY-04 refund.failed with object refund, idempotency key and reference fails the refund", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.failed",
      flatRefund(refundId, intent.amountIdr, {
        payment_id: intent.paymentId,
        id: "rf_actual",
        reference: intent.intentId,
        status: "failed",
      }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({ status: "processed" }),
    ]);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  // (a') A refund object whose `reference` names another intent is not ours,
  // even when its idempotency key matches: REFERENCE_MISMATCH, refund kept.
  it("PAY-04 refund.failed with object refund naming another intent's reference is a REFERENCE_MISMATCH", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    const body = refundEvent(
      "refund.failed",
      flatRefund(refundId, intent.amountIdr, {
        payment_id: intent.paymentId,
        id: "rf_actual",
        reference: randomUUID(),
        status: "failed",
      }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFERENCE_MISMATCH",
      }),
    ]);
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  // (b) Assumption: event type `refund.succeeded`; the refund was approved and
  // already got DOIT's refund id (`rf_actual`) from the POST answer; the
  // webhook carries only the payment object (`pay_actual` = intent.paymentId).
  // The refund id must not be overwritten with the payment id.
  it("PAY-04 refund.succeeded with a payment object completes a refund whose providerRef is the refund id, keeping that id", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: "rf_actual",
    });
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", intent.amountIdr),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({ status: "processed" }),
    ]);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      provider_ref: "rf_actual",
    });
    expect(await intentStatus(intent.intentId)).toBe("refunded");
  });
});

// ---------------------------------------------------------------------------
// Quarantine is not touched; the provider is authoritative
// ---------------------------------------------------------------------------

describe("PAY-04 a quarantined refund is closed by the provider, never paid by us", () => {
  async function seedQuarantined(intent: SeededIntent) {
    return seedRefund(intent, {
      attempts: 1,
      // A user who holds no approver role: the payout guard quarantines it.
      approvedBy: randomUUID(),
      lastPayoutError: PAYOUT_QUARANTINED,
    });
  }

  it("PAY-04 refund.succeeded completes a quarantined refund without any refund call", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedQuarantined(intent);
    const body = refundEvent(
      "refund.succeeded",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 refund.failed fails a quarantined refund without any refund call", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedQuarantined(intent);
    const body = refundEvent(
      "refund.failed",
      flatRefund(refundId, intent.amountIdr, { payment_id: intent.paymentId }),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("failed");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 the sweep keeps a quarantined refund quarantined and sends nothing", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedQuarantined(intent);
    doit.setPayment(intent, "paid");

    await sweep();

    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sweep: the poll job for approved refunds whose DOIT result is pending
// ---------------------------------------------------------------------------

describe("PAY-04 the sweep polls DOIT for an approved refund still pending", () => {
  it("PAY-04 DOIT reports the payment refunded for the same amount: the refund completes without a new refund call", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: `rf_${hex(6)}`,
    });
    doit.setPayment(intent, "refunded");

    await sweep();

    const done = await refundRow(refundId);
    expect(done.status).toBe("completed");
    expect(done.completed_at).not.toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("refunded");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
    expect(
      doit.calls.some(
        (call) =>
          call.method === "GET" &&
          call.path === `/v1/payments/${intent.paymentId}`,
      ),
    ).toBe(true);
  });

  it("PAY-04 DOIT still says paid: the refund stays approved and DOIT is never asked to refund again", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: `rf_${hex(6)}`,
    });
    doit.setPayment(intent, "paid");

    await sweep();
    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [refundId],
    );
    await sweep();

    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      failure_reason: null,
      completed_at: null,
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 a refunded payment for a different amount is not treated as this refund's success", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, {
      attempts: 1,
      providerRef: `rf_${hex(6)}`,
    });
    doit.setPayment(intent, "refunded", intent.amountIdr - 1);

    await sweep();

    expect((await refundRow(refundId)).status).toBe("approved");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 an unknown outcome (DOIT answers 404 for the payment) never triggers a second refund call", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 1 });
    // The fake knows no such payment: GET answers 404 payment_not_found.

    await sweep();

    expect((await refundRow(refundId)).status).toBe("approved");
    expect(doit.refundPostsFor(intent.paymentId)).toEqual([]);
  });

  it("PAY-04 a never-attempted approved refund is sent once with its idempotency key and completes", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 0 });

    await sweep();

    const posts = doit.refundPostsFor(intent.paymentId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      idempotencyKey: `refund:${refundId}`,
      body: expect.objectContaining({ amount: intent.amountIdr }),
    });
    expect((await refundRow(refundId)).status).toBe("completed");

    await sweep();
    expect(doit.refundPostsFor(intent.paymentId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fund refunds pay back evidence, not the intent's own payment
// ---------------------------------------------------------------------------

describe("PAY-04 a refund of an unallocated fund is bound to the fund's evidence", () => {
  const fundIds: string[] = [];
  const evidenceRefs: string[] = [];
  const FUND_IDR = 20_000;

  afterEach(async () => {
    // The shared cleanup removes refunds too, but only after this hook, and a
    // fund cannot go while a refund still points at it.
    await owner.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await owner.query(
      "DELETE FROM payment_unallocated_funds WHERE id = ANY($1::uuid[])",
      [fundIds],
    );
    await owner.query(
      "DELETE FROM payment_evidence WHERE tenant_id = $1 AND provider_ref = ANY($2::text[])",
      [tenantId, evidenceRefs],
    );
    fundIds.length = 0;
    evidenceRefs.length = 0;
  });

  /** An approved fund refund; the fund's money came in on a payment other than
   * the intent's own (`withEvidence`), or its evidence is not known yet. */
  async function seedFundRefund(
    intent: SeededIntent,
    withEvidence: boolean,
  ): Promise<{ refundId: string; evidenceRef: string | null }> {
    let evidenceId: string | null = null;
    let evidenceRef: string | null = null;
    if (withEvidence) {
      evidenceRef = `dp_fund_${hex(6)}`;
      evidenceRefs.push(evidenceRef);
      const inserted = await owner.query<{ id: string }>(
        `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
         RETURNING id`,
        [tenantId, outletA, intent.intentId, evidenceRef, FUND_IDR],
      );
      evidenceId = inserted.rows[0]!.id;
    }
    const fundId = randomUUID();
    fundIds.push(fundId);
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'overpayment')`,
      [fundId, tenantId, outletA, intent.intentId, evidenceId, FUND_IDR],
    );
    const refundId = randomUUID();
    refundIds.push(refundId);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                    requested_by, approved_by, decided_at, payout_attempts, updated_at, unallocated_fund_id)
       VALUES ($1, $2, $3, $4, $5, 'Kembalikan kelebihan bayar', 'approved', $6, $7, now(), 1, now() - interval '2 hours', $8)`,
      [
        refundId,
        tenantId,
        outletA,
        intent.intentId,
        FUND_IDR,
        actor,
        supervisorUserId,
        fundId,
      ],
    );
    return { refundId, evidenceRef };
  }

  const withPayment = (
    refundId: string,
    intent: SeededIntent,
    paymentId: string,
  ): RefundData =>
    flatRefund(refundId, FUND_IDR, {
      payment: {
        id: paymentId,
        status: "refunded",
        amount: FUND_IDR,
        reference: intent.intentId,
      },
    });

  it("PAY-04 path c never settles a fund refund, even when the amount matches the payment", async () => {
    const intent = await seedPaidIntent(FUND_IDR);
    const { refundId } = await seedFundRefund(intent, true);
    const body = refundEvent(
      "refund.succeeded",
      paymentData(intent, "refunded", FUND_IDR),
    );

    const response = await deliver(body);

    expect(response.status).toBe(500); // unmatched, DOIT resends
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  it("PAY-04 a fund refund event naming the intent's own payment, not the fund's evidence, is a REFERENCE_MISMATCH", async () => {
    const intent = await seedPaidIntent();
    const { refundId } = await seedFundRefund(intent, true);
    const body = refundEvent(
      "refund.succeeded",
      withPayment(refundId, intent, intent.paymentId),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(await eventRows(body.id)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFERENCE_MISMATCH",
      }),
    ]);
  });

  it("PAY-04 a fund refund event naming the fund's evidence payment completes the refund", async () => {
    const intent = await seedPaidIntent();
    const { refundId, evidenceRef } = await seedFundRefund(intent, true);
    const body = refundEvent(
      "refund.succeeded",
      withPayment(refundId, intent, evidenceRef!),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
  });

  it("PAY-04 a fund whose evidence is not known yet does not reject the payment object (key and integration still bind)", async () => {
    const intent = await seedPaidIntent();
    const { refundId } = await seedFundRefund(intent, false);
    const body = refundEvent(
      "refund.succeeded",
      withPayment(refundId, intent, intent.paymentId),
    );

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    expect((await refundRow(refundId)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// T3 (docs/briefs/sub-175-doit-refund-parser.md): an identity mismatch stays
// visible. DOIT's 2xx answer to POST refund names another payment, or another
// amount: the refund is never completed, never re-sent, and carries the sticky
// flag DOIT_REFUND_IDENTITY_MISMATCH that later unknown lookups and the attempt
// limit do not overwrite.
// Assumptions: the audit row is found by `event->>'action'`, `objectId` = the
// refund id and `event->>'reason'` = the code (same shape as the quarantine
// audit); the `providerEvidence` ids are asserted by their presence anywhere in
// the audit event, not by their exact JSON path. The attempt limit is 8 unknown
// outcomes, reached here by setting payout_attempts to 7 (the brief names
// PAYOUT_MAX_ATTEMPTS without a value).
// ---------------------------------------------------------------------------

const IDENTITY_MISMATCH = "DOIT_REFUND_IDENTITY_MISMATCH";
const MISMATCH_ACTION = "payment.refund_payout_identity_mismatch";

async function mismatchAudits(refundId: string) {
  const { rows } = await owner.query<{
    reason: string | null;
    event: unknown;
  }>(
    `SELECT event->>'reason' AS reason, event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, refundId, MISMATCH_ACTION],
  );
  return rows;
}

const ageRefund = (refundId: string, attempts?: number) =>
  owner.query(
    `UPDATE payment_refunds
        SET updated_at = now() - interval '2 hours',
            payout_attempts = COALESCE($2::int, payout_attempts)
      WHERE tenant_id = $1 AND id = $3::uuid`,
    [tenantId, attempts ?? null, refundId],
  );

async function payoutAttempts(refundId: string): Promise<number> {
  const { rows } = await owner.query<{ payout_attempts: number }>(
    "SELECT payout_attempts FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, refundId],
  );
  return rows[0]!.payout_attempts;
}

type ForeignAnswer = (paymentId: string, input: { amount: number }) => unknown;

describe("PAY-04 a DOIT refund answer for another payment or amount stays visible (legend-r7g2 T3)", () => {
  const foreignPayment: ForeignAnswer = (_paymentId, input) => ({
    id: "rf_foreign",
    payment_id: `dp_other_${hex(6)}`,
    status: "succeeded",
    amount: input.amount,
  });
  const foreignAmount: ForeignAnswer = (paymentId, input) => ({
    id: "rf_foreign",
    payment_id: paymentId,
    status: "succeeded",
    amount: input.amount + 1_000,
  });

  it.each([
    ["names another payment_id", foreignPayment],
    ["carries another amount", foreignAmount],
  ] as Array<[string, ForeignAnswer]>)(
    "PAY-04 the answer %s: refund stays approved, flagged, sent once, audited once",
    async (_label, answer) => {
      const intent = await seedPaidIntent();
      const refundId = await seedRefund(intent, { attempts: 0 });
      doit.refundAnswer = answer;

      await sweep();

      expect(await refundRow(refundId)).toMatchObject({
        status: "approved",
        completed_at: null,
        last_payout_error: IDENTITY_MISMATCH,
      });
      expect(await intentStatus(intent.intentId)).toBe("paid");
      expect(doit.refundPostsFor(intent.paymentId)).toHaveLength(1);

      const audits = await mismatchAudits(refundId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.reason).toBe(IDENTITY_MISMATCH);
      // Ids are masked in the audit row ("[REDACTED]"); the amount and status are not.
      const after = (
        audits[0]!.event as {
          maskedChanges: {
            after: { providerEvidence: Record<string, unknown> };
          };
        }
      ).maskedChanges.after;
      expect(Object.keys(after.providerEvidence).sort()).toEqual([
        "amountIdr",
        "id",
        "paymentId",
        "status",
      ]);
      expect(after.providerEvidence).toMatchObject({
        status: "succeeded",
        amountIdr: expect.any(Number),
      });
      expect(JSON.stringify(audits[0]!.event)).not.toContain(apiKeyA);
    },
  );

  it("PAY-04 a later sweep whose lookup is unknown (404) keeps the flag, adds no audit and sends nothing again", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 0 });
    doit.refundAnswer = foreignPayment;
    await sweep();
    expect(await refundRow(refundId)).toMatchObject({
      last_payout_error: IDENTITY_MISMATCH,
    });

    // From here the fake knows no payment: GET answers 404 (unknown outcome).
    for (let round = 0; round < 2; round += 1) {
      await ageRefund(refundId);
      await sweep();
      expect(await refundRow(refundId)).toMatchObject({
        status: "approved",
        completed_at: null,
        last_payout_error: IDENTITY_MISMATCH,
      });
    }

    expect(
      doit.calls.some(
        (call) =>
          call.method === "GET" &&
          call.path === `/v1/payments/${intent.paymentId}`,
      ),
    ).toBe(true);
    expect(doit.refundPostsFor(intent.paymentId)).toHaveLength(1);
    expect(await mismatchAudits(refundId)).toHaveLength(1);
  });

  it("PAY-04 after the attempt limit the flag stays; it is not replaced by MANUAL_RECONCILIATION", async () => {
    const intent = await seedPaidIntent();
    const refundId = await seedRefund(intent, { attempts: 0 });
    doit.refundAnswer = foreignPayment;
    await sweep();
    expect((await refundRow(refundId)).last_payout_error).toBe(
      IDENTITY_MISMATCH,
    );

    // One unknown lookup short of the limit, then past it.
    await ageRefund(refundId, 7);
    await sweep();
    await ageRefund(refundId);
    await sweep();
    await ageRefund(refundId);
    await sweep();

    expect(await payoutAttempts(refundId)).toBeGreaterThanOrEqual(8);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      completed_at: null,
      last_payout_error: IDENTITY_MISMATCH,
    });
    expect(doit.refundPostsFor(intent.paymentId)).toHaveLength(1);
    expect(await mismatchAudits(refundId)).toHaveLength(1);
  });
});
