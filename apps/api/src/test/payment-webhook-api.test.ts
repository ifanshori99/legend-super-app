// Verified DOIT webhooks, store-then-process dedupe and the polling fallback
// over the real Express app and PostgreSQL (bead legend-b9i; PRD v1.7 §3.13
// "Webhook Terverifikasi", PAY-02, PAY-03, PAY-06, TEN-01).
//
// Setup: a fake DOIT is a real http server on 127.0.0.1. The real DOIT adapter
// talks to it, so intents are created through the existing payment-link flow
// exactly as in production. Fixtures follow the official DOIT docs
// (https://doit.id/docs/en/): `GET /v1/methods`, `POST /v1/payments` with
// `rail` and `expires_in`, payment objects without a paid amount, webhook
// bodies `{ id, type, created_at, data }`. Webhooks are signed here with Node
// crypto: `PayBridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret,
// "<t>." + raw bytes)>`, accepted 25 h back and 5 min ahead. Only
// `payment.paid` / `payment.expired` move an intent; other types are stored
// `ignored`. The route is `POST /api/webhooks/payments/doit/:tenantId` and
// answers `200 { received: true, status }` (contract S4).
//
// Assumptions where the contract is silent:
// - A 401 carries one fixed body for every verification failure (no oracle), so
//   the tests compare bodies of different failure modes for equality.
// - A late payment (expired, then paid) ends `paid` and the guest view reports
//   `paidAfterExpiry: true` (PRD "diterima dan ditandai").
// - Rows for an unknown tenant UUID cannot be stored (tenant FK), so only the
//   401 is asserted there.
// - Fix waves 1 and 2 (docs/briefs/sub-doit-provider.md): a `failed` intent is
//   never revived, so a paid event after failed answers 200, leaves the intent
//   `failed` and parks the money as an unallocated-funds row (reason
//   `double_payment`) plus one evidence row. An event whose provider payment id
//   and `reference` do not name the same intent is `ignored` with
//   `REFERENCE_MISMATCH` (200, no side effect); a bound event whose `amount`
//   differs from the intent's is parked as unallocated funds (AMOUNT_MISMATCH).
//   A payment unknown to the tenant is stored `failed`, answered 500 (so DOIT
//   retries) and retried by the worker for 15 minutes, then ignored. Any event
//   that ends `failed` answers 500; a rejected (bad signature) delivery is one
//   counter row per tenant per minute, not one row per body.
//   The limiter only counts failed verifications (401): more than 30 per IP and
//   minute answer 429 `RATE_LIMITED`; valid deliveries never consume it.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  vi,
} from "vitest";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { createLogger, logger as moduleLogger } from "../lib/logger";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  cancelPaymentLinkInTx,
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service";
import {
  listIntegrations,
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  purgeRejectedWebhookEvents,
  receiveDoitWebhook,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent } from "./helpers";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
/** A tenant that never configured DOIT: no integration, no webhook secret. */
const tenantC = randomUUID();
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const actor = randomUUID();
const webhookPath = (tenantId: string) =>
  `/api/webhooks/payments/doit/${tenantId}`;
const BILL_TOTAL = 144_375;

// Fake credentials: they must never appear in a response or a log line.
const apiKeyA = `doit-key-a-${randomBytes(12).toString("hex")}`;
const secretA = `whsec-a-${randomBytes(16).toString("hex")}`;
const apiKeyB = `doit-key-b-${randomBytes(12).toString("hex")}`;
const secretB = `whsec-b-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
/** The tenant-wide DOIT integration of tenant A (the verifying one). */
let integrationAId = "";

const unique = () => randomBytes(4).toString("hex");

function contextFor(
  tenantId: string,
  source: "session" | "webhook" = "webhook",
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "tenant" },
  );
}

function outletContext(outletIds: readonly OutletId[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

// ---------------------------------------------------------------------------
// Fake DOIT server
// ---------------------------------------------------------------------------

/** A DOIT payment object as the official docs describe it: no paid amount
 * (`paid` means DOIT collected `total_amount`; the bill is credited
 * `amount`), status one of pending|paid|refunded|expired|failed. */
type DoitPayment = {
  id: string;
  status: "pending" | "paid" | "refunded" | "expired" | "failed";
  amount: number;
  rail: string | null;
  reference: string;
  qr_content: string | null;
  va_number: string | null;
  va_bank: string | null;
  hosted_url: string | null;
  return_url: string | null;
  provider: string;
  provider_ref: string | null;
  fee_amount: number;
  fee_payer: string;
  total_amount: number;
  expires_at: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DoitEvent = {
  id: string;
  type: string;
  created_at: string;
  data: DoitPayment;
};

const newEventId = () => `evt_${randomBytes(8).toString("hex")}`;

/** Official method row of `GET /v1/methods`. */
function methodRow(
  code: string,
  label: string,
  rail: string,
  bank: string | null,
) {
  return {
    code,
    label,
    rail,
    bank,
    fee_flat: 0,
    fee_pct: 0,
    fee_payer: "merchant",
    min_amount: null,
    max_amount: null,
    fee_amount: 0,
    total_amount: null,
    within_limits: true,
    limit: null,
  };
}

class FakeDoit {
  readonly payments = new Map<string, DoitPayment>();
  private readonly byIdempotencyKey = new Map<string, DoitPayment>();
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

  /** The provider reports the payment as paid, crediting `amount` (the whole
   * bill by default; another figure models a mismatch). */
  settle(id: string, amount: number = BILL_TOTAL): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** A `payment.paid` / `payment.expired` webhook body for the payment, with
   * `data` in the given status. No `paid_at` unless the test sets one. */
  eventFor(
    id: string,
    status: "paid" | "expired",
    eventId = newEventId(),
  ): DoitEvent {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return {
      id: eventId,
      type: `payment.${status}`,
      created_at: new Date().toISOString(),
      data: { ...payment, status },
    };
  }

  /** An event of another type for the payment (stored and ignored). */
  otherEvent(
    id: string,
    type: string,
    status: DoitPayment["status"] = "pending",
  ): DoitEvent {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return {
      id: newEventId(),
      type,
      created_at: new Date().toISOString(),
      data: { ...payment, status },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.headers.authorization !== `Bearer ${apiKeyA}`)
      return send(401, {
        error: { code: "unauthorized", message: "Invalid API key" },
      });
    if (req.method === "GET" && url.pathname === "/v1/methods")
      return send(200, {
        environment: "sandbox",
        amount: null,
        data: [
          methodRow("qris", "QRIS", "qris", null),
          methodRow("va_bmri", "Mandiri Virtual Account", "va", "bmri"),
          methodRow("transfer_bca", "Transfer BCA", "transfer", "bca"),
        ],
      });
    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(key);
      if (known) return send(200, known);
      const input = JSON.parse(body) as {
        amount: number;
        rail: string;
        va_bank?: string;
        reference: string;
        expires_in: number;
      };
      const id = `dp_${randomBytes(8).toString("hex")}`;
      const createdAt = new Date();
      const payment: DoitPayment = {
        id,
        status: "pending",
        amount: input.amount,
        rail: input.rail,
        reference: input.reference,
        qr_content:
          input.rail === "qris" ? "00020101021226610014ID.CO.DOIT.FAKE" : null,
        va_number: input.rail === "va" ? "8808123456789012" : null,
        va_bank: input.va_bank ?? null,
        hosted_url: `https://pay.doit.id/p/${id}`,
        return_url: null,
        provider: "pjp",
        provider_ref: null,
        fee_amount: 0,
        fee_payer: "merchant",
        total_amount: input.amount,
        expires_at: new Date(
          createdAt.getTime() + input.expires_in * 1000,
        ).toISOString(),
        paid_at: null,
        metadata: null,
        created_at: createdAt.toISOString(),
      };
      this.payments.set(payment.id, payment);
      if (key) this.byIdempotencyKey.set(key, payment);
      return send(201, payment);
    }
    const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && found) {
      const payment = this.payments.get(decodeURIComponent(found[1]!));
      return payment ? send(200, payment) : send(404, { error: "not_found" });
    }
    return send(404, { error: "not_found" });
  }
}

const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

