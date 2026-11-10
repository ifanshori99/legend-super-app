// Fail-first tests for bead legend-whiwv (414 HRIS absensi fix), findings 1, 5, 6.
// Same setup as hris-attendance-clock.test.ts: real Express app, Better Auth,
// RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant.
// Expected behaviour comes from docs/briefs/414-hris-attendance-fix.md, not from
// service code.
//
// Assumptions:
//  - F1: the clock permission (self.attendance.clock) is outlet-scoped. An
//    employee whose assignment covers only outlet A, but whose shift and home
//    outlet are B, is refused 403 and no log is stored.
//  - F5: a retry with the same idempotency key answers the ORIGINAL log (2xx,
//    same id, no new row) even after the shift or home outlet changed, because
//    the key's owner is looked up before the outlet is re-picked. The brief says
//    "look up the original log with owner authorization first"; test 5c takes
//    that to mean the owner may replay even where the current outlet pick is no
//    longer within their permission scope.
//  - F6: two or more concurrent identical requests (same key, same
//    photoUploadRef) all succeed with 201 and the same log id. Races are
//    probabilistic, so the test runs several rounds with fresh selfies; any
//    single losing request fails it.
import { randomUUID } from "node:crypto";
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
        `Attendance 414 ${roleId.slice(0, 8)}`,
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

