// Fail-first tests for bead legend-bf20 (WS-10 BE): selfie upload transport and
// the supervisor device-binding endpoint (PRD v1.7 F25 "Absensi selfie dengan
// geofence dan pengikatan perangkat", HR-02). Expected behaviour comes from
// docs/briefs/538-g4-sub.md, bead legend-bf20 and the shared contract
// (packages/shared/src/hris), never from service code.
//
// Endpoints under test (both new):
//   POST /api/hris/attendance/selfie-upload            (self.attendance.clock)
//     -> { data: { uploadUrl, photoUploadRef } }; without object storage the
//        real build fails closed: 503 SELFIE_UPLOAD_UNAVAILABLE.
//   POST /api/hris/attendance/devices/bind-by-supervisor
//     { employeeId, deviceIdHash, label } for a supervisor / HR with
//     hr.attendance.manage at the employee's outlet; the clock policy then
//     accepts that binding.
//
// Assumptions (the brief leaves these open):
//  - Bodies follow the other attendance POSTs (clientInputSchema): they carry
//    an `idempotencyKey`. The selfie-upload body is `{ contentType, sizeBytes,
//    idempotencyKey }` (image/jpeg, under the 5 MB client limit).
//  - Success answers 200 or 201 with the payload under `data`; `uploadUrl` is
//    an absolute URL, `photoUploadRef` a non-empty string of at most 200
//    characters (the clock contract's photoUploadRef limit) that never exposes
//    the private object key (no "/original").
//  - Error code is the literal "SELFIE_UPLOAD_UNAVAILABLE" in the JSON body.
//  - ATTENDANCE_SUPERVISOR_CODES contains hr.attendance.manage (the code that
//    already revokes devices); the supervisor here is outlet-scoped HR
//    (hr.attendance.manage + hr.employee.manage) of the employee's outlet.
//  - A foreign tenant or outlet answers 403 or 404 (never 200, never a binding).
//  - Like self-bind, a second active device for the same employee is refused
//    with 409 or 422.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const withStorage: StorageRuntime = {
  storage: new FakeObjectStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.example.test/selfie/${objectId}?sig=fake`,
  hrisDocumentSigner: async () => null,
};
const appWithStorage = createApp({ storageRuntime: withStorage });
const appWithoutStorage = createApp({ storageRuntime: null });

type App = ReturnType<typeof createApp>;
type Client = ReturnType<typeof agent>;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let tenantB: SecondTenant;
let tenantBEmployeeId: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  tenantId: string = tenant.id,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function signedInClient(
  app: App,
  name: string,
  options: { mfa?: boolean } = {},
) {
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
  outletIds: string[],
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
        `Selfie bind ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["outlet"]),
      ],
    );
    for (const scopeId of outletIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scopeId],
      );
  });
}

const CENTER = { latitude: -6.2, longitude: 106.8 };
const key = () => `att-sb-${randomUUID()}`;
const deviceHash = () =>
  createHash("sha256").update(randomUUID()).digest("hex");
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

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
        `SB-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet selfie bind ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(
  tenantId: string,
  homeOutletId: string,
  userId: string | null,
) {
  const id = randomUUID();
  if (tenantId === tenant.id) createdEmployees.push(id);
  await asTenant(
    (client) =>
      client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, 'Karyawan Selfie Bind', $5, 'pkwtt', '2025-03-01', 'active')`,
        [
          id,
          tenantId,
          userId,
          `SB-${id.slice(0, 8).toUpperCase()}`,
          homeOutletId,
        ],
      ),
    tenantId,
  );
  return id;
}

let outletId: string; // device binding is required here
let otherOutletId: string;
let hr: Client; // outlet-scoped HR of outletId
let hrOtherOutlet: Client; // HR of otherOutletId only

/** An employee of `outletId` who may clock; no device bound yet. */
async function newStaff(app: App, label: string) {
  const session = await signedInClient(app, `Staf Selfie Bind ${label}`);
  await grantRole(
    session.userId,
    ["self.profile.view", "self.attendance.clock"],
    [outletId],
  );
  const employeeId = await seedEmployee(tenant.id, outletId, session.userId);
  return { ...session, employeeId };
}

const clock = (client: Client, deviceIdHash: string | null) =>
  post(client, "/api/hris/attendance/clock", {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...CENTER, accuracyM: 5 },
    deviceIdHash,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
  });

const bindBySupervisor = (client: Client, body: Record<string, unknown>) =>
  post(client, "/api/hris/attendance/devices/bind-by-supervisor", {
    label: "Ponsel dibantu supervisor",
    idempotencyKey: key(),
    ...body,
  });

