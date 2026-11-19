// A retried DOIT event id stays bound to the integration that stored it (bead
// legend-101, sub-brief 101; PRD v1.7 §3.13, PAY-03, TEN-01), and since bead
// legend-srf6 the verified-event key is per integration.
//
// Contract under test:
// - the dedupe key is (tenant, provider, integration, event id): integration B
//   reusing an event id of integration A gets its OWN row; A's row is never
//   touched, completed or replayed by B, and B's body cannot settle, expire or
//   otherwise move A's intent (a deterministic refusal answers 200 so DOIT does
//   not retry forever). Assumption: the exact response body of B's delivery is
//   not specified, only the 200 and the unchanged money state;
// - the database refuses a verified row without an integration (check
//   gateway_webhook_events_verified_integration_check), so no row can escape
//   the per-integration key;
// - same integration, stored payload present: the STORED payload is processed,
//   a replacement body is ignored;
// - same integration, stored row was MALFORMED (payload null): the replacement
//   payload is stored and processed.
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
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent } from "./helpers";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const actor = randomUUID();
const BILL_TOTAL = 144_375;

const apiKeyA = `doit-key-a-${randomBytes(12).toString("hex")}`;
const secretA = `whsec-a-${randomBytes(16).toString("hex")}`;
/** Integration B: the outlet B account of the same tenant, own secret. */
const secretB = `whsec-b-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
const eventIds: string[] = [];
let integrationAId = "";
let integrationBId = "";

const unique = () => randomBytes(4).toString("hex");
const newEventId = () => `evt_${randomBytes(8).toString("hex")}`;

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
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
// Minimal fake DOIT: only what creating a QRIS intent needs
// ---------------------------------------------------------------------------

type DoitPayment = {
  id: string;
  status: "pending" | "paid" | "expired";
  amount: number;
  rail: string;
  reference: string;
  qr_content: string;
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
  paid_at: null;
  metadata: null;
  created_at: string;
};

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

  /** A `payment.paid` webhook body for the payment with `data` in `status`. */
  eventFor(
    id: string,
    status: "pending" | "paid" | "expired",
    eventId: string,
    amount: number = BILL_TOTAL,
  ) {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return {
      id: eventId,
      type: status === "expired" ? "payment.expired" : "payment.paid",
      created_at: new Date().toISOString(),
      data: { ...payment, status, amount, total_amount: amount },
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
      return send(401, { error: { code: "unauthorized" } });
    if (req.method === "GET" && url.pathname === "/v1/methods")
      return send(200, {
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
    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(key);
      if (known) return send(200, known);
      const input = JSON.parse(body) as {
        amount: number;
        reference: string;
        expires_in: number;
      };
      const id = `dp_${randomBytes(8).toString("hex")}`;
      const createdAt = new Date();
      const payment: DoitPayment = {
        id,
        status: "pending",
        amount: input.amount,
        rail: "qris",
        reference: input.reference,
        qr_content: "00020101021226610014ID.CO.DOIT.FAKE",
        va_number: null,
        va_bank: null,
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
  outletId: OutletId | null,
  apiKey: string,
  webhookSecret: string,
): Promise<string> {
  const created = await upsertIntegration(
    contextFor("session"),
    {
      outletId,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor("session"),
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
  integrationAId = await seedIntegration(null, apiKeyA, secretA);
  integrationBId = await seedIntegration(outletB, apiKeyA, secretB);
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationAId,
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
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = ANY($2::text[])",
    [tenantA, eventIds],
  );
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

afterEach(() => {
  clearDoitWebhookSecretCache();
});

type Bill = { linkId: string; intentId: string; providerRef: string };

/** A payable QRIS intent minted on integration A (tenant-wide account). */
async function openIntent(): Promise<Bill> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `R-${unique()}`,
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
  return { linkId: opened.linkId, intentId, providerRef };
}

/** Stores a verified row of integration `integrationId`, as an earlier delivery
 * (or the worker's input) would have left it. `payload: null` is MALFORMED. */
async function storeRow(
  eventId: string,
  integrationId: string | null,
  status: "received" | "failed",
  payload: object | null,
) {
  eventIds.push(eventId);
  await owner.query(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, last_error_code, received_at, updated_at,
        integration_id)
     VALUES ($1, 'doit', $2, $3, true, $4, $5::jsonb, $6, $7, 1, $8, now(), now(), $9)`,
    [
      tenantA,
      eventId,
      payload ? "payment.paid" : null,
      randomBytes(32).toString("hex"),
      payload ? JSON.stringify(payload) : null,
      payload ? (payload as { data: { id: string } }).data.id : null,
      status,
      payload ? null : "MALFORMED",
      integrationId,
    ],
  );
}

