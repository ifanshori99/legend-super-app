// legend-gchkf (brief 820): the owner lists every web push device registered
// for their own account, INCLUDING devices whose login session has already
// expired, and revokes one device at a time so a lost phone stops receiving
// panic alarms. Written from the brief and the shared notification contract
// (packages/shared/src/notification), never from the implementation.
//
// ASSUMED CONTRACT (the endpoints do not exist yet; names are my choice):
//   GET    /api/identity/push-devices        -> 200 { data: PushDevice[] }
//   DELETE /api/identity/push-devices/:id    -> 204 (no body)
//  - :id is the push subscription id (UUID, pushSubscriptionIdSchema).
//  - PushDevice carries at least { id, deviceLabel: string|null,
//    registeredAt: ISO string }. It NEVER carries the endpoint, keys,
//    ciphertext or hash (asserted on the raw JSON).
//  - Only the caller's own devices are returned (user id from the session,
//    filtered in SQL). The list is not limited to devices whose session is
//    alive: sessions that expired, or whose row was deleted (session_id NULL),
//    are still listed.
//  - A revoked device disappears from the list and the panic fan-out no longer
//    sends to its endpoint. Whether the row is deleted or deactivated is not
//    asserted (brief: "dihapus/nonaktif").
//  - Another user's id and an unknown id both answer 404 and change nothing.
//  - No session -> 401; DELETE from an untrusted Origin -> 403 (nothing
//    changes); a malformed id -> 400 or 422 (both accepted).
//  - The endpoint is account-level: tests send the tenant Host header but the
//    result must not depend on it.
//  - The fan-out is exercised through the production consumer + delivery code
//    exactly like panic-push-fanout.test.ts (fake webPushSend records endpoints).
import { createECDH, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createApp } from "../app.ts";
import { createWorkerNotificationHandlers } from "../worker/notification-adapters.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { PANIC_PERMISSION_RESPOND } from "./panic-test-helpers.ts";

const BASE = "/api/identity/push-devices";
const app = createApp();
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const HOUR = 3_600_000;
const wibDate = (ms: number) =>
  new Date(ms + 7 * HOUR).toISOString().slice(0, 10);

let tenantA: IsolatedTenant;
let outletA: string;
let adminUserId: string;
const userIds: string[] = [];
const hostA = () => ({ Host: tenantA.hostname });

type Account = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

/** A real signed-in account that is also an on-duty alarm receiver at outletA. */
async function receiver(): Promise<Account> {
  const client = agent(app);
  const email = await signUp(client, "Penerima Alarm");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, '["outlet"]'::jsonb)`,
    [
      roleId,
      tenantA.tenantId,
      `Darurat ${roleId.slice(0, 8)}`,
      JSON.stringify([PANIC_PERMISSION_RESPOND]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
    [tenantA.tenantId, userId, roleId, outletA],
  );
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Darurat', $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      employeeId,
      tenantA.tenantId,
      userId,
      `PD-${employeeId.slice(0, 8).toUpperCase()}`,
      outletA,
    ],
  );
  const now = Date.now();
  await owner.query(
    `INSERT INTO shift_assignments
       (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
        status, source, published_by, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
    [
      randomUUID(),
      tenantA.tenantId,
      outletA,
      employeeId,
      wibDate(now - HOUR),
      JSON.stringify([
        {
          startsAt: new Date(now - HOUR).toISOString(),
          endsAt: new Date(now + 7 * HOUR).toISOString(),
        },
      ]),
      adminUserId,
    ],
  );
  return { client, userId, email };
}

/** An account that only needs to be signed in (no alarm duty). */
async function plainAccount(): Promise<Account> {
  const client = agent(app);
  const email = await signUp(client, "Pengguna Lain");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  return { client, userId, email };
}

type Seeded = { id: string; endpoint: string };

/**
 * A registered browser push subscription of `userId` (v2 registration: has
 * registered_at, bound to outletA).
 *  - "live": a login session that is still valid
 *  - "expired": the session row exists but expired an hour ago
 *  - "none": the expired session row was deleted (session_id NULL)
 */
async function seedDevice(
  userId: string,
  options: {
    session?: "live" | "expired" | "none";
    label?: string | null;
    ageMs?: number;
  } = {},
): Promise<Seeded> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  const key = createECDH("prime256v1");
  key.generateKeys();
  const sealed = await createPushSubscriptionProtector().seal(
    {
      endpoint,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    },
    tenantA.tenantId,
    userId,
  );
  const kind = options.session ?? "live";
  let sessionId: string | null = null;
  if (kind !== "none") {
    sessionId = randomUUID();
    await owner.query(
      `INSERT INTO "session" (id, expires_at, token, user_id)
       VALUES ($1, now() + $2::interval, $3, $4)`,
      [
        sessionId,
        kind === "expired" ? "-1 hour" : "7 days",
        randomUUID(),
        userId,
      ],
    );
  }
  const id = randomUUID();
  const registeredAt = new Date(Date.now() - (options.ageMs ?? 0));
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_label, session_id, created_at, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      tenantA.tenantId,
      id,
      userId,
      sealed.endpointHash,
      sealed.ciphertext,
      sealed.keyVersion,
      outletA,
      options.label === undefined ? "HP petugas" : options.label,
      sessionId,
      registeredAt,
    ],
  );
  return { id, endpoint };
}