async function seedIntegration(
  context: ScopedTenantContext,
  apiKey: string,
  webhookSecret: string,
): Promise<string> {
  const created = await upsertIntegration(
    context,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret },
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
  for (const [id, name] of [
    [tenantB, "Tenant B Webhook API"],
    [tenantC, "Tenant C Webhook API"],
  ] as const)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, $5, 'lengkap', 'active', 'shared',
               '{"modules":[],"integrationProviders":["doit"]}', $3, $4)`,
      [
        id,
        `uji-webhook-api-${unique()}`,
        JSON.stringify({
          maxOutlets: 1,
          maxActiveEmployees: 30,
          maxDevices: 10,
          aiRequestsPerMonth: 3,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 10_000,
          emailCostCapIdr: 1_000,
        }),
        actor,
        name,
      ],
    );
  const integrationA = (integrationAId = await seedIntegration(
    contextFor(tenantA, "session"),
    apiKeyA,
    secretA,
  ));
  await seedIntegration(contextFor(tenantB, "session"), apiKeyB, secretB);
  // The real adapter, pointed at the fake DOIT through the injected loader.
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationA,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey: apiKeyA, webhookSecret: secretA },
      }),
    }),
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB, tenantC]],
  );
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
  }
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
    [tenantB, tenantC],
  ]);
  await owner.end();
  await doit.stop();
});

/** Rows of an earlier test never leak into the next one's counts. */
beforeEach(async () => {
  // Fresh limiter windows and secret cache: no test inherits another's state.
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = ANY($1::uuid[]) AND (payment_intent_id IS NULL OR NOT signature_valid)",
    [[tenantA, tenantB, tenantC]],
  );
});

type Bill = {
  token: string;
  linkId: string;
  intentId: string;
  /** DOIT's own payment id, the webhook's `data.id`. */
  providerRef: string;
};

/** A payable QRIS intent created through the guest link flow. */
async function openIntent(): Promise<Bill> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `W-${unique()}`,
      tableLabel: "A03",
      pax: 3,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: BILL_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  expect(created.status).toBe(201);
  const intentId = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [intentId],
  );
  const providerRef = rows[0]?.provider_ref;
  if (!providerRef) throw new Error("Intent has no DOIT payment id");
  return { token: opened.token, linkId: opened.linkId, intentId, providerRef };
}

function signatureHeader(
  raw: string,
  secret: string,
  at: Date = new Date(),
): string {
  const t = Math.floor(at.getTime() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

type Delivery = {
  tenantId?: string;
  secret?: string;
  signedAt?: Date;
  /** Overrides the computed header; `null` sends none. */
  header?: string | null;
  contentType?: string;
  origin?: string;
  application?: ReturnType<typeof createApp>;
};

/** Sends `body` (object or raw string) the way DOIT would. */
async function deliver(body: object | string, options: Delivery = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const header =
    options.header === undefined
      ? signatureHeader(raw, options.secret ?? secretA, options.signedAt)
      : options.header;
  let call = request(options.application ?? app)
    .post(webhookPath(options.tenantId ?? tenantA))
    .set("Content-Type", options.contentType ?? "application/json");
  if (header !== null) call = call.set("PayBridge-Signature", header);
  if (options.origin) call = call.set("Origin", options.origin);
  return call.send(raw);
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{ status: string; paid_at: Date | null }>(
    "SELECT status, paid_at FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

const evidenceCount = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
const unallocatedCount = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
async function unallocatedRows(intentId: string) {
  const { rows } = await owner.query<{ reason: string; amount_idr: string }>(
    "SELECT reason, amount_idr::text AS amount_idr FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return rows.map((row) => ({
    reason: row.reason,
    amountIdr: Number(row.amount_idr),
  }));
}
/**
 * Every parked fund of the intent must point at the evidence row just recorded
 * for it (`evidence_id`), so the money can be traced to the gateway proof.
 */
async function expectFundsLinkedToEvidence(intentId: string) {
  const funds = await owner.query<{ evidence_id: string | null }>(
    "SELECT evidence_id FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  const evidence = await owner.query<{ id: string }>(
    "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  expect(evidence.rows).toHaveLength(1);
  expect(funds.rows).toHaveLength(1);
  expect(funds.rows[0]?.evidence_id).toBe(evidence.rows[0]?.id);
}
async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

/** Assert the bill was settled exactly once, with no parked double funds. */
async function expectPaidOnce(bill: Bill) {
  expect((await intentRow(bill.intentId)).status).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  expect(await evidenceCount(bill.intentId)).toBe(1);
  expect(await unallocatedCount(bill.intentId)).toBe(0);
}

async function expectUntouched(bill: Bill) {
  expect((await intentRow(bill.intentId)).status).toBe("pending");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  expect(await evidenceCount(bill.intentId)).toBe(0);
}

type EventRow = {
  tenant_id: string;
  provider: string;
  event_id: string | null;
  signature_valid: boolean;
  status: string;
  payload_hash: string;
  payload: unknown;
  payment_intent_id: string | null;
  provider_ref: string | null;
  last_error_code: string | null;
  attempts: number;
  processed_at: Date | null;
};

async function eventRows(tenantId: string, eventId: string | null) {
  const { rows } = await owner.query<EventRow>(
    `SELECT tenant_id, provider, event_id, signature_valid, status, payload_hash,
            payload, payment_intent_id, provider_ref, last_error_code, attempts, processed_at
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id IS NOT DISTINCT FROM $2
     ORDER BY received_at`,
    [tenantId, eventId],
  );
  return rows;
}

/** Stored rows of a body by its hash (verified-but-malformed deliveries). */
async function rowsByBodyHash(tenantId: string, raw: string) {
  const { rows } = await owner.query<EventRow>(
    `SELECT tenant_id, provider, event_id, signature_valid, status, payload_hash,
            payload, payment_intent_id, provider_ref, last_error_code, attempts, processed_at
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND payload_hash = $2`,
    [tenantId, sha256(raw)],
  );
  return rows;
}

/** Rejected deliveries are one counter row per tenant per minute bucket. */
async function rejectedRows(tenantId: string) {
  const { rows } = await owner.query<EventRow>(
    `SELECT tenant_id, provider, event_id, signature_valid, status, payload_hash,
            payload, payment_intent_id, provider_ref, last_error_code, attempts, processed_at
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND NOT signature_valid
     ORDER BY received_at`,
    [tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// PAY-02 / PAY-03: verified, deduplicated, order-independent settlement
// ---------------------------------------------------------------------------

describe("PAY-02 a verified webhook settles the intent", () => {
  it("PAY-02 a valid paid event settles the bill once and answers 200 received", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    const raw = JSON.stringify(body);

    // DOIT calls without a session, cookie or browser origin.
    const response = await deliver(raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });

    await expectPaidOnce(bill);
    const evidence = await owner.query<{
      source: string;
      provider_ref: string;
    }>(
      "SELECT source, provider_ref FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantA, bill.intentId],
    );
    expect(evidence.rows).toEqual([
      { source: "verified_webhook", provider_ref: bill.providerRef },
    ]);
    expect((await intentRow(bill.intentId)).paid_at).not.toBeNull();

    // The webhook log row is the audit trail of the delivery.
    const [row, ...rest] = await eventRows(tenantA, body.id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      provider: "doit",
      signature_valid: true,
      status: "processed",
      payload_hash: sha256(raw),
      payment_intent_id: bill.intentId,
      provider_ref: bill.providerRef,
    });
    expect(row?.processed_at).not.toBeNull();

    // The guest sees the paid intent and the settled bill.
    const guest = await agent(app).get(
      `/api/payments/links/${bill.token}/intents/${bill.intentId}`,
    );
    expect(guest.body.data.status).toBe("paid");
  });

  it("PAY-02 the origin and CSRF checks do not apply to the webhook path", async () => {
    const bill = await openIntent();
    const response = await deliver(doit.eventFor(bill.providerRef, "paid"), {
      origin: "https://not-the-web-app.example",
    });
    expect(response.status).toBe(200);
    await expectPaidOnce(bill);
  });

  it("PAY-02 a payment event whose payment is still pending changes nothing and is recorded as processed", async () => {
    const bill = await openIntent();
    const body = doit.otherEvent(bill.providerRef, "payment.paid", "pending");
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });
    await expectUntouched(bill);
    expect((await eventRows(tenantA, body.id))[0]?.status).toBe("processed");
  });

  it("PAY-02 event types other than payment and refund events are stored ignored and change nothing", async () => {
    const bill = await openIntent();
    // refund.succeeded / refund.failed go to the refund port (legend-0ogy);
    // see the next test and payment-doit-refund-webhook.test.ts.
    for (const [type, status] of [
      ["webhook.test", "pending"],
      ["payment.proof_uploaded", "pending"],
      // Not in the docs: never moves an intent either.
      ["payment.failed", "failed"],
    ] as const) {
      const body = doit.otherEvent(bill.providerRef, type, status);
      const response = await deliver(body);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, status: "ignored" });
      const [row, ...rest] = await eventRows(tenantA, body.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        status: "ignored",
        last_error_code: "EVENT_TYPE_IGNORED",
      });
      // The same event again is a duplicate.
      expect((await deliver(body)).body.status).toBe("duplicate");
    }
    // Invoice events that are not DOIT recurring billing (no
    // `data.invoice.subscription_id`) keep the old path: stored `ignored`, HTTP
    // 200, never MALFORMED or 5xx (6c6 fix round 2, finding 1).
    for (const [type, data] of [
      ["invoice.created", {}],
      ["invoice.paid", {}],
      ["invoice.created", { invoice: { id: "inv_other", amount: 1000 } }],
    ] as const) {
      const body = {
        id: newEventId(),
        type,
        created_at: new Date().toISOString(),
        data,
      };
      const response = await deliver(body);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, status: "ignored" });
      const [row, ...rest] = await eventRows(tenantA, body.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        status: "ignored",
        last_error_code: "EVENT_TYPE_IGNORED",
      });
    }
    await expectUntouched(bill);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
  });

  it("legend-0ogy refund events with no matching refund never move the intent", async () => {
    const bill = await openIntent();
    for (const [type, status] of [
      ["refund.succeeded", "refunded"],
      ["refund.failed", "paid"],
    ] as const) {
      const body = doit.otherEvent(bill.providerRef, type, status);
      // No refund to settle yet: DOIT is asked to retry (500) within the
      // unknown-reference window, and the row waits as failed.
      const response = await deliver(body);
      expect(response.status).toBe(500);
      const [row, ...rest] = await eventRows(tenantA, body.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        status: "failed",
        last_error_code: "REFUND_UNMATCHED",
      });
    }
    await expectUntouched(bill);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
  });

  it("PAY-02 a webhook.test event without a payment object is accepted and ignored", async () => {
    const body = {
      id: newEventId(),
      type: "webhook.test",
      created_at: new Date().toISOString(),
      data: { message: "ping" },
    };
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "ignored" });
  });

  it("PAY-02 a payment event whose payment was refunded changes nothing", async () => {
    const bill = await openIntent();
    const body = doit.otherEvent(bill.providerRef, "payment.paid", "refunded");
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectUntouched(bill);
  });

  it("PAY-02 an expired event expires a pending intent", async () => {
    const bill = await openIntent();
    const response = await deliver(doit.eventFor(bill.providerRef, "expired"));
    expect(response.status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await evidenceCount(bill.intentId)).toBe(0);
  });

  it("PAY-02 a payment event whose payment failed fails a pending intent", async () => {
    const failed = await openIntent();
    expect(
      (
        await deliver(
          doit.otherEvent(failed.providerRef, "payment.expired", "failed"),
        )
      ).status,
    ).toBe(200);
    expect((await intentRow(failed.intentId)).status).toBe("failed");
  });

  it("PAY-02 a paid amount that differs from the bill is not settled as a full payment", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.amount = BILL_TOTAL - 1_000;
    await deliver(body);
    // Assumption: the contract does not fix the HTTP answer for an amount the
    // lifecycle refuses (200 or a retryable 5xx), only that nothing settles.
    // An underpayment never settles the bill (PAY-04), whatever the webhook says.
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect((await intentRow(bill.intentId)).status).not.toBe("paid");
    // Wave 2: money that arrived is never dropped. Assumption: it is parked as
    // one unallocated-funds row for the paid amount (the reason value is the
    // implementation's choice among the existing two).
    expect(await unallocatedRows(bill.intentId)).toEqual([
      expect.objectContaining({ amountIdr: BILL_TOTAL - 1_000 }),
    ]);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    await expectFundsLinkedToEvidence(bill.intentId);
  });

  it("PAY-02 a paid event with a zero amount does not settle (fail closed)", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.amount = 0;
    const response = await deliver(body);
    // Stored failed, so the route answers 5xx and DOIT retries.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("AMOUNT_MISSING");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect((await intentRow(bill.intentId)).status).not.toBe("paid");
    // Wave 2: stays visible for manual review and retry (DOIT may resend with
    // an amount), it is not silently ignored.
    const [row] = await eventRows(tenantA, body.id);
    expect(row).toMatchObject({
      status: "failed",
      last_error_code: "AMOUNT_MISSING",
    });
    expect(await unallocatedCount(bill.intentId)).toBe(0);
  });

  it("PAY-02 a failed zero-amount paid event answers 5xx again on redelivery, and a resend with the amount settles once", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.amount = 0;
    expect((await deliver(body)).status).toBe(500);
    // DOIT retries the same event: still failed, still 5xx, one stored row.
    expect((await deliver(body)).status).toBe(500);
    const rows = await eventRows(tenantA, body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      last_error_code: "AMOUNT_MISSING",
    });
    await expectUntouched(bill);
    // DOIT later resends with the amount (new event id): settles exactly once.
    const resend = await deliver(doit.eventFor(bill.providerRef, "paid"));
    expect(resend.status).toBe(200);
    expect(resend.body.status).toBe("processed");
    await expectPaidOnce(bill);
    // And a further redelivery is idempotent.
    const again = await deliver(doit.eventFor(bill.providerRef, "paid"));
    expect(again.status).toBe(200);
    await expectPaidOnce(bill);
  });

  it("PAY-02 a paid event without paid_at uses the injected clock, so an old retry is not a late payment", async () => {
    const bill = await openIntent();
    // The intent expired an hour ago by the wall clock; the retry is handled
    // as of 90 minutes ago, before the expiry.
    await owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [bill.intentId],
    );
    const now = new Date(Date.now() - 90 * 60_000);
    const body = doit.eventFor(bill.providerRef, "paid");
    body.created_at = "2026-11-08 10:00:00"; // parses, but is not strict ISO
    const raw = JSON.stringify(body);
    const result = await receiveDoitWebhook({
      tenantId: tenantA,
      rawBody: Buffer.from(raw),
      signatureHeader: signatureHeader(raw, secretA, now),
      now,
    });
    expect(result.status).toBe("processed");
    const { rows } = await owner.query<{ status: string; flags: string[] }>(
      "SELECT status, flags FROM payment_intents WHERE id = $1",
      [bill.intentId],
    );
    expect(rows[0]?.status).toBe("paid");
    expect(rows[0]?.flags).not.toContain("late_payment");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });
});

describe("PAY-03 duplicate and out-of-order webhooks never double-settle", () => {
  it("PAY-03 the same event id delivered twice settles once and answers duplicate", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    const first = await deliver(body);
    const second = await deliver(body);
    expect(first.body.status).toBe("processed");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, status: "duplicate" });

    await expectPaidOnce(bill);
    expect(await eventRows(tenantA, body.id)).toHaveLength(1);
  });

  it("PAY-03 two different event ids for one payment settle once", async () => {
    const bill = await openIntent();
    const first = await deliver(doit.eventFor(bill.providerRef, "paid"));
    const second = await deliver(doit.eventFor(bill.providerRef, "paid"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Same DOIT payment id: evidence dedupes, nothing is parked as double funds.
    await expectPaidOnce(bill);
  });

  it("PAY-03 concurrent deliveries of one event settle once", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    const responses = await Promise.all([deliver(body), deliver(body)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(["processed", "duplicate"]).toContain(response.body.status);
    }
    await expectPaidOnce(bill);
    expect(await eventRows(tenantA, body.id)).toHaveLength(1);
  });

  it("PAY-03 paid then expired ends paid", async () => {
    const bill = await openIntent();
    expect(
      (await deliver(doit.eventFor(bill.providerRef, "paid"))).status,
    ).toBe(200);
    expect(
      (await deliver(doit.eventFor(bill.providerRef, "expired"))).status,
    ).toBe(200);
    expect(
      (
        await deliver(
          doit.otherEvent(bill.providerRef, "payment.expired", "failed"),
        )
      ).status,
    ).toBe(200);
    await expectPaidOnce(bill);
  });

  it("PAY-03 expired then paid ends paid and is flagged as a late payment", async () => {
    const bill = await openIntent();
    expect(
      (await deliver(doit.eventFor(bill.providerRef, "expired"))).status,
    ).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    expect(
      (await deliver(doit.eventFor(bill.providerRef, "paid"))).status,
    ).toBe(200);

    await expectPaidOnce(bill);
    const guest = await agent(app).get(
      `/api/payments/links/${bill.token}/intents/${bill.intentId}`,
    );
    expect(guest.body.data.status).toBe("paid");
    expect(guest.body.data.paidAfterExpiry).toBe(true);
  });

  // legend-b0au (main): a verified gateway settlement may land after the
  // intent failed (the guest paid the code DOIT had reported failed). The
  // money is accepted like a late payment: the intent becomes paid, flagged
  // late_payment, the bill is settled once and nothing is parked.
  it("PAY-03 failed then paid answers 200, settles once and flags a late payment", async () => {
    const bill = await openIntent();
    await deliver(
      doit.otherEvent(bill.providerRef, "payment.expired", "failed"),
    );
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    const paid = doit.eventFor(bill.providerRef, "paid");
    const late = await deliver(paid);
    expect(late.status).toBe(200);
    expect(late.body.status).toBe("processed");

    await expectPaidOnce(bill);
    const { rows } = await owner.query<{ flags: string[] }>(
      "SELECT flags FROM payment_intents WHERE id = $1",
      [bill.intentId],
    );
    expect(rows[0]?.flags).toContain("late_payment");

    // The same event again, and another event for the same payment: still once.
    expect((await deliver(paid)).status).toBe(200);
    expect(
      (await deliver(doit.eventFor(bill.providerRef, "paid"))).status,
    ).toBe(200);
    await expectPaidOnce(bill);
  });
});

describe("PAY-03 forged webhooks are rejected", () => {
  const generic = async () => {
    const bill = await openIntent();
    return {
      bill,
      raw: JSON.stringify(doit.eventFor(bill.providerRef, "paid")),
    };
  };

  it("PAY-03 a signature made with the wrong secret answers 401 and stores a rejected row", async () => {
    const { bill, raw } = await generic();
    const response = await deliver(raw, { secret: "not-the-tenant-secret" });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
    const rows = await rejectedRows(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signature_valid: false,
      status: "rejected",
      event_id: null,
      payload: null,
      payment_intent_id: null,
      attempts: 1,
    });
    // The body is not stored; not even its hash is the row key.
    expect(rows[0]?.payload_hash).not.toBe(sha256(raw));
  });

  it("PAY-03 a missing signature header answers 401", async () => {
    const { bill, raw } = await generic();
    const response = await deliver(raw, { header: null });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
  });

  it("PAY-03 a malformed signature header answers 401", async () => {
    const { bill, raw } = await generic();
    for (const header of [
      "",
      "garbage",
      "t=abc,v1=zz",
      `v1=${"0".repeat(64)}`,
    ]) {
      const response = await deliver(raw, { header });
      expect(response.status).toBe(401);
    }
    await expectUntouched(bill);
  });

  it("PAY-03 a timestamp older than 25 hours or more than 5 minutes ahead answers 401 even with the right secret", async () => {
    const { bill, raw } = await generic();
    const stale = new Date(Date.now() - 26 * 3_600_000);
    expect((await deliver(raw, { signedAt: stale })).status).toBe(401);
    const future = new Date(Date.now() + 6 * 60 * 1000);
    expect((await deliver(raw, { signedAt: future })).status).toBe(401);
    await expectUntouched(bill);
  });

  it("PAY-03 a DOIT retry signed 24 hours ago is still accepted (retries run up to 24 h)", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    const response = await deliver(body, {
      signedAt: new Date(Date.now() - 24 * 3_600_000),
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
  });

  it("PAY-03 a body changed after signing answers 401", async () => {
    const { bill, raw } = await generic();
    const signed = signatureHeader(raw, secretA);
    const tampered = raw.replace(`"amount":${BILL_TOTAL}`, `"amount":1`);
    expect(tampered).not.toBe(raw);
    const response = await deliver(tampered, { header: signed });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
  });

  it("PAY-03 every verification failure gives the same answer (no oracle)", async () => {
    const { raw } = await generic();
    const wrongSecret = await deliver(raw, { secret: "nope" });
    const missing = await deliver(raw, { header: null });
    const stale = await deliver(raw, {
      signedAt: new Date(Date.now() - 26 * 3_600_000),
    });
    const unknownTenant = await deliver(raw, { tenantId: randomUUID() });
    // A real, active tenant that never configured DOIT: no secret to check
    // against. It must look the same (no 503, no "not configured" hint).
    const noSecretTenant = await deliver(raw, {
      tenantId: tenantC,
      secret: secretA,
    });
    // The request id is per request; everything else must be identical.
    const answer = (response: { body: { error?: object } }) => ({
      ...response.body.error,
      requestId: undefined,
    });
    for (const response of [missing, stale, unknownTenant, noSecretTenant]) {
      expect(response.status).toBe(401);
      expect(answer(response)).toEqual(answer(wrongSecret));
    }
    expect(JSON.stringify(wrongSecret.body)).not.toMatch(/whsec|v1=/);
  });

  it("PAY-03 a webhook for a suspended tenant answers 401 and changes nothing", async () => {
    const { bill, raw } = await generic();
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantA,
    ]);
    try {
      const response = await deliver(raw);
      expect(response.status).toBe(401);
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        tenantA,
      ]);
    }
    await expectUntouched(bill);
  });

  it("PAY-03 a validly signed but unreadable event answers 500 (DOIT retries) and stores a failed row", async () => {
    const bill = await openIntent();
    for (const raw of [
      "this is not json",
      JSON.stringify({ hello: "world" }),
    ]) {
      const response = await deliver(raw);
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe("INTERNAL_ERROR");
      const rows = await rowsByBodyHash(tenantA, raw);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        signature_valid: true,
        status: "failed",
        last_error_code: "MALFORMED",
      });
    }
    await expectUntouched(bill);
  });
});

describe("PAY-03 a verified event the parser refuses is retried, not dropped", () => {
  it("PAY-03 a paid event without expires_at or a usable QR still settles", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid") as unknown as {
      data: Record<string, unknown>;
    };
    delete body.data.expires_at;
    body.data.qr_content = null;
    body.data.paid_at = "not a time";
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
  });

  it("PAY-03 a verified paid event that fails the schema answers 500, and DOIT's resend of the same event settles once", async () => {
    const bill = await openIntent();
    const good = doit.eventFor(bill.providerRef, "paid");
    const broken = {
      ...good,
      data: { ...good.data, amount: String(good.data.amount) },
    };
    const first = await deliver(broken);
    expect(first.status).toBe(500);
    expect(first.body.error.code).toBe("INTERNAL_ERROR");
    expect((await eventRows(tenantA, good.id))[0]).toMatchObject({
      status: "failed",
      last_error_code: "MALFORMED",
      payload: null,
    });
    await expectUntouched(bill);

    // The resend (same event id) parses: the stored row is completed.
    const resend = await deliver(good);
    expect(resend.status).toBe(200);
    expect(resend.body.status).toBe("processed");
    await expectPaidOnce(bill);
    const rows = await eventRows(tenantA, good.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "processed" });
    expect(rows[0]?.payload).not.toBeNull();
  });
});

describe("PAY-03 an intent keeps the DOIT integration that minted it", () => {
  async function addOutletIntegration(apiKey: string, webhookSecret: string) {
    const context = contextFor(tenantA, "session");
    const created = await upsertIntegration(
      context,
      {
        outletId: outletA,
        provider: "doit",
        config: { baseUrl: doit.baseUrl },
        credentials: { apiKey, webhookSecret },
      },
      actor,
    );
    integrationIds.push(created.id);
    await setIntegrationStatus(
      context,
      created.id,
      { status: "active" },
      actor,
    );
    return created.id;
  }

  async function mintedBy(intentId: string): Promise<string | null> {
    const { rows } = await owner.query<{ id: string | null }>(
      "SELECT gateway_integration_id AS id FROM payment_intents WHERE id = $1",
      [intentId],
    );
    return rows[0]?.id ?? null;
  }

  it("PAY-03 a code minted on the tenant account still settles by the tenant-signed webhook after the outlet gets its own integration", async () => {
    const bill = await openIntent();
    expect(await mintedBy(bill.intentId)).toBe(integrationAId);
    const outletSecret = `whsec-outlet-a-${randomBytes(12).toString("hex")}`;
    const outletIntegration = await addOutletIntegration(
      `doit-key-outlet-${randomBytes(8).toString("hex")}`,
      outletSecret,
    );
    try {
      const response = await deliver(doit.eventFor(bill.providerRef, "paid"));
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("processed");
      await expectPaidOnce(bill);
    } finally {
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        outletIntegration,
      ]);
      clearDoitWebhookSecretCache();
    }
  });

  it("PAY-03 the outlet's new secret cannot settle a code minted on the tenant account", async () => {
    const bill = await openIntent();
    const outletSecret = `whsec-outlet-a-${randomBytes(12).toString("hex")}`;
    const outletIntegration = await addOutletIntegration(apiKeyA, outletSecret);
    try {
      const body = doit.eventFor(bill.providerRef, "paid");
      const response = await deliver(body, { secret: outletSecret });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ignored");
      await expectUntouched(bill);
      expect((await eventRows(tenantA, body.id))[0]).toMatchObject({
        last_error_code: "REFERENCE_MISMATCH",
      });
    } finally {
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        outletIntegration,
      ]);
      clearDoitWebhookSecretCache();
    }
  });

  it("PAY-02 the poll asks DOIT with the minting account's key after the outlet gets its own integration", async () => {
    const bill = await openIntent();
    // The fake DOIT only knows apiKeyA: the outlet key would answer 401.
    const outletIntegration = await addOutletIntegration(
      `doit-key-outlet-${randomBytes(8).toString("hex")}`,
      `whsec-outlet-a-${randomBytes(12).toString("hex")}`,
    );
    try {
      doit.settle(bill.providerRef);
      const later = new Date(Date.now() + 120_000);
      await pollPendingGatewayIntents(contextFor(tenantA), later, 100);
      await expectPaidOnce(bill);
    } finally {
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        outletIntegration,
      ]);
      clearDoitWebhookSecretCache();
    }
  });

  it("PAY-03 money in flight on an integration disabled since is still verified and settled", async () => {
    const bill = await openIntent();
    const context = contextFor(tenantA, "session");
    await setIntegrationStatus(
      context,
      integrationAId,
      { status: "disabled" },
      actor,
    );
    try {
      const response = await deliver(doit.eventFor(bill.providerRef, "paid"));
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("processed");
      await expectPaidOnce(bill);
      // A forged body naming the same intent is still refused.
      const forged = await deliver(doit.eventFor(bill.providerRef, "paid"), {
        secret: "forged",
      });
      expect(forged.status).toBe(401);
    } finally {
      await setIntegrationStatus(
        context,
        integrationAId,
        { status: "active" },
        actor,
      );
      clearDoitWebhookSecretCache();
    }
  });
});

describe("PAY-03 rejected deliveries are one counter row per tenant per minute", () => {
  it("PAY-03 many forged payloads in one minute keep one rejected row that counts the attempts", async () => {
    const bill = await openIntent();
    const bodies = [1, 2, 3].map(() =>
      JSON.stringify(doit.eventFor(bill.providerRef, "paid")),
    );
    expect(new Set(bodies).size).toBe(3);
    for (const raw of bodies)
      expect((await deliver(raw, { secret: "forged" })).status).toBe(401);
    expect((await deliver(bodies[0]!, { secret: "forged-2" })).status).toBe(
      401,
    );
    const rows = await rejectedRows(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "rejected",
      signature_valid: false,
      payload: null,
      attempts: 4,
    });
    for (const raw of bodies)
      expect(rows[0]?.payload_hash).not.toBe(sha256(raw));
    await expectUntouched(bill);
  });

  it("PAY-03 a forged payload in the next minute opens a new counter row", async () => {
    const raw = JSON.stringify({ forged: randomBytes(6).toString("hex") });
    const first = new Date("2026-11-08T10:00:20.000Z");
    const sameMinute = new Date("2026-11-08T10:00:50.000Z");
    const nextMinute = new Date("2026-11-08T10:01:05.000Z");
    for (const now of [first, sameMinute, nextMinute])
      await expect(
        receiveDoitWebhook({
          tenantId: tenantA,
          rawBody: Buffer.from(raw),
          signatureHeader: signatureHeader(raw, "forged", now),
          now,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await rejectedRows(tenantA);
    expect(rows.map((row) => row.attempts)).toEqual([2, 1]);
  });

  it("PAY-03 the same forged payload is a separate counter row in another tenant", async () => {
    const raw = JSON.stringify({ forged: randomBytes(6).toString("hex") });
    await deliver(raw, { secret: "forged" });
    await deliver(raw, { tenantId: tenantB, secret: "forged" });
    expect(await rejectedRows(tenantA)).toHaveLength(1);
    expect(await rejectedRows(tenantB)).toHaveLength(1);
  });
});

describe("PAY-03 a verified event must name the intent it settles", () => {
  const ignoredMismatch = async (bill: Bill, body: object) => {
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "ignored" });
    await expectUntouched(bill);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
    const { rows } = await owner.query<{
      status: string;
      last_error_code: string;
    }>(
      "SELECT status, last_error_code FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
      [tenantA, (body as { id: string }).id],
    );
    expect(rows).toEqual([
      { status: "ignored", last_error_code: "REFERENCE_MISMATCH" },
    ]);
  };

  it("PAY-03 a paid event whose reference is another intent's id is ignored", async () => {
    const bill = await openIntent();
    const other = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.reference = other.intentId;
    await ignoredMismatch(bill, body);
    await expectUntouched(other);
  });

  it("PAY-03 a reference that is not a uuid is ignored", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.reference = "not-a-uuid";
    await ignoredMismatch(bill, body);
  });

  it("PAY-03 a bound event whose amount differs from the intent is not a reference mismatch: the money is parked", async () => {
    // DOIT has no separate paid amount: a paid `amount` other than the
    // intent's takes the AMOUNT_MISMATCH way, like the poll does.
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.amount = BILL_TOTAL - 5_000;
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    // Not settled, but the parked money keeps its one evidence row (as in the
    // PAY-02 underpayment case).
    expect((await intentRow(bill.intentId)).status).toBe("pending");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    expect((await eventRows(tenantA, body.id))[0]).toMatchObject({
      status: "ignored",
      last_error_code: "REJECTED_AMOUNT_MISMATCH",
    });
    expect(await unallocatedRows(bill.intentId)).toEqual([
      expect.objectContaining({ amountIdr: BILL_TOTAL - 5_000 }),
    ]);
    await expectFundsLinkedToEvidence(bill.intentId);
  });

  it("TEN-01 a secret of outlet B cannot settle an intent of outlet A", async () => {
    const bill = await openIntent(); // outlet A, served by the tenant-wide secret
    const outletSecret = `whsec-outlet-b-${randomBytes(12).toString("hex")}`;
    const created = await upsertIntegration(
      contextFor(tenantA, "session"),
      {
        outletId: outletB,
        provider: "doit",
        config: { baseUrl: doit.baseUrl },
        credentials: { apiKey: apiKeyA, webhookSecret: outletSecret },
      },
      actor,
    );
    integrationIds.push(created.id);
    await setIntegrationStatus(
      contextFor(tenantA, "session"),
      created.id,
      { status: "active" },
      actor,
    );
    clearDoitWebhookSecretCache();
    try {
      // Signed with outlet B's own valid secret, naming outlet A's payment.
      const body = doit.eventFor(bill.providerRef, "paid");
      const response = await deliver(body, { secret: outletSecret });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ignored");
      await expectUntouched(bill);
      expect(await unallocatedCount(bill.intentId)).toBe(0);
      expect((await eventRows(tenantA, body.id))[0]).toMatchObject({
        status: "ignored",
        last_error_code: "REFERENCE_MISMATCH",
      });
      // The secret that serves outlet A still settles it.
      const good = await deliver(doit.eventFor(bill.providerRef, "paid"));
      expect(good.body.status).toBe("processed");
      await expectPaidOnce(bill);
    } finally {
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        created.id,
      ]);
      clearDoitWebhookSecretCache();
    }
  });
});

describe("PAY-03 an integration change reaches the webhook secret cache at once", () => {
  it("PAY-03 rotating keeps the old secret valid only for the grace window; disabling refuses both at once, without clearing the cache by hand", async () => {
    const oldSecret = `whsec-rot-old-${randomBytes(12).toString("hex")}`;
    const newSecret = `whsec-rot-new-${randomBytes(12).toString("hex")}`;
    const context = contextFor(tenantA, "session");
    const created = await upsertIntegration(
      context,
      {
        outletId: outletB,
        provider: "doit",
        config: { baseUrl: doit.baseUrl },
        credentials: { apiKey: apiKeyA, webhookSecret: oldSecret },
      },
      actor,
    );
    integrationIds.push(created.id);
    try {
      await setIntegrationStatus(
        context,
        created.id,
        { status: "active" },
        actor,
      );
      const bill = await openIntent();
      const send = (secret: string) =>
        deliver(doit.otherEvent(bill.providerRef, "webhook.test"), { secret });
      // Warm the 60 s cache with the old secret.
      expect((await send(oldSecret)).status).toBe(200);

      await upsertIntegration(
        context,
        {
          outletId: outletB,
          provider: "doit",
          config: { baseUrl: doit.baseUrl },
          credentials: { apiKey: apiKeyA, webhookSecret: newSecret },
        },
        actor,
      );
      expect((await send(newSecret)).status).toBe(200);
      // Sub-302 D17-D18: the replaced secret still verifies during the grace
      // window (the provider may still be signing with it), and the cache
      // served the rotation at once (the new secret works without a clear).
      expect((await send(oldSecret)).status).toBe(200);
      // Past previousValidUntil (default grace 72 h) the old secret is
      // refused, even though the cached entry is still inside its 60 s TTL.
      const afterGrace = new Date(Date.now() + 73 * 3_600_000);
      const raw = JSON.stringify(
        doit.otherEvent(bill.providerRef, "webhook.test"),
      );
      const late = (secret: string) =>
        receiveDoitWebhook({
          tenantId: tenantA,
          rawBody: Buffer.from(raw),
          signatureHeader: signatureHeader(raw, secret, afterGrace),
          now: afterGrace,
        });
      await expect(late(oldSecret)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(late(newSecret)).resolves.toMatchObject({
        status: expect.stringMatching(/ignored|duplicate/),
      });

      await setIntegrationStatus(
        context,
        created.id,
        { status: "disabled" },
        actor,
      );
      // A disabled integration is refused for the new secret and for the
      // previous one still in grace.
      expect((await send(newSecret)).status).toBe(401);
      expect((await send(oldSecret)).status).toBe(401);
    } finally {
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        created.id,
      ]);
      clearDoitWebhookSecretCache();
    }
  });
});

describe("TEN-01 webhooks are isolated per tenant", () => {
  it("TEN-01 tenant B's URL with tenant A's secret answers 401", async () => {
    const bill = await openIntent();
    const raw = JSON.stringify(doit.eventFor(bill.providerRef, "paid"));
    const response = await deliver(raw, { tenantId: tenantB, secret: secretA });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
    // The rejected attempt is logged under the tenant of the URL only.
    expect(await rejectedRows(tenantB)).toHaveLength(1);
    expect(await rejectedRows(tenantA)).toHaveLength(0);
  });

  it("TEN-01 tenant A's URL with tenant B's secret answers 401", async () => {
    const bill = await openIntent();
    const response = await deliver(doit.eventFor(bill.providerRef, "paid"), {
      tenantId: tenantA,
      secret: secretB,
    });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
  });

  it("TEN-01 tenant B's valid signature naming tenant A's payment settles nothing and is parked for retry", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    const response = await deliver(body, {
      tenantId: tenantB,
      secret: secretB,
    });
    // Tenant B has no such payment: unknown to it, so it is retryable for 15
    // minutes (wave 1 item 4); the 5xx makes DOIT retry as well.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    await expectUntouched(bill);
    const [row] = await eventRows(tenantB, body.id);
    expect(row).toMatchObject({
      status: "failed",
      signature_valid: true,
      last_error_code: "UNKNOWN_REFERENCE",
      payment_intent_id: null,
    });
    expect(await eventRows(tenantA, body.id)).toHaveLength(0);
  });

  it("PAY-03 a valid event for a payment the tenant does not know is stored for retry and settles nothing", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    body.data.id = `dp_${randomBytes(8).toString("hex")}`;
    body.data.reference = randomUUID();
    const response = await deliver(body);
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    await expectUntouched(bill);
    expect(await eventRows(tenantA, body.id)).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error_code: "UNKNOWN_REFERENCE",
        payment_intent_id: null,
      }),
    ]);
  });

  it("TEN-01 the same event id in two tenants is two independent events", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    // Unknown to tenant B (stored failed and answered 5xx so DOIT retries
    // there), nothing happens to A's bill.
    expect(
      (await deliver(body, { tenantId: tenantB, secret: secretB })).status,
    ).toBe(500);
    expect(await eventRows(tenantB, body.id)).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error_code: "UNKNOWN_REFERENCE",
      }),
    ]);
    const response = await deliver(body);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
  });
});

describe("PAY-03 the route refuses what it cannot verify", () => {
  it("PAY-03 a tenant id that is not a uuid is 404 and echoes nothing", async () => {
    const raw = JSON.stringify({ id: "x" });
    const response = await request(app)
      .post("/api/webhooks/payments/doit/not-a-uuid<script>")
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", signatureHeader(raw, secretA))
      .send(raw);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("script");
  });

  it("PAY-03 a body that is not JSON content is 415", async () => {
    const bill = await openIntent();
    const raw = JSON.stringify(doit.eventFor(bill.providerRef, "paid"));
    const response = await deliver(raw, { contentType: "text/plain" });
    expect(response.status).toBe(415);
    await expectUntouched(bill);
  });
});

// ---------------------------------------------------------------------------
// Retry path and polling fallback
// ---------------------------------------------------------------------------

/**
 * Writes a stored event the way the service would have, as the table owner.
 * `ageSeconds` is how long ago it was received; `idleSeconds` how long ago it
 * was last touched (`updated_at`, the base of the retry back-off).
 */
async function storeEvent(
  bill: Bill,
  status: "received" | "failed" | "processed",
  options: {
    ageSeconds?: number;
    idleSeconds?: number;
    attempts?: number;
    lastErrorCode?: string;
  } = {},
) {
  const body = doit.eventFor(bill.providerRef, "paid");
  const raw = JSON.stringify(body);
  const receivedAt = new Date(
    Date.now() - (options.ageSeconds ?? 3_600) * 1000,
  );
  const updatedAt = new Date(
    Date.now() - (options.idleSeconds ?? 3_600) * 1000,
  );
  await owner.query(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, last_error_code, received_at, updated_at,
        integration_id)
     VALUES ($1, 'doit', $2, $3, true, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
    [
      tenantA,
      body.id,
      body.type,
      sha256(raw),
      raw,
      bill.providerRef,
      status,
      options.attempts ?? 0,
      options.lastErrorCode ?? null,
      receivedAt,
      updatedAt,
      integrationAId,
    ],
  );
  return body;
}

describe("PAY-03 stored events are retried", () => {
  it("PAY-03 a stored received event is reprocessed and settles once", async () => {
    const bill = await openIntent();
    const body = await storeEvent(bill, "received");
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectPaidOnce(bill);
    const [row] = await eventRows(tenantA, body.id);
    expect(row).toMatchObject({
      status: "processed",
      payment_intent_id: bill.intentId,
    });
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    // Running the job again changes nothing.
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectPaidOnce(bill);
  });

  it("PAY-03 a stored failed event is reprocessed", async () => {
    const bill = await openIntent();
    await storeEvent(bill, "failed", { attempts: 3 });
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectPaidOnce(bill);
  });

  // Wave 2: retry is by time. Next attempt is due at updated_at +
  // min(2^attempts, 60) minutes, and only while received_at is under 24 h old.
  it("PAY-03 an event whose back-off has not elapsed is left alone, then retried when due", async () => {
    const waiting = await openIntent();
    // attempts 3 -> due after 8 minutes; idle for 2 minutes only.
    await storeEvent(waiting, "failed", {
      attempts: 3,
      idleSeconds: 120,
      ageSeconds: 600,
    });
    const due = await openIntent();
    // attempts 3, idle for 9 minutes -> due.
    await storeEvent(due, "failed", {
      attempts: 3,
      idleSeconds: 540,
      ageSeconds: 600,
    });
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectUntouched(waiting);
    await expectPaidOnce(due);
  });

  it("PAY-03 the back-off is capped at 60 minutes however many attempts failed", async () => {
    const bill = await openIntent();
    await storeEvent(bill, "failed", {
      attempts: 12,
      idleSeconds: 61 * 60,
      ageSeconds: 2 * 3_600,
    });
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectPaidOnce(bill);
  });

  it("PAY-03 a failed event older than 24 hours stays failed for manual review", async () => {
    const bill = await openIntent();
    const body = await storeEvent(bill, "failed", {
      attempts: 1,
      ageSeconds: 25 * 3_600,
      idleSeconds: 3_600,
    });
    await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
    await expectUntouched(bill);
    expect((await eventRows(tenantA, body.id))[0]?.status).toBe("failed");
  });

  it("PAY-03 DOIT re-delivering a stored failed event processes it", async () => {
    const bill = await openIntent();
    const body = await storeEvent(bill, "failed", { attempts: 1 });
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    expect(await eventRows(tenantA, body.id)).toHaveLength(1);
  });

  it("PAY-03 re-delivering an already processed event does nothing", async () => {
    const bill = await openIntent();
    const body = await storeEvent(bill, "processed", { attempts: 1 });
    const response = await deliver(body);
    expect(response.body).toEqual({ received: true, status: "duplicate" });
    await expectUntouched(bill);
  });

  describe("UNKNOWN_REFERENCE", () => {
    /** An event for a payment the tenant does not know yet (id and reference). */
    async function deliverUnknown() {
      const bill = await openIntent();
      const body = doit.eventFor(bill.providerRef, "paid");
      body.data.id = `dp_${randomBytes(8).toString("hex")}`;
      body.data.reference = randomUUID();
      const response = await deliver(body);
      return { bill, body, response };
    }
    /**
     * The payment becomes known later (the intent write that the event
     * overtook lands): point the stored event at the real intent.
     */
    const reveal = (bill: Bill, eventId: string) => {
      const real = doit.eventFor(bill.providerRef, "paid", eventId);
      return owner.query(
        `UPDATE gateway_webhook_events SET payload = $3::jsonb, provider_ref = $4
         WHERE tenant_id = $1 AND event_id = $2`,
        [tenantA, eventId, JSON.stringify(real), bill.providerRef],
      );
    };
    const backdate = (eventId: string, minutes: number) =>
      owner.query(
        `UPDATE gateway_webhook_events
           SET received_at = now() - make_interval(mins => $3),
               updated_at = now() - make_interval(mins => $3)
         WHERE tenant_id = $1 AND event_id = $2`,
        [tenantA, eventId, minutes],
      );

    it("PAY-03 an event that overtakes its intent is retried and settles once the intent is known", async () => {
      const { bill, body, response } = await deliverUnknown();
      expect(response.status).toBe(500);
      expect((await eventRows(tenantA, body.id))[0]).toMatchObject({
        status: "failed",
        last_error_code: "UNKNOWN_REFERENCE",
      });
      await expectUntouched(bill);

      await reveal(bill, body.id);
      await backdate(body.id, 10); // 10 min old: inside the 15 min window, past back-off
      await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
      await expectPaidOnce(bill);
      expect((await eventRows(tenantA, body.id))[0]?.status).toBe("processed");
    });

    it("PAY-03 an event still unknown after 15 minutes is ignored", async () => {
      const { bill, body } = await deliverUnknown();
      await backdate(body.id, 20);
      await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
      const [row] = await eventRows(tenantA, body.id);
      expect(row).toMatchObject({
        status: "ignored",
        last_error_code: "UNKNOWN_REFERENCE",
      });
      await expectUntouched(bill);
      // An ignored event is not retried again, even once the intent is known.
      await reveal(bill, body.id);
      await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
      await expectUntouched(bill);
    });

    it("PAY-03 an event still unknown inside 15 minutes stays failed for the next retry", async () => {
      const { bill, body } = await deliverUnknown();
      await backdate(body.id, 5); // 5 min old, back-off for attempt 0/1 elapsed
      await reprocessStoredWebhookEvents(contextFor(tenantA), new Date(), 100);
      expect((await eventRows(tenantA, body.id))[0]?.status).toBe("failed");
      await expectUntouched(bill);
    });
  });
});

describe("PAY-03 rejected rows are purged after 30 days", () => {
  async function storeRejected(
    tenantId: string,
    daysOld: number,
    status: "rejected" | "processed" = "rejected",
  ) {
    const hash = sha256(`purge-${randomBytes(8).toString("hex")}`);
    await owner.query(
      `INSERT INTO gateway_webhook_events
         (tenant_id, provider, event_id, signature_valid, payload_hash, status, received_at,
          integration_id)
       VALUES ($1, 'doit', $2, $3, $4, $5, now() - make_interval(days => $6), $7)`,
      [
        tenantId,
        status === "processed" ? `evt-purge-${unique()}` : null,
        status === "processed",
        hash,
        status,
        daysOld,
        // A verified row must name its integration
        // (gateway_webhook_events_verified_integration_check); only tenant A
        // has a seeded integration, and "processed" is only stored for A.
        status === "processed" ? integrationAId : null,
      ],
    );
    return hash;
  }
  const exists = async (tenantId: string, hash: string) =>
    (await count(
      "SELECT count(*)::text AS n FROM gateway_webhook_events WHERE tenant_id = $1 AND payload_hash = $2",
      [tenantId, hash],
    )) === 1;

  it("PAY-03 purge deletes rejected rows older than 30 days and keeps the rest", async () => {
    const oldRejected = await storeRejected(tenantA, 40);
    const recentRejected = await storeRejected(tenantA, 5);
    const oldVerified = await storeRejected(tenantA, 40, "processed");
    const otherTenantOld = await storeRejected(tenantB, 40);

    const result = await purgeRejectedWebhookEvents(
      contextFor(tenantA),
      new Date(),
    );
    expect(result.deleted).toBe(1);
    expect(await exists(tenantA, oldRejected)).toBe(false);
    expect(await exists(tenantA, recentRejected)).toBe(true);
    // Verified rows are audit trail of settled money: kept.
    expect(await exists(tenantA, oldVerified)).toBe(true);
    // Another tenant's rows are out of reach.
    expect(await exists(tenantB, otherTenantOld)).toBe(true);
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND status = 'processed' AND event_id LIKE 'evt-purge-%'",
      [tenantA],
    );
  });

  it("PAY-03 the retention window is a parameter", async () => {
    const eightDays = await storeRejected(tenantA, 8);
    const fiveDays = await storeRejected(tenantA, 5);
    await purgeRejectedWebhookEvents(contextFor(tenantA), new Date(), 7);
    expect(await exists(tenantA, eightDays)).toBe(false);
    expect(await exists(tenantA, fiveDays)).toBe(true);
  });

  it("PAY-03 purge with nothing to delete answers zero", async () => {
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND status = 'rejected'",
      [tenantA],
    );
    expect(
      await purgeRejectedWebhookEvents(contextFor(tenantA), new Date()),
    ).toEqual({ deleted: 0 });
  });
});

describe("PAY-03 the webhook route rate-limits failed verifications only", () => {
  it("PAY-03 more than 30 failed verifications from one IP in a minute answer 429 without echoing the body", async () => {
    const marker = `echo-${randomBytes(6).toString("hex")}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 36; attempt++) {
      const raw = JSON.stringify({ marker, attempt });
      const response = await deliver(raw, { secret: "forged" });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.body.error.code).toBe("RATE_LIMITED");
        expect(response.text).not.toContain(marker);
      }
    }
    // Assumption on the boundary: the first 30 failures are plain 401s ("more
    // than 30" trips it); by the 36th request the limit has surely engaged.
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(
      true,
    );
  });

  it("PAY-03 the limit resets with a fresh window", async () => {
    for (let attempt = 0; attempt < 36; attempt++)
      await deliver(JSON.stringify({ attempt }), { secret: "forged" });
    expect(
      (await deliver(JSON.stringify({ again: 1 }), { secret: "forged" }))
        .status,
    ).toBe(429);
    resetPaymentWebhookRateLimits();
    expect(
      (await deliver(JSON.stringify({ again: 2 }), { secret: "forged" }))
        .status,
    ).toBe(401);
  });

  it("PAY-03 correctly signed deliveries never consume the limit", async () => {
    const bill = await openIntent();
    const body = doit.eventFor(bill.providerRef, "paid");
    // 70 valid deliveries (first processed, the rest duplicates) > 60/min and
    // > 30: none may be 429.
    for (let attempt = 0; attempt < 70; attempt++) {
      const response = await deliver(body);
      expect(response.status).toBe(200);
    }
    await expectPaidOnce(bill);
    // And a forged one right after is still an ordinary 401.
    expect((await deliver("{}", { secret: "forged" })).status).toBe(401);
  });

  it("PAY-03 valid deliveries stay accepted between a few failed ones", async () => {
    const bill = await openIntent();
    for (let attempt = 0; attempt < 10; attempt++)
      await deliver(JSON.stringify({ attempt }), { secret: "forged" });
    const response = await deliver(doit.eventFor(bill.providerRef, "paid"));
    expect(response.status).toBe(200);
    await expectPaidOnce(bill);
  });
});

