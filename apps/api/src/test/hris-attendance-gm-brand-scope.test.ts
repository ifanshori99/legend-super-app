// Q41 (founder decision): a General Manager scoped to a BRAND sees ALL
// employees of that brand in attendance (logs, selfie review queue, manual
// corrections, devices), not only direct reports. The rule is keyed on the
// BRAND scope of the caller's hr.attendance.manage assignment (not on
// hr.employee.manage and not on a role name) and stops at the brand's outlets.
// Outlet-scoped holders (supervisor) keep direct reports only; tenant-wide
// holders keep everything. Everything runs through HTTP against the real app.
//
// Layout: brand A (the fixture brand) has outlets A1 and A2, brand B has
// outlet B1. Every seeded employee has manager_id NULL, so a direct-report
// rule would show nothing; the supervisor's only direct report is subSup.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidToUlid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const KEY_PREFIX = "att-gm-brand-";
const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/selfie/${objectId}?sig=fake`;

const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) => signedUrlFor(objectId),
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

type Client = ReturnType<typeof agent>;
type JsonRow = Record<string, unknown>;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdLogs: string[] = [];
const createdCorrections: string[] = [];
const createdObjects: string[] = [];
const createdOutlets: string[] = [];
const brandA = cafeLegendPlatformFixtures.brand.id;
const brandB = randomUUID();
let outletA1: string;
let outletA2: string;
let outletB1: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

// No hr.employee.manage: the rule must come from the brand scope alone.
const ATTENDANCE_PERMISSIONS = [
  "hr.attendance.manage",
  "hr.attendance_correction.approve",
];

async function grantRole(
  userId: string,
  scope:
    | { type: "brand"; brandId: string }
    | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `GM brand scope ${roleId.slice(0, 8)}`,
        JSON.stringify(ATTENDANCE_PERMISSIONS),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "brand" ? [scope.brandId] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

const CENTER = { latitude: -6.2, longitude: 106.8 };

async function seedOutlet(brandId: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet GM brand', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        brandId,
        cafeLegendPlatformFixtures.legalEntity.id,
        `GB-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(options: {
  userId: string | null;
  managerId: string | null;
  name: string;
  homeOutletId: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenant.id,
        options.userId,
        `GB-${id.slice(0, 8).toUpperCase()}`,
        options.name,
        options.homeOutletId,
        options.managerId,
      ],
    ),
  );
  return id;
}

async function seedFlaggedLog(employeeId: string, outletId: string) {
  const logId = randomUUID();
  const objectId = randomUUID();
  createdLogs.push(logId);
  createdObjects.push(objectId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          source_kind, source_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, 'attendance', $5)`,
      [
        tenant.id,
        outletId,
        objectId,
        `selfie/${objectId}/original.webp`,
        logId,
      ],
    );
    await client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, business_date, client_event_id, photo_key)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 500, 'flagged',
               (now() AT TIME ZONE 'UTC')::date, $5, $6)`,
      [
        logId,
        tenant.id,
        outletId,
        employeeId,
        `${KEY_PREFIX}${randomUUID()}`,
        objectId,
      ],
    );
  });
  return { logId, objectId, apiId: uuidToUlid(logId) };
}

async function seedCorrection(employeeId: string, outletId: string) {
  const id = randomUUID();
  createdCorrections.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'Lupa absen pulang', $5, $6)`,
      [id, tenant.id, outletId, employeeId, randomUUID(), `${KEY_PREFIX}${id}`],
    ),
  );
  return id;
}

async function seedDevice(employeeId: string) {
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_devices (id, tenant_id, employee_id, device_id_hash, label)
       VALUES ($1, $2, $3, $4, 'HP gm brand')`,
      [
        id,
        tenant.id,
        employeeId,
        (randomUUID() + randomUUID()).replaceAll("-", ""),
      ],
    ),
  );
  return id;
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

async function collectAll(client: Client, path: string) {
  const rows: JsonRow[] = [];
  const bodies: unknown[] = [];
  let status = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    status = response.status;
    bodies.push(response.body);
    if (status !== 200) break;
    rows.push(...(response.body.data as JsonRow[]));
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return { status, rows, text: JSON.stringify(bodies) };
}

const queueIds = (rows: JsonRow[]) =>
  rows.map((row) => String((row.log as JsonRow).id).toUpperCase());
const rowIds = (rows: JsonRow[]) =>
  rows.map((row) => String(row.id).toUpperCase());
const lowerIds = (rows: JsonRow[]) =>
  rows.map((row) => String(row.id).toLowerCase());

