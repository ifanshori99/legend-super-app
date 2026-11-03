// Integrations store + quota/cost usage API (PRD v1.7 §3 F4 "Integrasi per
// Tenant", "Kuota & Plafon"; PAY-06, TEN-06). Real Express app, Better Auth
// and PostgreSQL. DB-role isolation of the tables lives in
// platform-integrations-db.test.ts.
import { Writable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cafeLegendPlatformFixtures,
  tenantIntegrationSchema,
  tenantUsageViewSchema,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { createLogger } from "../lib/logger.ts";
import { currentCredentialKeyVersion } from "../services/platform-integration.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

// Mount this bead's routers in front of the app's API router, the way the
// lead registers them in routes/index.ts. Mounting first is harmless once the
// real registration exists: the guards are per route.
vi.mock("../routes/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/index.ts")>();
  const { Router } = await import("express");
  const { orgIntegrationsRouter, platformUsageRouter } =
    await import("../routes/platform-integrations.routes.ts");
  const router = Router();
  router.use("/org", orgIntegrationsRouter);
  router.use("/platform", platformUsageRouter);
  router.use(actual.apiRouter);
  return { ...actual, apiRouter: router };
});

const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// Providers this suite owns in the seeded tenant (whatsapp belongs to the
// identity-login suite). All are in the seeded tenant's available list.
const OWNED_PROVIDERS = ["doit", "edc", "gofood"];

const tenantB = randomUUID();
const brandB = randomUUID();
const legalEntityB = randomUUID();
const outletB = randomUUID();
const integrationB = randomUUID();

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return {
    lines,
    logger: createLogger({ level: "trace", destination: stream }),
  };
}

const app = createApp();

/** Signs up a user holding `template` in the seeded tenant, MFA verified. */
async function tenantMember(
  template: string,
  expressApp = app,
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(expressApp);
  const email = await signUp(client, `Uji ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = $3`,
    [seededTenantId, userId, template],
  );
  if (assigned.rowCount !== 1) throw new Error(`No ${template} role template`);
  await verifySessionMfa(email);
  return { client, userId };
}

async function platformAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [session.body.user.id],
  );
  await verifySessionMfa(email);
  return client;
}

async function seededOutletId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM outlets WHERE tenant_id = $1 ORDER BY id LIMIT 1",
    [seededTenantId],
  );
  if (!rows[0]) throw new Error("Seeded tenant has no outlet");
  return rows[0].id;
}

beforeAll(async () => {
  await owner.query(
    `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = ANY($2)`,
    [seededTenantId, OWNED_PROVIDERS],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Integrasi', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["doit"]}', $3, $4)`,
    [
      tenantB,
      `uji-int-${randomBytes(4).toString("hex")}`,
      JSON.stringify({
        maxOutlets: 5,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, tenantB, `uji-int-b-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
    [legalEntityB, tenantB],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', '{}')`,
    [outletB, tenantB, brandB, legalEntityB],
  );
  await owner.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, config) VALUES ($1, $2, 'doit', '{}')`,
    [integrationB, tenantB],
  );
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = ANY($2)`,
    [seededTenantId, OWNED_PROVIDERS],
  );
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    tenantB,
  ]);
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
    tenantB,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
});

