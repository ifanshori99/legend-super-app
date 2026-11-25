// legend-806 T1: panic push dispatch fixes from the second opinion
// (docs/qa/second-opinion-alarm-panik.md P0-1, P0-2, P1-2 dispatch) and
// docs/briefs/806-panic-second-opinion-fix.md. Written from the brief and the
// public functions / HTTP routes only, never from the worker code. It uses no
// new column name, so it also runs (and fails for the right reason) on the
// base commit e241e9476.
//
// Rules under test:
//  - P0-1: one browser accepted (201) must not cancel the retry of another
//    browser of the same receiver that got a transient failure (503). On
//    retry only the failed browser is called again, the one that already got
//    the alarm is not sent a second time. Retry stops once the alarm is
//    acknowledged.
//  - P0-2: the old "5 newest" cut must not push the receiver's phone out. With
//    6 eligible subscriptions the oldest (the phone) is still sent; with 5
//    unreadable newest rows the valid sixth is still sent. A safety limit of
//    30 applies after opening the ciphertexts.
//  - P1-2 dispatch: a subscription registered with a device token must stop
//    receiving once the device token is reissued (the old credential is dead);
//    a registration with the new token is delivered again.
//
// ASSUMPTIONS where the brief is silent:
//  - A transient push failure is simulated by a webPushSend that throws what
//    the web-push library throws: an Error named "WebPushError" with
//    statusCode 503.
//  - "Advance now" = passing a later Date as the 5th argument of
//    deliverNotificationAttempt. The exact backoff is not in the brief, so the
//    test advances in 2-minute steps (at most 6) until the attempt is sent;
//    steps before the retry is due answer "not_due" and send nothing.
//  - Which 30 subscriptions are kept above the limit is not asserted beyond
//    "the newest registration is among them".
//  - The reissue of the device token waits 1.1 s first so the new credential
//    generation (whole seconds) differs from the enrollment's, as the real
//    world does; this is not a timing race, only a guaranteed distinct second.
import { createECDH, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";

// config/env.ts reads process.env once at import: the push configuration
// must exist before the app module graph loads (registration over HTTP).
await vi.hoisted(async () => {
  const { createECDH } = await import("node:crypto");
  const key = createECDH("prime256v1");
  key.generateKeys();
  process.env.NOTIFICATION_PUSH_PROVIDER = "web_push";
  process.env.VAPID_PUBLIC_KEY = key.getPublicKey().toString("base64url");
  process.env.VAPID_PRIVATE_KEY = Buffer.from(
    key.getPrivateKey("hex").padStart(64, "0"),
    "hex",
  ).toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:push@example.test";
});

import { createApp } from "../app.ts";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createWorkerNotificationHandlers } from "../worker/notification-adapters.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { enrollDevice, issueDeviceToken } from "../services/device.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { PANIC_PERMISSION_RESPOND } from "./panic-test-helpers.ts";

const app = createApp();
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + 7 * HOUR).toISOString().slice(0, 10);
const actor = randomUUID();

let tenantA: IsolatedTenant;
let outletA: string;
let adminUserId: string;
const userIds: string[] = [];

const contextOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const outletScope = (outlet: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
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
      `P8-${id.slice(0, 8)}`.toUpperCase(),
      label,
    ],
  );
  return id;
}

/** A receiver on duty at outletA with the respond permission. */
async function onDutyReceiver(name: string, existingUserId?: string) {
  const userId = existingUserId ?? (await insertUser(name));
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
      `P8-${employeeId.slice(0, 8).toUpperCase()}`,
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
  /** Registered this long ago (newer = smaller). */
  ageMs?: number;
  /** Ciphertext that cannot be opened. */
  unreadable?: boolean;
};
type Seeded = { endpoint: string };

