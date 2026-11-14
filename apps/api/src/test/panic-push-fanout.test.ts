// legend-ofq4f D3 + architect findings 3, 4, 5 of 791 (docs/briefs/791-panic-architect-findings.md):
// which stored web push subscriptions a panic alarm is delivered to.
// Written from docs/briefs/ofq4f-push-registration.md and the 791 findings,
// never from the worker code.
//
// Rules under test (brief D3 + 791 items 3-5, design v2 V3 of the architect round):
//  - A subscription counts only when it was registered by design v2:
//    registered_at IS NOT NULL and newer than 30 days. Legacy rows
//    (registered_at NULL) are never used.
//  - Its login session may have EXPIRED (idle 30 min) or been deleted
//    (session_id becomes NULL): the alarm must still arrive. Only an
//    explicitly REVOKED session (revoked_at set) excludes it.
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
//  - The 30-day edge is tested at 29 days (kept) and 31 days (dropped).
//  - A hung push endpoint is simulated with a fake webPushSend that never
//    resolves until released; the other endpoints must be sent meanwhile.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  /**
   * Login session of the registration; default = a live one. "none" = the
   * session row was deleted after expiry (session_id NULL, ON DELETE SET NULL).
   */
  session?: "live" | "expired" | "revoked" | "revoked-expired" | "none";
  /** Pre-v2 row: registered_at NULL. */
  legacy?: boolean;
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
      `INSERT INTO "session" (id, expires_at, token, user_id, revoked_at)
       VALUES ($1, now() + $2::interval, $3, $4, $5)`,
      [
        sessionId,
        spec.session === "expired" || spec.session === "revoked-expired"
          ? "-1 hour"
          : "7 days",
        randomUUID(),
        receiver.userId,
        spec.session === "revoked" || spec.session === "revoked-expired"
          ? new Date()
          : null,
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      spec.legacy ? null : registeredAt,
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
  options: {
    send?: (subscription: { endpoint: string }) => Promise<unknown>;
    /** Runs while delivery is in flight, before it is awaited. */
    during?: (sent: () => string[]) => Promise<void>;
  } = {},
) {
  const context = contextOf(tenantA.tenantId);
  const event = await raisedAlarm();
  const sent: unknown[][] = [];
  const handlers = createWorkerNotificationHandlers(database, env, {
    fetch: globalThis.fetch,
    webPushSend: async (...args: unknown[]) => {
      sent.push(args);
      await options.send?.(args[0] as { endpoint: string });
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
  const delivery = (async () => {
    const delivered: string[] = [];
    for (const attempt of attempts)
      delivered.push(
        await deliverNotificationAttempt(
          database,
          context,
          uuidToUlid(attempt.id),
          handlers.notificationDelivery,
        ),
      );
    return delivered;
  })();
  await options.during?.(() =>
    sent.map((call) => (call[0] as { endpoint: string }).endpoint),
  );
  const results = await delivery;
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

  it("never sends to a legacy subscription (registered_at NULL), even with a live session", async () => {
    const receiver = await onDutyReceiver("Penerima lama");
    await seedSubscription(receiver, { legacy: true });
    expect((await ring(receiver)).endpoints).toEqual([]);
  });

  it("still sends when the login session EXPIRED (idle 30 min) without being revoked", async () => {
    const receiver = await onDutyReceiver("Penerima sesi idle");
    const idle = await seedSubscription(receiver, { session: "expired" });
    const outcome = await ring(receiver);
    expect(outcome.endpoints).toEqual([idle.endpoint]);
    expect(outcome.results).toEqual(["sent"]);
  });

  it("still sends when the expired session row was deleted (session_id NULL)", async () => {
    const receiver = await onDutyReceiver("Penerima sesi dihapus");
    const gone = await seedSubscription(receiver, { session: "none" });
    expect((await ring(receiver)).endpoints).toEqual([gone.endpoint]);
    // Same thing through the real foreign key: deleting the session row keeps
    // the subscription and only clears its session_id.
    const live = await seedSubscription(receiver);
    // The session expired by idle time (not revoked), then was cleaned up.
    await owner.query(
      `UPDATE "session" SET expires_at = now() - interval '1 hour' WHERE user_id = $1 AND revoked_at IS NULL`,
      [receiver.userId],
    );
    await owner.query(`DELETE FROM "session" WHERE user_id = $1`, [
      receiver.userId,
    ]);
    const { rows } = await owner.query<{ session_id: string | null }>(
      `SELECT session_id FROM push_subscriptions
        WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at`,
      [receiver.userId, tenantA.tenantId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === null)).toBe(true);
    expect([...(await ring(receiver)).endpoints].sort()).toEqual(
      [gone.endpoint, live.endpoint].sort(),
    );
  });

  it("never sends to a subscription whose login session was revoked", async () => {
    const receiver = await onDutyReceiver("Penerima sesi dicabut");
    await seedSubscription(receiver, { session: "revoked" });
    const live = await seedSubscription(receiver);
    expect((await ring(receiver)).endpoints).toEqual([live.endpoint]);
  });

  // legend-ofq4f round 3 B1: a login revoked by UPDATE (row kept) that is later
  // cleaned up must stay undeliverable, not come back as session_id NULL.
  it("B1 never sends after a session revoked by UPDATE was deleted afterwards", async () => {
    const receiver = await onDutyReceiver("Penerima dicabut lalu dihapus");
    await seedSubscription(receiver, { session: "revoked-expired" });
    const live = await seedSubscription(receiver);
    await owner.query(
      `DELETE FROM "session" WHERE user_id = $1 AND revoked_at IS NOT NULL`,
      [receiver.userId],
    );
    expect((await ring(receiver)).endpoints).toEqual([live.endpoint]);
  });

  it("drops a registration older than 30 days and keeps one of 29 days", async () => {
    const receiver = await onDutyReceiver("Penerima lama terdaftar");
    await seedSubscription(receiver, { ageMs: 31 * 24 * HOUR });
    const recent = await seedSubscription(receiver, { ageMs: 29 * 24 * HOUR });
    expect((await ring(receiver)).endpoints).toEqual([recent.endpoint]);
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

describe("legend-ofq4f v2 V3 sends are parallel", () => {
  it("one hanging push endpoint does not hold back the others", async () => {
    const receiver = await onDutyReceiver("Penerima endpoint macet");
    // newest registration first: the hanging one would go first if sequential.
    const hung = await seedSubscription(receiver, { ageMs: MINUTE });
    const fine = [
      await seedSubscription(receiver, { ageMs: 5 * MINUTE }),
      await seedSubscription(receiver, { ageMs: 10 * MINUTE }),
    ];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let outcome: Awaited<ReturnType<typeof ring>> | undefined;
    let during: Error | undefined;
    try {
      outcome = await ring(receiver, webPushEnv, {
        send: (subscription) =>
          subscription.endpoint === hung.endpoint ? gate : Promise.resolve(),
        during: async (sent) => {
          try {
            await vi.waitFor(
              () => {
                for (const sub of fine) expect(sent()).toContain(sub.endpoint);
              },
              { timeout: 4000, interval: 25 },
            );
          } catch (error) {
            during = error as Error;
          } finally {
            release(); // never leave the delivery dangling
          }
        },
      });
    } finally {
      release();
    }
    expect(
      during,
      "the other endpoints must be sent while one endpoint is still hanging",
    ).toBeUndefined();
    expect(outcome!.endpoints).toContain(hung.endpoint);
    expect(outcome!.results).toEqual(["sent"]);
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