const CENTER = { latitude: -6.2, longitude: 106.8 };
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
        `A4-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet absensi 414 ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi 414', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `A4-${id.slice(0, 8).toUpperCase()}`,
        homeOutletId,
      ],
    ),
  );
  return id;
}

/**
 * A signed-in employee whose home outlet is `homeOutletId` and whose clock
 * permission is assigned only at `permittedOutletIds`.
 */
async function newStaff(
  homeOutletId: string,
  permittedOutletIds: string[],
  name = "Staf Absensi 414",
) {
  const staff = await signedInClient(name);
  await grantRole(
    staff.userId,
    ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: permittedOutletIds },
  );
  const employeeId = await seedEmployee(staff.userId, homeOutletId);
  return { ...staff, employeeId };
}

const key = () => `att-api-414-${randomUUID()}`;
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

async function setPolicy(admin: Client, outletId: string) {
  const response = await put(admin, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: noSampling,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

function clockBody(
  overrides: Partial<{
    type: string;
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

const clockWith = (client: Client, body: ReturnType<typeof clockBody>) =>
  post(client, "/api/hris/attendance/clock", body);

async function storedLogs(employeeId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ id: string; validity: string }>(
      `SELECT id, validity FROM attendance_logs
        WHERE tenant_id = $1 AND employee_id = $2 ORDER BY occurred_at`,
      [tenant.id, employeeId],
    );
    return rows;
  });
}

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

/** A published shift covering "now", at `outletId`. */
async function seedShiftNow(employeeId: string, outletId: string) {
  await avoidOutletMidnight();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        randomUUID(),
        tenant.id,
        outletId,
        employeeId,
        wibDate(Date.now()),
        JSON.stringify([
          {
            startsAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
            endsAt: new Date(Date.now() + 8 * 60 * MINUTE).toISOString(),
          },
        ]),
        mgrUserId,
      ],
    ),
  );
}

async function seedSelfie(outletId: string, userId: string) {
  const objectId = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          thumbnail_key, owner_user_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
      [
        tenant.id,
        outletId,
        objectId,
        `selfie/${objectId}/original.webp`,
        `selfie/${objectId}/thumb.webp`,
        userId,
      ],
    ),
  );
  return objectId;
}

// ---- fixtures ---------------------------------------------------------------

let outletA: string;
let outletB: string;
let mgrUserId: string;

beforeAll(async () => {
  outletA = await seedOutlet("A");
  outletB = await seedOutlet("B");

  const manager = await signedInClient("Manajer Absensi 414", { mfa: true });
  await grantRole(manager.userId, ["hr.schedule.manage"], {
    type: "outlet",
    outletIds: [outletA, outletB],
  });
  mgrUserId = manager.userId;

  const policyAdmin = await signedInClient("Admin Kebijakan Absensi 414", {
    mfa: true,
  });
  await grantRole(policyAdmin.userId, ["hr.attendance.manage"], {
    type: "tenant",
  });
  await setPolicy(policyAdmin.client, outletA);
  await setPolicy(policyAdmin.client, outletB);
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-api-414-%'",
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

// ---- finding 1: clock permission is checked at the target outlet -------------

describe("[F25] 414 finding 1: clock permission is scoped to the target outlet", () => {
  it("[F25] an employee permitted to clock only at outlet A is refused 403 when their shift and home outlet are B", async () => {
    const staff = await newStaff(outletB, [outletA], "Staf Izin Outlet A");
    await seedShiftNow(staff.employeeId, outletB);

    const response = await clockWith(staff.client, clockBody());
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await storedLogs(staff.employeeId)).toHaveLength(0);
  });

  it("[F25] control: the same setup with clock permission at outlet B too clocks in 201", async () => {
    const staff = await newStaff(
      outletB,
      [outletA, outletB],
      "Staf Izin A dan B",
    );
    await seedShiftNow(staff.employeeId, outletB);

    const response = await clockWith(staff.client, clockBody());
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });
});

// ---- finding 5: a retry answers the original log -----------------------------

describe("[F25] 414 finding 5: retry with the same key returns the original log", () => {
  it("[F25] a retry after a shift at another outlet was published returns the original log", async () => {
    const staff = await newStaff(
      outletA,
      [outletA, outletB],
      "Staf Retry Shift",
    );
    const body = clockBody();
    const first = await clockWith(staff.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The schedule changes between the first attempt and the retry.
    await seedShiftNow(staff.employeeId, outletB);

    const retry = await clockWith(staff.client, body);
    expect(retry.status, JSON.stringify(retry.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] a retry after the home outlet changed returns the original log", async () => {
    const staff = await newStaff(
      outletA,
      [outletA, outletB],
      "Staf Retry Pindah",
    );
    const body = clockBody();
    const first = await clockWith(staff.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    await asTenant((client) =>
      client.query(
        "UPDATE employees SET home_outlet_id = $1 WHERE tenant_id = $2 AND id = $3",
        [outletB, tenant.id, staff.employeeId],
      ),
    );

    const retry = await clockWith(staff.client, body);
    expect(retry.status, JSON.stringify(retry.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] the owner still gets the original log when the new outlet is outside their clock permission", async () => {
    const staff = await newStaff(outletA, [outletA], "Staf Retry Luar Izin");
    const body = clockBody();
    const first = await clockWith(staff.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    await seedShiftNow(staff.employeeId, outletB);

    const retry = await clockWith(staff.client, body);
    expect(retry.status, JSON.stringify(retry.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await storedLogs(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] another employee cannot replay the key to read the original log", async () => {
    const a = await newStaff(outletA, [outletA], "Staf Pemilik Kunci");
    const b = await newStaff(outletA, [outletA], "Staf Peniru Kunci");
    const body = clockBody();
    const first = await clockWith(a.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replay = await clockWith(b.client, body);
    expect(JSON.stringify(replay.body)).not.toContain(first.body.data.id);
    expect(await storedLogs(a.employeeId)).toHaveLength(1);
  });
});

// ---- finding 6: concurrent identical requests with a selfie ------------------

describe("[F25] 414 finding 6: concurrent identical requests with one selfie", () => {
  it("[F25] concurrent requests with the same key and the same photoUploadRef all succeed with the same log id", async () => {
    const ROUNDS = 8;
    const PARALLEL = 16;
    for (let round = 0; round < ROUNDS; round += 1) {
      const staff = await newStaff(
        outletA,
        [outletA],
        `Staf Selfie Kembar ${round}`,
      );
      const photoUploadRef = await seedSelfie(outletA, staff.userId);
      const body = clockBody({ photoUploadRef });

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () => clockWith(staff.client, body)),
      );
      for (const result of results)
        expect(
          result.status,
          `round ${round}: ${JSON.stringify(result.body)}`,
        ).toBeLessThan(300);
      expect(
        new Set(results.map((result) => result.body.data.id)).size,
        `round ${round}`,
      ).toBe(1);
      expect(await storedLogs(staff.employeeId)).toHaveLength(1);
    }
  });
});
