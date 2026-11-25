// Gateway credentials, secret rotation and "test connection" (sub-302 Slice E,
// D15-D17; PAY-06). Real Express app, Better Auth and PostgreSQL. The Duitku
// adapter itself is a double registered in the payment gateway registry: this
// suite covers the integrations store and the admin endpoint, not the wire.
import { Writable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import { createLogger } from "../lib/logger.ts";
import { openSecret } from "../lib/secrets.ts";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  unconfiguredPaymentGateway,
  type GatewayMethodAvailability,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const GRACE_MS = 72 * 3_600_000;
// Slice B owns the reader; this suite only needs the grace window (and the
// enabled flag Slice A's selector imports from the same module).
vi.mock("../services/platform-payment-gateway.service.ts", () => ({
  gatewaySecretGraceMs: async () => 72 * 3_600_000,
  isPlatformGatewayEnabled: async () => true,
}));

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
const OWNED_PROVIDERS = ["duitku", "doit", "gofood"];
const createdRoleIds: string[] = [];
let originalProviders: unknown;

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

async function tenantMember(template: string, expressApp = app) {
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

async function outletScopedManager(outletId: string) {
  const client = agent(app);
  const email = await signUp(client, "Uji outlet integrasi");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const role = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, false, $3::jsonb, '["outlet"]'::jsonb) RETURNING id`,
    [
      seededTenantId,
      `Outlet integrasi ${randomBytes(4).toString("hex")}`,
      JSON.stringify(["org.integration.manage"]),
    ],
  );
  createdRoleIds.push(role.rows[0]!.id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [seededTenantId, userId, role.rows[0]!.id, outletId],
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

const duitkuConfig = {
  environment: "sandbox",
  notificationEmail: "kas@cafe.test",
  vaName: "Cafe Legend",
};
function secrets() {
  return {
    merchantCode: `D${randomBytes(4).toString("hex").toUpperCase()}`,
    apiKey: `dk-${randomBytes(16).toString("hex")}`,
  };
}
function duitkuBody(credentials?: Record<string, string>, outletId = null) {
  return {
    outletId,
    provider: "duitku",
    config: duitkuConfig,
    ...(credentials ? { credentials } : {}),
  };
}

async function storedBlob(integrationId: string) {
  const { rows } = await owner.query<{
    credentials_encrypted: string;
    credential_fields: string[];
  }>(
    "SELECT credentials_encrypted, credential_fields FROM tenant_integrations WHERE id = $1",
    [integrationId],
  );
  const row = rows[0]!;
  return {
    sealed: row.credentials_encrypted,
    fields: row.credential_fields,
    plain: JSON.parse(
      openSecret(
        row.credentials_encrypted,
        `tenant_integration:${seededTenantId}:${integrationId}`,
      ),
    ) as Record<string, string>,
  };
}

async function auditRows(integrationId: string, action: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3
      ORDER BY id`,
    [seededTenantId, integrationId, action],
  );
  // The writer stores the masked snapshots under `maskedChanges`.
  return rows.map((row) => ({
    ...row.event,
    after: (row.event.maskedChanges as { after: unknown }).after,
  }));
}

const methods: readonly GatewayMethodAvailability[] = [
  { method: "qris", enabled: true, channels: [] },
  {
    method: "va",
    enabled: true,
    channels: [
      { code: "BC", name: "BCA VA" },
      { code: "M2", name: "Mandiri VA" },
    ] as unknown as GatewayMethodAvailability["channels"],
  },
  { method: "card", enabled: false, channels: [] },
];

let testConnection: NonNullable<PaymentGatewayPort["testConnection"]>;
const testConnectionCalls: string[] = [];
function duitkuDouble(): PaymentGatewayPort {
  return {
    ...unconfiguredPaymentGateway,
    provider: "duitku",
    testConnection: (context, integrationId) => {
      testConnectionCalls.push(integrationId);
      return testConnection(context, integrationId);
    },
  };
}

