// legend-srf6 (docs/briefs/payment-hardening.md, card 1): verified DOIT webhook
// events are deduplicated per integration, not per tenant. Before, the first
// sender of an event id owned it for the whole tenant (unique index on tenant,
// provider, event_id): a second integration of the same tenant that sent the
// same event id was blocked. Now the key includes the integration.
//
// Expected behavior (from the brief; derived from the contract, not the code):
// - Two integrations (same tenant + provider) that deliver the same event id are
//   both stored, one row each, each bound to its own integration.
// - A replay of the same event id by the SAME integration is answered
//   `duplicate` and never creates a second row.
// - The database itself enforces the same rule on the unique index.
//
// Assumptions (the spec leaves them open):
// - The event type `webhook.test` is stored `ignored` and moves no money, so the
//   test needs no payment intent. The answer to a first delivery is
//   `{ received: true, status: "ignored" }` and a replay answers `duplicate`
//   (same as the existing PAY-02 / PAY-03 suites in payment-webhook-api.test.ts).
// - The two integrations are outlet-scoped (outlet A and outlet B of the demo
//   tenant), each with its own webhook secret, as in the TEN-01 case of
//   payment-webhook-api.test.ts. Money paths are not touched.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const actor = randomUUID();
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;

// Fake credentials: they are never sent anywhere (no DOIT call is made).
const secretA = `whsec-dedupe-a-${randomBytes(12).toString("hex")}`;
const secretB = `whsec-dedupe-b-${randomBytes(12).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const integrationIds: string[] = [];
const eventIds: string[] = [];
let integrationAId = "";
let integrationBId = "";

const newEventId = () => {
  const id = `evt_dedupe_${randomBytes(8).toString("hex")}`;
  eventIds.push(id);
  return id;
};

function sessionContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function seedOutletIntegration(
  outletId: typeof outletA,
  webhookSecret: string,
): Promise<string> {
  const context = sessionContext();
  const created = await upsertIntegration(
    context,
    {
      outletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: {
        apiKey: `doit-key-${randomBytes(8).toString("hex")}`,
        webhookSecret,
      },
    },
    actor,
  );
  await setIntegrationStatus(context, created.id, { status: "active" }, actor);
  integrationIds.push(created.id);
  return created.id;
}

/** A DOIT `webhook.test` event body: stored `ignored`, moves no money. */
function webhookTestEvent(eventId: string) {
  return {
    id: eventId,
    type: "webhook.test",
    created_at: new Date().toISOString(),
    data: {
      id: `dp_${randomBytes(8).toString("hex")}`,
      status: "pending",
      amount: 10_000,
      rail: "qris",
      reference: `DEDUPE-${randomBytes(4).toString("hex")}`,
      qr_content: null,
      va_number: null,
      va_bank: null,
      hosted_url: null,
      return_url: null,
      provider: "pjp",
      provider_ref: null,
      fee_amount: 0,
      fee_payer: "merchant",
      total_amount: 10_000,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      paid_at: null,
      metadata: null,
      created_at: new Date().toISOString(),
    },
  };
}

function signatureHeader(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

async function deliver(body: object, secret: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw, secret))
    .send(raw);
}

type StoredEvent = {
  integration_id: string | null;
  status: string;
  signature_valid: boolean;
};

async function storedRows(eventId: string): Promise<StoredEvent[]> {
  const { rows } = await owner.query<StoredEvent>(
    `SELECT integration_id, status, signature_valid
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND provider = 'doit' AND event_id = $2
     ORDER BY received_at`,
    [tenantId, eventId],
  );
  return rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  integrationAId = await seedOutletIntegration(outletA, secretA);
  integrationBId = await seedOutletIntegration(outletB, secretB);
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = ANY($2::text[])",
    [tenantId, eventIds],
  );
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  clearDoitWebhookSecretCache();
  await owner.end();
});

describe("legend-srf6 webhook event dedupe is per integration", () => {
  it("legend-srf6 two integrations of one tenant delivering the same event id are both stored", async () => {
    const eventId = newEventId();
    const body = webhookTestEvent(eventId);

    const first = await deliver(body, secretA);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, status: "ignored" });

    // The second integration sends the same event id with its own valid secret:
    // it is not blocked by the first sender, and is not a duplicate either.
    const second = await deliver(body, secretB);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, status: "ignored" });

    const rows = await storedRows(eventId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.integration_id).sort()).toEqual(
      [integrationAId, integrationBId].sort(),
    );
    for (const row of rows) {
      expect(row.signature_valid).toBe(true);
      expect(row.status).toBe("ignored");
    }
  });

  it("legend-srf6 a replay of the same event id by the same integration is a duplicate and adds no row", async () => {
    const eventId = newEventId();
    const body = webhookTestEvent(eventId);

    expect((await deliver(body, secretA)).body.status).toBe("ignored");
    expect((await deliver(body, secretB)).body.status).toBe("ignored");

    // Each integration replays its own event id: both answer duplicate.
    for (const secret of [secretA, secretB]) {
      const replay = await deliver(body, secret);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ received: true, status: "duplicate" });
    }
    expect(await storedRows(eventId)).toHaveLength(2);
  });

  it("legend-srf6 the same integration never gets two verified rows for one event id", async () => {
    const eventId = newEventId();
    const body = webhookTestEvent(eventId);
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await deliver(body, secretA)).status).toBe(200);

    const rows = await storedRows(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.integration_id).toBe(integrationAId);
  });
});

describe("legend-srf6 the unique index keys verified events by integration", () => {
  const insertSql = `INSERT INTO gateway_webhook_events
    (tenant_id, provider, integration_id, event_id, signature_valid, payload_hash, status)
    VALUES ($1, 'doit', $2, $3, true, $4, 'received')`;
  const hash = () => randomBytes(32).toString("hex");

  it("legend-srf6 the database accepts one event id for two integrations of a tenant", async () => {
    const eventId = newEventId();
    await owner.query(insertSql, [tenantId, randomUUID(), eventId, hash()]);
    await owner.query(insertSql, [tenantId, randomUUID(), eventId, hash()]);
    expect(await storedRows(eventId)).toHaveLength(2);
  });

  it("legend-srf6 the database refuses a second verified row of one event id for the same integration", async () => {
    const eventId = newEventId();
    const integrationId = randomUUID();
    await owner.query(insertSql, [tenantId, integrationId, eventId, hash()]);
    await expect(
      owner.query(insertSql, [tenantId, integrationId, eventId, hash()]),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await storedRows(eventId)).toHaveLength(1);
  });
});
