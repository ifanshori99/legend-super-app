// Panic alert push fallback outside the LAN (bead legend-kmjax, FAC-08; contract
// packages/shared/src/facility/emergency.ts and the notification catalog in
// packages/shared/src/notification). Written BEFORE the implementation, from the
// contract and the shared validators, never from the worker code.
//
// The cloud receives the edge's `panic_alert.raised` event. The notification
// recipient resolver must page the staff ON DUTY at that outlet who hold the
// receiver permission `facility.emergency.respond`, in the `emergency` category
// (bypasses quiet hours, web push by default), and nobody else.
//
// ASSUMPTIONS where the contract is silent:
//  - "On duty" = the receiver rule D-04 of the emergency design: a published
//    shift whose window covers now (plus 30 min grace after it ends), or a
//    clock-in without a later clock-out that is younger than 14 h.
//  - Recipients are resolved from the stored alert (`panic_alerts`) and the
//    event; an alert that already has `acknowledged_at` pages nobody (a delayed
//    raised event must not wake staff after the first ack), like
//    `facility_incident.raised` for an answered incident.
//  - Kind `test` pages the same staff and the title/body carries "UJI".
//  - A tenant-scope role holder (general manager) on duty at the outlet counts.
//  - A mismatch between the envelope outlet and the payload outlet, or a
//    foreign-tenant outlet, may reject or page nobody; the test only requires
//    that the staff of the wrong outlet/tenant is never paged.
import { createECDH, createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createNotificationRecipientResolver,
  createWorkerNotificationHandlers,
} from "../worker/notification-adapters.ts";
import { sealSecret, sealedVersion } from "../lib/secrets.ts";
import {
  assertPushServiceEndpoint,
  createPushSubscriptionProtector,
  openPushSubscription,
} from "../lib/push-subscription.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
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
const WIB_OFFSET = 7 * HOUR;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA: string; // tenant A, the outlet that rings
let outletA2: string; // tenant A, another outlet
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

async function seedOutlet(tenant: IsolatedTenant, label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `PP-${id.slice(0, 8)}`.toUpperCase(),
      label,
    ],
  );
  return id;
}

type StaffOptions = {
  tenant?: IsolatedTenant;
  outlet?: string;
  permissions?: string[];
  scope?: "outlet" | "tenant";
  employeeStatus?: string;
  validUntil?: string; // pg interval relative to now
};

/** Staff with a role in the scope and an employee row; duty comes separately. */
async function newStaff(name: string, options: StaffOptions = {}) {
  const tenant = options.tenant ?? tenantA;
  const outlet = options.outlet ?? outletA;
  const scope = options.scope ?? "outlet";
  const userId = await insertUser(name);
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, $5::jsonb)`,
    [
      roleId,
      tenant.tenantId,
      `Darurat ${roleId.slice(0, 8)}`,
      JSON.stringify(options.permissions ?? [PANIC_PERMISSION_RESPOND]),
      JSON.stringify([scope]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '2 hours',
             ${options.validUntil ? "now() + $6::interval" : "$6::timestamptz"}, $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope,
      scope === "outlet" ? outlet : null,
      options.validUntil ?? null,
    ],
  );
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Darurat', $5, 'pkwtt', '2025-03-01', $6)`,
    [
      employeeId,
      tenant.tenantId,
      userId,
      `PP-${employeeId.slice(0, 8).toUpperCase()}`,
      outlet,
      options.employeeStatus ?? "active",
    ],
  );
  return { userId, employeeId, outlet, tenant };
}
type Staff = Awaited<ReturnType<typeof newStaff>>;

/** A published shift whose window is [now + start, now + end]. */
async function seedShift(staff: Staff, startMs: number, endMs: number) {
  const now = Date.now();
  await owner.query(
    `INSERT INTO shift_assignments
       (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
        status, source, published_by, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
    [
      randomUUID(),
      staff.tenant.tenantId,
      staff.outlet,
      staff.employeeId,
      wibDate(now + startMs),
      JSON.stringify([
        {
          startsAt: new Date(now + startMs).toISOString(),
          endsAt: new Date(now + endMs).toISOString(),
        },
      ]),
      adminUserId,
    ],
  );
}

async function seedClock(staff: Staff, type: "in" | "out", agoMs: number) {
  const at = new Date(Date.now() - agoMs);
  await owner.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        validity, business_date, client_event_id)
     VALUES ($1, $2, $3, $4, $5, 'outlet_device', $6, $6, 'valid', $7, $8)`,
    [
      randomUUID(),
      staff.tenant.tenantId,
      staff.outlet,
      staff.employeeId,
      type,
      at.toISOString(),
      wibDate(at.getTime()),
      createUlid(),
    ],
  );
}