beforeAll(async () => {
  const flags = await owner.query<{ providers: unknown }>(
    "SELECT feature_flags->'integrationProviders' AS providers FROM tenants WHERE id = $1",
    [seededTenantId],
  );
  originalProviders = flags.rows[0]?.providers;
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
              (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
      WHERE id = $1
        AND NOT (feature_flags->'integrationProviders') ? 'duitku'`,
    [seededTenantId],
  );
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = ANY($2)",
    [seededTenantId, OWNED_PROVIDERS],
  );
});

beforeEach(() => {
  testConnectionCalls.length = 0;
  testConnection = async () => ({ ok: true, methods });
  resetPaymentGateways();
  registerPaymentGateway(duitkuDouble());
});

afterAll(async () => {
  resetPaymentGateways();
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = ANY($2)",
    [seededTenantId, OWNED_PROVIDERS],
  );
  await owner.query(
    "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1",
    [seededTenantId, JSON.stringify(originalProviders)],
  );
  for (const id of createdRoleIds) {
    await owner.query("DELETE FROM role_assignments WHERE role_id = $1", [id]);
    await owner.query("DELETE FROM roles WHERE id = $1", [id]);
  }
  await owner.end();
});

async function resetDuitkuRows() {
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
    [seededTenantId],
  );
}

describe("Duitku credential spec (D15)", () => {
  beforeEach(resetDuitkuRows);

  it("PAY-06 stores merchantCode + apiKey as sealed credentials and lists only their names", async () => {
    const { client } = await tenantMember("tenant_admin");
    const creds = secrets();
    const response = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(creds));
    expect(response.status).toBe(200);
    expect(response.body.data.provider).toBe("duitku");
    expect(response.body.data.config).toEqual(duitkuConfig);
    expect(response.body.data.credentials.fields).toEqual([
      "apiKey",
      "merchantCode",
    ]);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(creds.apiKey);
    expect(text).not.toContain(creds.merchantCode);
    const blob = await storedBlob(response.body.data.id);
    expect(blob.plain).toEqual(creds);
    expect(blob.fields).toEqual(["apiKey", "merchantCode"]);
  });

  it("PAY-06 refuses a duitku body with a missing or invalid field, naming fields only", async () => {
    const { client } = await tenantMember("tenant_admin");
    const creds = secrets();
    const put = (body: unknown) =>
      client
        .put("/api/org/integrations")
        .set(originHeader)
        .send(body as object);
    const noEnvironment: Record<string, string> = { ...duitkuConfig };
    delete noEnvironment.environment;
    const noEmail: Record<string, string> = { ...duitkuConfig };
    delete noEmail.notificationEmail;
    const cases: { body: unknown; field: string }[] = [
      {
        body: { ...duitkuBody(creds), config: noEnvironment },
        field: "environment",
      },
      {
        body: {
          ...duitkuBody(creds),
          config: { ...duitkuConfig, environment: "live" },
        },
        field: "environment",
      },
      {
        body: { ...duitkuBody(creds), config: noEmail },
        field: "notificationEmail",
      },
      {
        body: {
          ...duitkuBody(creds),
          config: { ...duitkuConfig, notificationEmail: "not-an-email" },
        },
        field: "notificationEmail",
      },
      {
        body: {
          ...duitkuBody(creds),
          config: { ...duitkuConfig, vaName: "x".repeat(21) },
        },
        field: "vaName",
      },
      {
        body: duitkuBody({ merchantCode: creds.merchantCode }),
        field: "apiKey",
      },
      {
        body: duitkuBody({ apiKey: creds.apiKey }),
        field: "merchantCode",
      },
      {
        body: duitkuBody({ ...creds, secretKey: "extra-secret-value-1234" }),
        field: "secretKey",
      },
      {
        body: duitkuBody({ ...creds, previousApiKey: "forged-previous-key-1" }),
        field: "previousApiKey",
      },
      {
        body: duitkuBody({
          ...creds,
          previousValidUntil: "2999-01-01T00:00:00Z",
        }),
        field: "previousValidUntil",
      },
    ];
    for (const { body, field } of cases) {
      const response = await put(body);
      expect(response.status, field).toBe(422);
      expect(response.body.error.code, field).toBe("VALIDATION_ERROR");
      expect(response.body.error.message, field).toContain(field);
      const text = JSON.stringify(response.body);
      for (const value of [
        creds.apiKey,
        creds.merchantCode,
        "extra-secret-value-1234",
        "forged-previous-key-1",
        "not-an-email",
      ])
        expect(text, field).not.toContain(value);
    }
    const rows = await owner.query(
      "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
      [seededTenantId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("PAY-06 a config-only update keeps stored credentials but still validates the config", async () => {
    const { client } = await tenantMember("tenant_admin");
    const creds = secrets();
    const first = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(creds));
    const production = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        ...duitkuBody(),
        config: { ...duitkuConfig, environment: "production" },
      });
    expect(production.status).toBe(200);
    expect(production.body.data.config.environment).toBe("production");
    expect(production.body.data.credentials.secretRef).toBe(
      first.body.data.credentials.secretRef,
    );
    const broken = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ ...duitkuBody(), config: { vaName: "Cafe" } });
    expect(broken.status).toBe(422);
  });

  it("1269 C0 refuses to save a duitku sandbox row in production, new or existing, unless staging allows it", async () => {
    const { client } = await tenantMember("tenant_admin");
    const saved = {
      isProduction: env.isProduction,
      allowSandbox: env.DUITKU_ALLOW_SANDBOX,
    };
    const put = (environment: string, credentials?: Record<string, string>) =>
      client
        .put("/api/org/integrations")
        .set(originHeader)
        .send({
          ...duitkuBody(credentials),
          config: { ...duitkuConfig, environment },
        });
    const storedEnvironments = async () => {
      const { rows } = await owner.query<{ environment: string }>(
        "SELECT config->>'environment' AS environment FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
        [seededTenantId],
      );
      return rows.map((row) => row.environment);
    };
    const expectRefused = (response: {
      status: number;
      body: { error: { code: string; message: string } };
    }) => {
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("environment");
    };
    const creds = secrets();
    try {
      env.isProduction = true;
      env.DUITKU_ALLOW_SANDBOX = false;
      const refused = await put("sandbox", creds);
      expectRefused(refused);
      expect(JSON.stringify(refused.body)).not.toContain(creds.apiKey);
      expect(await storedEnvironments()).toEqual([]);

      expect((await put("production", creds)).status).toBe(200);
      expectRefused(await put("sandbox"));
      expect(await storedEnvironments()).toEqual(["production"]);

      env.DUITKU_ALLOW_SANDBOX = true;
      expect((await put("sandbox")).status).toBe(200);
      expect(await storedEnvironments()).toEqual(["sandbox"]);
    } finally {
      env.isProduction = saved.isProduction;
      env.DUITKU_ALLOW_SANDBOX = saved.allowSandbox;
    }
  });
});

describe("Secret rotation keeps one previous generation (D17)", () => {
  beforeEach(resetDuitkuRows);

  it("PAY-06 replacing the duitku apiKey seals previous key + merchant code with a grace window and audits it", async () => {
    const { lines, logger } = captureLogs();
    const loggedApp = createApp({ logger });
    const { client } = await tenantMember("tenant_admin", loggedApp);
    const first = secrets();
    const created = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(first));
    const id = created.body.data.id as string;
    // First write has nothing to rotate away from.
    expect((await storedBlob(id)).plain).toEqual(first);
    expect(await auditRows(id, "integration.credentials_rotated")).toHaveLength(
      0,
    );

    const second = { ...secrets(), merchantCode: first.merchantCode };
    const before = Date.now();
    const rotated = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(second));
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.credentials.fields).toEqual([
      "apiKey",
      "merchantCode",
    ]);
    const blob = await storedBlob(id);
    expect(blob.fields).toEqual(["apiKey", "merchantCode"]);
    expect(blob.plain).toMatchObject({
      apiKey: second.apiKey,
      merchantCode: second.merchantCode,
      previousApiKey: first.apiKey,
      previousMerchantCode: first.merchantCode,
    });
    const validUntil = Date.parse(blob.plain.previousValidUntil!);
    expect(validUntil).toBeGreaterThanOrEqual(before + GRACE_MS - 1_000);
    expect(validUntil).toBeLessThanOrEqual(Date.now() + GRACE_MS + 1_000);

    const audit = await auditRows(id, "integration.credentials_rotated");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      after: {
        provider: "duitku",
        previousValidUntil: new Date(validUntil).toISOString(),
      },
    });

    // Only one previous generation: a third key pushes the second one in.
    const third = { ...secrets(), merchantCode: first.merchantCode };
    await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(third));
    const next = (await storedBlob(id)).plain;
    expect(next.previousApiKey).toBe(second.apiKey);
    expect(Object.values(next)).not.toContain(first.apiKey);

    // The same body again changes nothing (idempotent PUT despite previous*).
    const sealedBefore = (await storedBlob(id)).sealed;
    const again = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(third));
    expect(again.status).toBe(200);
    expect((await storedBlob(id)).sealed).toBe(sealedBefore);
    expect(await auditRows(id, "integration.credentials_rotated")).toHaveLength(
      2,
    );

    // Nothing leaks: responses, audit trail and logs.
    const everything = JSON.stringify([
      created.body,
      rotated.body,
      await auditRows(id, "integration.credentials_rotated"),
      await auditRows(id, "integration.credentials.replaced"),
      lines,
    ]);
    for (const value of [
      first.apiKey,
      second.apiKey,
      third.apiKey,
      first.merchantCode,
    ])
      expect(everything).not.toContain(value);
  });

  it("PAY-06 a changed merchantCode alone also rotates, and a config-only change keeps the previous pair", async () => {
    const { client } = await tenantMember("tenant_admin");
    const first = secrets();
    const created = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(first));
    const id = created.body.data.id as string;
    const moved = { ...first, merchantCode: "DNEWCODE1" };
    await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(moved));
    const afterMove = (await storedBlob(id)).plain;
    expect(afterMove.previousMerchantCode).toBe(first.merchantCode);
    expect(afterMove.previousApiKey).toBe(first.apiKey);

    await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ ...duitkuBody(), config: { ...duitkuConfig, vaName: "Baru" } });
    const afterConfig = (await storedBlob(id)).plain;
    expect(afterConfig).toEqual(afterMove);
  });

  it("PAY-06 replacing the doit webhookSecret seals previousWebhookSecret", async () => {
    const { client } = await tenantMember("tenant_admin");
    const body = (webhookSecret: string) => ({
      outletId: null,
      provider: "doit",
      config: {},
      credentials: { apiKey: "doit-key-0000000001", webhookSecret },
    });
    const first = `whsec-${randomBytes(8).toString("hex")}`;
    const second = `whsec-${randomBytes(8).toString("hex")}`;
    const created = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(body(first));
    const id = created.body.data.id as string;
    await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(body(second));
    const blob = await storedBlob(id);
    expect(blob.fields).toEqual(["apiKey", "webhookSecret"]);
    expect(blob.plain).toMatchObject({
      webhookSecret: second,
      previousWebhookSecret: first,
    });
    expect(Date.parse(blob.plain.previousValidUntil!)).toBeGreaterThan(
      Date.now() + GRACE_MS - 5_000,
    );
    const audit = await auditRows(id, "integration.credentials_rotated");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ after: { provider: "doit" } });
    expect(JSON.stringify(audit)).not.toContain(first);

    // A non-gateway provider never gets previous* keys.
    const gofood = {
      outletId: null,
      provider: "gofood",
      config: {},
    };
    const g1 = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ ...gofood, credentials: { clientKey: "gf-key-000000001" } });
    await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({ ...gofood, credentials: { clientKey: "gf-key-000000002" } });
    expect(Object.keys((await storedBlob(g1.body.data.id)).plain)).toEqual([
      "clientKey",
    ]);
  });
});

describe("Test connection (D16)", () => {
  beforeEach(resetDuitkuRows);

  async function draftDuitku(
    client: ReturnType<typeof agent>,
    outletId = null,
  ) {
    const creds = secrets();
    const response = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send(duitkuBody(creds, outletId));
    expect(response.status).toBe(200);
    return { id: response.body.data.id as string, creds };
  }

  it("PAY-06 a draft row tests ok: response shape, last_checked_at, audit, no secret anywhere", async () => {
    const { lines, logger } = captureLogs();
    const loggedApp = createApp({ logger });
    const { client } = await tenantMember("tenant_admin", loggedApp);
    const { id, creds } = await draftDuitku(client);

    const response = await client
      .post(`/api/org/integrations/${id}/test`)
      .set(originHeader);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      ok: true,
      checkedAt: expect.any(String),
      errorCode: null,
      methods: [
        { method: "qris", enabled: true, channelCount: 0 },
        { method: "va", enabled: true, channelCount: 2 },
        { method: "card", enabled: false, channelCount: 0 },
      ],
    });
    expect(testConnectionCalls).toEqual([id]);
    const row = await owner.query<{
      status: string;
      last_checked_at: Date;
      last_error_code: string | null;
    }>(
      "SELECT status, last_checked_at, last_error_code FROM tenant_integrations WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.status).toBe("draft");
    expect(row.rows[0]?.last_error_code).toBeNull();
    expect(row.rows[0]?.last_checked_at.toISOString()).toBe(
      response.body.data.checkedAt,
    );
    const audit = await auditRows(id, "integration.connection_tested");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ after: { ok: true, errorCode: null } });

    const listed = await client.get("/api/org/integrations");
    const listedRow = (
      listed.body.data as { id: string; lastCheckedAt: string }[]
    ).find((item) => item.id === id);
    expect(listedRow?.lastCheckedAt).toBe(response.body.data.checkedAt);

    const everything = JSON.stringify([
      response.body,
      listed.body,
      audit,
      lines,
    ]);
    expect(everything).not.toContain(creds.apiKey);
    expect(everything).not.toContain(creds.merchantCode);
  });

  it("PAY-06 a failed check answers 200 with the error code and stores it", async () => {
    const { client } = await tenantMember("tenant_admin");
    const { id } = await draftDuitku(client);
    testConnection = async () => ({ ok: false, code: "GATEWAY_AUTH_FAILED" });
    const failed = await client
      .post(`/api/org/integrations/${id}/test`)
      .set(originHeader);
    expect(failed.status).toBe(200);
    expect(failed.body.data).toMatchObject({
      ok: false,
      errorCode: "GATEWAY_AUTH_FAILED",
      methods: [],
    });
    const row = await owner.query<{ last_error_code: string | null }>(
      "SELECT last_error_code FROM tenant_integrations WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.last_error_code).toBe("GATEWAY_AUTH_FAILED");
    const audit = await auditRows(id, "integration.connection_tested");
    expect(audit[0]).toMatchObject({
      after: { ok: false, errorCode: "GATEWAY_AUTH_FAILED" },
    });

    // A later success clears the stored code.
    testConnection = async () => ({ ok: true, methods });
    await client.post(`/api/org/integrations/${id}/test`).set(originHeader);
    const cleared = await owner.query<{ last_error_code: string | null }>(
      "SELECT last_error_code FROM tenant_integrations WHERE id = $1",
      [id],
    );
    expect(cleared.rows[0]?.last_error_code).toBeNull();
  });

  it("PAY-06 an adapter that throws reads as GATEWAY_UNREACHABLE and leaks nothing", async () => {
    const { lines, logger } = captureLogs();
    const loggedApp = createApp({ logger });
    const { client } = await tenantMember("tenant_admin", loggedApp);
    const { id, creds } = await draftDuitku(client);
    testConnection = async () => {
      throw new Error(`boom apiKey=${creds.apiKey} sig=deadbeef raw={"x":1}`);
    };
    const response = await client
      .post(`/api/org/integrations/${id}/test`)
      .set(originHeader);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      ok: false,
      errorCode: "GATEWAY_UNREACHABLE",
    });
    const everything = JSON.stringify([
      response.body,
      await auditRows(id, "integration.connection_tested"),
      lines,
    ]);
    expect(everything).not.toContain(creds.apiKey);
    expect(everything).not.toContain("deadbeef");
  });

  it("PAY-06 NOT_SUPPORTED for a non-gateway provider and for an adapter without testConnection", async () => {
    const { client } = await tenantMember("tenant_admin");
    const gofood = await client
      .put("/api/org/integrations")
      .set(originHeader)
      .send({
        outletId: null,
        provider: "gofood",
        config: {},
        credentials: { clientKey: "gf-key-000000001" },
      });
    const refused = await client
      .post(`/api/org/integrations/${gofood.body.data.id}/test`)
      .set(originHeader);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("NOT_SUPPORTED");

    const { id } = await draftDuitku(client);
    resetPaymentGateways();
    registerPaymentGateway({
      ...unconfiguredPaymentGateway,
      provider: "duitku",
    });
    const noMethod = await client
      .post(`/api/org/integrations/${id}/test`)
      .set(originHeader);
    expect(noMethod.status).toBe(422);
    expect(noMethod.body.error.code).toBe("NOT_SUPPORTED");
    expect(testConnectionCalls).toEqual([]);
    const row = await owner.query<{ last_checked_at: Date | null }>(
      "SELECT last_checked_at FROM tenant_integrations WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.last_checked_at).toBeNull();
  });

  it("PAY-06 an unknown id is 404 and finance (no org.integration.manage) is 403", async () => {
    const { client } = await tenantMember("tenant_admin");
    const missing = await client
      .post(`/api/org/integrations/${randomUUID()}/test`)
      .set(originHeader);
    expect(missing.status).toBe(404);
    const { id } = await draftDuitku(client);
    const finance = (await tenantMember("finance")).client;
    const denied = await finance
      .post(`/api/org/integrations/${id}/test`)
      .set(originHeader);
    expect(denied.status).toBe(403);
    expect(
      await agent(app)
        .post(`/api/org/integrations/${id}/test`)
        .set(originHeader),
    ).toHaveProperty("status", 401);
    expect(testConnectionCalls).toEqual([]);
  });

  it("PAY-06 an outlet-scoped caller is refused at the route and never reaches an adapter", async () => {
    const outletId = await seededOutletId();
    const { client: admin } = await tenantMember("tenant_admin");
    const tenantRow = await draftDuitku(admin);
    const outletRow = await draftDuitku(admin, outletId as never);
    const scoped = await outletScopedManager(outletId);

    // org.* permissions are tenant-level: an outlet assignment is not enough.
    for (const id of [tenantRow.id, outletRow.id]) {
      const denied = await scoped
        .post(`/api/org/integrations/${id}/test`)
        .set(originHeader);
      expect(denied.status).toBe(403);
    }
    expect(testConnectionCalls).toEqual([]);
    const untouched = await owner.query(
      "SELECT 1 FROM tenant_integrations WHERE id = ANY($1) AND last_checked_at IS NOT NULL",
      [[tenantRow.id, outletRow.id]],
    );
    expect(untouched.rowCount).toBe(0);
  });
});