/** A subscription of a receiver with a live login session, for the alarm's outlet. */
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
  const sessionId = randomUUID();
  await owner.query(
    `INSERT INTO "session" (id, expires_at, token, user_id)
     VALUES ($1, now() + interval '7 days', $2, $3)`,
    [sessionId, randomUUID(), receiver.userId],
  );
  const registeredAt = new Date(Date.now() - (spec.ageMs ?? 0));
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_id, session_id, created_at, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $9)`,
    [
      tenantA.tenantId,
      randomUUID(),
      receiver.userId,
      sealed.endpointHash,
      spec.unreadable ? "not-a-sealed-secret" : sealed.ciphertext,
      sealed.keyVersion,
      outletA,
      sessionId,
      registeredAt,
    ],
  );
  return { endpoint };
}

const vapidKey = createECDH("prime256v1");
vapidKey.generateKeys();
const webPushEnv = {
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "web_push",
  VAPID_PUBLIC_KEY: vapidKey.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: Buffer.from(
    vapidKey.getPrivateKey("hex").padStart(64, "0"),
    "hex",
  ).toString("base64url"),
  VAPID_SUBJECT: "mailto:push@example.test",
};

function transientFailure(endpoint: string, statusCode = 503) {
  return Object.assign(new Error("Received unexpected response code"), {
    name: "WebPushError",
    statusCode,
    headers: {},
    body: "",
    endpoint,
  });
}

/**
 * Raise an alarm, run the production consumer and return a handle to deliver
 * the queued push attempts, optionally at a later `now`. `behavior` decides per
 * call whether the push service answers 201 (return) or fails (throw).
 */
async function raiseAlarm(
  receiver: Receiver,
  behavior: (endpoint: string, callNumber: number) => void = () => {},
) {
  const context = contextOf(tenantA.tenantId);
  const event = await raisedAlarm();
  const calls: string[] = [];
  const handlers = createWorkerNotificationHandlers(database, webPushEnv, {
    fetch: globalThis.fetch,
    webPushSend: async (...args: unknown[]) => {
      const endpoint = (args[0] as { endpoint: string }).endpoint;
      calls.push(endpoint);
      behavior(endpoint, calls.filter((call) => call === endpoint).length);
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
      [tenantA.tenantId, receiver.userId, ulidToUuid(event.id)],
    )
  ).rows;
  const deliver = async (now?: Date) => {
    const results: string[] = [];
    for (const attempt of attempts)
      results.push(
        await deliverNotificationAttempt(
          database,
          context,
          uuidToUlid(attempt.id),
          handlers.notificationDelivery,
          now,
        ),
      );
    return results;
  };
  const countOf = (endpoint: string) =>
    calls.filter((call) => call === endpoint).length;
  return { event, calls, attempts: attempts.length, deliver, countOf };
}
type Alarm = Awaited<ReturnType<typeof raiseAlarm>>;

/** Deliver once now, then retry at later times (2 min steps) until it is sent. */
async function deliverUntilSent(alarm: Alarm) {
  const first = await alarm.deliver();
  let last = first;
  for (let step = 1; step <= 6 && !last.every((r) => r === "sent"); step++) {
    last = await alarm.deliver(new Date(Date.now() + step * 2 * MINUTE));
  }
  return { first, last };
}

/** One-shot alarm: deliver once and report which endpoints were called. */
async function ring(receiver: Receiver) {
  const alarm = await raiseAlarm(receiver);
  const results = await alarm.deliver();
  return { results, endpoints: alarm.calls };
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
  tenantA = await createIsolatedTenant(`p8-a-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet("Outlet 806 A");
  adminUserId = await insertUser("Admin 806");
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

