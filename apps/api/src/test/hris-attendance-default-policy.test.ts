// Attendance clock-in under the DEFAULT policy (founder decision Q81; PRD v1.7
// F25 "Absensi", HR-02). A tenant that has stored no attendance policy must
// ACCEPT a clock-in made outside the geofence or from a device that is not
// bound, stored with validity "flagged" (reasons outside_geofence /
// device_not_bound) for HR to review, instead of rejecting it. A selfie stays
// mandatory: without one the submission is rejected (selfie_missing). A policy
// the tenant SAVED with outsideGeofenceAction / unboundDeviceAction "reject"
// still rejects. Runs the real Express app, Better Auth, RBAC and PostgreSQL
// against the seeded Cafe Legend tenant; pattern of hris-attendance-clock.test.ts.
// Written BEFORE the default changes: the default-flagged cases must fail first.
//
// Assumptions:
//  - "No stored policy" means no attendance_policies row for the outlet and no
//    tenant-default row (outlet_id IS NULL); the suite removes any leftover
//    tenant-default row first (files run one after another, fileParallelism off).
//  - A rejected submission answers 422 naming the reason; a flagged one answers
//    201 with validity "flagged" and the reasons show in the review queue.
//  - The selfie is a core_storage_objects row of purpose "selfie" owned by the
//    employee's user, referenced through photoUploadRef.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];

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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Client = ReturnType<typeof agent>;

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
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
        `Attendance default ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "tenant" ? [null] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

// Outlet centre; 0.0003 deg of latitude is ~33 m, 0.01 deg is ~1.1 km.
const CENTER = { latitude: -6.2, longitude: 106.8 };
const NEAR = { ...CENTER, latitude: CENTER.latitude + 0.0003 };
const FAR = { ...CENTER, latitude: CENTER.latitude + 0.01 };
const at = (point: { latitude: number; longitude: number }) => ({
  ...point,
  accuracyM: 5,
});

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `AD-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet absensi default ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi Default', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, userId, `AD-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

async function newStaff(outletId: string, name = "Staf Absensi Default") {
  const staff = await signedInClient(name);
  await grantRole(
    staff.userId,
    ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: [outletId] },
  );
  const employeeId = await seedEmployee(staff.userId, outletId);
  return { ...staff, employeeId, outletId };
}

