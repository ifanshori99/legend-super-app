// legend-65i3t: the profit-share statement email provider raises the same
// throttled Brevo auth-failure ops alert as the notification worker does
// (legend-j75w). A Brevo 401/403 (bad API key or sender) writes ONE
// `notification_provider.email_auth_failed` notification_outbox row for the
// tenant, and the provider still throws the Brevo error. A 500 raises nothing.
//
// Written from the brief (card 3) and modelled on brevo-auth-failure-alert.test.ts.
// Assumptions:
//   - createStatementEmailProvider(env, options?: { database?: Database,
//     fetch?: FetchLike }) is the injection seam: the test passes its own
//     database (app-role pool) and a mock fetch. Without `database` the shared
//     db from db/index.ts is used; the old one-argument call stays valid.
//   - It returns null for an unusable env, so the tests assert non-null first.
//   - The wiring is the same as the worker: onAuthFailure runs
//     notifyBrevoAuthFailed inside withTenant, and a failing alert never
//     replaces the Brevo error.
//   - An "alert sent" is a notification_outbox row of event_type
//     `notification_provider.email_auth_failed` for the tenant. Each fixture
//     tenant has one owner with a push subscription so an outbox row is made.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { emailRequestSchema } from "@starter/shared/adapters";
import * as schema from "../db/schema/index.ts";
import { createStatementEmailProvider } from "../services/profit-share-statement-ports.ts";

const EVENT_TYPE = "notification_provider.email_auth_failed";

const BREVO_ENV = {
  NOTIFICATION_EMAIL_PROVIDER: "brevo",
  BREVO_API_KEY: "xkeysib-test-secret-value",
  NOTIFICATION_EMAIL_FROM: "noreply@example.test",
};

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });

const contextOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

type Fixture = { tenantId: string; userId: string; roleId: string };
let created: Fixture[] = [];

async function seedTenant(): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Statement email alert tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `stmt-email-alert-${tenantId}`, userId],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`,
    [userId, `${userId}@example.test`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Owner', true, 'owner', '[]'::jsonb, '["tenant"]'::jsonb)`,
    [roleId, tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, assigned_by, valid_from)
     VALUES ($1, $2, $3, 'tenant', $2, now() - interval '1 hour')`,
    [tenantId, userId, roleId],
  );
  await owner.query(
    `INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version)
     VALUES ($1, $2, $3, $4, 'encrypted', 'v1')`,
    [tenantId, randomUUID(), userId, `stmt-email-${randomUUID()}`],
  );
  const fixture = { tenantId, userId, roleId };
  created.push(fixture);
  return fixture;
}

async function dropTenant({ tenantId, userId, roleId }: Fixture) {
  for (const table of [
    "notification_outbox",
    "whatsapp_reservations",
    "delivery_attempts",
    "notifications",
    "push_subscriptions",
    "role_assignments",
  ])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  await owner.query("DELETE FROM roles WHERE id = $1", [roleId]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await owner.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
}

async function alertCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id = $1 AND event_type = $2",
    [tenantId, EVENT_TYPE],
  );
  return rows[0]!.n;
}

function respondingWith(status: number) {
  return (async () =>
    new Response(JSON.stringify({ message: "Key not found" }), {
      status,
    })) as typeof globalThis.fetch;
}

function statementProvider(fetch: typeof globalThis.fetch) {
  const provider = createStatementEmailProvider(BREVO_ENV, {
    database,
    fetch,
  });
  expect(provider).not.toBeNull();
  return provider!;
}

const emailFor = (tenantId: string) =>
  emailRequestSchema.parse({
    tenantId,
    outletId: null,
    reference: `statement-${randomUUID()}`,
    to: "mitra@example.test",
    subject: "Laporan bagi hasil",
    body: "Isi laporan",
  });

async function send(tenantId: string, fetch: typeof globalThis.fetch) {
  return statementProvider(fetch)
    .send(contextOf(tenantId), emailFor(tenantId))
    .then(
      () => null,
      (caught: unknown) => caught,
    );
}

beforeEach(() => {
  created = [];
});

afterEach(async () => {
  for (const fixture of created) await dropTenant(fixture);
});

describe("legend-65i3t statement email brevo auth failure alert", () => {
  it("legend-65i3t a 401 raises exactly one alert and the send still throws", async () => {
    const a = await seedTenant();
    expect(await alertCount(a.tenantId)).toBe(0);
    const error = await send(a.tenantId, respondingWith(401));
    expect(error).toBeInstanceOf(Error);
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-65i3t a 403 (bad sender) raises the alert too and still throws", async () => {
    const a = await seedTenant();
    const error = await send(a.tenantId, respondingWith(403));
    expect(error).toBeInstanceOf(Error);
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-65i3t a repeat failure inside 15 minutes sends no new alert", async () => {
    const a = await seedTenant();
    await send(a.tenantId, respondingWith(401));
    await send(a.tenantId, respondingWith(403));
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-65i3t the alert lands on the failing tenant only", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await send(a.tenantId, respondingWith(401));
    expect(await alertCount(a.tenantId)).toBe(1);
    expect(await alertCount(b.tenantId)).toBe(0);
  });

  it("legend-65i3t a 500 raises no alert and still throws", async () => {
    const a = await seedTenant();
    const error = await send(a.tenantId, respondingWith(500));
    expect(error).toBeInstanceOf(Error);
    expect(await alertCount(a.tenantId)).toBe(0);
  });

  it("legend-65i3t a successful send raises no alert", async () => {
    const a = await seedTenant();
    const ok = (async () =>
      new Response(JSON.stringify({ messageId: "<m1@example.test>" }), {
        status: 201,
      })) as typeof globalThis.fetch;
    await statementProvider(ok).send(contextOf(a.tenantId), emailFor(a.tenantId));
    expect(await alertCount(a.tenantId)).toBe(0);
  });

  it("legend-65i3t the Brevo error is thrown even when the alert itself fails", async () => {
    const a = await seedTenant();
    // Break the alert path: the app role cannot write the outbox when the
    // injected database is closed. A closed pool makes withTenant reject.
    const brokenPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
    });
    const brokenDatabase = drizzle(brokenPool, { schema });
    await brokenPool.end();
    const provider = createStatementEmailProvider(BREVO_ENV, {
      database: brokenDatabase,
      fetch: respondingWith(401),
    });
    expect(provider).not.toBeNull();
    const error = await provider!
      .send(contextOf(a.tenantId), emailFor(a.tenantId))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    // The Brevo failure surfaces, not the alert channel's own pool error.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/pool|closed|ended/i);
    expect(await alertCount(a.tenantId)).toBe(0);
  });
});