describe("legend-806 P0-1 a delivered browser does not cancel the retry of a failed one", () => {
  it("retries only the phone that got 503; the laptop that got 201 is sent once", async () => {
    const receiver = await onDutyReceiver("Penerima laptop dan HP");
    const phone = await seedSubscription(receiver, { ageMs: 30 * MINUTE });
    const laptop = await seedSubscription(receiver, { ageMs: 5 * MINUTE });
    const alarm = await raiseAlarm(receiver, (endpoint, callNumber) => {
      // The phone's push service is down for the first call only.
      if (endpoint === phone.endpoint && callNumber === 1)
        throw transientFailure(endpoint);
    });

    const { first, last } = await deliverUntilSent(alarm);

    // The first pass did not finish the job: the phone has not been reached.
    expect(first.every((result) => result === "sent")).toBe(false);
    // After the retry the phone was called again, and finally accepted.
    expect(alarm.countOf(phone.endpoint)).toBe(2);
    expect(last.every((result) => result === "sent")).toBe(true);
    // The laptop already had the alarm: it is not sent a second time.
    expect(alarm.countOf(laptop.endpoint)).toBe(1);
  });

  it("retries the phone when the planned laptop endpoint is gone (410) on the first try", async () => {
    const receiver = await onDutyReceiver("Penerima laptop 410 dan HP");
    const phone = await seedSubscription(receiver, { ageMs: 30 * MINUTE });
    // The newest registration is the endpoint the attempt is planned for.
    const laptop = await seedSubscription(receiver, { ageMs: 5 * MINUTE });
    const alarm = await raiseAlarm(receiver, (endpoint, callNumber) => {
      if (callNumber !== 1) return;
      if (endpoint === laptop.endpoint) throw transientFailure(endpoint, 410);
      if (endpoint === phone.endpoint) throw transientFailure(endpoint);
    });

    const { first, last } = await deliverUntilSent(alarm);

    expect(first.every((result) => result === "sent")).toBe(false);
    // The laptop is gone and not called again; the phone gets the retry.
    expect(alarm.countOf(laptop.endpoint)).toBe(1);
    expect(alarm.countOf(phone.endpoint)).toBe(2);
    expect(last.every((result) => result === "sent")).toBe(true);
  });

  it("does not call anybody again once everything was accepted", async () => {
    const receiver = await onDutyReceiver("Penerima semua terkirim");
    const one = await seedSubscription(receiver, { ageMs: 20 * MINUTE });
    const two = await seedSubscription(receiver, { ageMs: 10 * MINUTE });
    const alarm = await raiseAlarm(receiver);
    expect((await alarm.deliver()).every((r) => r === "sent")).toBe(true);
    await alarm.deliver(new Date(Date.now() + 4 * MINUTE));
    await alarm.deliver(new Date(Date.now() + 10 * MINUTE));
    expect(alarm.countOf(one.endpoint)).toBe(1);
    expect(alarm.countOf(two.endpoint)).toBe(1);
  });

  it("stops retrying the failed phone once the alarm was acknowledged", async () => {
    const receiver = await onDutyReceiver("Penerima alarm ditangani");
    const phone = await seedSubscription(receiver, { ageMs: 30 * MINUTE });
    await seedSubscription(receiver, { ageMs: 5 * MINUTE });
    const alarm = await raiseAlarm(receiver, (endpoint) => {
      if (endpoint === phone.endpoint) throw transientFailure(endpoint);
    });
    await alarm.deliver();
    expect(alarm.countOf(phone.endpoint)).toBe(1);
    await owner.query(
      `UPDATE panic_alerts SET acknowledged_at = now(), acknowledged_by = $3
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA.tenantId, alarm.event.aggregateId, receiver.userId],
    );
    for (let step = 1; step <= 4; step++)
      await alarm.deliver(new Date(Date.now() + step * 2 * MINUTE));
    expect(alarm.countOf(phone.endpoint)).toBe(1);
  });
});

describe("legend-806 P0-2 five newer subscriptions do not push the phone out", () => {
  it("sends to the oldest subscription (the phone) when five newer desktops exist", async () => {
    const receiver = await onDutyReceiver("Penerima enam perangkat");
    const phone = await seedSubscription(receiver, { ageMs: 120 * MINUTE });
    const desktops: Seeded[] = [];
    for (let minutesAgo = 50; minutesAgo >= 10; minutesAgo -= 10)
      desktops.push(
        await seedSubscription(receiver, { ageMs: minutesAgo * MINUTE }),
      );
    expect(desktops).toHaveLength(5);
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toContain(phone.endpoint);
    expect([...outcome.endpoints].sort()).toEqual(
      [phone, ...desktops].map((sub) => sub.endpoint).sort(),
    );
    expect(outcome.results.every((result) => result === "sent")).toBe(true);
  });

  it("still sends to a valid phone when the five newest ciphertexts cannot be opened", async () => {
    const receiver = await onDutyReceiver("Penerima lima rusak");
    const phone = await seedSubscription(receiver, { ageMs: 120 * MINUTE });
    for (let minutesAgo = 5; minutesAgo >= 1; minutesAgo--)
      await seedSubscription(receiver, {
        ageMs: minutesAgo * MINUTE,
        unreadable: true,
      });
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toEqual([phone.endpoint]);
    expect(outcome.results).toEqual(["sent"]);
  });

  it("applies a safety limit of 30 subscriptions after opening them, newest first", async () => {
    const receiver = await onDutyReceiver("Penerima tiga puluh dua");
    const subs: Seeded[] = [];
    for (let minutesAgo = 64; minutesAgo >= 1; minutesAgo -= 2)
      subs.push(
        await seedSubscription(receiver, { ageMs: minutesAgo * MINUTE }),
      );
    expect(subs).toHaveLength(32); // oldest first
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toHaveLength(30);
    expect(outcome.endpoints).toContain(subs[subs.length - 1]!.endpoint);
  });
});

describe("legend-806 P1-2 dispatch: reissuing a device token cuts off its old push", () => {
  async function signedInReceiver(name: string) {
    const client = agent(app);
    const email = `p8-${randomUUID()}@example.com`;
    const signUp = await client
      .post("/api/auth/sign-up/email")
      .set(originHeader)
      .send({ name, email, password: "Test-password-123!" });
    if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    userIds.push(userId);
    const receiver = await onDutyReceiver(name, userId);
    await verifySessionMfa(email);
    return { client, receiver };
  }

  function subscriptionBody() {
    const key = createECDH("prime256v1");
    key.generateKeys();
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
      deviceLabel: null,
    };
  }

  it("the old endpoint no longer receives the alarm; a registration with the new token does", async () => {
    await owner.query(
      `INSERT INTO notification_policies
         (tenant_id, web_push_enabled, email_enabled, whatsapp, max_attempts, retry_backoff_seconds)
       VALUES ($1, true, true, $2::jsonb, 3, '[30,120]'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET web_push_enabled = true`,
      [
        tenantA.tenantId,
        JSON.stringify({
          enabled: false,
          allowedCategories: [],
          monthlyCap: 0,
          costPerMessageIdr: 0,
        }),
      ],
    );
    const { client, receiver } = await signedInReceiver("Petugas token HP");
    const enrolled = await enrollDevice(outletScope(outletA), actor, {
      outletId: outletA,
      type: "pos",
      label: `Kasir ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    const register = (token: string, body: object) =>
      client
        .post("/api/notifications/push-subscriptions")
        .set({
          Host: tenantA.hostname,
          ...originHeader,
          [DEVICE_TOKEN_HEADER]: token,
        })
        .send(body);

    const oldBody = subscriptionBody();
    expect((await register(enrolled.token, oldBody)).status).toBe(200);
    // Sanity: before the reissue the registered phone does receive the alarm.
    expect((await ring(receiver)).endpoints).toEqual([oldBody.endpoint]);

    // The phone is lost: the admin reissues the device token (device stays active).
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reissued = await issueDeviceToken(outletScope(outletA), actor, {
      deviceId: enrolled.device.id,
    });
    const afterReissue = await ring(receiver);
    expect(
      afterReissue.endpoints,
      "the lost phone's old credential must not receive the alarm",
    ).toEqual([]);

    // A registration made with the new token is delivered again.
    const newBody = subscriptionBody();
    expect((await register(reissued.token, newBody)).status).toBe(200);
    const afterNewRegistration = await ring(receiver);
    expect(afterNewRegistration.endpoints).toEqual([newBody.endpoint]);
    expect(afterNewRegistration.results).toEqual(["sent"]);
  });
});
