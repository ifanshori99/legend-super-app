// legend-ofq4f D3 + architect findings 3, 4, 5 of 791 (docs/briefs/791-panic-architect-findings.md):
// which stored web push subscriptions a panic alarm is delivered to.
// Written from docs/briefs/ofq4f-push-registration.md and the 791 findings,
// never from the worker code.
//
// Rules under test (brief D3 + 791 items 3-5):
//  - Only subscriptions that were registered with a live login session count:
//    session_id NOT NULL, the session still exists, is not expired and belongs
//    to the same user. Legacy rows (session_id NULL) are never used.
//  - A subscription bound to a device counts only while the device is active.
//  - For a panic alarm only subscriptions of the alarm's outlet count (a NULL
//    outlet or another outlet does not).
//  - The alarm goes to EVERY eligible subscription of the receiver, at most 5,
//    newest registration first.
//  - One subscription that cannot be opened is skipped; the others still send.
//  - Without a configured push provider the in-app notification is still
//    created, the event is not rejected (no dead-letter), and no push attempt
//    exists.
//
// ASSUMPTIONS where the brief is silent:
//  - "newest" = registered_at (created_at is set equal in the fixtures, so
//    ordering by created_at agrees).
//  - An attempt whose receiver has no eligible subscription may either not be
//    queued at all or end as not "sent"; the tests only require that nothing
//    is transported.
//  - Operator log output of item 4 (an error line without secrets) is not
//    asserted: the logger is silent under test.
import { createECDH, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createWorkerNotificationHandlers } from "../worker/notification-adapters.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { PANIC_PERMISSION_RESPOND } from "./panic-test-helpers.ts";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + 7 * HOUR).toISOString().slice(0, 10);

let tenantA: IsolatedTenant;
let outletA: string;
let outletA2: string;
let adminUserId: string;
const userIds: string[] = [];

const contextOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

async function insertUser(label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, label, `${id}@example.test`],
  );
  userIds.push(id);
  return id;
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      `PF-${id.slice(0, 8)}`.toUpperCase(),
      label,
    ],
  );
  return id;
}

/** A receiver on duty at outletA with the respond permission. */
async function onDutyReceiver(name: string) {
  const userId = await insertUser(name);
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
      `PF-${employeeId.slice(0, 8).toUpperCase()}`,
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
  return { userId, employeeId };
}
type Receiver = Awaited<ReturnType<typeof onDutyReceiver>>;

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

type SubscriptionSpec = {
  /** Outlet the browser registered for; default = the alarm's outlet. */
  outlet?: string | null;
  /** Login session of the registration; default = a live one. */
  session?: "live" | "expired" | "none";
  device?: "active" | "revoked" | null;
  /** Registered this long ago (newer = smaller). */
  ageMs?: number;
  /** Ciphertext that cannot be opened. */
  unreadable?: boolean;
};
type Seeded = { endpoint: string; spec: SubscriptionSpec };

async function seedSubscription(
  receiver: Receiver,
  spec: SubscriptionSpec = {},
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
    receiver.userId,
  );
  let sessionId: string | null = null;
  if ((spec.session ?? "live") !== "none") {
    sessionId = randomUUID();
    await owner.query(
      `INSERT INTO "session" (id, expires_at, token, user_id)
       VALUES ($1, now() + $2::interval, $3, $4)`,
      [
        sessionId,
        spec.session === "expired" ? "-1 hour" : "7 days",
        randomUUID(),
        receiver.userId,
      ],
    );
  }
  let deviceId: string | null = null;
  if (spec.device) {
    deviceId = randomUUID();
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status, revoked_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir uji', $4, $5)`,
      [
        deviceId,
        tenantA.tenantId,
        outletA,
        spec.device,
        spec.device === "revoked" ? new Date() : null,
      ],
    );
  }
  const registeredAt = new Date(Date.now() - (spec.ageMs ?? 0));
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_id, session_id, created_at, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      tenantA.tenantId,
      randomUUID(),
      receiver.userId,
      sealed.endpointHash,
      spec.unreadable ? "not-a-sealed-secret" : sealed.ciphertext,
      sealed.keyVersion,
      spec.outlet === undefined ? outletA : spec.outlet,
      deviceId,
      sessionId,
      registeredAt,
    ],
  );
  return { endpoint, spec };
}

const key = createECDH("prime256v1");
key.generateKeys();
const webPushEnv = {
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "web_push",
  VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: key.getPrivateKey().toString("base64url"),
  VAPID_SUBJECT: "mailto:push@example.test",
};