describe("Integrations store (PAY-06)", () => {
  it("PAY-06 encrypts gateway credentials and never sends them to the client, the log or the audit trail", async () => {
    const { lines, logger } = captureLogs();
    const loggedApp = createApp({ logger });
    const { client } = await tenantMember("tenant_admin", loggedApp);
    const apiKey = `doit-live-${randomBytes(16).toString("hex")}`;
    const signingSecret = `whsec-${randomBytes(16).toString("hex")}`;

    const created = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        outletId: null,
        provider: "doit",
        config: { merchantCode: "CAFE-001" },
        credentials: { apiKey, signingSecret },
      });
    expect(created.status).toBe(200);
    const integration = tenantIntegrationSchema.parse(created.body.data);
    expect(integration).toMatchObject({
      tenantId: seededTenantId,
      outletId: null,
      provider: "doit",
      status: "draft",
      config: { merchantCode: "CAFE-001" },
    });
    expect(integration.credentials?.fields).toEqual([
      "apiKey",
      "signingSecret",
    ]);
    expect(integration.credentials?.secretRef).toMatch(/^sec_/);

    const listed = await client.get("/api/org/integrations");
    expect(listed.status).toBe(200);
    expect(listed.headers["cache-control"]).toContain("no-store");

    const activated = await client
      .post(`/api/org/integrations/${integration.id}/status`)
      .set(originHeader)
      .send({ status: "active" });
    expect(activated.status).toBe(200);
    expect(activated.body.data.status).toBe("active");

    // Never in a response.
    for (const body of [created.body, listed.body, activated.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain(signingSecret);
      expect(text).not.toContain("credentialsEncrypted");
    }

    // Stored sealed, with the current key version, never in plaintext.
    const stored = await owner.query<{
      credentials_encrypted: string;
      credentials_key_version: number;
    }>(
      "SELECT credentials_encrypted, credentials_key_version FROM tenant_integrations WHERE id = $1",
      [integration.id],
    );
    const sealed = stored.rows[0]?.credentials_encrypted ?? "";
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed).not.toContain(apiKey);
    expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain(
      apiKey,
    );
    expect(stored.rows[0]?.credentials_key_version).toBe(
      currentCredentialKeyVersion(),
    );

    // Never in the audit trail (the changes are audited, masked).
    const audited = await owner.query<{ event: unknown; action: string }>(
      `SELECT event, event->>'action' AS action FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2`,
      [seededTenantId, integration.id],
    );
    expect(audited.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "integration.created",
        "integration.status.changed",
      ]),
    );
    const auditText = JSON.stringify(audited.rows);
    expect(auditText).not.toContain(apiKey);
    expect(auditText).not.toContain(signingSecret);

    // Never in the log, even at trace level.
    const logText = lines.join("\n");
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).not.toContain(apiKey);
    expect(logText).not.toContain(signingSecret);
  });

  it("PAY-06 PUT is an idempotent upsert: the same body keeps the sealed secret, new credentials replace it", async () => {
    const { client } = await tenantMember("tenant_admin");
    const body = {
      outletId: null,
      provider: "gofood",
      config: { storeId: "GF-1" },
      credentials: { clientKey: `gf-${randomBytes(8).toString("hex")}` },
    };
    const first = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(body);
    expect(first.status).toBe(200);
    const sealedBefore = await owner.query<{ c: string }>(
      "SELECT credentials_encrypted AS c FROM tenant_integrations WHERE id = $1",
      [first.body.data.id],
    );

    const again = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(body);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    const sealedAfter = await owner.query<{ c: string }>(
      "SELECT credentials_encrypted AS c FROM tenant_integrations WHERE id = $1",
      [first.body.data.id],
    );
    expect(sealedAfter.rows[0]?.c).toBe(sealedBefore.rows[0]?.c);
    const rows = await owner.query(
      "SELECT id FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'gofood' AND outlet_id IS NULL",
      [seededTenantId],
    );
    expect(rows.rowCount).toBe(1);

    // Omitted credentials keep the stored secret; config still updates.
    const configOnly = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        outletId: null,
        provider: "gofood",
        config: { storeId: "GF-2" },
      });
    expect(configOnly.status).toBe(200);
    expect(configOnly.body.data.config).toEqual({ storeId: "GF-2" });
    expect(configOnly.body.data.credentials.secretRef).toBe(
      first.body.data.credentials.secretRef,
    );

    const replaced = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ ...body, credentials: { clientKey: "gf-rotated-key-0001" } });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.id).toBe(first.body.data.id);
    expect(replaced.body.data.credentials.secretRef).not.toBe(
      first.body.data.credentials.secretRef,
    );
  });

  it("PAY-06 validates strictly: secret-like config keys, tenantId in the body and unavailable providers are refused", async () => {
    const { client } = await tenantMember("tenant_admin");
    const secretInConfig = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        outletId: null,
        provider: "doit",
        config: { apiSecret: "should-be-a-credential" },
      });
    expect(secretInConfig.status).toBe(422);
    expect(JSON.stringify(secretInConfig.body)).not.toContain(
      "should-be-a-credential",
    );

    const withTenant = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        outletId: null,
        provider: "doit",
        config: {},
        tenantId: tenantB,
      });
    expect(withTenant.status).toBe(422);

    // duitku is not in the seeded tenant's available providers.
    const unavailable = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ outletId: null, provider: "duitku", config: {} });
    expect(unavailable.status).toBe(422);
    expect(unavailable.body.error.code).toBe(
      "INTEGRATION_PROVIDER_NOT_AVAILABLE",
    );

    // Activating without stored credentials breaks the state machine.
    const draft = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ outletId: await seededOutletId(), provider: "edc", config: {} });
    expect(draft.status).toBe(200);
    expect(draft.body.data.outletId).toBe(await seededOutletId());
    const refused = await client
      .post(`/api/org/integrations/${draft.body.data.id}/status`)
      .set(originHeader)
      .send({ status: "active" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("INVALID_TRANSITION");

    // Mutations need the trusted origin.
    const noOrigin = await client
      .put("/api/org/integrations")
      .send({ outletId: null, provider: "doit", config: {} });
    expect(noOrigin.status).toBe(403);
  });

  it("PAY-06 TEN-01 another tenant's integration and outlet are unreachable", async () => {
    const { client } = await tenantMember("tenant_admin");
    const listed = await client.get("/api/org/integrations");
    expect(listed.status).toBe(200);
    for (const row of listed.body.data as { tenantId: string; id: string }[]) {
      expect(row.tenantId).toBe(seededTenantId);
      expect(row.id).not.toBe(integrationB);
    }

    const foreignStatus = await client
      .post(`/api/org/integrations/${integrationB}/status`)
      .set(originHeader)
      .send({ status: "disabled" });
    expect(foreignStatus.status).toBe(404);

    const foreignOutlet = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ outletId: outletB, provider: "doit", config: {} });
    expect(foreignOutlet.status).toBe(404);

    const untouched = await owner.query<{ status: string }>(
      "SELECT status FROM tenant_integrations WHERE id = $1",
      [integrationB],
    );
    expect(untouched.rows[0]?.status).toBe("draft");
    const leaked = await owner.query(
      "SELECT 1 FROM tenant_integrations WHERE outlet_id = $1",
      [outletB],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it("PAY-06 denies callers without org.integration.manage", async () => {
    expect((await agent(app).get("/api/org/integrations")).status).toBe(401);

    // Finance reaches the back office but holds no org.* permission.
    const { client } = await tenantMember("finance");
    expect((await client.get("/api/org/integrations")).status).toBe(403);
    const put = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ outletId: null, provider: "doit", config: {} });
    expect(put.status).toBe(403);
    expect((await client.get("/api/org/usage")).status).toBe(403);
  });
});