const onDuty = async (name: string, options: StaffOptions = {}) => {
  const staff = await newStaff(name, options);
  await seedShift(staff, -HOUR, 7 * HOUR);
  return staff;
};

async function subscribePush(staff: Staff) {
  // legend-ofq4f: only a subscription registered with a live login session
  // for the outlet counts as reachable.
  const sessionId = randomUUID();
  await owner.query(
    `INSERT INTO "session" (id, expires_at, token, user_id) VALUES ($1, now() + interval '7 days', $2, $3)`,
    [sessionId, randomUUID(), staff.userId],
  );
  await owner.query(
    `INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version, outlet_id, session_id, registered_at)
     VALUES ($1, $2, $3, $4, 'cipher', 'v1', $5, $6, now())`,
    [
      staff.tenant.tenantId,
      randomUUID(),
      staff.userId,
      `hash-${randomUUID()}`,
      staff.outlet,
      sessionId,
    ],
  );
}

type RaisedOptions = {
  tenant?: IsolatedTenant;
  outlet?: string;
  kind?: "press" | "test";
  acknowledged?: boolean;
  resolved?: boolean;
  ageMs?: number; // how long ago the cloud received the alert
  envelopeOutlet?: string;
};

/** Stores the alert like the cloud applier and returns the raised envelope. */
async function raised(options: RaisedOptions = {}) {
  const tenant = options.tenant ?? tenantA;
  const outlet = options.outlet ?? outletA;
  const alertId = randomUUID();
  const deviceId = randomUUID();
  const receivedAt = new Date(Date.now() - (options.ageMs ?? 0)).toISOString();
  await owner.query(
    `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                               unit_code_snapshot, facility_name_snapshot, device_label_snapshot,
                               received_at, acknowledged_at, acknowledged_by,
                               resolved_at, resolved_by)
     VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas Uji', 'Tombol Uji', $6, $7, $8, $9, $10)`,
    [
      alertId,
      tenant.tenantId,
      outlet,
      deviceId,
      `evt-${alertId}`,
      receivedAt,
      options.acknowledged ? receivedAt : null,
      options.acknowledged ? adminUserId : null,
      options.resolved ? receivedAt : null,
      options.resolved ? adminUserId : null,
    ],
  );
  const name = "panic_alert.raised";
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId: tenant.tenantId,
    outletId: options.envelopeOutlet ?? outlet,
    name,
    aggregateType: "panic_alert",
    aggregateId: alertId,
    idempotencyKey: `${name}-${alertId}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      alertId,
      outletId: outlet,
      deviceId,
      unitId: null,
      firstDeviceEventId: `evt-${alertId}`,
      kind: options.kind ?? "press",
      triggeredAt: null,
      receivedAt,
      unitCodeSnapshot: "P1",
      facilityNameSnapshot: "Fasilitas Uji",
      deviceLabelSnapshot: "Tombol Uji",
      linkOffline: false,
    },
  });
}
type Raised = Awaited<ReturnType<typeof raised>>;

const resolve = (event: Raised, tenant: IsolatedTenant = tenantA) =>
  withTenant(database, contextOf(tenant.tenantId), (tx) =>
    createNotificationRecipientResolver({ email: true, push: true })(
      contextOf(tenant.tenantId),
      event,
      tx,
    ),
  );
/** Resolve, treating a rejection (a refused event) as "paged nobody". */
const resolveOrNobody = async (event: Raised, tenant?: IsolatedTenant) => {
  try {
    return await resolve(event, tenant);
  } catch {
    return [];
  }
};
const ids = (recipients: { userId: string }[]) =>
  recipients.map((recipient) => recipient.userId);

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
  tenantA = await createIsolatedTenant(`pp-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`pp-b-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet(tenantA, "Outlet darurat A");
  outletA2 = await seedOutlet(tenantA, "Outlet darurat A2");
  adminUserId = await insertUser("Admin push darurat");
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await purge(tenantB.tenantId);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await appPool.end();
  await owner.end();
});

describe("legend-kmjax panic_alert.raised notification rule", () => {
  it("legend-kmjax pages the on-duty staff of the outlet with the respond permission in the emergency category", async () => {
    const attendant = await onDuty("Petugas jaga");
    const offline = await onDuty("Petugas jaga tanpa push");
    await subscribePush(attendant);

    const recipients = await resolve(await raised());

    expect(ids(recipients)).toEqual(
      expect.arrayContaining([attendant.userId, offline.userId]),
    );
    const mine = recipients.find((r) => r.userId === attendant.userId)!;
    expect(mine.category).toBe("emergency");
    expect(mine.title.length).toBeGreaterThan(0);
    expect(mine.body.length).toBeGreaterThan(0);
    // The push channel is routed from the subscription on file.
    expect(mine.reachability.hasPushSubscription).toBe(true);
    expect(
      recipients.find((r) => r.userId === offline.userId)!.reachability
        .hasPushSubscription,
    ).toBe(false);
    expect(mine.policy.tenantId).toBe(tenantA.tenantId);
  });

  it("legend-kmjax never puts internal ids or the press event id in the visible text", async () => {
    const staff = await onDuty("Petugas teks");
    const event = await raised();
    const recipients = await resolve(event);
    const mine = recipients.find((r) => r.userId === staff.userId)!;
    const text = `${mine.title} ${mine.body}`;
    const payload = event.payload as Record<string, string>;
    expect(text).not.toContain(payload.deviceId);
    expect(text).not.toContain(payload.firstDeviceEventId);
  });

  it("legend-kmjax pages a tenant-scope manager who is on duty at the outlet, once", async () => {
    const manager = await newStaff("Manajer umum", { scope: "tenant" });
    await seedShift(manager, -HOUR, 7 * HOUR);
    const recipients = await resolve(await raised());
    expect(ids(recipients).filter((id) => id === manager.userId)).toHaveLength(
      1,
    );
  });

  it("legend-kmjax pages nobody who is off duty, lacks the permission, or is out of scope", async () => {
    const notYet = await newStaff("Shift besok");
    await seedShift(notYet, 5 * HOUR, 13 * HOUR);
    const ended = await newStaff("Shift lewat grace");
    await seedShift(ended, -9 * HOUR, -45 * MINUTE); // ended > 30 min ago
    const noNo = await onDuty("Tanpa izin", {
      permissions: ["pos.order.view"],
    });
    const otherOutlet = await onDuty("Outlet lain", { outlet: outletA2 });
    const lapsed = await onDuty("Peran lewat", { validUntil: "-1 minute" });
    const suspended = await onDuty("Karyawan nonaktif", {
      employeeStatus: "suspended",
    });
    const clockedOut = await newStaff("Sudah clock out");
    await seedClock(clockedOut, "in", 5 * HOUR);
    await seedClock(clockedOut, "out", HOUR);
    const stale = await newStaff("Clock in kedaluwarsa");
    await seedClock(stale, "in", 15 * HOUR); // older than the 14 h cap

    const paged = ids(await resolve(await raised()));

    for (const staff of [
      notYet,
      ended,
      noNo,
      otherOutlet,
      lapsed,
      suspended,
      clockedOut,
      stale,
    ])
      expect(paged, staff.userId).not.toContain(staff.userId);
  });

  it("legend-kmjax pages staff on duty by grace window or by an open clock-in", async () => {
    const inGrace = await newStaff("Shift baru selesai");
    await seedShift(inGrace, -8 * HOUR, -10 * MINUTE); // within the 30 min grace
    const clockedIn = await newStaff("Clock in terbuka");
    await seedClock(clockedIn, "in", 3 * HOUR);

    const paged = ids(await resolve(await raised()));

    expect(paged).toContain(inGrace.userId);
    expect(paged).toContain(clockedIn.userId);
  });

  it("legend-kmjax pages the same staff for a test alert and marks it UJI", async () => {
    const staff = await onDuty("Petugas uji");
    const recipients = await resolve(await raised({ kind: "test" }));
    const mine = recipients.find((r) => r.userId === staff.userId);
    expect(mine).toBeDefined();
    expect(`${mine!.title} ${mine!.body}`).toMatch(/UJI/);
  });

  it("legend-kmjax pages nobody for an alert that was already acknowledged", async () => {
    await onDuty("Petugas terlambat");
    expect(await resolve(await raised({ acknowledged: true }))).toEqual([]);
  });

  it("legend-kmjax pages nobody for an alert that was already resolved", async () => {
    await onDuty("Petugas selesai");
    expect(await resolve(await raised({ resolved: true }))).toEqual([]);
  });

  it("legend-kmjax pages nobody for a stale alert (received over 24 h ago, e.g. after a long link outage)", async () => {
    await onDuty("Petugas alert basi");
    expect(await resolve(await raised({ ageMs: 25 * HOUR }))).toEqual([]);
  });

  it("legend-kmjax still pages for a fresh alert received just under 24 h ago", async () => {
    const staff = await onDuty("Petugas alert segar");
    const recipients = await resolve(await raised({ ageMs: 23 * HOUR }));
    expect(ids(recipients)).toContain(staff.userId);
  });

  it("legend-kmjax does not page an off-duty holder when the outlet has nobody on duty, and does not fail", async () => {
    // Outlet A2 has only an off-duty holder of the permission.
    const sleeping = await newStaff("Tidur", { outlet: outletA2 });
    const recipients = await resolve(await raised({ outlet: outletA2 }));
    expect(ids(recipients)).not.toContain(sleeping.userId);
  });
});

describe("legend-kmjax panic_alert.raised isolation", () => {
  it("legend-kmjax never pages the on-duty staff of another outlet of the same tenant", async () => {
    const here = await onDuty("Di outlet A");
    const there = await onDuty("Di outlet A2", { outlet: outletA2 });

    const forA = ids(await resolve(await raised({ outlet: outletA })));
    expect(forA).toContain(here.userId);
    expect(forA).not.toContain(there.userId);

    const forA2 = ids(await resolve(await raised({ outlet: outletA2 })));
    expect(forA2).toContain(there.userId);
    expect(forA2).not.toContain(here.userId);
  });

  it("legend-kmjax never pages the on-duty staff of another tenant", async () => {
    const mine = await onDuty("Tenant A");
    const outletB = await seedOutlet(tenantB, "Outlet tenant B");
    const foreign = await onDuty("Tenant B", {
      tenant: tenantB,
      outlet: outletB,
    });

    const forA = ids(await resolve(await raised()));
    expect(forA).toContain(mine.userId);
    expect(forA).not.toContain(foreign.userId);

    const forB = ids(
      await resolve(
        await raised({ tenant: tenantB, outlet: outletB }),
        tenantB,
      ),
    );
    expect(forB).toContain(foreign.userId);
    expect(forB).not.toContain(mine.userId);
  });

  it("legend-kmjax an event that names a foreign tenant's outlet pages nobody of that outlet", async () => {
    const outletB = await seedOutlet(tenantB, "Outlet tenant B2");
    const foreign = await onDuty("Tenant B korban", {
      tenant: tenantB,
      outlet: outletB,
    });
    // Tenant A's context and envelope, but the payload points at tenant B.
    const event = await raised({ tenant: tenantB, outlet: outletB });
    const forged = eventEnvelopeSchema.parse({
      ...event,
      tenantId: tenantA.tenantId,
    });
    expect(ids(await resolveOrNobody(forged, tenantA))).not.toContain(
      foreign.userId,
    );
  });

  it("legend-kmjax an envelope outlet that disagrees with the stored alert does not page the alert's outlet staff", async () => {
    const victim = await onDuty("Outlet asli");
    const event = await raised({ outlet: outletA, envelopeOutlet: outletA2 });
    expect(ids(await resolveOrNobody(event))).not.toContain(victim.userId);
  });
});

describe("legend-po3fe production factory panic delivery", () => {
  const disabled = {
    NOTIFICATION_EMAIL_PROVIDER: "disabled",
    NOTIFICATION_PUSH_PROVIDER: "disabled",
    NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  };
  async function queuedFactoryPush() {
    const staff = await onDuty("Factory push receiver");
    const context = contextOf(tenantA.tenantId);
    const event = await raised();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const key = createECDH("prime256v1");
    key.generateKeys();
    const subscription = {
      endpoint,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    };
    const ciphertext = sealSecret(
      JSON.stringify(subscription),
      `push-subscription:${tenantA.tenantId}:${staff.userId}`,
    );
    // legend-ofq4f: a subscription only counts when it was registered with a
    // live login session for the alarm's outlet.
    const sessionId = randomUUID();
    await owner.query(
      `INSERT INTO "session" (id, expires_at, token, user_id) VALUES ($1, now() + interval '7 days', $2, $3)`,
      [sessionId, randomUUID(), staff.userId],
    );
    await owner.query(
      `INSERT INTO push_subscriptions (tenant_id,id,user_id,endpoint_hash,subscription_ciphertext,key_version,outlet_id,session_id,registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        tenantA.tenantId,
        randomUUID(),
        staff.userId,
        createHash("sha256").update(endpoint).digest("hex"),
        ciphertext,
        `v${sealedVersion(ciphertext)}`,
        outletA,
        sessionId,
      ],
    );
    const sent: unknown[][] = [];
    const options = {
      fetch: globalThis.fetch,
      webPushSend: async (...args: unknown[]) => {
        sent.push(args);
        return { statusCode: 201, headers: {}, body: "" };
      },
    };
    const handlers = createWorkerNotificationHandlers(
      database,
      {
        ...disabled,
        NOTIFICATION_PUSH_PROVIDER: "web_push",
        VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"),
        VAPID_PRIVATE_KEY: key.getPrivateKey().toString("base64url"),
        VAPID_SUBJECT: "mailto:push@example.test",
      },
      options,
    );
    const consume = createNotificationConsumer(
      context,
      handlers.resolveNotificationRecipients,
    );
    await withTenant(database, context, (tx) => consume(event, event.id, tx));
    await withTenant(database, context, (tx) => consume(event, event.id, tx));
    const attempts = (
      await owner.query<{ id: string; status: string }>(
        `SELECT a.id::text,a.status FROM delivery_attempts a JOIN notifications n ON n.id=a.notification_id AND n.tenant_id=a.tenant_id WHERE n.tenant_id=$1 AND n.user_id=$2 AND n.source_event_id=$3 AND a.channel=$$web_push$$`,
        [tenantA.tenantId, staff.userId, ulidToUuid(event.id)],
      )
    ).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("queued");
    const id = uuidToUlid(attempts[0]!.id);
    return {
      staff,
      event,
      context,
      id,
      handlers,
      sent,
      endpoint,
      subscription,
    };
  }
  it("sends once through the production consumer and delivery factory, including event replay", async () => {
    const { context, id, handlers, sent, endpoint, subscription, event } =
      await queuedFactoryPush();
    expect(
      await deliverNotificationAttempt(
        database,
        context,
        id,
        handlers.notificationDelivery,
      ),
    ).toBe("sent");
    expect(
      await deliverNotificationAttempt(
        database,
        context,
        id,
        handlers.notificationDelivery,
      ),
    ).toBe("not_due");
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toMatchObject({ endpoint, keys: subscription.keys });
    expect(JSON.parse(String(sent[0]![1]))).toMatchObject({
      data: { url: expect.stringContaining("/fasilitas/darurat") },
    });
    expect(JSON.parse(String(sent[0]![1])).data.url).toContain(
      event.aggregateId,
    );
  });
  it.each([
    "permission",
    "outlet",
    "duty",
    "inactive",
    "acknowledged",
    "resolved",
    "stale",
  ] as const)(
    "does not send a queued panic after its %s eligibility changes",
    async (change) => {
      const { staff, event, context, id, handlers, sent } =
        await queuedFactoryPush();
      const statements = {
        permission: [
          "DELETE FROM role_assignments WHERE tenant_id=$1 AND user_id=$2",
          [tenantA.tenantId, staff.userId],
        ],
        outlet: [
          "UPDATE role_assignments SET scope_id=$3 WHERE tenant_id=$1 AND user_id=$2",
          [tenantA.tenantId, staff.userId, outletA2],
        ],
        duty: [
          "DELETE FROM shift_assignments WHERE tenant_id=$1 AND employee_id=$2",
          [tenantA.tenantId, staff.employeeId],
        ],
        inactive: [
          "UPDATE employees SET status=$$suspended$$ WHERE tenant_id=$1 AND id=$2",
          [tenantA.tenantId, staff.employeeId],
        ],
        acknowledged: [
          "UPDATE panic_alerts SET acknowledged_at=now(),acknowledged_by=$3 WHERE tenant_id=$1 AND id=$2",
          [tenantA.tenantId, event.aggregateId, staff.userId],
        ],
        resolved: [
          "UPDATE panic_alerts SET resolved_at=now(),resolved_by=$3 WHERE tenant_id=$1 AND id=$2",
          [tenantA.tenantId, event.aggregateId, staff.userId],
        ],
      };
      try {
        if (change === "stale") {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date(Date.now() + 25 * HOUR));
          // Keep the receiver on duty: only the alert's 24 h age limit changes.
          await seedShift(staff, -HOUR, 7 * HOUR);
        } else {
          const [statement, values] = statements[change] as [string, string[]];
          await owner.query(statement, values);
        }
        const result = await deliverNotificationAttempt(
          database,
          context,
          id,
          handlers.notificationDelivery,
        );
        expect(result).not.toBe("sent");
        expect(sent).toHaveLength(0);
      } finally {
        if (change === "stale") vi.useRealTimers();
      }
    },
  );
  it("preserves a non-emergency notifications validated internal destination", async () => {
    const { staff, event, context, id, handlers, sent } =
      await queuedFactoryPush();
    const link = "/pos/pesanan?tab=siap";
    await owner.query(
      `UPDATE notifications SET category=$$order_ready$$,link=$4 WHERE tenant_id=$1 AND user_id=$2 AND source_event_id=$3`,
      [tenantA.tenantId, staff.userId, ulidToUuid(event.id), link],
    );
    expect(
      await deliverNotificationAttempt(
        database,
        context,
        id,
        handlers.notificationDelivery,
      ),
    ).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]![1]))).toMatchObject({
      data: { url: link },
    });
  });
  it("legend-ofq4f 791-4 disabled push keeps the in-app panic notification and does not reject the event", async () => {
    // Changed from "rejects": a missing push configuration must not drop the
    // in-app alarm or send the event to the dead-letter queue (architect 791 item 4).
    const staff = await onDuty("Penerima tanpa push");
    const event = await raised();
    const context = contextOf(tenantA.tenantId);
    const handlers = createWorkerNotificationHandlers(database, disabled);
    const consume = createNotificationConsumer(
      context,
      handlers.resolveNotificationRecipients,
    );
    await expect(
      withTenant(database, context, (tx) => consume(event, event.id, tx)),
    ).resolves.not.toThrow();
    const { rows } = await owner.query(
      `SELECT id FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND source_event_id=$3`,
      [tenantA.tenantId, staff.userId, ulidToUuid(event.id)],
    );
    expect(rows).toHaveLength(1);
    const pushAttempts = await owner.query(
      `SELECT a.id, a.status FROM delivery_attempts a JOIN notifications n ON n.id=a.notification_id AND n.tenant_id=a.tenant_id WHERE n.tenant_id=$1 AND n.user_id=$2 AND n.source_event_id=$3 AND a.channel=$$web_push$$`,
      [tenantA.tenantId, staff.userId, ulidToUuid(event.id)],
    );
    // Push is skipped: a row may exist but must not be waiting to be sent.
    expect(
      pushAttempts.rows.filter(
        (row: { status: string }) =>
          row.status === "queued" || row.status === "sent",
      ),
    ).toHaveLength(0);
  });
});

