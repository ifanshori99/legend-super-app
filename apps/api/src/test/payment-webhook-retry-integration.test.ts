// A retried DOIT event id must stay bound to the integration that first stored
// it (bead legend-101, sub-brief 101; PRD v1.7 §3.13, PAY-03, TEN-01).
//
// Before the fix a delivery that hit the unique event-id index re-processed the
// stored row with the NEW payload and the NEW signer's secret, so integration B
// (any other active DOIT integration of the tenant) that knew an event id of
// integration A could settle A's intent with a paid body signed by B's key.
//
// Contract under test:
// - stored row of another integration: nothing is processed, the row is not
//   touched, an audit row `payment.webhook.integration_mismatch` is written and
//   the answer is `200 { status: "ignored" }` (same convention as
//   REFERENCE_MISMATCH: a deterministic refusal must not make DOIT retry
//   forever);
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
const AUDIT_ACTION = "payment.webhook.integration_mismatch";

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

async function eventRow(eventId: string) {
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
     FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2`,
    [tenantA, eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Mismatch audit rows that name this event id. */
async function mismatchAudits(eventId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2
       AND event->'maskedChanges'->'after'->>'eventId' = $3`,
    [tenantA, AUDIT_ACTION, eventId],
  );
  return rows.map((row) => row.event);
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
  it("TEN-01 integration B cannot settle A's intent by reusing A's event id (received row)", async () => {
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
    expect(response.body.status).toBe("ignored");
    await expectPending(bill);
    const after = await eventRow(eventId);
    expect(after).toEqual(before);
    expect(after.integration_id).toBe(integrationAId);
    const audits = await mismatchAudits(eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "system",
      action: AUDIT_ACTION,
    });
    // No payload and no secret in the audit row.
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(secretA);
    expect(serialized).not.toContain(secretB);
    expect(serialized).not.toContain("qr_content");
  });

  it("TEN-01 the same attack on a failed row is refused too, and the owner's retry then settles from the stored payload", async () => {
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
    expect(attack.body.status).toBe("ignored");
    await expectPending(bill);
    expect(await eventRow(eventId)).toEqual(before);
    expect(await mismatchAudits(eventId)).toHaveLength(1);

    // The owner's own retry is not refused and settles the bill once.
    const retry = await deliver(stored, secretA);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("processed");
    await expectPaidOnce(bill);
    expect((await eventRow(eventId)).status).toBe("processed");
    expect(await mismatchAudits(eventId)).toHaveLength(1);
  });

  it("TEN-01 after a refused attack the worker settles the intent from A's stored payload", async () => {
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
    expect(attack.body.status).toBe("ignored");
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

  it("TEN-01 a row without an owning integration is refused to everyone and left unchanged", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      null,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
    );
    const before = await eventRow(eventId);

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      secretB,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    await expectPending(bill);
    expect(await eventRow(eventId)).toEqual(before);
    expect(await mismatchAudits(eventId)).toHaveLength(1);

    // Signed with A's secret: an unowned row is refused too.
    const fromA = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      secretA,
    );
    expect(fromA.status).toBe(200);
    expect(fromA.body.status).toBe("ignored");
    await expectPending(bill);
    expect(await eventRow(eventId)).toEqual(before);
    expect(await mismatchAudits(eventId)).toHaveLength(2);
  });

  it("PAY-03 a retry from the same integration with a different body processes the STORED payload", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const stored = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, integrationAId, "received", stored);
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
    expect(await mismatchAudits(eventId)).toHaveLength(0);
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
    expect(response.body.status).toBe("ignored");
    await expectPending(bill);
    const after = await eventRow(eventId);
    expect(after).toEqual(before);
    expect(after.payload).toBeNull();
    expect(await mismatchAudits(eventId)).toHaveLength(1);
    // The audit row belongs to integration B's delivery of A's event id.
    expect(integrationBId).not.toBe(integrationAId);
  });
});