const devicesOf = async (client: Client, employeeId: string) => {
  const list = await client.get(
    `/api/hris/attendance/devices?employeeId=${employeeId}`,
  );
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return list.body.data as { id: string; status: string }[];
};

/**
 * Positive control for the refusal tests: the endpoint exists and works for the
 * outlet's own HR. Without it a missing route (404) would pass "403 or 404".
 */
async function expectEndpointWorksForOwnOutlet(label: string) {
  const control = await newStaff(appWithStorage, label);
  const response = await bindBySupervisor(hr, {
    employeeId: control.employeeId,
    deviceIdHash: deviceHash(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

beforeAll(async () => {
  outletId = await seedOutlet("utama");
  otherOutletId = await seedOutlet("lain");
  tenantB = await createSecondTenant(owner, "selfiebind");
  tenantBEmployeeId = await seedEmployee(
    tenantB.tenantId,
    tenantB.outletId,
    null,
  );

  const admin = await signedInClient(appWithStorage, "Admin Kebijakan SB", {
    mfa: true,
  });
  await grantRole(
    admin.userId,
    ["hr.attendance.manage"],
    [outletId, otherOutletId],
  );
  const policy = await admin.client
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "flag",
        unboundDeviceAction: "reject",
        requireSelfie: false,
        requireDeviceBinding: true,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const manager = await signedInClient(appWithStorage, "HR Outlet SB", {
    mfa: true,
  });
  await grantRole(
    manager.userId,
    ["hr.attendance.manage", "hr.employee.manage", "hr.employee.view"],
    [outletId],
  );
  hr = manager.client;

  const outsider = await signedInClient(appWithStorage, "HR Outlet Lain SB", {
    mfa: true,
  });
  await grantRole(
    outsider.userId,
    ["hr.attendance.manage", "hr.employee.manage", "hr.employee.view"],
    [otherOutletId],
  );
  hrOtherOutlet = outsider.client;
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    for (const table of ["attendance_logs", "attendance_policies"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-sb-%'",
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
  await asTenant(
    (client) =>
      client.query("DELETE FROM employees WHERE tenant_id = $1", [
        tenantB.tenantId,
      ]),
    tenantB.tenantId,
  );
  await removeSecondTenant(owner, tenantB);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

// ---- selfie upload transport -------------------------------------------------

const selfieBody = () => ({
  contentType: "image/jpeg",
  sizeBytes: 150_000,
  idempotencyKey: key(),
});

describe("[bf20] POST /api/hris/attendance/selfie-upload", () => {
  it("[bf20] an employee who may clock gets a signed upload URL and a photoUploadRef", async () => {
    const staff = await newStaff(appWithStorage, "u1");
    const response = await post(
      staff.client,
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const data = response.body.data as {
      uploadUrl: string;
      photoUploadRef: string;
    };
    expect(typeof data.uploadUrl).toBe("string");
    expect(() => new URL(data.uploadUrl)).not.toThrow();
    expect(typeof data.photoUploadRef).toBe("string");
    expect(data.photoUploadRef.length).toBeGreaterThan(0);
    expect(data.photoUploadRef.length).toBeLessThanOrEqual(200);
    // The private storage key is never handed to the client as the reference.
    expect(data.photoUploadRef).not.toContain("/original");
  });

  it("[bf20] two uploads give two different references", async () => {
    const staff = await newStaff(appWithStorage, "u2");
    const first = await post(
      staff.client,
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    const second = await post(
      staff.client,
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(first.body.data.photoUploadRef).not.toBe(
      second.body.data.photoUploadRef,
    );
  });

  it("[bf20] without object storage the real build fails closed with 503 SELFIE_UPLOAD_UNAVAILABLE", async () => {
    const staff = await newStaff(appWithoutStorage, "u3");
    const response = await post(
      staff.client,
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(JSON.stringify(response.body)).toContain(
      "SELFIE_UPLOAD_UNAVAILABLE",
    );
    expect(JSON.stringify(response.body)).not.toContain("uploadUrl");
  });

  it("[bf20] a user without self.attendance.clock is refused 403", async () => {
    const session = await signedInClient(appWithStorage, "Tanpa Izin Selfie");
    await grantRole(session.userId, ["self.profile.view"], [outletId]);
    await seedEmployee(tenant.id, outletId, session.userId);
    const response = await post(
      session.client,
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("[bf20] a request without a session is refused 401", async () => {
    const response = await post(
      agent(appWithStorage),
      "/api/hris/attendance/selfie-upload",
      selfieBody(),
    );
    expect(response.status).toBe(401);
  });
});

// ---- bind device by supervisor ---------------------------------------------

describe("[bf20] POST /api/hris/attendance/devices/bind-by-supervisor", () => {
  it("[bf20] the outlet's HR binds a device for an employee and the clock policy then accepts it", async () => {
    const staff = await newStaff(appWithStorage, "b1");
    const bound = deviceHash();
    const other = deviceHash();

    // Control: before the binding the device is refused.
    const before = await clock(staff.client, bound);
    expect(before.status, JSON.stringify(before.body)).toBe(422);

    const bind = await bindBySupervisor(hr, {
      employeeId: staff.employeeId,
      deviceIdHash: bound,
      label: "Ponsel baru karyawan",
    });
    expect(bind.status, JSON.stringify(bind.body)).toBe(201);
    expect(bind.body.data).toMatchObject({
      employeeId: staff.employeeId,
      label: "Ponsel baru karyawan",
      status: "active",
    });
    // The raw hash is never returned.
    expect(JSON.stringify(bind.body)).not.toContain(bound);

    const devices = await devicesOf(hr, staff.employeeId);
    expect(devices.filter((d) => d.status === "active")).toHaveLength(1);

    const accepted = await clock(staff.client, bound);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.validity).toBe("valid");

    // Only that device: another phone is still refused.
    const refused = await clock(staff.client, other);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
  });

  it("[bf20] an employee already holding an active device cannot get a second one", async () => {
    const staff = await newStaff(appWithStorage, "b2");
    const first = await bindBySupervisor(hr, {
      employeeId: staff.employeeId,
      deviceIdHash: deviceHash(),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await bindBySupervisor(hr, {
      employeeId: staff.employeeId,
      deviceIdHash: deviceHash(),
    });
    expect([409, 422], JSON.stringify(second.body)).toContain(second.status);
    const devices = await devicesOf(hr, staff.employeeId);
    expect(devices.filter((d) => d.status === "active")).toHaveLength(1);
  });

  it("[bf20] the employee cannot bind through the supervisor endpoint (403) and nothing is bound", async () => {
    const staff = await newStaff(appWithStorage, "b3");
    const bound = deviceHash();
    const response = await bindBySupervisor(staff.client, {
      employeeId: staff.employeeId,
      deviceIdHash: bound,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect((await devicesOf(hr, staff.employeeId)).length).toBe(0);
    expect((await clock(staff.client, bound)).status).toBe(422);
  });

  it("[bf20] HR of another outlet cannot bind a device for this outlet's employee", async () => {
    await expectEndpointWorksForOwnOutlet("b4c");
    const staff = await newStaff(appWithStorage, "b4");
    const bound = deviceHash();
    const response = await bindBySupervisor(hrOtherOutlet, {
      employeeId: staff.employeeId,
      deviceIdHash: bound,
    });
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect((await devicesOf(hr, staff.employeeId)).length).toBe(0);
    expect((await clock(staff.client, bound)).status).toBe(422);
  });

  it("[bf20] an employee of another tenant is refused and gets no device", async () => {
    await expectEndpointWorksForOwnOutlet("b5c");
    const response = await bindBySupervisor(hr, {
      employeeId: tenantBEmployeeId,
      deviceIdHash: deviceHash(),
    });
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const rows = await asTenant(
      (client) =>
        client.query(
          "SELECT id FROM attendance_devices WHERE tenant_id = $1 AND employee_id = $2",
          [tenantB.tenantId, tenantBEmployeeId],
        ),
      tenantB.tenantId,
    );
    expect(rows.rowCount).toBe(0);
  });

  it("[bf20] an unknown employee id is refused 403 or 404", async () => {
    await expectEndpointWorksForOwnOutlet("b6c");
    const response = await bindBySupervisor(hr, {
      employeeId: randomUUID(),
      deviceIdHash: deviceHash(),
    });
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("[bf20] a malformed device hash is rejected before anything is stored", async () => {
    const staff = await newStaff(appWithStorage, "b6");
    const response = await bindBySupervisor(hr, {
      employeeId: staff.employeeId,
      deviceIdHash: "not-a-sha256",
    });
    expect([400, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect((await devicesOf(hr, staff.employeeId)).length).toBe(0);
  });

  it("[bf20] a request without a session is refused 401", async () => {
    const response = await bindBySupervisor(agent(appWithStorage), {
      employeeId: randomUUID(),
      deviceIdHash: deviceHash(),
    });
    expect(response.status).toBe(401);
  });
});