describe("PAY-02 the polling fallback settles without a webhook", () => {
  it("PAY-02 a pending intent DOIT reports paid is settled by the poll", async () => {
    const bill = await openIntent();
    doit.settle(bill.providerRef);
    const later = new Date(Date.now() + 120_000);
    const result = await pollPendingGatewayIntents(
      contextFor(tenantA),
      later,
      100,
    );
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.settled).toBeGreaterThanOrEqual(1);
    await expectPaidOnce(bill);
    // Polling again is a no-op for the settled intent.
    await pollPendingGatewayIntents(contextFor(tenantA), later, 100);
    await expectPaidOnce(bill);
  });

  it("PAY-02 an intent DOIT still reports pending stays pending", async () => {
    const bill = await openIntent();
    await pollPendingGatewayIntents(
      contextFor(tenantA),
      new Date(Date.now() + 120_000),
      100,
    );
    await expectUntouched(bill);
  });

  it("PAY-02 intents younger than 60 seconds are not polled", async () => {
    const bill = await openIntent();
    doit.settle(bill.providerRef);
    await pollPendingGatewayIntents(contextFor(tenantA), new Date(), 100);
    await expectUntouched(bill);
  });

  it("PAY-02 a webhook after the poll settled it adds no second payment", async () => {
    const bill = await openIntent();
    doit.settle(bill.providerRef);
    await pollPendingGatewayIntents(
      contextFor(tenantA),
      new Date(Date.now() + 120_000),
      100,
    );
    const response = await deliver(doit.eventFor(bill.providerRef, "paid"));
    expect(response.status).toBe(200);
    await expectPaidOnce(bill);
  });
});