let gm: Awaited<ReturnType<typeof signedInClient>>;
let sup: Awaited<ReturnType<typeof signedInClient>>;
let subA1: string;
let subA2: string;
let subB1: string;
let subSup: string;
let logA1: Awaited<ReturnType<typeof seedFlaggedLog>>;
let logA2: Awaited<ReturnType<typeof seedFlaggedLog>>;
let logB1: Awaited<ReturnType<typeof seedFlaggedLog>>;
let corrA1: string;
let corrA2: string;
let corrB1: string;
let devA1: string;
let devA2: string;
let devB1: string;

beforeAll(async () => {
  await asTenant((client) =>
    client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B GM scope')`,
      [brandB, tenant.id, `gb-${brandB.slice(0, 8)}`],
    ),
  );
  outletA1 = await seedOutlet(brandA);
  outletA2 = await seedOutlet(brandA);
  outletB1 = await seedOutlet(brandB);

  gm = await signedInClient("GM Brand Scope");
  sup = await signedInClient("Supervisor Brand Scope");
  await grantRole(gm.userId, { type: "brand", brandId: brandA });
  await grantRole(sup.userId, { type: "outlet", outletIds: [outletA1] });

  const supEmployee = await seedEmployee({
    userId: sup.userId,
    managerId: null,
    name: "Supervisor Brand Scope",
    homeOutletId: outletA1,
  });
  await seedEmployee({
    userId: gm.userId,
    managerId: null,
    name: "GM Brand Scope",
    homeOutletId: outletA1,
  });
  // manager_id stays NULL for everyone except the supervisor's one report.
  subA1 = await seedEmployee({
    userId: null,
    managerId: null,
    name: "Karyawan A1",
    homeOutletId: outletA1,
  });
  subA2 = await seedEmployee({
    userId: null,
    managerId: null,
    name: "Karyawan A2",
    homeOutletId: outletA2,
  });
  subB1 = await seedEmployee({
    userId: null,
    managerId: null,
    name: "Karyawan B1",
    homeOutletId: outletB1,
  });
  subSup = await seedEmployee({
    userId: null,
    managerId: supEmployee,
    name: "Bawahan Supervisor A1",
    homeOutletId: outletA1,
  });
  logA1 = await seedFlaggedLog(subA1, outletA1);
  logA2 = await seedFlaggedLog(subA2, outletA2);
  logB1 = await seedFlaggedLog(subB1, outletB1);
  corrA1 = await seedCorrection(subA1, outletA1);
  corrA2 = await seedCorrection(subA2, outletA2);
  corrB1 = await seedCorrection(subB1, outletB1);
  devA1 = await seedDevice(subA1);
  devA2 = await seedDevice(subA2);
  devB1 = await seedDevice(subB1);
}, 120_000);

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await owner.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND (id = ANY($2::uuid[]) OR outlet_id = ANY($3::uuid[]))",
      [tenant.id, createdLogs, createdOutlets],
    );
    await owner.query(
      "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND (id = ANY($2::uuid[]) OR outlet_id = ANY($3::uuid[]))",
      [tenant.id, createdCorrections, createdOutlets],
    );
    await owner.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await owner.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1 AND (event->>'objectId' = ANY($2::text[])
           OR event->>'actorId' = ANY($3::text[]))`,
      [
        tenant.id,
        [...createdLogs.map(uuidToUlid), ...createdCorrections],
        createdUsers,
      ],
    );
    await owner.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdObjects],
    );
    await owner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await owner.query(
      "DELETE FROM outlets WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await owner.query("DELETE FROM brands WHERE tenant_id = $1 AND id = $2", [
      tenant.id,
      brandB,
    ]);
    await owner.query("COMMIT");
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

const reviewQueue = (client: Client, outletId: string) =>
  collectAll(client, `/api/hris/attendance/review-queue?outletId=${outletId}`);

describe("[Q41] brand-scoped General Manager sees every employee of the brand", () => {
  it("lists logs of A1 and A2 employees, none of brand B", async () => {
    for (const [outletId, expected] of [
      [outletA1, logA1],
      [outletA2, logA2],
    ] as const) {
      const list = await collectAll(
        gm.client,
        `/api/hris/attendance/logs?outletId=${outletId}`,
      );
      expect(list.status, list.text).toBe(200);
      expect(rowIds(list.rows)).toContain(expected.apiId);
    }
    const leak = await collectAll(
      gm.client,
      `/api/hris/attendance/logs?employeeId=${subB1}`,
    );
    if (leak.status === 200) expect(leak.rows).toHaveLength(0);
    else expect([403, 404]).toContain(leak.status);
    expect(leak.text).not.toContain(logB1.apiId);
    expect(leak.text).not.toContain(logB1.objectId);
  });

  it("lists the selfie review queue of A1 and A2, hides brand B", async () => {
    const queueA1 = await reviewQueue(gm.client, outletA1);
    expect(queueA1.status, queueA1.text).toBe(200);
    expect(queueIds(queueA1.rows)).toContain(logA1.apiId);
    expect(queueA1.text).toContain(signedUrlFor(logA1.objectId));
    const queueA2 = await reviewQueue(gm.client, outletA2);
    expect(queueA2.status, queueA2.text).toBe(200);
    expect(queueIds(queueA2.rows)).toContain(logA2.apiId);
    const queueB1 = await reviewQueue(gm.client, outletB1);
    if (queueB1.status === 200) expect(queueB1.rows).toHaveLength(0);
    else expect([403, 404]).toContain(queueB1.status);
    expect(queueB1.text).not.toContain(logB1.objectId);
  });

  it("lists corrections of A1 and A2, never brand B", async () => {
    const list = await collectAll(
      gm.client,
      "/api/hris/attendance/corrections",
    );
    expect(list.status, list.text).toBe(200);
    expect(lowerIds(list.rows)).toContain(corrA1);
    expect(lowerIds(list.rows)).toContain(corrA2);
    expect(lowerIds(list.rows)).not.toContain(corrB1);
    expect(list.text).not.toContain(subB1);
  });

  it("lists devices of A1 and A2, never brand B", async () => {
    const list = await collectAll(gm.client, "/api/hris/attendance/devices");
    expect(list.status, list.text).toBe(200);
    const ids = lowerIds(list.rows);
    expect(ids).toContain(devA1);
    expect(ids).toContain(devA2);
    expect(ids).not.toContain(devB1);
  });

  it("decides a review in A2 and gets 404 on brand B, changing nothing", async () => {
    const own = await seedFlaggedLog(subA2, outletA2);
    const accepted = await post(
      gm.client,
      `/api/hris/attendance/logs/${own.apiId}/review`,
      { action: "accept", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.log.validity).toBe("valid");

    const refused = await post(
      gm.client,
      `/api/hris/attendance/logs/${logB1.apiId}/review`,
      { action: "reject", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    const { rows } = await owner.query(
      "SELECT validity, review_status FROM attendance_logs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, logB1.logId],
    );
    expect(rows[0]).toEqual({ validity: "flagged", review_status: "none" });
  });

  it("refuses to revoke a brand B device with 404 and revokes one in A2", async () => {
    const refused = await post(
      gm.client,
      `/api/hris/attendance/devices/${devB1}/revoke`,
      { idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    const revoked = await post(
      gm.client,
      `/api/hris/attendance/devices/${devA2}/revoke`,
      { idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });
});

describe("[Q41] an outlet-scoped supervisor still sees direct reports only", () => {
  it("hides A1 employees who are not direct reports, in logs, queue, corrections and devices", async () => {
    const queue = await reviewQueue(sup.client, outletA1);
    expect(queue.status, queue.text).toBe(200);
    expect(queueIds(queue.rows)).not.toContain(logA1.apiId);
    const corrections = await collectAll(
      sup.client,
      "/api/hris/attendance/corrections",
    );
    expect(corrections.status, corrections.text).toBe(200);
    expect(lowerIds(corrections.rows)).not.toContain(corrA1);
    const devices = await collectAll(
      sup.client,
      "/api/hris/attendance/devices",
    );
    expect(devices.status, devices.text).toBe(200);
    expect(lowerIds(devices.rows)).not.toContain(devA1);
    const logs = await collectAll(
      sup.client,
      `/api/hris/attendance/logs?outletId=${outletA1}`,
    );
    if (logs.status === 200)
      expect(rowIds(logs.rows)).not.toContain(logA1.apiId);
    else expect([403, 404]).toContain(logs.status);
  });

  it("still sees and decides a direct report's flagged log", async () => {
    const own = await seedFlaggedLog(subSup, outletA1);
    const queue = await reviewQueue(sup.client, outletA1);
    expect(queueIds(queue.rows)).toContain(own.apiId);
    const response = await post(
      sup.client,
      `/api/hris/attendance/logs/${own.apiId}/review`,
      { action: "accept", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});
