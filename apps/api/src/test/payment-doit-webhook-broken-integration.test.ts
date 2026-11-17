// DOIT webhooks, card legend-145n0 (found in legend-6c6 round 3, REC-33): ONE
// active DOIT integration whose stored credentials cannot be read breaks the
// webhook secret lookup of the whole tenant, so every DOIT webhook of that
// tenant fails with a server error. Written from the card text and the existing
// webhook test conventions (payment-recurring-488-start-race.test.ts deliver),
// NOT from the implementation. Fail-first: "NEW" tests fail today; "control"
// tests pass today.
//
// Rule pinned: an active integration with unreadable credentials is skipped
// and a warning is logged WITHOUT any secret material; the tenant's other
// active integrations still verify and process their webhooks, other tenants
// are not affected, and the skipped integration grants nothing (a signature
// from an unknown secret is still refused).
//
// How "unreadable" is built: an ACTIVE DOIT row inserted directly with only
// `credentials_encrypted = 'sealed'` (no secret reference, no field names). It
// satisfies the table checks and is exactly what breaks the integration list
// (see the comment in payment-recurring-isolation.test.ts).
//
// ASSUMPTIONS
// - Delivering a valid-signature `webhook.test` event is answered 2xx (the
//   status is not pinned beyond "not an error"): the rotation test calls it a
//   stored-and-ignored event.
// - The warning goes through `logger.warn` (src/lib/logger) with the
//   integration id in the structured fields; its exact message is not pinned.
//   Nothing logged may contain the webhook secret, the API key or the sealed
//   value.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { logger } from "../lib/logger";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");
const SEALED = `sealed-${unique()}`;

type Setup = {
  tenant: SecondTenant;
  secret: string;
  apiKey: string;
  goodIntegrationId: string;
  brokenIntegrationId: string | null;
};
let broken: Setup;
let healthy: Setup;
const integrationIds: string[] = [];
const extraSetups: Setup[] = [];

function contextFor(id: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function addOutlet(tenant: SecondTenant): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet 145n0', 'Jl. 145n0', '{}')`,
    [
      id,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `WB-${unique()}`.toUpperCase(),
    ],
  );
  return id;
}

async function setup(label: string, withBroken: boolean): Promise<Setup> {
  const tenant = await createSecondTenant(owner, label);
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenant.tenantId],
  );
  const secret = `whsec-wb-${randomBytes(12).toString("hex")}`;
  const apiKey = `doit-key-${randomBytes(8).toString("hex")}`;
  const created = await upsertIntegration(
    contextFor(tenant.tenantId),
    {
      outletId: tenant.outletId as OutletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor(tenant.tenantId),
    created.id,
    { status: "active" },
    actor,
  );
  integrationIds.push(created.id);
  let brokenId: string | null = null;
  if (withBroken) {
    brokenId = randomUUID();
    await owner.query(
      `INSERT INTO tenant_integrations (id, tenant_id, outlet_id, provider, config, status, credentials_encrypted)
       VALUES ($1, $2, $3, 'doit', '{}', 'active', $4)`,
      [brokenId, tenant.tenantId, await addOutlet(tenant), SEALED],
    );
    integrationIds.push(brokenId);
  }
  return {
    tenant,
    secret,
    apiKey,
    goodIntegrationId: created.id,
    brokenIntegrationId: brokenId,
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  broken = await setup("wbbroken", true);
  healthy = await setup("wbhealthy", false);
  clearDoitWebhookSecretCache();
});

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  await step(() =>
    owner.query("DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])", [
      integrationIds,
    ]),
  );
  for (const setupRow of [broken, healthy, ...extraSetups])
    if (setupRow) {
      // Same sweep as the other recurring suites: audit rows and other
      // tenant-scoped rows point at the extra outlet, so they go first.
      await step(() => sweepTenantRows(setupRow.tenant.tenantId));
      await step(() =>
        owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id <> $2", [
          setupRow.tenant.tenantId,
          setupRow.tenant.outletId,
        ]),
      );
      await step(() => removeSecondTenant(owner, setupRow.tenant));
    }
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
});