describe("PAY-02 an intent past its expiry asks DOIT before it expires", () => {
  const expireNow = (intentId: string) =>
    owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [intentId],
    );
  const guestView = (bill: Bill) =>
    agent(app).get(
      `/api/payments/links/${bill.token}/intents/${bill.intentId}`,
    );
  const pollLater = () =>
    pollPendingGatewayIntents(
      contextFor(tenantA),
      new Date(Date.now() + 120_000),
      100,
    );

  it("PAY-02 the poll settles a past-expiry intent DOIT reports paid, as a late payment", async () => {
    const bill = await openIntent();
    await expireNow(bill.intentId);
    doit.settle(bill.providerRef);
    const result = await pollLater();
    expect(result.settled).toBeGreaterThanOrEqual(1);
    await expectPaidOnce(bill);
    expect((await guestView(bill)).body.data.paidAfterExpiry).toBe(true);
  });

  // Brief 95 follow-up: DOIT's own expiry can lag ours, so `pending` is not
  // definitive; only DOIT's `expired` closes the intent before the window.
  it("PAY-02 the poll expires a past-expiry intent DOIT reports expired", async () => {
    const bill = await openIntent();
    await expireNow(bill.intentId);
    doit.payments.get(bill.providerRef)!.status = "expired";
    await pollLater();
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await evidenceCount(bill.intentId)).toBe(0);
  });

  it("PAY-02 the guest view settles a past-expiry intent DOIT reports paid", async () => {
    const bill = await openIntent();
    await expireNow(bill.intentId);
    doit.settle(bill.providerRef);
    const view = await guestView(bill);
    expect(view.status).toBe(200);
    expect(view.body.data.status).toBe("paid");
    expect(view.body.data.paidAfterExpiry).toBe(true);
    await expectPaidOnce(bill);
  });

  // Wave 2 (G-C): a paid answer the lifecycle refuses never turns the guest
  // view into a 409; the intent just expires.
  it("PAY-02 a past-expiry intent DOIT reports paid with a wrong amount expires without a 409", async () => {
    const bill = await openIntent();
    await expireNow(bill.intentId);
    doit.settle(bill.providerRef, BILL_TOTAL - 1_000);
    const view = await guestView(bill);
    expect(view.status).toBe(200);
    expect(view.body.data.status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
  });
});