describe("legend-po3fe stored push subscription boundaries", () => {
  it("opens only for its own tenant and user and rejects corrupted ciphertext", async () => {
    const userId = randomUUID();
    const key = createECDH("prime256v1");
    key.generateKeys();
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/sealed-test",
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    };
    const sealed = await createPushSubscriptionProtector().seal(
      subscription,
      tenantA.tenantId,
      userId,
    );
    expect(
      openPushSubscription(
        sealed.ciphertext,
        tenantA.tenantId,
        userId,
        sealed.endpointHash,
      ),
    ).toEqual(subscription);
    expect(() =>
      openPushSubscription(
        sealed.ciphertext,
        tenantB.tenantId,
        userId,
        sealed.endpointHash,
      ),
    ).toThrow();
    expect(() =>
      openPushSubscription(
        sealed.ciphertext,
        tenantA.tenantId,
        randomUUID(),
        sealed.endpointHash,
      ),
    ).toThrow();
    expect(() =>
      openPushSubscription(
        `${sealed.ciphertext}corrupt`,
        tenantA.tenantId,
        userId,
        sealed.endpointHash,
      ),
    ).toThrow();
    expect(() =>
      openPushSubscription(
        sealed.ciphertext,
        tenantA.tenantId,
        userId,
        "wrong-endpoint-hash",
      ),
    ).toThrow();
  });
  it.each([
    "https://localhost/push",
    "https://127.0.0.1/push",
    "https://169.254.169.254/push",
    "https://fcm.googleapis.com.evil.test/push",
    "https://fcm.googleapis.com:8443/push",
    "https://user:pass@fcm.googleapis.com/push",
  ])("rejects an untrusted push service endpoint %s", (endpoint) => {
    expect(() => assertPushServiceEndpoint(endpoint)).toThrow();
  });
});