const list = (who: Account) =>
  who.client.get(BASE).set({ ...hostA(), ...originHeader });
const revoke = (who: Account, id: string, origin = originHeader.Origin) =>
  who.client.delete(`${BASE}/${id}`).set({ ...hostA(), Origin: origin });
const listedIds = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((device) => device.id);

// ---- panic fan-out harness (same production path as panic-push-fanout) ----

const contextOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const webPushEnv = {
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "web_push",
  VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: Buffer.from(
    ecdh.getPrivateKey("hex").padStart(64, "0"),
    "hex",
  ).toString("base64url"),
  VAPID_SUBJECT: "mailto:push@example.test",
};

async function raisedAlarm() {
  const alertId = randomUUID();
  const deviceId = randomUUID();
  const receivedAt = new Date().toISOString();
  await owner.query(
    `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                               unit_code_snapshot, facility_name_snapshot, device_label_snapshot, received_at)
     VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas Uji', 'Tombol Uji', $6)`,
    [
      alertId,
      tenantA.tenantId,
      outletA,
      deviceId,
      `evt-${alertId}`,
      receivedAt,
    ],
  );
  const name = "panic_alert.raised";
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId: tenantA.tenantId,
    outletId: outletA,
    name,
    aggregateType: "panic_alert",
    aggregateId: alertId,
    idempotencyKey: `${name}-${alertId}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      alertId,
      outletId: outletA,
      deviceId,
      unitId: null,
      firstDeviceEventId: `evt-${alertId}`,
      kind: "press",
      triggeredAt: null,
      receivedAt,
      unitCodeSnapshot: "P1",
      facilityNameSnapshot: "Fasilitas Uji",
      deviceLabelSnapshot: "Tombol Uji",
      linkOffline: false,
    },
  });
}

/** Raise a panic alarm, run the real consumer + delivery; return sent endpoints. */
async function ring(userId: string): Promise<string[]> {
  const context = contextOf(tenantA.tenantId);
  const event = await raisedAlarm();
  const sent: string[] = [];
  const handlers = createWorkerNotificationHandlers(database, webPushEnv, {
    fetch: globalThis.fetch,
    webPushSend: async (...args: unknown[]) => {
      sent.push((args[0] as { endpoint: string }).endpoint);
      return { statusCode: 201, headers: {}, body: "" };
    },
  });
  const consume = createNotificationConsumer(
    context,
    handlers.resolveNotificationRecipients,
  );
  await withTenant(database, context, (tx) => consume(event, event.id, tx));
  const attempts = (
    await owner.query<{ id: string }>(
      `SELECT a.id::text FROM delivery_attempts a
         JOIN notifications n ON n.id = a.notification_id AND n.tenant_id = a.tenant_id
        WHERE n.tenant_id = $1 AND n.user_id = $2 AND n.source_event_id = $3
          AND a.channel = 'web_push'`,
      [tenantA.tenantId, userId, ulidToUuid(event.id)],
    )
  ).rows;
  for (const attempt of attempts)
    await deliverNotificationAttempt(
      database,
      context,
      uuidToUlid(attempt.id),
      handlers.notificationDelivery,
    );
  return sent;
}

async function purge(tenantId: string) {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`,
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  tenantA = await createIsolatedTenant(`pd-a-${randomUUID().slice(0, 6)}`);
  outletA = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet perangkat', 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      outletA,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      `PD-${outletA.slice(0, 8)}`.toUpperCase(),
    ],
  );
  adminUserId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Admin perangkat', $2)`,
    [adminUserId, `${adminUserId}@example.test`],
  );
  userIds.push(adminUserId);
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
  await appPool.end();
});

