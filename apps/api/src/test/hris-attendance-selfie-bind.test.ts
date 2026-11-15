// Fail-first tests for bead legend-bf20 (WS-10 BE): selfie upload transport and
// the supervisor device-binding endpoint (PRD v1.7 F25 "Absensi selfie dengan
// geofence dan pengikatan perangkat", HR-02). Expected behaviour comes from
// docs/briefs/538-g4-sub.md, bead legend-bf20 and the shared contract
// (packages/shared/src/hris), never from service code.
//
// CTO decision: the selfie transport is the existing multipart
// POST /api/storage/uploads (purpose=selfie, through processImage + scanner),
// with NO selfie-upload / signed-PUT endpoint. Endpoints under test:
//   POST /api/storage/uploads  (multipart: purpose=selfie, outletId, file)
//     -> 201 { data: StorageObject }; the object id is the photoUploadRef the
//        clock accepts. The row in core_storage_objects must be owned by the
//        actor, carry the outlet, and be purpose=selfie. Without a storage
//        runtime: 503; without a session: 401.
//   POST /api/hris/attendance/devices/bind-by-supervisor (new)
//     { employeeId, deviceIdHash, label } for a supervisor / HR with
//     hr.attendance.manage at the employee's outlet; the clock policy then
//     accepts that binding.
//
// Assumptions (the brief leaves these open):
//  - The selfie-upload bodies below follow the storage contract
//    (packages/shared/src/storage): the response object has no outletId or
//    owner, so owner/outlet/purpose are checked on the stored row.
//  - A selfie ref of another user or outlet, a non-image and a scanner
//    rejection all answer a 4xx (not 5xx) and leave no log / no storage row.
//  - Uploading a selfie needs self.attendance.clock at the outlet: without it
//    (or with it only at another outlet) the answer is 403 or 404.
//  - Bodies of the attendance POSTs carry an `idempotencyKey`.
//  - ATTENDANCE_SUPERVISOR_CODES contains hr.attendance.manage (the code that
//    already revokes devices); the supervisor here is outlet-scoped HR
//    (hr.attendance.manage + hr.employee.manage) of the employee's outlet.
//  - A foreign tenant or outlet answers 403 or 404 (never 200, never a binding).
//  - Like self-bind, a second active device for the same employee is refused
//    with 409 or 422.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import { NoopMalwareScanner, processImage } from "../services/core-image.ts";
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
  jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "teal" },
  })
    .jpeg()
    .toBuffer();
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

// ---- selfie upload transport (multipart /api/storage/uploads) --------------

let jpeg: Buffer;
const rejectingRuntime: StorageRuntime = {
  ...withStorage,
  scanner: {
    scan: async () => {
      throw new HttpError(422, "MALWARE_FOUND", "internal signature secret");
    },
  } as unknown as StorageRuntime["scanner"],
};
const appRejectingScanner = createApp({ storageRuntime: rejectingRuntime });
const appUnavailableScanner = createApp({
  storageRuntime: {
    ...withStorage,
    scanner: {
      scan: async () => {
        throw new Error("internal scanner socket failure");
      },
    },
  },
});

const uploadSelfie = (
  client: Client,
  options: {
    outlet?: string;
    purpose?: string;
    file?: Buffer;
    filename?: string;
    contentType?: string;
  } = {},
) =>
  client
    .post("/api/storage/uploads")
    .set(originHeader)
    .field("purpose", options.purpose ?? "selfie")
    .field("outletId", options.outlet ?? outletId)
    .attach("file", options.file ?? jpeg, {
      filename: options.filename ?? "selfie.jpg",
      contentType: options.contentType ?? "image/jpeg",
    });

const storedObject = async (objectId: string) =>
  (
    await asTenant((client) =>
      client.query<{
        owner_user_id: string | null;
        outlet_id: string;
        purpose: string;
      }>(
        "SELECT owner_user_id, outlet_id, purpose FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
        [tenant.id, objectId],
      ),
    )
  ).rows[0];

