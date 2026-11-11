// Object storage wiring in the app (bead legend-dzh9q): createApp({ storageRuntime })
// hands the attendance routers their selfie signer and mounts the core-storage
// router. With a runtime, attendance logs (employee GET and admin review queue)
// carry a signed photoUrl; with `storageRuntime: null`, uploads answer 503 and
// the logs still list with photoUrl null. The signer here is a fake: signing
// itself is covered by core-storage-runtime.test.ts. Runs the real Express app,
// Better Auth, RBAC and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/selfie/${objectId}?sig=fake`;

// The signer is the only part of the runtime the attendance routes use; the
// storage and scanner are never reached because no upload is made with it.
const withStorage: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) => signedUrlFor(objectId),
  hrisDocumentSigner: async () => null,
};
const appWithStorage = createApp({ storageRuntime: withStorage });
const appWithoutStorage = createApp({ storageRuntime: null });

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
let outletId: string;

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
type App = ReturnType<typeof createApp>;

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
        `Attendance storage ${roleId.slice(0, 8)}`,
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

// Outlet centre; 0.01 deg of latitude is ~1.1 km, outside the 100 m geofence.
const CENTER = { latitude: -6.2, longitude: 106.8 };
const FAR = { ...CENTER, latitude: CENTER.latitude + 0.01 };

async function seedOutlet() {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet absensi storage', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `AS-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

/** A signed-in employee of the outlet who may clock, with a selfie object. */
async function newStaff(app: App, name: string) {
  const staff = await signedInClient(app, name);
  await grantRole(
    staff.userId,
    ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: [outletId] },
  );
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi Storage', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        staff.userId,
        `AS-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
  });
  const objectId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
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
        staff.userId,
      ],
    );
  });
  return { ...staff, employeeId, objectId };
}

/**
 * A manager who reviews the outlet (back office, MFA). A supervisor sees only
 * direct reports, so the manager is an employee and `staff` reports to them.
 */
async function newManager(
  app: App,
  name: string,
  staff: Awaited<ReturnType<typeof newStaff>>,
) {
  const manager = await signedInClient(app, name, { mfa: true });
  await grantRole(
    manager.userId,
    ["hr.attendance.manage", "hr.attendance_correction.approve"],
    { type: "outlet", outletIds: [outletId] },
  );
  const managerEmployeeId = randomUUID();
  createdEmployees.push(managerEmployeeId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Manajer Absensi Storage', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        managerEmployeeId,
        tenant.id,
        manager.userId,
        `AM-${managerEmployeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
    await client.query(
      "UPDATE employees SET manager_id = $1 WHERE tenant_id = $2 AND id = $3",
      [managerEmployeeId, tenant.id, staff.employeeId],
    );
  });
  return manager;
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

/** A flagged clock-in with a selfie, so it also reaches the review queue. */
async function clockWithSelfie(staff: Awaited<ReturnType<typeof newStaff>>) {
  const response = await post(staff.client, "/api/hris/attendance/clock", {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...FAR, accuracyM: 5 },
    deviceIdHash: null,
    photoUploadRef: staff.objectId,
    qrToken: null,
    idempotencyKey: `att-storage-${randomUUID()}`,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; photoUrl: string | null };
}

type ReviewItem = { log: { id: string; photoUrl: string | null } };
const reviewItem = async (manager: Client, logId: string) => {
  const queue = await manager.get(
    `/api/hris/attendance/review-queue?outletId=${outletId}`,
  );
  expect(queue.status, JSON.stringify(queue.body)).toBe(200);
  return (queue.body.data as ReviewItem[]).find(
    (entry) => entry.log.id === logId,
  );
};

beforeAll(async () => {
  outletId = await seedOutlet();
  const policyAdmin = await signedInClient(
    appWithStorage,
    "Admin Kebijakan Absensi Storage",
    { mfa: true },
  );
  await grantRole(policyAdmin.userId, ["hr.attendance.manage"], {
    type: "tenant",
  });
  const response = await policyAdmin.client
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "flag",
        unboundDeviceAction: "reject",
        requireSelfie: false,
        requireDeviceBinding: false,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of ["attendance_logs", "attendance_policies"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = $2`,
        [tenant.id, outletId],
      );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-storage-%'",
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
    // Outlet and storage objects stay: audit_logs is append-only and
    // references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

describe("createApp with a storage runtime", () => {
  it("[F25] the employee's log list carries a signed selfie URL", async () => {
    const staff = await newStaff(appWithStorage, "Staf Storage Ada");
    const created = await clockWithSelfie(staff);
    expect(created.photoUrl).toBe(signedUrlFor(staff.objectId));

    const list = await staff.client.get("/api/hris/attendance/logs");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const log = (
      list.body.data as { id: string; photoUrl: string | null }[]
    ).find((entry) => entry.id === created.id);
    expect(log?.photoUrl).toBe(signedUrlFor(staff.objectId));
  });

  it("[F25] the admin review queue carries a signed selfie URL", async () => {
    const staff = await newStaff(appWithStorage, "Staf Storage Review");
    const manager = await newManager(
      appWithStorage,
      "Manajer Storage Ada",
      staff,
    );
    const created = await clockWithSelfie(staff);

    const item = await reviewItem(manager.client, created.id);
    expect(item?.log.photoUrl).toBe(signedUrlFor(staff.objectId));
  });
});

describe("createApp with storageRuntime null", () => {
  it("answers 503 on POST /api/storage/uploads for a signed-in user", async () => {
    const staff = await signedInClient(appWithoutStorage, "Pengunggah Storage");
    const response = await post(staff.client, "/api/storage/uploads", {});
    expect(response.status, JSON.stringify(response.body)).toBe(503);
  });

  it("answers 401 on POST /api/storage/uploads without a session", async () => {
    const response = await post(
      agent(appWithoutStorage),
      "/api/storage/uploads",
      {},
    );
    expect(response.status).toBe(401);
  });

  it("[F25] the employee's log list still works with photoUrl null", async () => {
    const staff = await newStaff(appWithoutStorage, "Staf Storage Kosong");
    const created = await clockWithSelfie(staff);
    expect(created.photoUrl).toBeNull();

    const list = await staff.client.get("/api/hris/attendance/logs");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const log = (
      list.body.data as { id: string; photoUrl: string | null }[]
    ).find((entry) => entry.id === created.id);
    expect(log).toBeDefined();
    expect(log?.photoUrl).toBeNull();
  });

  it("[F25] the admin review queue still works with photoUrl null", async () => {
    const staff = await newStaff(
      appWithoutStorage,
      "Staf Storage Review Kosong",
    );
    const manager = await newManager(
      appWithoutStorage,
      "Manajer Storage Kosong",
      staff,
    );
    const created = await clockWithSelfie(staff);

    const item = await reviewItem(manager.client, created.id);
    expect(item).toBeDefined();
    expect(item?.log.photoUrl).toBeNull();
  });
});
