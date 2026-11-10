// Attendance clock-in/out over HTTP (PRD v1.7 F25 "Absensi", HR-02, §6 H
// `attendance_logs`; WS-10, bead legend-wh71). Runs the real Express app,
// Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend
// tenant. Expected behaviour comes from the PRD, the shared contract
// (packages/shared/src/hris/{attendance,endpoints}.ts) and the work brief, not
// from service code. Written BEFORE the implementation: it must fail first.
//
// Assumptions (the spec leaves these open):
//  - The clock route takes the outlet from the employee's home outlet; the
//    contract body carries no outlet id. Policy and geofence are therefore set
//    per outlet through PUT /api/hris/attendance/policy (outlet override) and
//    outlets.geofence, with the same radius in both.
//  - A rejected submission answers 422 and the body names the reasons (the
//    test searches the serialized body for the reason code). The brief says a
//    rejected row is stored with validity "rejected" for HR to see; the tests
//    only require that NO valid or flagged row exists, never how a rejected one
//    is shaped.
//  - Late / early-leave / overtime minutes are not on the wire contract, so they
//    are read from attendance_logs (late_minutes, early_leave_minutes,
//    overtime_minutes; brief §6 H table). Server time is the attendance time,
//    so shifts are seeded relative to "now" with a 1-minute tolerance for test
//    latency. No grace period is assumed (late = minutes after shift start).
//    With a shift but on time, late minutes is 0 or null; with no shift all
//    three are null (brief: "Tanpa shift: late/OT null").
//  - Clocking "out" does not need a prior "in" for the same day.
//  - The outlet QR is read by a manager holding hr.attendance.manage. A token
//    from a window older than the tolerance cannot be produced without waiting
//    minutes, so expiry is covered by a forged token and by a token issued
//    before the outlet secret was rotated.
//  - A second active device for the same employee is refused with 409 or 422
//    (the brief says at most one active device; it does not name the code).
//  - A same-key replay of clock-in answers the first log with a 2xx status and
//    adds no row.
//  - An employee reading another employee's logs or devices gets 403/404 or an
//    empty list, never the other person's rows.
//  - Corrections, the review decision, the selfie purge job and duty meals are
//    covered by their own suites; this file covers the clock path.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  getAttendanceQr,
  rotateAttendanceQrSecret,
} from "../services/hris-attendance.service.ts";
import {
  deriveQrDayKeys,
  qrDayIndexOfWindow,
  validateQr,
  seedQrKeySource,
  type QrKeySource,
} from "../services/hris-attendance-qr.ts";
import { qrWindowOf } from "../services/hris-attendance-logic.ts";
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
        `Attendance API ${roleId.slice(0, 8)}`,
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
        `AT-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet absensi ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string | null, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi API', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, userId, `AT-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