const objectsOwnedBy = async (userId: string) =>
  (
    await asTenant((client) =>
      client.query(
        "SELECT id FROM core_storage_objects WHERE tenant_id = $1 AND owner_user_id = $2",
        [tenant.id, userId],
      ),
    )
  ).rowCount;

/** An employee of `outletId` with a self-bound device (the outlet needs one). */
async function newBoundStaff(app: App, label: string) {
  const staff = await newStaff(app, label);
  const deviceIdHash = deviceHash();
  const bind = await post(staff.client, "/api/hris/attendance/devices/bind", {
    deviceIdHash,
    label: "Ponsel sendiri",
    idempotencyKey: key(),
  });
  expect(bind.status, JSON.stringify(bind.body)).toBe(201);
  return { ...staff, deviceIdHash };
}

const clockWithRef = (
  client: Client,
  deviceIdHash: string,
  photoUploadRef: string,
) =>
  post(client, "/api/hris/attendance/clock", {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...CENTER, accuracyM: 5 },
    deviceIdHash,
    photoUploadRef,
    qrToken: null,
    idempotencyKey: key(),
  });

const logsOf = async (client: Client) => {
  const list = await client.get("/api/hris/attendance/logs");
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return list.body.data as { id: string; photoUrl: string | null }[];
};

