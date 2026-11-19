// Sub-brief 1167 P3, card f03o: one DOIT webhook secret shared by several
// integrations of the same tenant (a tenant-wide integration T and an outlet
// integration O).
//
// Contract under test:
// - a stored event row belongs to the integration that stored it (T). When T is
//   later disabled, a genuine retry signed with the shared secret still reaches
//   T's row: a MALFORMED row (payload null) is filled and processed, a failed
//   row is processed from its stored payload. The event is never lost, the
//   bill is paid once, and no stray row appears for O;
// - the same holds when the shared secret is T's previous (in-grace) secret;
// - signature verification is not loosened: a wrong secret is still refused
//   (401) and leaves the row and the money untouched.
//
// ASSUMPTIONS
// - The intent is minted through T (the fake gateway answers with T's
//   integration id), so processing the event under T's row is the consistent
//   outcome.
// - Only the observable state is pinned (HTTP 200, body status "processed",
//   row status/payload/integration, money), not the exact internal path.
// - A brand new event id (no stored row) is out of scope here: its owner stays
//   deterministic as today.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import { agent } from "./helpers";
import { BILL_TOTAL, FakeDoit } from "./payment-webhook-fake-doit";

// The previous secret of a rotated integration stays valid for this long.
vi.mock("../services/platform-payment-gateway.service", async (original) => ({
  ...(await original<
    typeof import("../services/platform-payment-gateway.service")
  >()),
  gatewaySecretGraceMs: async () => 72 * 3_600_000,
}));

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const actor = randomUUID();

const apiKey = `doit-key-shared-${randomBytes(12).toString("hex")}`;
const sharedSecret = `whsec-shared-${randomBytes(16).toString("hex")}`;
const rotatedSecret = `whsec-rotated-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
const eventIds: string[] = [];
/** T: tenant-wide integration, mints the intents. O: outlet integration. */
let integrationT = "";
let integrationO = "";

const doit = new FakeDoit(apiKey);
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

async function seedIntegration(
  outletId: OutletId | null,
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

async function setStatus(id: string, status: "active" | "disabled") {
  await owner.query(
    "UPDATE tenant_integrations SET status = $2 WHERE id = $1",
    [id, status],
  );
  clearDoitWebhookSecretCache();
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  integrationT = await seedIntegration(null, sharedSecret);
  integrationO = await seedIntegration(outletB, sharedSecret);
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationT,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey, webhookSecret: sharedSecret },
      }),
    }),
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
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

beforeEach(async () => {
  resetPaymentWebhookRateLimits();
  // Both integrations active and sharing the secret at the start of each test.
  await setStatus(integrationT, "active");
  await setStatus(integrationO, "active");
});

afterEach(() => {
  clearDoitWebhookSecretCache();
});

type Bill = { linkId: string; intentId: string; providerRef: string };

/** A payable QRIS intent minted through T. */
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

/** A verified row of integration `integrationId`, as an earlier delivery left
 * it. `payload: null` is a MALFORMED row. */
async function storeRow(
  eventId: string,
  integrationId: string,
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

async function evidenceCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]!.n);
}

async function rowsOf(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    payload: { data: { status: string } } | null;
    integration_id: string;
    last_error_code: string | null;
  }>(
    `SELECT status, payload, integration_id, last_error_code
       FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2 AND signature_valid`,
    [tenantA, eventId],
  );
  return rows;
}

async function expectPending(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("pending");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  expect(await evidenceCount(bill.intentId)).toBe(0);
}

async function expectPaidOnce(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  expect(await evidenceCount(bill.intentId)).toBe(1);
}

describe("f03o a retry signed with a secret shared by several integrations reaches the row of the integration that stored the event", () => {
  it("f03o a MALFORMED row of T is filled and processed after T is disabled, once, with no stray row for O", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(eventId, integrationT, "failed", null);
    await setStatus(integrationT, "disabled");

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      sharedSecret,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    // The event is not lost: T's own row holds the payload and is processed.
    const rows = await rowsOf(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processed",
      integration_id: integrationT,
    });
    expect(rows[0]!.payload?.data.status).toBe("paid");

    // Delivering it again never pays twice.
    const again = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      sharedSecret,
    );
    expect(again.status).toBe(200);
    expect(again.body.status).not.toBe("failed");
    await expectPaidOnce(bill);
    expect(await rowsOf(eventId)).toHaveLength(1);
  });

  it("f03o a failed row of T with a stored payload is processed from that payload after T is disabled, even if the retry body differs", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      integrationT,
      "failed",
      doit.eventFor(bill.providerRef, "paid", eventId),
    );
    await setStatus(integrationT, "disabled");

    // A different body for the same event id must not decide the outcome.
    const response = await deliver(
      doit.eventFor(bill.providerRef, "expired", eventId),
      sharedSecret,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    const rows = await rowsOf(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processed",
      integration_id: integrationT,
    });
    expect(rows[0]!.payload?.data.status).toBe("paid");
  });

  it("f03o the shared secret is T's previous in-grace secret after T rotated: the MALFORMED row of T is still filled and processed", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(eventId, integrationT, "failed", null);
    // T moves to a new secret; the shared one is now its previous secret, and
    // still O's current one.
    await upsertIntegration(
      contextFor("session"),
      {
        outletId: null,
        provider: "doit",
        config: { baseUrl: doit.baseUrl },
        credentials: { apiKey, webhookSecret: rotatedSecret },
      },
      actor,
    );
    clearDoitWebhookSecretCache();
    await setStatus(integrationT, "disabled");

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      sharedSecret,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    const rows = await rowsOf(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processed",
      integration_id: integrationT,
    });
  });

  it("f03o a wrong secret is still refused: 401, the MALFORMED row stays empty and nothing is paid", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(eventId, integrationT, "failed", null);
    await setStatus(integrationT, "disabled");

    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
      `whsec-wrong-${unique()}`,
    );

    expect(response.status).toBe(401);
    await expectPending(bill);
    const rows = await rowsOf(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      integration_id: integrationT,
      payload: null,
      last_error_code: "MALFORMED",
    });
  });
});