/** A signed-in employee of one outlet who may clock. */
async function newStaff(outletId: string, name = "Staf Absensi API") {
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

const basePolicy = {
  geofenceRadiusM: 100,
  outsideGeofenceAction: "reject",
  unboundDeviceAction: "reject",
  requireSelfie: false,
  requireDeviceBinding: false,
  allowRotatingQr: true,
  selfieRetentionDays: 90,
};
const noSampling = { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 };

async function setPolicy(
  admin: Client,
  outletId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await put(admin, "/api/hris/attendance/policy", {
    outletId,
    policy: { ...basePolicy, ...overrides },
    sampling: noSampling,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
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

const deviceHash = () =>
  createHash("sha256").update(randomUUID()).digest("hex");

type LogRow = {
  id: string;
  validity: string;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  overtime_minutes: number | null;
};

async function storedLogs(employeeId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<LogRow>(
      `SELECT id, validity, late_minutes, early_leave_minutes, overtime_minutes
         FROM attendance_logs
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY occurred_at`,
      [tenant.id, employeeId],
    );
    return rows;
  });
}

/** Rows that count toward work hours: anything not rejected. */
async function countedLogs(employeeId: string) {
  return (await storedLogs(employeeId)).filter(
    (row) => row.validity !== "rejected",
  );
}

async function storedLog(logId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<LogRow>(
      `SELECT id, validity, late_minutes, early_leave_minutes, overtime_minutes
         FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, ulidToUuid(logId)],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

// ---- shifts, seeded relative to "now" (server time is the attendance time) --

const MINUTE = 60_000;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % (24 * 60 * MINUTE);
  const untilMidnight = 24 * 60 * MINUTE - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

async function seedShift(
  staff: { employeeId: string; outletId: string },
  startMs: number,
  endMs: number,
) {
  await avoidOutletMidnight();
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        id,
        tenant.id,
        staff.outletId,
        staff.employeeId,
        wibDate(Date.now()),
        JSON.stringify([
          {
            startsAt: new Date(startMs).toISOString(),
            endsAt: new Date(endMs).toISOString(),
          },
        ]),
        mgrUserId,
      ],
    ),
  );
  return id;
}

// ---- fixtures ---------------------------------------------------------------

let geoRejectOutlet: string;
let geoFlagOutlet: string;
let deviceOutlet: string;
let qrOutlet: string;
let qrRotateOutlet: string;
let qrEdgeOutlet: string;
let shiftOutlet: string;
let ownOutlet: string;

let mgr: Client;
let mgrUserId: string;
let admin: Client;
let nobody: Client;

beforeAll(async () => {
  geoRejectOutlet = await seedOutlet("geofence tolak");
  geoFlagOutlet = await seedOutlet("geofence tandai");
  deviceOutlet = await seedOutlet("perangkat");
  qrOutlet = await seedOutlet("qr");
  qrRotateOutlet = await seedOutlet("qr rotasi");
  qrEdgeOutlet = await seedOutlet("qr edge");
  shiftOutlet = await seedOutlet("shift");
  ownOutlet = await seedOutlet("data sendiri");
  const outlets = [
    geoRejectOutlet,
    geoFlagOutlet,
    deviceOutlet,
    qrOutlet,
    qrRotateOutlet,
    qrEdgeOutlet,
    shiftOutlet,
    ownOutlet,
  ];

  const manager = await signedInClient("Manajer Absensi API", { mfa: true });
  await grantRole(
    manager.userId,
    [
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
      "hr.schedule.manage",
    ],
    { type: "outlet", outletIds: outlets },
  );
  mgr = manager.client;
  mgrUserId = manager.userId;

  const policyAdmin = await signedInClient("Admin Kebijakan Absensi API", {
    mfa: true,
  });
  await grantRole(policyAdmin.userId, ["hr.attendance.manage"], {
    type: "tenant",
  });
  admin = policyAdmin.client;

  const none = await signedInClient("Tanpa Izin Absensi API");
  await grantRole(none.userId, ["self.profile.view"], {
    type: "outlet",
    outletIds: [ownOutlet],
  });
  nobody = none.client;

  await setPolicy(admin, geoRejectOutlet);
  await setPolicy(admin, geoFlagOutlet, { outsideGeofenceAction: "flag" });
  await setPolicy(admin, deviceOutlet, { requireDeviceBinding: true });
  await setPolicy(admin, qrOutlet);
  await setPolicy(admin, qrRotateOutlet);
  await setPolicy(admin, qrEdgeOutlet);
  await setPolicy(admin, shiftOutlet, {
    geofenceRadiusM: 500,
  });
  await setPolicy(admin, ownOutlet);
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "attendance_corrections",
      "attendance_duty_meals",
      "attendance_logs",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    for (const table of ["attendance_policies", "attendance_qr_secrets"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
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

// ---- authentication and permissions -----------------------------------------

describe("authentication and permissions", () => {
  it("[F25] anonymous clock-in answers 401", async () => {
    const response = await post(
      agent(app),
      "/api/hris/attendance/clock",
      clockBody(),
    );
    expect(response.status).toBe(401);
  });

  it("[F25] a user without self.attendance.clock cannot clock in", async () => {
    const response = await clock(nobody);
    expect(response.status).toBe(403);
  });

  it("[F25] a body with a client-sent tenantId is refused 422", async () => {
    const staff = await newStaff(ownOutlet);
    const response = await post(staff.client, "/api/hris/attendance/clock", {
      ...clockBody(),
      tenantId: randomUUID(),
    });
    expect(response.status).toBe(422);
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });
});

// ---- geofence ----------------------------------------------------------------

describe("geofence", () => {
  it("[HR-02] a clock-in inside the radius is valid and shows the distance, not the coordinates", async () => {
    const staff = await newStaff(geoRejectOutlet);
    const response = await clock(staff.client, { location: at(NEAR) });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      employeeId: staff.employeeId,
      outletId: geoRejectOutlet,
      type: "in",
      method: "selfie_geo",
      validity: "valid",
    });
    expect(response.body.data.geoDistanceM).toBeGreaterThanOrEqual(25);
    expect(response.body.data.geoDistanceM).toBeLessThanOrEqual(45);
    // Raw coordinates are never stored or returned.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("latitude");
    expect(serialized).not.toContain("longitude");
    expect(serialized).not.toContain("106.8");
  });

  it("[HR-02] a clock-in outside the radius is rejected 422 and counts as no work time", async () => {
    const staff = await newStaff(geoRejectOutlet);
    const response = await clock(staff.client, { location: at(FAR) });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("outside_geofence");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);

    const logs = await staff.client.get(
      `/api/hris/attendance/logs?employeeId=${staff.employeeId}`,
    );
    expect(logs.status).toBe(200);
    expect(
      (logs.body.data as { validity: string }[]).filter(
        (log) => log.validity !== "rejected",
      ),
    ).toEqual([]);
  });

  it("[HR-02] a geofenced clock-in without coordinates is rejected like one outside the radius", async () => {
    const staff = await newStaff(geoRejectOutlet);
    const response = await clock(staff.client, { location: null });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("outside_geofence");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[HR-02] when the policy says flag, an outside clock-in is stored flagged and reaches the review queue", async () => {
    const staff = await newStaff(geoFlagOutlet);
    const response = await clock(staff.client, { location: at(FAR) });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("flagged");
    const logId = response.body.data.id as string;

    const queue = await mgr.get(
      `/api/hris/attendance/review-queue?outletId=${geoFlagOutlet}`,
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
    expect(item?.flagReasons).toContain("outside_geofence");
  });
});

// ---- device binding ----------------------------------------------------------

describe("device binding", () => {
  it("[HR-02] a device that is not bound to the employee is rejected 422", async () => {
    const staff = await newStaff(deviceOutlet);
    const response = await clock(staff.client, { deviceIdHash: deviceHash() });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("device_not_bound");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[HR-02] a clock-in with no device hash at all is rejected when binding is required", async () => {
    const staff = await newStaff(deviceOutlet);
    const response = await clock(staff.client, { deviceIdHash: null });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("device_not_bound");
  });

  it("[F25] the bound device clocks in; another device is rejected; HR reset lets the employee bind again", async () => {
    const staff = await newStaff(deviceOutlet);
    const bound = deviceHash();
    const other = deviceHash();

    const bind = await post(staff.client, "/api/hris/attendance/devices/bind", {
      deviceIdHash: bound,
      label: "Ponsel pribadi",
      idempotencyKey: key(),
    });
    expect(bind.status, JSON.stringify(bind.body)).toBe(201);
    expect(bind.body.data).toMatchObject({
      employeeId: staff.employeeId,
      label: "Ponsel pribadi",
      status: "active",
    });
    // The raw hash is never returned.
    expect(JSON.stringify(bind.body)).not.toContain(bound);
    const deviceId = bind.body.data.id as string;

    const accepted = await clock(staff.client, { deviceIdHash: bound });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.validity).toBe("valid");

    const refused = await clock(staff.client, {
      type: "out",
      deviceIdHash: other,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);

    // At most one active device per employee.
    const second = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      { deviceIdHash: other, label: "Ponsel kedua", idempotencyKey: key() },
    );
    expect([409, 422]).toContain(second.status);

    const revoked = await post(
      mgr,
      `/api/hris/attendance/devices/${deviceId}/revoke`,
      { reason: "Ponsel hilang", idempotencyKey: key() },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.data.status).toBe("revoked");

    const afterReset = await clock(staff.client, {
      type: "out",
      deviceIdHash: bound,
    });
    expect(afterReset.status, JSON.stringify(afterReset.body)).toBe(422);

    const rebind = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      { deviceIdHash: other, label: "Ponsel baru", idempotencyKey: key() },
    );
    expect(rebind.status, JSON.stringify(rebind.body)).toBe(201);
    const again = await clock(staff.client, {
      type: "out",
      deviceIdHash: other,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("[F25] re-sending a bind with the same idempotency key keeps one device", async () => {
    const staff = await newStaff(deviceOutlet);
    const body = {
      deviceIdHash: deviceHash(),
      label: "Ponsel replay",
      idempotencyKey: key(),
    };
    const first = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      body,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      body,
    );
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const list = await staff.client.get(
      `/api/hris/attendance/devices?employeeId=${staff.employeeId}`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("[F25] an employee cannot revoke a device; only HR can", async () => {
    const staff = await newStaff(deviceOutlet);
    const bind = await post(staff.client, "/api/hris/attendance/devices/bind", {
      deviceIdHash: deviceHash(),
      label: "Ponsel tetap",
      idempotencyKey: key(),
    });
    expect(bind.status, JSON.stringify(bind.body)).toBe(201);
    const response = await post(
      staff.client,
      `/api/hris/attendance/devices/${bind.body.data.id}/revoke`,
      { idempotencyKey: key() },
    );
    expect(response.status).toBe(403);
  });
});

// ---- rotating QR -------------------------------------------------------------

describe("rotating QR", () => {
  it("[F25] the current outlet QR is accepted", async () => {
    const staff = await newStaff(qrOutlet);
    const qr = await mgr.get(`/api/hris/attendance/qr?outletId=${qrOutlet}`);
    expect(qr.status, JSON.stringify(qr.body)).toBe(200);
    expect(qr.body.data).toMatchObject({
      outletId: qrOutlet,
      rotationSeconds: 30,
    });
    const response = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: qr.body.data.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      method: "rotating_qr",
      validity: "valid",
    });
  });

  it("[HR-02] a forged or expired QR token is rejected 422 and no valid log exists", async () => {
    const staff = await newStaff(qrOutlet);
    const response = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: "X".repeat(43),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("qr_token_invalid");
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[HR-02] a QR clock-in without a token is rejected", async () => {
    const staff = await newStaff(qrOutlet);
    const response = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await countedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[F25] a token shown before the outlet secret was rotated stops working", async () => {
    const staff = await newStaff(qrRotateOutlet);
    const before = await mgr.get(
      `/api/hris/attendance/qr?outletId=${qrRotateOutlet}`,
    );
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const oldToken = before.body.data.token as string;

    const rotated = await post(mgr, "/api/hris/attendance/qr/rotate", {
      outletId: qrRotateOutlet,
      idempotencyKey: key(),
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBeLessThan(300);

    const stale = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: oldToken,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(422);
    expect(JSON.stringify(stale.body)).toContain("qr_token_invalid");

    const fresh = await mgr.get(
      `/api/hris/attendance/qr?outletId=${qrRotateOutlet}`,
    );
    const accepted = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: fresh.body.data.token,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it("[F25] an employee cannot read the outlet QR", async () => {
    const staff = await newStaff(qrOutlet);
    const response = await staff.client.get(
      `/api/hris/attendance/qr?outletId=${qrOutlet}`,
    );
    expect(response.status).toBe(403);
  });
});

describe("T3 QR v2 in EDGE_MODE (card C4, legend-cku1m)", () => {
  const context = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id as never,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(qrEdgeOutlet)] },
    );
  const secretRows = async () =>
    asTenant(async (client) => {
      const { rows } = await client.query(
        "SELECT 1 FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = $2",
        [tenant.id, qrEdgeOutlet],
      );
      return rows.length;
    });
  const noKeys: QrKeySource = { dayKey: async () => null };

  it("the edge display with no key answers 503 QR_KEY_UNAVAILABLE and creates no seed", async () => {
    await expect(
      getAttendanceQr(
        context(),
        mgrUserId,
        { outletId: outletIdSchema.parse(qrEdgeOutlet) },
        new Date(),
        { edgeMode: true, keySource: noKeys },
      ),
    ).rejects.toMatchObject({ status: 503, code: "QR_KEY_UNAVAILABLE" });
    expect(await secretRows()).toBe(0);
  });

  it("the edge display with the real edge source (no key table row) also leaves attendance_qr_secrets empty", async () => {
    // Without C1's table the raw read fails; with it the read is empty. Either
    // way no seed may be created.
    await getAttendanceQr(
      context(),
      mgrUserId,
      { outletId: outletIdSchema.parse(qrEdgeOutlet) },
      new Date(),
      { edgeMode: true },
    ).catch(() => undefined);
    expect(await secretRows()).toBe(0);
  });

  it("rotateAttendanceQrSecret throws on an edge and writes nothing", async () => {
    await expect(
      rotateAttendanceQrSecret(
        context(),
        mgrUserId,
        {
          outletId: outletIdSchema.parse(qrEdgeOutlet),
          idempotencyKey: key(),
        },
        new Date(),
        { edgeMode: true },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(await secretRows()).toBe(0);
  });

  it("EDGE_MODE=true in the process but runtime state not yet flipped (boot window) still counts as an edge", async () => {
    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      const outletId = outletIdSchema.parse(qrEdgeOutlet);
      const shown = await getAttendanceQr(
        context(),
        mgrUserId,
        { outletId },
        new Date(),
      ).catch((error: unknown) => error);
      expect(shown).toBeInstanceOf(Error);
      await expect(
        rotateAttendanceQrSecret(context(), mgrUserId, {
          outletId,
          idempotencyKey: key(),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await secretRows()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
  });

  it("an edge never validates a QR clock-in itself (fails closed)", async () => {
    // Design §3.2/T4: the edge answers 400 to every method but outlet_device,
    // with or without a device token, so a cloud-valid QR never counts.
    const staff = await newStaff(qrEdgeOutlet);
    const shown = await mgr.get(
      `/api/hris/attendance/qr?outletId=${qrEdgeOutlet}`,
    );
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      const response = await clock(staff.client, {
        method: "rotating_qr",
        location: null,
        qrToken: shown.body.data.token,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error.code).toBe("ATTENDANCE_METHOD_NOT_ON_EDGE");
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
  });

  it("a token an edge shows (day key only) is accepted by the cloud clock-in", async () => {
    // Cloud creates the seed on first read; derive what the snapshot would send.
    const first = await mgr.get(
      `/api/hris/attendance/qr?outletId=${qrEdgeOutlet}`,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const { rows } = await asTenant((client) =>
      client.query(
        "SELECT seed FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = $2",
        [tenant.id, qrEdgeOutlet],
      ),
    );
    const seed = rows[0].seed as Buffer;
    const now = new Date();
    const day = qrDayIndexOfWindow(qrWindowOf(now.getTime()));
    const keys = new Map(
      deriveQrDayKeys(seed, tenant.id, qrEdgeOutlet, day - 1, 5).map(
        (entry) => [entry.dayIndex, entry.key] as const,
      ),
    );
    const edge: QrKeySource = {
      dayKey: async (_t, _o, d) => keys.get(d) ?? null,
    };
    const shown = await getAttendanceQr(
      context(),
      mgrUserId,
      { outletId: outletIdSchema.parse(qrEdgeOutlet) },
      now,
      { edgeMode: true, keySource: edge },
    );
    expect(shown.token.startsWith("2.")).toBe(true);
    expect(shown.token).toBe(first.body.data.token);
    const cloud = seedQrKeySource(async () => seed);
    expect(
      await validateQr(
        cloud,
        tenant.id,
        qrEdgeOutlet,
        shown.token,
        now.getTime(),
      ),
    ).toBe(true);
    const staff = await newStaff(qrEdgeOutlet);
    const response = await clock(staff.client, {
      method: "rotating_qr",
      location: null,
      qrToken: shown.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});

// ---- late, early leave and overtime against the shift ------------------------

describe("shift timing", () => {
  it("[F25] clocking in 25 minutes after the shift start records the lateness", async () => {
    const staff = await newStaff(shiftOutlet);
    const now = Date.now();
    const shiftId = await seedShift(
      staff,
      now - 25 * MINUTE,
      now + 4 * 60 * MINUTE,
    );
    const response = await clock(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.shiftAssignmentId).toBe(shiftId);
    const row = await storedLog(response.body.data.id);
    expect(row.late_minutes).toBeGreaterThanOrEqual(25);
    expect(row.late_minutes).toBeLessThanOrEqual(27);
  });

  it("[F25] clocking in before the shift start is not late", async () => {
    const staff = await newStaff(shiftOutlet);
    const now = Date.now();
    await seedShift(staff, now + 30 * MINUTE, now + 8 * 60 * MINUTE);
    const response = await clock(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await storedLog(response.body.data.id);
    expect(row.late_minutes ?? 0).toBe(0);
  });

  it("[F25] clocking out 90 minutes after the shift end records overtime", async () => {
    const staff = await newStaff(shiftOutlet);
    const now = Date.now();
    await seedShift(staff, now - 10 * 60 * MINUTE, now - 90 * MINUTE);
    const response = await clock(staff.client, { type: "out" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await storedLog(response.body.data.id);
    expect(row.overtime_minutes).toBeGreaterThanOrEqual(90);
    expect(row.overtime_minutes).toBeLessThanOrEqual(92);
    expect(row.early_leave_minutes ?? 0).toBe(0);
  });

  it("[F25] clocking out 60 minutes before the shift end records an early leave and no overtime", async () => {
    const staff = await newStaff(shiftOutlet);
    const now = Date.now();
    await seedShift(staff, now - 6 * 60 * MINUTE, now + 60 * MINUTE);
    const response = await clock(staff.client, { type: "out" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await storedLog(response.body.data.id);
    expect(row.early_leave_minutes).toBeGreaterThanOrEqual(59);
    expect(row.early_leave_minutes).toBeLessThanOrEqual(61);
    expect(row.overtime_minutes ?? 0).toBe(0);
  });

  it("[F25] with no shift that day, late, early-leave and overtime stay empty", async () => {
    const staff = await newStaff(shiftOutlet);
    const clockIn = await clock(staff.client);
    expect(clockIn.status, JSON.stringify(clockIn.body)).toBe(201);
    expect(clockIn.body.data.shiftAssignmentId).toBeNull();
    const clockOut = await clock(staff.client, { type: "out" });
    expect(clockOut.status, JSON.stringify(clockOut.body)).toBe(201);
    for (const id of [clockIn.body.data.id, clockOut.body.data.id]) {
      const row = await storedLog(id);
      expect(row.late_minutes).toBeNull();
      expect(row.early_leave_minutes).toBeNull();
      expect(row.overtime_minutes).toBeNull();
    }
  });

  it("[F25] a cancelled shift is not used to judge lateness", async () => {
    const staff = await newStaff(shiftOutlet);
    const now = Date.now();
    const shiftId = await seedShift(
      staff,
      now - 25 * MINUTE,
      now + 4 * 60 * MINUTE,
    );
    await asTenant((client) =>
      client.query(
        "UPDATE shift_assignments SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, shiftId],
      ),
    );
    const response = await clock(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.shiftAssignmentId).toBeNull();
    expect((await storedLog(response.body.data.id)).late_minutes).toBeNull();
  });
});

// ---- idempotency -------------------------------------------------------------

describe("manual correction method", () => {
  it("[F25] the clock endpoint refuses method manual_correction 422 and stores no log", async () => {
    const staff = await newStaff(ownOutlet, "Staf Koreksi Palsu");
    const response = await clock(staff.client, { method: "manual_correction" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await storedLogs(staff.employeeId)).toHaveLength(0);
  });
});

describe("outlet_device method (legend-hwn02)", () => {
  it("[F25] the clock endpoint refuses method outlet_device 422 until the edge path exists and stores no log", async () => {
    const staff = await newStaff(ownOutlet, "Staf Layar Outlet Palsu");
    const response = await clock(staff.client, { method: "outlet_device" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await storedLogs(staff.employeeId)).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("[F25] re-sending a clock-in with the same idempotency key returns the same log and adds none", async () => {
    const staff = await newStaff(ownOutlet);
    const body = clockBody();
    const first = await post(staff.client, "/api/hris/attendance/clock", body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post(staff.client, "/api/hris/attendance/clock", body);
    expect(replay.status, JSON.stringify(replay.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.occurredAt).toBe(first.body.data.occurredAt);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);

    const list = await staff.client.get(
      `/api/hris/attendance/logs?employeeId=${staff.employeeId}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("[F25] many concurrent re-sends of one clock-in still make one log", async () => {
    const staff = await newStaff(ownOutlet);
    const body = clockBody();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(staff.client, "/api/hris/attendance/clock", body),
      ),
    );
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] concurrent re-sends of one clock-in with a selfie return the same log, not 422", async () => {
    const staff = await newStaff(ownOutlet, "Staf Selfie Kembar");
    const objectId = randomUUID();
    await asTenant((client) =>
      client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, owner_user_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
        [
          tenant.id,
          ownOutlet,
          objectId,
          `selfie/${objectId}/original.webp`,
          `selfie/${objectId}/thumb.webp`,
          staff.userId,
        ],
      ),
    );
    const body = clockBody({ photoUploadRef: objectId } as never);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(staff.client, "/api/hris/attendance/clock", body),
      ),
    );
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] a different key is a different event and makes a new log", async () => {
    const staff = await newStaff(ownOutlet);
    const first = await clock(staff.client);
    const second = await clock(staff.client, { type: "out" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(await storedLogs(staff.employeeId)).toHaveLength(2);
  });
});