describe("PAY-02 a gateway error never closes a lapsed intent", () => {
  const minutes = 60_000;
  const pollAt = (at: Date) =>
    pollPendingGatewayIntents(contextFor(tenantA), at, 100);
  const lapse = async (intentId: string, interval: string) => {
    const { rows } = await owner.query<{ expires_at: Date }>(
      `UPDATE payment_intents SET expires_at = now() - $2::interval
       WHERE id = $1 RETURNING expires_at`,
      [intentId, interval],
    );
    return rows[0]!.expires_at;
  };
  /** DOIT cannot be read for this payment (the fake answers 404). */
  async function withDoitDown<T>(bill: Bill, run: () => Promise<T>) {
    const payment = doit.payments.get(bill.providerRef)!;
    doit.payments.delete(bill.providerRef);
    try {
      return await run();
    } finally {
      doit.payments.set(bill.providerRef, payment);
    }
  }
  const flagsOf = async (intentId: string) =>
    (
      await owner.query<{ flags: string[] }>(
        "SELECT flags FROM payment_intents WHERE id = $1",
        [intentId],
      )
    ).rows[0]!.flags;
  const polledAt = async (intentId: string) =>
    (
      await owner.query<{ gateway_polled_at: Date | null }>(
        "SELECT gateway_polled_at FROM payment_intents WHERE id = $1",
        [intentId],
      )
    ).rows[0]!.gateway_polled_at;

  it("PAY-02 paid before expiry but polled after it: not late, recorded at DOIT's paid time", async () => {
    const bill = await openIntent();
    const expiresAt = await lapse(bill.intentId, "1 minute");
    const paidAt = new Date(expiresAt.getTime() - 1 * minutes);
    doit.settle(bill.providerRef);
    doit.payments.get(bill.providerRef)!.paid_at = paidAt.toISOString();
    await pollAt(new Date(Date.now() + 2 * minutes));
    await expectPaidOnce(bill);
    expect(await flagsOf(bill.intentId)).not.toContain("late_payment");
    expect((await intentRow(bill.intentId)).paid_at?.toISOString()).toBe(
      paidAt.toISOString(),
    );
    const { rows } = await owner.query<{ received_at: Date }>(
      "SELECT received_at FROM payment_evidence WHERE payment_intent_id = $1",
      [bill.intentId],
    );
    expect(rows.map((row) => row.received_at.toISOString())).toEqual([
      paidAt.toISOString(),
    ]);
  });

  it("PAY-02 a DOIT paid_at in the future falls back to the poll time", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 minute");
    doit.settle(bill.providerRef);
    doit.payments.get(bill.providerRef)!.paid_at = new Date(
      Date.now() + 24 * 60 * minutes,
    ).toISOString();
    const pollTime = new Date(Date.now() + 2 * minutes);
    await pollAt(pollTime);
    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).paid_at?.toISOString()).toBe(
      pollTime.toISOString(),
    );
    const { rows } = await owner.query<{ received_at: Date }>(
      "SELECT received_at FROM payment_evidence WHERE payment_intent_id = $1",
      [bill.intentId],
    );
    expect(rows.map((row) => row.received_at.toISOString())).toEqual([
      pollTime.toISOString(),
    ]);
  });

  it("PAY-02 a settlement that fails with a non-rejection error past expiry keeps the intent pending; the next poll settles it", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    doit.settle(bill.providerRef);
    // A database error (not PaymentConfirmationRejected) while settling.
    await owner.query(`
      CREATE FUNCTION fail_paid_settlement() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'paid' THEN
          RAISE EXCEPTION 'injected settlement failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await owner.query(`
      CREATE TRIGGER fail_paid_settlement BEFORE UPDATE ON payment_intents
      FOR EACH ROW EXECUTE FUNCTION fail_paid_settlement()`);
    const first = new Date(Date.now() + 2 * minutes);
    try {
      await pollAt(first);
    } finally {
      await owner.query("DROP TRIGGER fail_paid_settlement ON payment_intents");
      await owner.query("DROP FUNCTION fail_paid_settlement()");
    }
    expect((await intentRow(bill.intentId)).status).toBe("pending");
    expect(await evidenceCount(bill.intentId)).toBe(0);

    await pollAt(new Date(first.getTime() + 65 * minutes));
    await expectPaidOnce(bill);
    expect(await flagsOf(bill.intentId)).toContain("late_payment");
  });

  it("PAY-02 a gateway error past expiry keeps the intent pending; the guest sees it expired; a later poll settles it", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    const first = new Date(Date.now() + 2 * minutes);
    await withDoitDown(bill, async () => {
      await pollAt(first);
      const view = await agent(app).get(
        `/api/payments/links/${bill.token}/intents/${bill.intentId}`,
      );
      expect(view.status).toBe(200);
      expect(view.body.data.status).toBe("expired");
    });
    expect((await intentRow(bill.intentId)).status).toBe("pending");
    expect(await evidenceCount(bill.intentId)).toBe(0);

    // DOIT answers again: the money that arrived is found and recorded.
    doit.settle(bill.providerRef);
    await pollAt(new Date(first.getTime() + 65 * minutes));
    await expectPaidOnce(bill);
    expect(await flagsOf(bill.intentId)).toContain("late_payment");
  });

  it("PAY-02 DOIT still pending past expiry keeps the intent pending; a later paid answer settles it", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    const first = new Date(Date.now() + 2 * minutes);
    await pollAt(first);
    expect((await intentRow(bill.intentId)).status).toBe("pending");
    expect(await evidenceCount(bill.intentId)).toBe(0);

    // The webhook is lost; DOIT takes the money late. The poll still finds it.
    doit.settle(bill.providerRef);
    await pollAt(new Date(first.getTime() + 65 * minutes));
    await expectPaidOnce(bill);
    expect(await flagsOf(bill.intentId)).toContain("late_payment");
  });

  it("PAY-02 DOIT still pending after the poll window: expires as timeout, audited as unconfirmed", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "25 hours");
    await pollAt(new Date(Date.now() + 2 * minutes));
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    const { rows } = await owner.query<{ reason: string | null }>(
      `SELECT event->>'reason' AS reason FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenantA, "payment.reconciliation_timed_out", bill.intentId],
    );
    expect(rows).toEqual([{ reason: "gateway_unconfirmed" }]);
  });

  it("PAY-02 cancelling the link (cash replaced the code) leaves a lapsed DOIT code in reconciliation", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    const first = new Date(Date.now() + 2 * minutes);
    await withDoitDown(bill, () => pollAt(first));
    await withTenant(db, contextFor(tenantA), (tx) =>
      cancelPaymentLinkInTx(tx, contextFor(tenantA), {
        linkId: bill.linkId,
        now: new Date(first.getTime() + 3 * minutes),
        reason: "order_paid_in_cash",
      }),
    );
    expect((await intentRow(bill.intentId)).status).toBe("pending");

    // The guest had paid before the code lapsed; DOIT answers later.
    doit.settle(bill.providerRef);
    await pollAt(new Date(first.getTime() + 65 * minutes));
    await expectPaidOnce(bill);
    expect(await flagsOf(bill.intentId)).toContain("late_payment");
  });

  it("PAY-02 a lapsed intent is asked again only after the backoff", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    const first = new Date(Date.now() + 2 * minutes);
    await withDoitDown(bill, () => pollAt(first));
    expect((await polledAt(bill.intentId))?.getTime()).toBe(first.getTime());
    doit.settle(bill.providerRef);
    // The wait is half the time since expiry: not due after 5 minutes, due
    // once it has passed (62 minutes past expiry at the first poll).
    await pollAt(new Date(first.getTime() + 5 * minutes));
    expect((await polledAt(bill.intentId))?.getTime()).toBe(first.getTime());
    await expectUntouched(bill);
    await pollAt(new Date(first.getTime() + 65 * minutes));
    await expectPaidOnce(bill);
  });

  // legend-osqou.41 (1bdbf0a8b, CTO 27 Nov): a link with no order takes no new
  // code while the lapsed one is unconfirmed, so the refresh is refused.
  it("PAY-02 a refresh while the lapsed code is unconfirmed is refused; the code stays pending for reconciliation", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "1 hour");
    const refreshed = await withDoitDown(bill, () =>
      agent(app).post(
        `/api/payments/links/${bill.token}/intents/${bill.intentId}/refresh`,
      ),
    );
    expect(refreshed.status).toBe(409);
    expect(refreshed.body.error.code).toBe("ORDER_CODE_ACTIVE");
    expect((await intentRow(bill.intentId)).status).toBe("pending");

    doit.settle(bill.providerRef);
    await pollAt(new Date(Date.now() + 2 * minutes));
    await expectPaidOnce(bill);
  });

  it("PAY-02 after the poll window an unanswered intent expires as timeout, audited", async () => {
    const bill = await openIntent();
    await lapse(bill.intentId, "25 hours");
    await withDoitDown(bill, () => pollAt(new Date(Date.now() + 2 * minutes)));
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    const { rows } = await owner.query<{ reason: string | null }>(
      `SELECT event->>'reason' AS reason FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenantA, "payment.reconciliation_timed_out", bill.intentId],
    );
    expect(rows).toEqual([{ reason: "gateway_unreachable" }]);
  });
});

/** A paid webhook crediting `paidAmount` (the fake's default is the bill). */
function paidEventWithAmount(providerRef: string, paidAmount: number) {
  const event = doit.eventFor(providerRef, "paid");
  return { ...event, data: { ...event.data, amount: paidAmount } };
}

const evidenceSources = async (intentId: string) =>
  (
    await owner.query<{ source: string }>(
      "SELECT source FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantA, intentId],
    )
  ).rows.map((row) => row.source);

describe("PAY-02 the poll parks an underpayment whose webhook was lost", () => {
  const underpaid = BILL_TOTAL - 1_000;
  const pollLater = () =>
    pollPendingGatewayIntents(
      contextFor(tenantA),
      new Date(Date.now() + 120_000),
      100,
    );

  it("PAY-02 a past-expiry underpayment is parked once, then the intent expires", async () => {
    const bill = await openIntent();
    await owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [bill.intentId],
    );
    doit.settle(bill.providerRef, underpaid);
    await pollLater();
    expect((await intentRow(bill.intentId)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedRows(bill.intentId)).toEqual([
      { reason: "double_payment", amountIdr: underpaid },
    ]);
    expect(await evidenceSources(bill.intentId)).toEqual(["gateway_status"]);
    await expectFundsLinkedToEvidence(bill.intentId);
    // Polling again, and the late webhook of the same DOIT payment, add nothing.
    await pollLater();
    const late = await deliver(
      paidEventWithAmount(bill.providerRef, underpaid),
    );
    expect(late.status).toBe(200);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    expect(await unallocatedRows(bill.intentId)).toHaveLength(1);
  });

  it("PAY-02 an underpayment on a still-valid intent is parked once and the intent stays pending", async () => {
    const bill = await openIntent();
    doit.settle(bill.providerRef, underpaid);
    await pollLater();
    await pollLater();
    expect((await intentRow(bill.intentId)).status).toBe("pending");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedRows(bill.intentId)).toEqual([
      { reason: "double_payment", amountIdr: underpaid },
    ]);
    await expectFundsLinkedToEvidence(bill.intentId);
  });

  it("PAY-02 the webhook first, then the poll of the same payment: still one row", async () => {
    const bill = await openIntent();
    doit.settle(bill.providerRef, underpaid);
    const first = await deliver(
      paidEventWithAmount(bill.providerRef, underpaid),
    );
    expect(first.status).toBe(200);
    expect(await unallocatedRows(bill.intentId)).toHaveLength(1);
    await pollLater();
    expect(await evidenceCount(bill.intentId)).toBe(1);
    expect(await unallocatedRows(bill.intentId)).toHaveLength(1);
  });

  it("PAY-02 an overpaid poll settles and parks only the remainder as overpayment", async () => {
    // An amount above the bill settles normally (the remainder is parked by
    // the lifecycle), so no AMOUNT_MISMATCH row is written by the poller.
    const bill = await openIntent();
    doit.settle(bill.providerRef, BILL_TOTAL + 5_000);
    await pollLater();
    expect((await intentRow(bill.intentId)).status).toBe("paid");
    expect(await unallocatedRows(bill.intentId)).toEqual([
      { reason: "overpayment", amountIdr: 5_000 },
    ]);
  });
});

describe("PAY-02 the poll rotates so failing intents cannot starve the rest", () => {
  it("PAY-02 three erroring intents do not hide a healthy newer one on the next run", async () => {
    // Park every other tenant A intent far in the future of the rotation so
    // only this test's four rows compete for the front of the queue.
    const failing = [
      await openIntent(),
      await openIntent(),
      await openIntent(),
    ];
    const healthy = await openIntent();
    const ids = [...failing, healthy].map((bill) => bill.intentId);
    await owner.query(
      `UPDATE payment_intents SET gateway_polled_at = now() + interval '1 day'
       WHERE tenant_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [tenantA, ids],
    );
    doit.settle(healthy.providerRef);
    // DOIT is unreachable for the failing ones (the fake answers 404).
    const hidden = failing.map(
      (bill) =>
        [bill.providerRef, doit.payments.get(bill.providerRef)!] as const,
    );
    for (const [ref] of hidden) doit.payments.delete(ref);
    try {
      const later = new Date(Date.now() + 120_000);
      await pollPendingGatewayIntents(contextFor(tenantA), later, 100);
      // The breaker ended run one before the healthy intent was reached.
      expect((await intentRow(healthy.intentId)).status).toBe("pending");
      await pollPendingGatewayIntents(contextFor(tenantA), later, 100);
      await expectPaidOnce(healthy);
    } finally {
      for (const [ref, payment] of hidden) doit.payments.set(ref, payment);
    }
  });
});