const key = () => `att-api-${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

const deviceHash = () =>
  createHash("sha256").update(randomUUID()).digest("hex");

/** A selfie object owned by the employee's user, usable as photoUploadRef. */
async function seedSelfie(staff: { userId: string; outletId: string }) {
  const objectId = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          thumbnail_key, owner_user_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
      [
        tenant.id,
        staff.outletId,
        objectId,
        `selfie/${objectId}/original.webp`,
        `selfie/${objectId}/thumb.webp`,
        staff.userId,
      ],
    ),
  );
  return objectId;
}

async function bindDevice(staff: { client: Client }) {
  const hash = deviceHash();
  const bind = await post(staff.client, "/api/hris/attendance/devices/bind", {
    deviceIdHash: hash,
    label: "Ponsel default",
    idempotencyKey: key(),
  });
  expect(bind.status, JSON.stringify(bind.body)).toBe(201);
  return hash;
}

function clockBody(
  overrides: Partial<{
    type: string;
    method: string;
    location: unknown;
    deviceIdHash: string | null;
    qrToken: string | null;
    photoUploadRef: string | null;
    idempotencyKey: string;
  }> = {},
) {
  return {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: at(CENTER),
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
    ...overrides,
  };
}

const clock = (
  client: Client,
  overrides: Parameters<typeof clockBody>[0] = {},
) => post(client, "/api/hris/attendance/clock", clockBody(overrides));

async function storedLogs(employeeId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ id: string; validity: string }>(
      `SELECT id, validity FROM attendance_logs
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY occurred_at`,
      [tenant.id, employeeId],
    );
    return rows;
  });
}

const countedLogs = async (employeeId: string) =>
  (await storedLogs(employeeId)).filter((row) => row.validity !== "rejected");

async function reviewReasons(outletId: string, logId: string) {
  const queue = await mgr.get(
    `/api/hris/attendance/review-queue?outletId=${outletId}`,
  );
  expect(queue.status, JSON.stringify(queue.body)).toBe(200);
  const item = (
    queue.body.data as {
      log: { id: string };
      source: string;
      flagReasons: string[];
    }[]
  ).find((entry) => entry.log.id === logId);
  expect(item).toMatchObject({ source: "flagged" });
  return item?.flagReasons ?? [];
}

// ---- fixtures ---------------------------------------------------------------

let defaultOutlet: string; // no stored policy anywhere
let savedRejectOutlet: string; // stored policy: reject / reject

let mgr: Client;
let admin: Client;

beforeAll(async () => {
  defaultOutlet = await seedOutlet("tanpa kebijakan");
  savedRejectOutlet = await seedOutlet("kebijakan tersimpan tolak");
  const outlets = [defaultOutlet, savedRejectOutlet];

  // The default only applies when the tenant has no default row either.
  await asTenant((client) =>
    client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id IS NULL",
      [tenant.id],
    ),
  );

  const manager = await signedInClient("Manajer Absensi Default", {
    mfa: true,
  });
  await grantRole(manager.userId, ["hr.attendance.manage"], {
    type: "outlet",
    outletIds: outlets,
  });
  mgr = manager.client;

  const policyAdmin = await signedInClient("Admin Kebijakan Absensi Default", {
    mfa: true,
  });
  await grantRole(policyAdmin.userId, ["hr.attendance.manage"], {
    type: "tenant",
  });
  admin = policyAdmin.client;

  const saved = await put(admin, "/api/hris/attendance/policy", {
    outletId: savedRejectOutlet,
    policy: {
      geofenceRadiusM: 100,
      outsideGeofenceAction: "reject",
      unboundDeviceAction: "reject",
      requireSelfie: true,
      requireDeviceBinding: true,
      allowRotatingQr: true,
      selfieRetentionDays: 90,
    },
    sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[]) AND purpose = 'selfie'",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-api-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

// ---- default policy: accept and flag -----------------------------------------

describe("default policy (tenant has stored no policy)", () => {
  it("[Q81] a clock-in outside the geofence is accepted and flagged outside_geofence", async () => {
    const staff = await newStaff(defaultOutlet);
    const device = await bindDevice(staff);
    const response = await clock(staff.client, {
      location: at(FAR),
      deviceIdHash: device,
      photoUploadRef: await seedSelfie(staff),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("flagged");
    expect(await reviewReasons(defaultOutlet, response.body.data.id)).toContain(
      "outside_geofence",
    );
    expect(await countedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[Q81] a clock-in from a device that is not bound is accepted and flagged device_not_bound", async () => {
    const staff = await newStaff(defaultOutlet);
    const response = await clock(staff.client, {
      location: at(NEAR),
      deviceIdHash: deviceHash(),
      photoUploadRef: await seedSelfie(staff),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("flagged");
    expect(await reviewReasons(defaultOutlet, response.body.data.id)).toContain(
      "device_not_bound",
    );
    expect(await countedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[Q81] a clock-in inside the geofence from the bound device with a selfie stays valid", async () => {
    const staff = await newStaff(defaultOutlet);
    const device = await bindDevice(staff);
    const response = await clock(staff.client, {
      location: at(NEAR),
      deviceIdHash: device,
      photoUploadRef: await seedSelfie(staff),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("valid");
  });

  it("[Q81] the selfie stays mandatory: no selfie is rejected 422 selfie_missing", async () => {
    const staff = await newStaff(defaultOutlet);
    const device = await bindDevice(staff);
    const response = await clock(staff.client, {
      location: at(NEAR),
      deviceIdHash: device,
      photoUploadRef: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("selfie_missing");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[Q81] no selfie is still rejected when the clock-in is also outside the geofence", async () => {
    const staff = await newStaff(defaultOutlet);
    const response = await clock(staff.client, {
      location: at(FAR),
      deviceIdHash: deviceHash(),
      photoUploadRef: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("selfie_missing");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });
});

// ---- a policy the tenant saved keeps rejecting -------------------------------

describe("stored policy with reject actions", () => {
  it("[HR-02] outside the geofence is still rejected 422 outside_geofence", async () => {
    const staff = await newStaff(savedRejectOutlet);
    const device = await bindDevice(staff);
    const response = await clock(staff.client, {
      location: at(FAR),
      deviceIdHash: device,
      photoUploadRef: await seedSelfie(staff),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("outside_geofence");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[HR-02] an unbound device is still rejected 422 device_not_bound", async () => {
    const staff = await newStaff(savedRejectOutlet);
    const response = await clock(staff.client, {
      location: at(NEAR),
      deviceIdHash: deviceHash(),
      photoUploadRef: await seedSelfie(staff),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("device_not_bound");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[HR-02] a missing selfie is still rejected 422 selfie_missing", async () => {
    const staff = await newStaff(savedRejectOutlet);
    const device = await bindDevice(staff);
    const response = await clock(staff.client, {
      location: at(NEAR),
      deviceIdHash: device,
      photoUploadRef: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("selfie_missing");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });
});