/** Raise the alarm, run the production consumer and deliver every queued push. */
async function ring(
  receiver: Receiver,
  env: Record<string, string> = webPushEnv,
) {
  const context = contextOf(tenantA.tenantId);
  const event = await raisedAlarm();
  const sent: unknown[][] = [];
  const handlers = createWorkerNotificationHandlers(database, env, {
    fetch: globalThis.fetch,
    webPushSend: async (...args: unknown[]) => {
      sent.push(args);
      return { statusCode: 201, headers: {}, body: "" };
    },
  });
  const consume = createNotificationConsumer(
    context,
    handlers.resolveNotificationRecipients,
  );
  await withTenant(database, context, (tx) => consume(event, event.id, tx));
  const attempts = (
    await owner.query<{ id: string; status: string }>(
      `SELECT a.id::text, a.status FROM delivery_attempts a
         JOIN notifications n ON n.id = a.notification_id AND n.tenant_id = a.tenant_id
        WHERE n.tenant_id = $1 AND n.user_id = $2 AND n.source_event_id = $3
          AND a.channel = 'web_push'`,
      [tenantA.tenantId, receiver.userId, ulidToUuid(event.id)],
    )
  ).rows;
  const results: string[] = [];
  for (const attempt of attempts)
    results.push(
      await deliverNotificationAttempt(
        database,
        context,
        uuidToUlid(attempt.id),
        handlers.notificationDelivery,
      ),
    );
  const notifications = (
    await owner.query(
      `SELECT id FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND source_event_id = $3`,
      [tenantA.tenantId, receiver.userId, ulidToUuid(event.id)],
    )
  ).rows;
  return {
    results,
    attempts: attempts.length,
    attemptStatuses: attempts.map((attempt) => attempt.status),
    notifications: notifications.length,
    endpoints: sent.map((call) => (call[0] as { endpoint: string }).endpoint),
  };
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
  tenantA = await createIsolatedTenant(`pf-a-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet("Outlet fanout A");
  outletA2 = await seedOutlet("Outlet fanout A2");
  adminUserId = await insertUser("Admin fanout");
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await owner.query(`DELETE FROM "session" WHERE user_id = ANY($1::text[])`, [
    userIds,
  ]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await appPool.end();
  await owner.end();
});

describe("legend-ofq4f D3 eligible subscriptions for a panic alarm", () => {
  it("sends to a subscription registered with a live session for the alarm's outlet", async () => {
    const receiver = await onDutyReceiver("Penerima dasar");
    const good = await seedSubscription(receiver);
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toEqual([good.endpoint]);
    expect(outcome.results).toEqual(["sent"]);
  });

  it("never sends to a legacy subscription without a session", async () => {
    const receiver = await onDutyReceiver("Penerima lama");
    await seedSubscription(receiver, { session: "none" });
    expect((await ring(receiver)).endpoints).toEqual([]);
  });

  it("never sends to a subscription whose session expired or is gone", async () => {
    const receiver = await onDutyReceiver("Penerima sesi mati");
    await seedSubscription(receiver, { session: "expired" });
    const gone = await seedSubscription(receiver);
    await owner.query(
      `DELETE FROM "session" WHERE user_id = $1 AND expires_at > now()`,
      [receiver.userId],
    );
    const live = await seedSubscription(receiver);
    expect(gone.endpoint).not.toBe(live.endpoint);
    expect((await ring(receiver)).endpoints).toEqual([live.endpoint]);
  });

  it("only sends to subscriptions registered for the alarm's outlet", async () => {
    const receiver = await onDutyReceiver("Penerima outlet");
    const here = await seedSubscription(receiver, { outlet: outletA });
    await seedSubscription(receiver, { outlet: outletA2 });
    await seedSubscription(receiver, { outlet: null });
    expect((await ring(receiver)).endpoints).toEqual([here.endpoint]);
  });

  it("skips a subscription whose device was revoked, keeps one with an active device", async () => {
    const receiver = await onDutyReceiver("Penerima perangkat");
    await seedSubscription(receiver, { device: "revoked" });
    const active = await seedSubscription(receiver, { device: "active" });
    expect((await ring(receiver)).endpoints).toEqual([active.endpoint]);
  });
});

describe("legend-ofq4f 791 item 3 fan-out to every eligible subscription", () => {
  it("sends to all eligible subscriptions of the receiver, not only one", async () => {
    const receiver = await onDutyReceiver("Penerima banyak perangkat");
    const subs = [
      await seedSubscription(receiver, { ageMs: 30 * MINUTE }),
      await seedSubscription(receiver, { ageMs: 20 * MINUTE }),
      await seedSubscription(receiver, { ageMs: 10 * MINUTE }),
    ];
    const outcome = await ring(receiver);
    expect([...outcome.endpoints].sort()).toEqual(
      subs.map((sub) => sub.endpoint).sort(),
    );
    expect(outcome.results.every((result) => result === "sent")).toBe(true);
  });

  it("caps the fan-out at 5 and keeps the 5 newest registrations", async () => {
    const receiver = await onDutyReceiver("Penerima tujuh perangkat");
    const subs: Seeded[] = [];
    for (let minutesAgo = 70; minutesAgo >= 10; minutesAgo -= 10)
      subs.push(
        await seedSubscription(receiver, { ageMs: minutesAgo * MINUTE }),
      );
    expect(subs).toHaveLength(7); // oldest first
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toHaveLength(5);
    expect([...outcome.endpoints].sort()).toEqual(
      subs
        .slice(2)
        .map((sub) => sub.endpoint)
        .sort(),
    );
  });
});

describe("legend-ofq4f 791 item 5 an unreadable subscription is skipped", () => {
  it("still sends to the readable subscription", async () => {
    const receiver = await onDutyReceiver("Penerima rusak sebagian");
    await seedSubscription(receiver, { unreadable: true, ageMs: MINUTE });
    const good = await seedSubscription(receiver, { ageMs: 5 * MINUTE });
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toEqual([good.endpoint]);
    expect(outcome.results).toEqual(["sent"]);
  });
});

describe("legend-ofq4f 791 item 4 panic alarm without push configuration", () => {
  const disabled = {
    NOTIFICATION_EMAIL_PROVIDER: "disabled",
    NOTIFICATION_PUSH_PROVIDER: "disabled",
    NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  };
  it("still creates the in-app notification and does not reject the event", async () => {
    const receiver = await onDutyReceiver("Penerima tanpa push");
    await seedSubscription(receiver);
    const outcome = await ring(receiver, disabled);
    expect(outcome.notifications).toBe(1);
    expect(outcome.endpoints).toEqual([]);
    // Push is skipped: an attempt row may exist but must never be waiting to
    // be sent, and nothing was transported (asserted above).
    expect(outcome.attemptStatuses).not.toContain("queued");
    expect(outcome.attemptStatuses).not.toContain("sent");
  });
});