// ---- employees see only their own data ---------------------------------------

describe("own data only", () => {
  it("[F25] an employee lists only their own logs, and cannot read a colleague's", async () => {
    const a = await newStaff(ownOutlet, "Staf A Absensi");
    const b = await newStaff(ownOutlet, "Staf B Absensi");
    const logA = await clock(a.client);
    const logB = await clock(b.client);
    expect(logA.status, JSON.stringify(logA.body)).toBe(201);
    expect(logB.status, JSON.stringify(logB.body)).toBe(201);

    const ownList = await a.client.get("/api/hris/attendance/logs");
    expect(ownList.status, JSON.stringify(ownList.body)).toBe(200);
    const ownIds = (ownList.body.data as { id: string }[]).map((row) => row.id);
    expect(ownIds).toContain(logA.body.data.id);
    expect(ownIds).not.toContain(logB.body.data.id);

    const peek = await a.client.get(
      `/api/hris/attendance/logs?employeeId=${b.employeeId}`,
    );
    if (peek.status === 200)
      expect(
        (peek.body.data as { id: string }[]).map((row) => row.id),
      ).not.toContain(logB.body.data.id);
    else expect([403, 404]).toContain(peek.status);
    expect(JSON.stringify(peek.body)).not.toContain(logB.body.data.id);
  });

  it("[F25] an employee cannot list a colleague's devices", async () => {
    const a = await newStaff(deviceOutlet, "Staf A Perangkat");
    const b = await newStaff(deviceOutlet, "Staf B Perangkat");
    const bind = await post(b.client, "/api/hris/attendance/devices/bind", {
      deviceIdHash: deviceHash(),
      label: "Ponsel B",
      idempotencyKey: key(),
    });
    expect(bind.status, JSON.stringify(bind.body)).toBe(201);

    const peek = await a.client.get(
      `/api/hris/attendance/devices?employeeId=${b.employeeId}`,
    );
    if (peek.status === 200) expect(peek.body.data).toEqual([]);
    else expect([403, 404]).toContain(peek.status);
    expect(JSON.stringify(peek.body)).not.toContain(bind.body.data.id);
  });

  it("[F25] a manager of the outlet sees the employee's logs by employee filter", async () => {
    const a = await newStaff(ownOutlet, "Staf Dilihat Manajer");
    const log = await clock(a.client);
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    const response = await mgr.get(
      `/api/hris/attendance/logs?employeeId=${a.employeeId}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (response.body.data as { id: string }[]).map((row) => row.id),
    ).toEqual([log.body.data.id]);
  });

  it("[F25] a manager sees no device hash of an employee's log; the employee sees their own", async () => {
    const a = await newStaff(ownOutlet, "Staf Hash Perangkat");
    const hash = deviceHash();
    const log = await clock(a.client, { deviceIdHash: hash });
    expect(log.status, JSON.stringify(log.body)).toBe(201);

    const asManager = await mgr.get(
      `/api/hris/attendance/logs?employeeId=${a.employeeId}`,
    );
    expect(asManager.status, JSON.stringify(asManager.body)).toBe(200);
    expect(asManager.body.data).toHaveLength(1);
    expect(asManager.body.data[0].deviceIdHash).toBeNull();
    expect(JSON.stringify(asManager.body)).not.toContain(hash);

    const own = await a.client.get("/api/hris/attendance/logs");
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data[0].deviceIdHash).toBe(hash);
  });

  it("[F25] a manager outside the outlet scope cannot read that outlet's logs", async () => {
    const outsider = await signedInClient("Manajer Luar Absensi", {
      mfa: true,
    });
    await grantRole(outsider.userId, ["hr.attendance.manage"], {
      type: "outlet",
      outletIds: [geoRejectOutlet],
    });
    const a = await newStaff(ownOutlet, "Staf Luar Jangkauan");
    const log = await clock(a.client);
    expect(log.status, JSON.stringify(log.body)).toBe(201);

    const response = await outsider.client.get(
      `/api/hris/attendance/logs?employeeId=${a.employeeId}`,
    );
    if (response.status === 200) expect(response.body.data).toEqual([]);
    else expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(log.body.data.id);
  });

  it("[F25] anonymous reads of logs, devices and the review queue answer 401", async () => {
    const anonymous = agent(app);
    for (const path of [
      "/api/hris/attendance/logs",
      "/api/hris/attendance/devices",
      "/api/hris/attendance/review-queue",
      `/api/hris/attendance/qr?outletId=${qrOutlet}`,
    ])
      expect((await anonymous.get(path)).status, path).toBe(401);
  });
});