async function sweepTenantRows(id: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [id],
    );
    const { rows } = await client.query<{ tbl: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS tbl
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.contype = 'f'
          AND c.confrelid IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                              'public.brands'::regclass, 'public.legal_entities'::regclass)
          AND c.conrelid NOT IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                                 'public.brands'::regclass, 'public.legal_entities'::regclass)`,
    );
    // `tbl` comes from pg_catalog (regclass text, already quoted), not input.
    for (const { tbl } of rows)
      await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  vi.restoreAllMocks();
});

function signatureHeader(raw: string, key: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", key).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

function deliver(tenantId: string, secret: string) {
  const id = `evt_${randomBytes(8).toString("hex")}`;
  const raw = JSON.stringify({
    id,
    type: "webhook.test",
    created_at: new Date().toISOString(),
    data: {},
  });
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw, secret))
    .send(raw);
}

const isOk = (status: number) => status >= 200 && status < 300;

describe("145n0 an active integration with unreadable credentials does not break the tenant's DOIT webhooks", () => {
  it("145n0 NEW a webhook signed with the healthy integration's secret is accepted although a sibling integration is unreadable", async () => {
    const response = await deliver(broken.tenant.tenantId, broken.secret);
    expect(isOk(response.status), `status ${response.status}`).toBe(true);
  });

  it("145n0 NEW the unreadable integration is skipped with a warning that names it and carries no secret material", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const response = await deliver(broken.tenant.tenantId, broken.secret);
    expect(isOk(response.status), `status ${response.status}`).toBe(true);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(broken.brokenIntegrationId!);
    for (const secretValue of [broken.secret, broken.apiKey, SEALED])
      expect(logged).not.toContain(secretValue);
  });

  it("145n0 NEW the skipped integration grants nothing: an unknown secret is still refused (401), not a server error", async () => {
    const response = await deliver(
      broken.tenant.tenantId,
      `whsec-unknown-${unique()}`,
    );
    expect(response.status).toBe(401);
  });

  it("145n0 NEW the skip repeats: a second delivery after the cache is cleared still works", async () => {
    expect(
      isOk((await deliver(broken.tenant.tenantId, broken.secret)).status),
    ).toBe(true);
    clearDoitWebhookSecretCache();
    expect(
      isOk((await deliver(broken.tenant.tenantId, broken.secret)).status),
    ).toBe(true);
  });

  it("145n0 an incomplete secret load (an active integration failed to open) is not cached: the next delivery loads again", async () => {
    // Valid metadata (it passes the integration list) but a ciphertext that
    // cannot be opened, so `loadIntegrationCredentialsById` itself throws.
    const flaky = await setup("wbflaky", false);
    extraSetups.push(flaky);
    const second = await upsertIntegration(
      contextFor(flaky.tenant.tenantId),
      {
        outletId: (await addOutlet(flaky.tenant)) as OutletId,
        provider: "doit",
        config: { baseUrl: "http://127.0.0.1:9" },
        credentials: {
          apiKey: `doit-key-${unique()}`,
          webhookSecret: `whsec-wb-${randomBytes(12).toString("hex")}`,
        },
      },
      actor,
    );
    await setIntegrationStatus(
      contextFor(flaky.tenant.tenantId),
      second.id,
      { status: "active" },
      actor,
    );
    integrationIds.push(second.id);
    await owner.query(
      "UPDATE tenant_integrations SET credentials_encrypted = $2 WHERE id = $1",
      [second.id, SEALED],
    );
    clearDoitWebhookSecretCache();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const skipped = () =>
      warn.mock.calls.filter(
        (call) =>
          JSON.stringify(call).includes(second.id) &&
          JSON.stringify(call).includes("credentials unreadable, skipped"),
      ).length;
    expect(
      isOk((await deliver(flaky.tenant.tenantId, flaky.secret)).status),
    ).toBe(true);
    expect(skipped()).toBe(1);
    // No cache clear in between: a cached result would not read (or warn) again.
    expect(
      isOk((await deliver(flaky.tenant.tenantId, flaky.secret)).status),
    ).toBe(true);
    expect(skipped()).toBe(2);
    warn.mockRestore();
  });

  it("145n0 control: another tenant's webhook is unaffected by the broken tenant", async () => {
    const response = await deliver(healthy.tenant.tenantId, healthy.secret);
    expect(isOk(response.status), `status ${response.status}`).toBe(true);
  });

  it("145n0 control: the broken tenant's secret does not open another tenant", async () => {
    const response = await deliver(healthy.tenant.tenantId, broken.secret);
    expect(response.status).toBe(401);
  });
});