const expectClientError = (status: number, body: unknown) => {
  expect(status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
  expect(status, JSON.stringify(body)).toBeLessThan(500);
};

describe("[bf20] selfie upload through POST /api/storage/uploads", () => {
  it("[legend-bkoim] image processing reports scanner outages as typed 503 errors", async () => {
    await expect(
      processImage(jpeg, 10_000_000, {
        scan: async () => {
          throw new Error("internal scanner socket failure");
        },
      }),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
  });
  it("[legend-bf20 HR-01] an employee cannot select another selfie owner in multipart metadata", async () => {
    const staff = await newStaff(appWithStorage, "owner-spoof");
    const victim = await newStaff(appWithStorage, "owner-victim");
    const response = await staff.client
      .post("/api/storage/uploads")
      .set(originHeader)
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .field("ownerUserId", victim.userId)
      .field("employeeId", victim.employeeId)
      .attach("file", jpeg, {
        filename: "selfie.jpg",
        contentType: "image/jpeg",
      });
    expectClientError(response.status, response.body);
    expect(await objectsOwnedBy(victim.userId)).toBe(0);
    expect(await objectsOwnedBy(staff.userId)).toBe(0);
    const control = await uploadSelfie(staff.client);
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    expect((await storedObject(control.body.data.id))?.owner_user_id).toBe(
      staff.userId,
    );
  });

  it("[legend-bf20 TEN-01] a selfie cannot be uploaded to a foreign tenant outlet", async () => {
    const staff = await newStaff(appWithStorage, "tenant-upload");
    const control = await uploadSelfie(staff.client);
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    const response = await uploadSelfie(staff.client, {
      outlet: tenantB.outletId,
    });
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await objectsOwnedBy(staff.userId)).toBe(1);
  });

  it("[bf20] an employee who may clock uploads a selfie, then clocks with the returned id as photoUploadRef (201)", async () => {
    const staff = await newBoundStaff(appWithStorage, "u1");
    const upload = await uploadSelfie(staff.client);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const object = upload.body.data as {
      id: string;
      purpose: string;
      publicUrl: string | null;
    };
    expect(object.purpose).toBe("selfie");
    expect(object.publicUrl).toBeNull(); // the selfie bucket is private
    // The private storage key never reaches the client.
    expect(JSON.stringify(upload.body)).not.toContain("/original");

    // The stored row: id is the reference, owned by the actor, outlet filled.
    const row = await storedObject(object.id);
    expect(row).toMatchObject({
      owner_user_id: staff.userId,
      outlet_id: outletId,
      purpose: "selfie",
    });

    const clocked = await clockWithRef(
      staff.client,
      staff.deviceIdHash,
      object.id,
    );
    expect(clocked.status, JSON.stringify(clocked.body)).toBe(201);
    expect(clocked.body.data.validity).toBe("valid");
    // The clock really linked the selfie: the log carries its signed URL.
    expect(clocked.body.data.photoUrl).toBe(
      `https://signed.example.test/selfie/${object.id}?sig=fake`,
    );
    const log = (await logsOf(staff.client)).find(
      (entry) => entry.id === clocked.body.data.id,
    );
    expect(log?.photoUrl).toBe(clocked.body.data.photoUrl);
  });

  it("[bf20] two uploads give two different ids", async () => {
    const staff = await newStaff(appWithStorage, "u2");
    const first = await uploadSelfie(staff.client);
    const second = await uploadSelfie(staff.client);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });

  it("[bf20] a selfie uploaded by another user cannot be used to clock, and nothing is logged", async () => {
    const victim = await newStaff(appWithStorage, "o1");
    const upload = await uploadSelfie(victim.client);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);

    const thief = await newBoundStaff(appWithStorage, "o2");
    const refused = await clockWithRef(
      thief.client,
      thief.deviceIdHash,
      upload.body.data.id,
    );
    expectClientError(refused.status, refused.body);
    expect(await logsOf(thief.client)).toHaveLength(0);

    // Control: the thief's own selfie works, so the refusal was about the ref.
    const own = await uploadSelfie(thief.client);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const accepted = await clockWithRef(
      thief.client,
      thief.deviceIdHash,
      own.body.data.id,
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it("[bf20] a selfie uploaded for another outlet cannot be used to clock at this outlet", async () => {
    const staff = await newBoundStaff(appWithStorage, "o3");
    // The same employee may also clock at the other outlet, so the upload is
    // allowed there and only the outlet differs.
    await grantRole(staff.userId, ["self.attendance.clock"], [otherOutletId]);
    const foreign = await uploadSelfie(staff.client, { outlet: otherOutletId });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    expect((await storedObject(foreign.body.data.id))?.outlet_id).toBe(
      otherOutletId,
    );

    const refused = await clockWithRef(
      staff.client,
      staff.deviceIdHash,
      foreign.body.data.id,
    );
    expectClientError(refused.status, refused.body);
    expect(await logsOf(staff.client)).toHaveLength(0);

    const own = await uploadSelfie(staff.client);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const accepted = await clockWithRef(
      staff.client,
      staff.deviceIdHash,
      own.body.data.id,
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it("[bf20] without object storage the upload answers 503", async () => {
    const staff = await newStaff(appWithoutStorage, "u3");
    const response = await uploadSelfie(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(await objectsOwnedBy(staff.userId)).toBe(0);
  });

  it("[bf20] a request without a session is refused 401", async () => {
    const response = await uploadSelfie(agent(appWithStorage));
    expect(response.status).toBe(401);
  });

  it("[bf20] a user without self.attendance.clock cannot upload a selfie (403) and nothing is stored", async () => {
    const session = await signedInClient(appWithStorage, "Tanpa Izin Selfie");
    await grantRole(session.userId, ["self.profile.view"], [outletId]);
    await seedEmployee(tenant.id, outletId, session.userId);
    const response = await uploadSelfie(session.client);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await objectsOwnedBy(session.userId)).toBe(0);
  });

  it("[bf20] clock permission at another outlet does not allow a selfie upload for this outlet", async () => {
    const session = await signedInClient(appWithStorage, "Izin Outlet Lain");
    await grantRole(
      session.userId,
      ["self.profile.view", "self.attendance.clock"],
      [otherOutletId],
    );
    await seedEmployee(tenant.id, otherOutletId, session.userId);
    // Control: the same user may upload at their own outlet.
    const own = await uploadSelfie(session.client, { outlet: otherOutletId });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const response = await uploadSelfie(session.client);
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("[bf20] a file that is not an image is rejected 4xx and leaves no storage row", async () => {
    const staff = await newStaff(appWithStorage, "e1");
    const response = await uploadSelfie(staff.client, {
      file: Buffer.from("this is plain text, not a picture"),
      filename: "selfie.jpg",
      contentType: "image/jpeg",
    });
    expectClientError(response.status, response.body);
    expect(await objectsOwnedBy(staff.userId)).toBe(0);
  });

  it("[bf20] a file the malware scanner rejects is refused 4xx and leaves no storage row", async () => {
    const staff = await newStaff(appRejectingScanner, "e2");
    const response = await uploadSelfie(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("UPLOAD_REJECTED");
    expect(JSON.stringify(response.body)).not.toContain("internal signature");
    expect(await objectsOwnedBy(staff.userId)).toBe(0);
  });

  it("[legend-bf20 HR-02] scanner outage fails closed with 503 and no stored selfie", async () => {
    const staff = await newStaff(appUnavailableScanner, "scanner-outage");
    const response = await uploadSelfie(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body.error.code).toBe("SCANNER_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("internal scanner");
    expect(await objectsOwnedBy(staff.userId)).toBe(0);
  });
});

describe("[legend-bf20 HR-01] self binding actor ownership", () => {
  it("[legend-bf20 HR-01] employeeId cannot redirect a self bind to another employee", async () => {
    const staff = await newStaff(appWithStorage, "self-bind-spoof");
    const victim = await newStaff(appWithStorage, "self-bind-victim");
    const response = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      {
        employeeId: victim.employeeId,
        deviceIdHash: deviceHash(),
        label: "Spoof",
        idempotencyKey: key(),
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await devicesOf(hr, victim.employeeId)).toEqual([]);
    expect(await devicesOf(hr, staff.employeeId)).toEqual([]);
    const control = await post(
      staff.client,
      "/api/hris/attendance/devices/bind",
      {
        deviceIdHash: deviceHash(),
        label: "Own",
        idempotencyKey: key(),
      },
    );
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    expect(control.body.data.employeeId).toBe(staff.employeeId);
  });
});

// ---- bind device by supervisor ---------------------------------------------

describe("[bf20] POST /api/hris/attendance/devices/bind-by-supervisor", () => {
  it("[538-G4b P3] refuses 403 when an HR supervisor binds their own employee and stores no device", async () => {
    const supervisor = await signedInClient(
      appWithStorage,
      "Supervisor bind self",
      { mfa: true },
    );
    await grantRole(
      supervisor.userId,
      ["hr.attendance.manage", "hr.employee.manage"],
      [outletId],
    );
    const ownEmployeeId = await seedEmployee(
      tenant.id,
      outletId,
      supervisor.userId,
    );
    const response = await bindBySupervisor(supervisor.client, {
      employeeId: ownEmployeeId,
      deviceIdHash: deviceHash(),
    });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await devicesOf(hr, ownEmployeeId)).toEqual([]);
  });

  it("[538-G4b P3] still lets an attendance supervisor without employee management bind a direct report", async () => {
    const supervisor = await signedInClient(
      appWithStorage,
      "Supervisor bind direct report",
      { mfa: true },
    );
    await grantRole(supervisor.userId, ["hr.attendance.manage"], [outletId]);
    const supervisorEmployeeId = await seedEmployee(
      tenant.id,
      outletId,
      supervisor.userId,
    );
    const staff = await newStaff(appWithStorage, "direct-report");
    await asTenant((client) =>
      client.query(
        `UPDATE employees SET manager_id = $1 WHERE tenant_id = $2 AND id = $3`,
        [supervisorEmployeeId, tenant.id, staff.employeeId],
      ),
    );
    const response = await bindBySupervisor(supervisor.client, {
      employeeId: staff.employeeId,
      deviceIdHash: deviceHash(),
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.employeeId).toBe(staff.employeeId);
    expect(
      (await devicesOf(hr, staff.employeeId)).filter(
        (device) => device.status === "active",
      ),
    ).toHaveLength(1);
  });

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