// ---------------------------------------------------------------------------
// PAY-06: credentials never leak
// ---------------------------------------------------------------------------

describe("PAY-06 credentials never appear in responses or logs", () => {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  let captured: unknown[][];
  let spies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    captured = [];
    spies = [
      ...levels.map((level) =>
        vi.spyOn(moduleLogger, level).mockImplementation(((
          ...args: unknown[]
        ) => {
          captured.push(args);
        }) as never),
      ),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          captured.push(args);
        }),
      ),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("PAY-06 no apiKey, webhookSecret or signature reaches a log line or a response", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const loggingApp = createApp({
      logger: createLogger({ level: "debug", destination: stream }),
    });

    const bill = await openIntent();
    const responses: string[] = [];
    const signatures: string[] = [];

    const paid = doit.eventFor(bill.providerRef, "paid");
    const rawPaid = JSON.stringify(paid);
    const goodHeader = signatureHeader(rawPaid, secretA);
    signatures.push(goodHeader, ...goodHeader.split(/[=,]/).slice(-1));
    for (const attempt of [
      deliver(rawPaid, { header: goodHeader, application: loggingApp }),
      deliver(rawPaid, { header: goodHeader, application: loggingApp }),
      deliver(rawPaid, { secret: secretB, application: loggingApp }),
      deliver(rawPaid, { header: null, application: loggingApp }),
      deliver("not json", { application: loggingApp }),
      deliver(doit.eventFor(bill.providerRef, "paid"), {
        tenantId: tenantB,
        secret: secretB,
        application: loggingApp,
      }),
    ]) {
      const response = await attempt;
      responses.push(response.text, JSON.stringify(response.headers));
    }
    // Creating an intent sends the apiKey to DOIT; that must not be logged either.
    const another = await createPaymentLink(
      outletContext([outletA]),
      {
        outletId: outletA,
        reference: `W-${unique()}`,
        tableLabel: "A04",
        pax: 2,
        subtotalIdr: 125_000,
        discountIdr: 0,
        serviceChargeIdr: 6_250,
        taxIdr: 13_125,
        roundingIdr: 0,
        totalIdr: BILL_TOTAL,
        returnPath: "/t/v1.abc",
      },
      "00000000-0000-4000-8000-000000000001",
    );
    createdLinkIds.push(another.linkId);
    const created = await request(loggingApp)
      .post(`/api/payments/links/${another.token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      });
    responses.push(created.text);
    await pollPendingGatewayIntents(
      contextFor(tenantA),
      new Date(Date.now() + 120_000),
      100,
    );
    responses.push(
      JSON.stringify(await listIntegrations(contextFor(tenantA, "session"))),
    );

    const everything = [
      ...lines,
      ...captured.map((args) =>
        inspect(args, { depth: 6, breakLength: Infinity }),
      ),
      ...responses,
    ].join("\n");
    for (const secret of [apiKeyA, secretA, apiKeyB, secretB, ...signatures])
      expect(everything).not.toContain(secret);
    // The webhook secret is also never an HMAC input visible as plain text.
    expect(everything).not.toMatch(/Bearer doit-key/);
  });
});