describe("Quota & cost usage (TEN-06)", () => {
  it("TEN-06 the tenant admin reads its usage computed server-side from panel limits", async () => {
    const { client } = await tenantMember("tenant_admin");
    const response = await client.get("/api/org/usage");
    expect(response.status).toBe(200);
    const view = tenantUsageViewSchema.parse(response.body.data);
    expect(view.usage.outlets).toBeGreaterThan(0);
    expect(view.usage.activeEmployees).toBeGreaterThan(0);
    expect(view.quotas.map((quota) => quota.quota)).toEqual([
      "outlets",
      "active_employees",
      "devices",
      "ai_requests",
    ]);
    expect(view.costCaps.map((cap) => cap.cap)).toEqual([
      "whatsapp",
      "ai",
      "email",
    ]);
  });

  it("TEN-06 Super Admin reads any tenant's usage; non-platform callers are refused", async () => {
    const admin = await platformAdmin();
    const response = await admin.get(`/api/platform/tenants/${tenantB}/usage`);
    expect(response.status).toBe(200);
    const view = tenantUsageViewSchema.parse(response.body.data);
    expect(view.usage.outlets).toBe(1);
    // A zero WhatsApp cap means the feature is off (PRD §2): stopped.
    expect(view.costCaps.find((cap) => cap.cap === "whatsapp")?.state).toBe(
      "stopped",
    );

    expect(
      (await admin.get(`/api/platform/tenants/${randomUUID()}/usage`)).status,
    ).toBe(404);
    expect(
      (await admin.get("/api/platform/tenants/not-a-uuid/usage")).status,
    ).toBe(422);

    expect(
      (await agent(app).get(`/api/platform/tenants/${tenantB}/usage`)).status,
    ).toBe(401);
    // A tenant admin is not a platform admin.
    const { client } = await tenantMember("tenant_admin");
    expect(
      (await client.get(`/api/platform/tenants/${tenantB}/usage`)).status,
    ).toBe(403);
  });
});