describe("legend-gchkf GET /api/identity/push-devices", () => {
  it("lists the owner's devices including ones whose login session expired or was deleted", async () => {
    const me = await plainAccount();
    const live = await seedDevice(me.userId, {
      session: "live",
      label: "HP aktif",
    });
    const expired = await seedDevice(me.userId, {
      session: "expired",
      label: "HP hilang",
    });
    const orphan = await seedDevice(me.userId, {
      session: "none",
      label: "HP tanpa sesi",
    });

    const response = await list(me);
    expect(response.status).toBe(200);
    expect(new Set(listedIds(response))).toEqual(
      new Set([live.id, expired.id, orphan.id]),
    );
    const byId = new Map(
      (
        response.body.data as {
          id: string;
          deviceLabel: string | null;
          registeredAt: string;
        }[]
      ).map((device) => [device.id, device]),
    );
    expect(byId.get(expired.id)).toMatchObject({ deviceLabel: "HP hilang" });
    expect(Number.isNaN(Date.parse(byId.get(expired.id)!.registeredAt))).toBe(
      false,
    );
  });

  it("never exposes the push endpoint, keys or sealed secret", async () => {
    const me = await plainAccount();
    const device = await seedDevice(me.userId, { session: "expired" });
    const response = await list(me);
    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).toContain(device.id);
    expect(text).not.toContain(device.endpoint);
    expect(text).not.toContain("fcm.googleapis.com");
    expect(text).not.toMatch(/ciphertext|endpoint|p256dh|auth"/i);
  });

  it("is empty for an account without registered devices", async () => {
    const me = await plainAccount();
    const response = await list(me);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it("shows only the caller's own devices, never another account's", async () => {
    const alice = await plainAccount();
    const bob = await plainAccount();
    const aliceDevice = await seedDevice(alice.userId, { session: "expired" });
    const bobDevice = await seedDevice(bob.userId);
    const aliceList = await list(alice);
    const bobList = await list(bob);
    expect(listedIds(aliceList)).toEqual([aliceDevice.id]);
    expect(listedIds(bobList)).toEqual([bobDevice.id]);
  });

  it("requires a signed-in account (401)", async () => {
    const response = await request(app)
      .get(BASE)
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(401);
  });
});

describe("legend-gchkf DELETE /api/identity/push-devices/:id", () => {
  it("revokes one device: it leaves the list, the others stay, and the panic alarm stops going to it", async () => {
    const me = await receiver();
    const lost = await seedDevice(me.userId, {
      session: "expired",
      label: "HP hilang",
      ageMs: 2 * HOUR,
    });
    const kept = await seedDevice(me.userId, {
      session: "live",
      label: "HP baru",
    });

    // Baseline: both phones ring, proving the harness reaches the lost one.
    const before = await ring(me.userId);
    expect(new Set(before)).toEqual(new Set([lost.endpoint, kept.endpoint]));

    const response = await revoke(me, lost.id);
    expect(response.status).toBe(204);

    const after = await list(me);
    expect(listedIds(after)).toEqual([kept.id]);

    const sent = await ring(me.userId);
    expect(sent).toContain(kept.endpoint);
    expect(sent).not.toContain(lost.endpoint);
  });

  it("revoking an already revoked device answers 404", async () => {
    const me = await plainAccount();
    const device = await seedDevice(me.userId, { session: "expired" });
    expect((await revoke(me, device.id)).status).toBe(204);
    expect((await revoke(me, device.id)).status).toBe(404);
  });

  it("answers 404 for another account's device and leaves it listed and ringing", async () => {
    const victim = await receiver();
    const intruder = await plainAccount();
    const device = await seedDevice(victim.userId, { session: "expired" });

    const response = await revoke(intruder, device.id);
    expect(response.status).toBe(404);

    expect(listedIds(await list(victim))).toEqual([device.id]);
    expect(await ring(victim.userId)).toContain(device.endpoint);
  });

  it("answers 404 for an unknown id", async () => {
    const me = await plainAccount();
    expect((await revoke(me, randomUUID())).status).toBe(404);
  });

  it("requires a signed-in account (401) and changes nothing", async () => {
    const me = await plainAccount();
    const device = await seedDevice(me.userId, { session: "expired" });
    const response = await request(app)
      .delete(`${BASE}/${device.id}`)
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(401);
    expect(listedIds(await list(me))).toEqual([device.id]);
  });

  it("refuses an untrusted origin (403) and changes nothing", async () => {
    const me = await plainAccount();
    const device = await seedDevice(me.userId, { session: "expired" });
    const response = await revoke(me, device.id, "https://evil.example");
    expect(response.status).toBe(403);
    expect(listedIds(await list(me))).toEqual([device.id]);
  });

  it("rejects a malformed id (400 or 422) and changes nothing", async () => {
    const me = await plainAccount();
    const device = await seedDevice(me.userId, { session: "expired" });
    for (const bad of ["not-an-id", "123", "%27%20OR%201%3D1", "null"]) {
      const response = await revoke(me, bad);
      expect([400, 422]).toContain(response.status);
    }
    expect(listedIds(await list(me))).toEqual([device.id]);
  });
});
