// legend-j75w: a Brevo 401/403 (bad API key or sender) raises ONE throttled ops
// alert per tenant per 15 minutes, and the provider still throws so the
// delivery is retried and visible.
//
// Written from the brief (docs/briefs/payment-hardening.md, card 3), modelled
// on the edge-sync-conflict alert tests. Contract assumed:
//   - createBrevoEmailProvider({ ..., onAuthFailure(context, { outletId, status }) })
//     calls onAuthFailure on 401/403 before throwing; the production wiring
//     runs services/edge-sync-conflict-alert.ts notifyBrevoAuthFailed inside
//     withTenant.
//   - An "alert sent" is a notification_outbox row of event_type
//     `notification_provider.email_auth_failed` for the tenant (the throttle
//     counts these rows; no new table).
//   - Alerts reach the tenant owners. Each fixture tenant has one owner with a
//     push subscription so an outbox row is produced.
// Assumption: the 15-minute window is aged by backdating the alert rows'
// created_at as the migration owner (the throttle reads the database clock).
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
import { withTenant } from "../db/tenant.ts";
import { notifyBrevoAuthFailed } from "../services/edge-sync-conflict-alert.ts";
import { createBrevoEmailProvider } from "../worker/notification-adapters.ts";

const EVENT_TYPE = "notification_provider.email_auth_failed";

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
     VALUES ($1, $2, 'Brevo alert tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `brevo-alert-${tenantId}`, userId],
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
    [tenantId, randomUUID(), userId, `brevo-${randomUUID()}`],
  );
  const fixture = { tenantId, userId, roleId };
  created.push(fixture);
  return fixture;
}

async function dropTenant({ tenantId, userId, roleId }: Fixture) {
  for (const table of [
    "notification_outbox",
    // delivery_attempts (and whatsapp_reservations on top of it) reference
    // notifications by (tenant_id, id), so they go first.
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

/** Moves the tenant's alerts past the 15 minute window. */
async function ageAlerts(tenantId: string, minutes: number) {
  await owner.query(
    `UPDATE notification_outbox SET created_at = now() - make_interval(mins => $3)
      WHERE tenant_id = $1 AND event_type = $2`,
    [tenantId, EVENT_TYPE, minutes],
  );
}

function brevoRespondingWith(status: number) {
  const fetch = (async () =>
    new Response(JSON.stringify({ message: "Key not found" }), {
      status,
    })) as typeof globalThis.fetch;
  // Same wiring as production: the failure hook runs the throttled alert in
  // the tenant's transaction.
  return createBrevoEmailProvider({
    apiKey: "xkeysib-test-secret-value",
    from: "noreply@example.test",
    fromName: "Legend",
    fetch,
    onAuthFailure: (context, failure) =>
      withTenant(database, context, (tx) =>
        notifyBrevoAuthFailed(tx, context, {
          tenantId: context.tenant.tenantId,
          outletId: null,
          status: failure.status,
        }),
      ),
  });
}

const emailFor = (tenantId: string) =>
  emailRequestSchema.parse({
    tenantId,
    outletId: null,
    reference: `attempt-${randomUUID()}`,
    to: "staf@example.test",
    subject: "Judul",
    body: "Isi pesan",
  });

async function sendFails(tenantId: string, status = 401) {
  await expect(
    brevoRespondingWith(status).send(contextOf(tenantId), emailFor(tenantId)),
  ).rejects.toThrow();
}

beforeEach(() => {
  created = [];
});

afterEach(async () => {
  for (const fixture of created) await dropTenant(fixture);
});

describe("legend-j75w brevo auth failure alert", () => {
  it("legend-j75w the first 401 raises exactly one alert and still throws", async () => {
    const a = await seedTenant();
    expect(await alertCount(a.tenantId)).toBe(0);
    await sendFails(a.tenantId, 401);
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-j75w a 403 (bad sender) raises the alert too", async () => {
    const a = await seedTenant();
    await sendFails(a.tenantId, 403);
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-j75w a second failure inside 15 minutes for the same tenant sends no new alert, error still thrown", async () => {
    const a = await seedTenant();
    await sendFails(a.tenantId);
    expect(await alertCount(a.tenantId)).toBe(1);
    await sendFails(a.tenantId);
    await sendFails(a.tenantId, 403);
    expect(await alertCount(a.tenantId)).toBe(1);
  });

  it("legend-j75w another tenant is throttled on its own and still gets its alert", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await sendFails(a.tenantId);
    await sendFails(b.tenantId);
    expect(await alertCount(a.tenantId)).toBe(1);
    expect(await alertCount(b.tenantId)).toBe(1);
    await sendFails(b.tenantId);
    expect(await alertCount(a.tenantId)).toBe(1);
    expect(await alertCount(b.tenantId)).toBe(1);
  });

  it("legend-j75w after more than 15 minutes the next failure alerts again", async () => {
    const a = await seedTenant();
    await sendFails(a.tenantId);
    // Still inside the window (14 minutes old): no new alert.
    await ageAlerts(a.tenantId, 14);
    await sendFails(a.tenantId);
    expect(await alertCount(a.tenantId)).toBe(1);
    // Past the window: alerts again.
    await ageAlerts(a.tenantId, 16);
    await sendFails(a.tenantId);
    expect(await alertCount(a.tenantId)).toBe(2);
  });

  it("legend-j75w a failure that is not an auth error (500) raises no alert and still throws", async () => {
    const a = await seedTenant();
    await sendFails(a.tenantId, 500);
    expect(await alertCount(a.tenantId)).toBe(0);
  });

  it("legend-j75w the Brevo error is thrown even when the alert itself fails", async () => {
    const a = await seedTenant();
    const fetch = (async () =>
      new Response("{}", { status: 401 })) as typeof globalThis.fetch;
    const provider = createBrevoEmailProvider({
      apiKey: "xkeysib-test-secret-value",
      from: "noreply@example.test",
      fetch,
      onAuthFailure: async () => {
        throw new Error("alert channel down");
      },
    });
    // The Brevo failure surfaces, not the alert channel's own error.
    const error = await provider
      .send(contextOf(a.tenantId), emailFor(a.tenantId))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("alert channel down");
    expect(await alertCount(a.tenantId)).toBe(0);
  });
});