function deliver(body: object, secret: string) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantA}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", `t=${t},v1=${mac}`)
    .send(raw);
}

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.status;
}

async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

async function eventRow(
  eventId: string,
  integrationId: string = integrationAId,
) {
  const { rows } = await owner.query<{
    status: string;
    payload: { data: { status: string; amount: number } } | null;
    payload_hash: string;
    integration_id: string | null;
    payment_intent_id: string | null;
    last_error_code: string | null;
    attempts: number;
    updated_at: Date;
  }>(
    `SELECT status, payload, payload_hash, integration_id, payment_intent_id,
            last_error_code, attempts, updated_at
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2 AND integration_id = $3`,
    [tenantA, eventId, integrationId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Verified rows stored for this event id, one per integration. */
async function rowIntegrations(eventId: string): Promise<string[]> {
  const { rows } = await owner.query<{ integration_id: string }>(
    `SELECT integration_id FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2 AND signature_valid
     ORDER BY integration_id`,
    [tenantA, eventId],
  );
  return rows.map((row) => row.integration_id);
}

async function expectBothRows(eventId: string) {
  expect(await rowIntegrations(eventId)).toEqual(
    [integrationAId, integrationBId].sort(),
  );
}

async function expectPending(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("pending");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
}

async function expectPaidOnce(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
}

describe("PAY-03 a retried event id stays bound to the integration that stored it", () => {
  it("TEN-01 integration B reusing A's event id gets its own row and cannot settle A's intent (received row)", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    // A's earlier delivery: stored, never finished, payment still pending.
    await storeRow(
      eventId,
      integrationAId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
    );
    const before = await eventRow(eventId);

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      secretB,
    );

    expect(response.status).toBe(200);
    // B's delivery is stored as B's own row; A's row and the money are intact.
    await expectBothRows(eventId);
    await expectPending(bill);
    const after = await eventRow(eventId, integrationAId);
    expect(after).toEqual(before);
    expect(after.integration_id).toBe(integrationAId);
    expect((await eventRow(eventId, integrationBId)).integration_id).toBe(
      integrationBId,
    );
  });

  it("TEN-01 the same attack on a failed row leaves A's row alone, and the owner's retry then settles from the stored payload", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const stored = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, integrationAId, "failed", stored);
    const before = await eventRow(eventId);

    // B's body would expire the intent; it must not even be looked at.
    const attack = await deliver(
      doit.eventFor(bill.providerRef, "expired", eventId),
      secretB,
    );
    expect(attack.status).toBe(200);
    await expectBothRows(eventId);
    await expectPending(bill);
    expect(await eventRow(eventId, integrationAId)).toEqual(before);

    // The owner's own retry is not refused and settles the bill once.
    const retry = await deliver(stored, secretA);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("processed");
    await expectPaidOnce(bill);
    expect((await eventRow(eventId, integrationAId)).status).toBe("processed");
  });

  it("TEN-01 after B's attack the worker settles the intent from A's stored payload", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      integrationAId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
    );
    const attack = await deliver(
      doit.eventFor(bill.providerRef, "expired", eventId),
      secretB,
    );
    expect(attack.status).toBe(200);
    await expectPending(bill);

    // Past the back-off of the stored row.
    await reprocessStoredWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 10 * 60_000),
      100,
    );

    await expectPaidOnce(bill);
    const after = await eventRow(eventId);
    expect(after.status).toBe("processed");
    expect(after.payload?.data.status).toBe("paid");
    expect(after.integration_id).toBe(integrationAId);
  });

  it("TEN-01 the database refuses a verified event row without an owning integration", async () => {
    const bill = await openIntent();
    const eventId = newEventId();

    await expect(
      storeRow(
        eventId,
        null,
        "received",
        doit.eventFor(bill.providerRef, "pending", eventId),
      ),
    ).rejects.toThrow(/verified_integration_check|check constraint/i);

    expect(await rowIntegrations(eventId)).toEqual([]);
    await expectPending(bill);
  });

  it("PAY-03 a retry from the same integration with a different body processes the STORED payload", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const stored = doit.eventFor(bill.providerRef, "paid", eventId);
    // Claimable only once idle past the stuck window (1167), so age the row.
    await storeAged(eventId, "received", stored, 1, 600);
    const before = await eventRow(eventId);

    // Same event id, same signer, a body that would expire the intent.
    const response = await deliver(
      doit.eventFor(bill.providerRef, "expired", eventId),
      secretA,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    const after = await eventRow(eventId);
    expect(after.status).toBe("processed");
    expect(after.payment_intent_id).toBe(bill.intentId);
    expect(after.payload).toEqual(before.payload);
    expect(after.payload_hash).toBe(before.payload_hash);
    expect(await rowIntegrations(eventId)).toEqual([integrationAId]);
  });

  it("PAY-03 a retry of a MALFORMED row from the same integration stores the new payload and processes it", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(eventId, integrationAId, "failed", null);

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      secretA,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    const after = await eventRow(eventId);
    expect(after.status).toBe("processed");
    expect(after.payload?.data.status).toBe("paid");
    expect(after.integration_id).toBe(integrationAId);
  });

  it("TEN-01 a MALFORMED row of integration A cannot be filled or processed by integration B", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(eventId, integrationAId, "failed", null);
    const before = await eventRow(eventId);

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      secretB,
    );

    expect(response.status).toBe(200);
    await expectBothRows(eventId);
    await expectPending(bill);
    const after = await eventRow(eventId, integrationAId);
    expect(after).toEqual(before);
    expect(after.payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// legend-okrmg: the retry worker must not race the request that is still
// processing an event (money rule: never record a payment twice).
//
// ASSUMPTIONS (brief docs/briefs/webhook-retry-guard.md, Kartu 1, CTO decision):
// - A `received` row is held back until `updated_at` is 5 minutes old (the
//   existing "stuck" guard), whatever its attempts count. A `failed` row keeps
//   the normal back-off min(2^attempts, 60) minutes.
// - Time margins are wide (2 and 4 minutes vs 5; 10 minutes vs 5) so host and
//   database clock skew cannot decide a result.
// ---------------------------------------------------------------------------

/** A stored row of integration A with explicit `attempts` and idle time. */
async function storeAged(
  eventId: string,
  status: "received" | "failed",
  payload: object,
  attempts: number,
  idleSeconds: number,
) {
  eventIds.push(eventId);
  const updatedAt = new Date(Date.now() - idleSeconds * 1000);
  await owner.query(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, received_at, updated_at,
        integration_id)
     VALUES ($1, 'doit', $2, 'payment.paid', true, $3, $4::jsonb, $5, $6, $7, $8, $8, $9)`,
    [
      tenantA,
      eventId,
      randomBytes(32).toString("hex"),
      JSON.stringify(payload),
      (payload as { data: { id: string } }).data.id,
      status,
      attempts,
      updatedAt,
      integrationAId,
    ],
  );
}

async function evidenceCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]!.n);
}

describe("PAY-03 the retry worker leaves a recently stored received event alone", () => {
  it("PAY-03 a received event 2 minutes old (attempts 0) is not reprocessed by the worker", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      120,
    );
    const before = await eventRow(eventId);

    await reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100);

    await expectPending(bill);
    expect(await evidenceCount(bill.intentId)).toBe(0);
    const after = await eventRow(eventId);
    expect(after.status).toBe("received");
    expect(after.attempts).toBe(before.attempts);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it("PAY-03 a received event 4 minutes old is still held back, with any attempts count", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      2,
      240,
    );

    await reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100);

    await expectPending(bill);
    expect((await eventRow(eventId)).status).toBe("received");
  });

  it("PAY-03 a failed event 2 minutes idle (attempts 0) keeps the normal back-off and is retried", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "failed",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      120,
    );

    await reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100);

    await expectPaidOnce(bill);
    expect((await eventRow(eventId)).status).toBe("processed");
  });

  it("PAY-03 a received event stuck for more than 5 minutes is still retried and settles once", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      600,
    );

    await reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100);

    await expectPaidOnce(bill);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    const row = await eventRow(eventId);
    expect(row.status).toBe("processed");
    expect(row.payment_intent_id).toBe(bill.intentId);

    // A second sweep is a no-op: no second payment.
    await reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100);
    await expectPaidOnce(bill);
    expect(await evidenceCount(bill.intentId)).toBe(1);
  });

  it("PAY-03 two workers on the same stuck event record the payment once", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      600,
    );

    const results = await Promise.all([
      reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100),
      reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100),
    ]);

    await expectPaidOnce(bill);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    const row = await eventRow(eventId);
    expect(row.status).toBe("processed");
    // The payment-evidence filter alone would hide a double run, so also
    // prove the event was claimed by exactly one worker: the stuck claim counts
    // one attempt (1176) and the recorded outcome one more, so 2 (a double run
    // would show 4), and the two sweeps together processed it once.
    expect(row.attempts).toBe(2);
    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
  });

  it("PAY-03 a worker sweep racing a live delivery of a fresh received event records the payment once", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    // A received row is claimable only once idle past the stuck window (1167),
    // so age it (10 minutes): both the delivery and the sweep may now claim it.
    await storeAged(eventId, "received", body, 0, 600);

    const [delivery, sweep] = await Promise.all([
      deliver(body, secretA),
      reprocessStoredWebhookEvents(contextFor("webhook"), new Date(), 100),
    ]);

    expect(delivery.status).toBe(200);
    await expectPaidOnce(bill);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    const row = await eventRow(eventId);
    expect(row.status).toBe("processed");
    // Processed once in total: whichever of the delivery and the sweep claims
    // the row first processes it, and the other skips, so the row records a
    // single claim (stuck claim counts one attempt, 1176) plus its outcome: 2.
    expect(sweep.processed).toBeLessThanOrEqual(1);
    expect(row.attempts).toBe(2);
  });

  // Deterministic claim proof (no timing): a competing transaction holds the
  // row lock on a stuck event, the worker reads it as eligible and blocks on
  // it; the competitor then touches updated_at (as another worker's claim
  // would) and commits. The blocked worker must re-check eligibility and skip.
  it("PAY-03 a worker that loses the claim to a concurrent worker does not process the event", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeAged(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      600,
    );

    const holder = await owner.connect();
    let worker: Promise<{ checked: number; processed: number }> | undefined;
    try {
      await holder.query("BEGIN");
      const { rows: pid } = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await holder.query(
        `SELECT id FROM gateway_webhook_events
          WHERE tenant_id = $1 AND event_id = $2 FOR UPDATE`,
        [tenantA, eventId],
      );

      worker = reprocessStoredWebhookEvents(
        contextFor("webhook"),
        new Date(),
        100,
      );
      // Surface a worker rejection without leaving it unhandled while we poll.
      worker.catch(() => undefined);

      // Wait until some other session is queued behind the holder's lock.
      const deadline = Date.now() + 15_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const { rows } = await owner.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM pg_locks w
             JOIN pg_locks h
               ON h.locktype = 'transactionid'
              AND h.granted
              AND h.pid = $1
              AND w.transactionid = h.transactionid
            WHERE w.locktype = 'transactionid' AND NOT w.granted`,
          [pid[0]!.pid],
        );
        waiting = Number(rows[0]!.n);
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThan(0);

      // Mimic the competing worker's claim, then release the lock.
      await holder.query(
        `UPDATE gateway_webhook_events SET updated_at = now()
          WHERE tenant_id = $1 AND event_id = $2`,
        [tenantA, eventId],
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    const result = await worker!;
    expect(result.processed).toBe(0);
    await expectPending(bill);
    expect(await evidenceCount(bill.intentId)).toBe(0);
    const row = await eventRow(eventId);
    expect(row.status).toBe("received");
    expect(row.attempts).toBe(0);
  });
});
