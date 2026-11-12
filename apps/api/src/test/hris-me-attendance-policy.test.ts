// GET /api/hris/me/attendance-policy (bead legend-j06v; PRD v1.7 F25 "Absensi",
// HR-01/HR-02, TEN-01/TEN-03). A staff member who may clock in
// (self.attendance.clock) reads the EFFECTIVE attendance policy of their own
// outlet so the mobile clock-in screen can show the geofence radius and the
// selfie / device / QR rules before submitting. Effective policy resolution:
// outlet override, else tenant default, else the built-in default. Runs the
// real Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe
// Legend tenant; pattern of hris-api.test.ts and hris-attendance-default-policy.test.ts.
// Written BEFORE the endpoint exists: every case that reaches the route must
// fail first (the route answers 404 until it is added).
//
// Assumptions:
//  - Response is `{ data: { outletId, ...six policy fields } }` like the other HRIS endpoints.
//  - The only fields exposed are geofenceRadiusM, outsideGeofenceAction,
//    unboundDeviceAction, requireSelfie, requireDeviceBinding, allowRotatingQr.
//    selfieRetentionDays, sampling and tenant ids are NOT exposed.
//    Paket C legend-bf20 adds the effective outletId for the selfie upload.
//  - The built-in default (no stored policy) is DEFAULT_ATTENDANCE_POLICY
//    (accept-and-flag with a mandatory selfie, founder decision Q81, see
//    hris-attendance-default-policy.test.ts).
//  - The policy is the one of the outlet the clock lands in (clockAttendance):
//    the outlet of the published shift covering now, else the home outlet.
//  - "No stored policy" means no tenant-default row (outlet_id IS NULL) and no
//    outlet row; every case starts from that state (beforeEach) and stores what
//    it needs, so the cases run in any order (files run one after another,
//    fileParallelism off).
//  - Anonymous answers 401; a signed-in user without self.attendance.clock
//    answers 403.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { DEFAULT_ATTENDANCE_POLICY } from "../services/hris-attendance.service.ts";
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
const otherTenantIds: string[] = [];

async function asTenantId<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const asTenant = <T>(run: (client: PoolClient) => Promise<T>) =>
  asTenantId(tenant.id, run);

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
        `Me attendance policy ${roleId.slice(0, 8)}`,
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

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Kebijakan Saya', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `MP-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet kebijakan saya ${label}`,
        JSON.stringify({ latitude: -6.2, longitude: 106.8, radiusMeters: 100 }),
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
       VALUES ($1, $2, $3, $4, 'Karyawan Kebijakan Saya', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, userId, `MP-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

async function newStaff(
  outletId: string,
  name = "Staf Kebijakan Saya",
  extraOutletIds: string[] = [],
) {
  const staff = await signedInClient(name);
  await grantRole(
    staff.userId,
    ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: [outletId, ...extraOutletIds] },
  );
  const employeeId = await seedEmployee(staff.userId, outletId);
  return { ...staff, employeeId };
}

/** A published shift at `outletId` covering now (business date in WIB). */
async function seedCoverShift(
  staff: { userId: string; employeeId: string },
  outletId: string,
) {
  const hour = 60 * 60 * 1000;
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
        staff.employeeId,
        new Date(Date.now() + 7 * hour).toISOString().slice(0, 10),
        JSON.stringify([
          {
            startsAt: new Date(Date.now() - hour).toISOString(),
            endsAt: new Date(Date.now() + 4 * hour).toISOString(),
          },
        ]),
        staff.userId,
      ],
    ),
  );
}

const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

const SAMPLING = { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 };

const POLICY_FIELDS = [
  "allowRotatingQr",
  "geofenceRadiusM",
  "outletId",
  "outsideGeofenceAction",
  "requireDeviceBinding",
  "requireSelfie",
  "unboundDeviceAction",
];

// Distinctive values so a leak or a wrong source is obvious.
const TENANT_DEFAULT = {
  geofenceRadiusM: 250,
  outsideGeofenceAction: "reject",
  unboundDeviceAction: "reject",
  requireSelfie: true,
  requireDeviceBinding: false,
  allowRotatingQr: false,
  selfieRetentionDays: 123,
} as const;

const OUTLET_OVERRIDE = {
  geofenceRadiusM: 60,
  outsideGeofenceAction: "flag",
  unboundDeviceAction: "flag",
  requireSelfie: false,
  requireDeviceBinding: true,
  allowRotatingQr: true,
  selfieRetentionDays: 45,
} as const;

const OTHER_TENANT_POLICY = {
  geofenceRadiusM: 4321,
  outsideGeofenceAction: "reject",
  unboundDeviceAction: "reject",
  requireSelfie: false,
  requireDeviceBinding: false,
  allowRotatingQr: false,
  selfieRetentionDays: 321,
};

// ---- fixtures ---------------------------------------------------------------

let outletA: string; // no outlet row: falls back to tenant default / built-in
let outletB: string; // outlet override
let admin: Client;

function expectPolicyOnly(
  body: { data: Record<string, unknown> },
  expected: Omit<
    typeof TENANT_DEFAULT | typeof DEFAULT_ATTENDANCE_POLICY,
    "selfieRetentionDays"
  >,
) {
  expect(Object.keys(body.data).sort()).toEqual(POLICY_FIELDS);
  const { outletId, ...policy } = body.data;
  expect(outletId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(policy).toEqual(expected);
}

// Every case starts with no stored policy of this tenant (the built-in default
// only applies when the tenant has no default row) and stores what it needs.
async function clearStoredPolicies() {
  await asTenant((client) =>
    client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND (outlet_id IS NULL OR outlet_id = ANY($2::uuid[]))",
      [tenant.id, createdOutlets],
    ),
  );
}

async function storePolicy(outletId: string | null, policy: object) {
  const saved = await put(admin, "/api/hris/attendance/policy", {
    outletId,
    policy,
    sampling: SAMPLING,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

beforeAll(async () => {
  outletA = await seedOutlet("A tanpa override");
  outletB = await seedOutlet("B override");

  const policyAdmin = await signedInClient("Admin Kebijakan Saya", {
    mfa: true,
  });
  await grantRole(policyAdmin.userId, ["hr.attendance.manage"], {
    type: "tenant",
  });
  admin = policyAdmin.client;

  // Another tenant with its own default policy: it must never show up.
  const otherTenantId = randomUUID();
  otherTenantIds.push(otherTenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant lain kebijakan saya', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [otherTenantId, `me-policy-${otherTenantId}`, policyAdmin.userId],
  );
  await asTenantId(otherTenantId, (client) =>
    client.query(
      `INSERT INTO attendance_policies (tenant_id, outlet_id, policy, sampling, updated_by)
       VALUES ($1, NULL, $2::jsonb, $3::jsonb, $4)`,
      [
        otherTenantId,
        JSON.stringify(OTHER_TENANT_POLICY),
        JSON.stringify(SAMPLING),
        policyAdmin.userId,
      ],
    ),
  );
});

beforeEach(clearStoredPolicies);

afterAll(async () => {
  for (const otherTenantId of otherTenantIds) {
    await asTenantId(otherTenantId, (client) =>
      client.query("DELETE FROM attendance_policies WHERE tenant_id = $1", [
        otherTenantId,
      ]),
    );
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  }
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND (outlet_id IS NULL OR outlet_id = ANY($2::uuid[]))",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'me-policy-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
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

const PATH = "/api/hris/me/attendance-policy";

// ---- access ------------------------------------------------------------------

describe("legend-j06v GET /api/hris/me/attendance-policy access", () => {
  it("legend-j06v [TEN-01] answers 401 to an anonymous request", async () => {
    expect((await agent(app).get(PATH)).status).toBe(401);
  });

  it("legend-j06v answers 403 to a signed-in user without self.attendance.clock", async () => {
    const viewer = await signedInClient("Pelihat Profil Saja");
    await grantRole(viewer.userId, ["self.profile.view"], {
      type: "outlet",
      outletIds: [outletA],
    });
    await seedEmployee(viewer.userId, outletA);
    const response = await viewer.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("legend-j06v answers 403 to a signed-in user with no role at all", async () => {
    const nobody = await signedInClient("Tanpa Peran Kebijakan");
    const response = await nobody.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });
});

// ---- effective policy ----------------------------------------------------------

describe("legend-j06v GET /api/hris/me/attendance-policy effective policy", () => {
  it("legend-j06v staff gets the built-in default when no policy is stored (200)", async () => {
    const staff = await newStaff(outletA);
    const response = await staff.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expectPolicyOnly(response.body, {
      geofenceRadiusM: DEFAULT_ATTENDANCE_POLICY.geofenceRadiusM,
      outsideGeofenceAction: DEFAULT_ATTENDANCE_POLICY.outsideGeofenceAction,
      unboundDeviceAction: DEFAULT_ATTENDANCE_POLICY.unboundDeviceAction,
      requireSelfie: DEFAULT_ATTENDANCE_POLICY.requireSelfie,
      requireDeviceBinding: DEFAULT_ATTENDANCE_POLICY.requireDeviceBinding,
      allowRotatingQr: DEFAULT_ATTENDANCE_POLICY.allowRotatingQr,
    });
    // The other tenant's stored default (radius 4321) must not be picked up.
    expect(response.body.data.geofenceRadiusM).not.toBe(
      OTHER_TENANT_POLICY.geofenceRadiusM,
    );
  });

  it("legend-j06v the tenant default applies to an outlet without an override", async () => {
    await storePolicy(null, TENANT_DEFAULT);

    const staff = await newStaff(outletA);
    const response = await staff.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expectPolicyOnly(response.body, {
      geofenceRadiusM: 250,
      outsideGeofenceAction: "reject",
      unboundDeviceAction: "reject",
      requireSelfie: true,
      requireDeviceBinding: false,
      allowRotatingQr: false,
    });
  });

  it("legend-j06v the outlet override wins over the tenant default, only for that outlet", async () => {
    await storePolicy(null, TENANT_DEFAULT);
    await storePolicy(outletB, OUTLET_OVERRIDE);

    const staffB = await newStaff(outletB);
    const overridden = await staffB.client.get(PATH);
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);
    expectPolicyOnly(overridden.body, {
      geofenceRadiusM: 60,
      outsideGeofenceAction: "flag",
      unboundDeviceAction: "flag",
      requireSelfie: false,
      requireDeviceBinding: true,
      allowRotatingQr: true,
    });

    // A colleague at the outlet without an override still sees the tenant default.
    const staffA = await newStaff(outletA);
    const fallback = await staffA.client.get(PATH);
    expect(fallback.status, JSON.stringify(fallback.body)).toBe(200);
    expect(fallback.body.data.geofenceRadiusM).toBe(250);
  });

  it("legend-j06v a published cover shift at outlet B gives the policy of B", async () => {
    await storePolicy(null, TENANT_DEFAULT);
    await storePolicy(outletB, OUTLET_OVERRIDE);

    // Home outlet A (tenant default), but working a shift at B right now.
    const staff = await newStaff(outletA, "Staf Cover Kebijakan", [outletB]);
    const home = await staff.client.get(PATH);
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(home.body.data.geofenceRadiusM).toBe(250);
    expect(home.body.data.outletId).toBe(outletA);

    await seedCoverShift(staff, outletB);
    const covering = await staff.client.get(PATH);
    expect(covering.status, JSON.stringify(covering.body)).toBe(200);
    expect(covering.body.data.outletId).toBe(outletB);
    expectPolicyOnly(covering.body, {
      geofenceRadiusM: 60,
      outsideGeofenceAction: "flag",
      unboundDeviceAction: "flag",
      requireSelfie: false,
      requireDeviceBinding: true,
      allowRotatingQr: true,
    });
  });

  it("legend-j06v ignores a shift at an outlet the clock permission does not reach: home outlet policy, never the policy of B", async () => {
    // shift_assignments is outlet-RLS: the shift at B is invisible to this
    // caller, so the clock lands at home A. The service allows() check after
    // it is defence in depth (RLS scope and snapshot come from the same grant).
    await storePolicy(null, TENANT_DEFAULT);
    await storePolicy(outletB, OUTLET_OVERRIDE);
    const staff = await newStaff(outletA, "Staf Cover Tanpa Akses");
    await seedCoverShift(staff, outletB);
    const response = await staff.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.geofenceRadiusM).toBe(250);
    expect(response.body.data.requireSelfie).not.toBe(false);
    expect(response.body.data.outletId).toBe(outletA);
  });

  it("legend-j06v refuses an employee who is not active or onboarding", async () => {
    const staff = await newStaff(outletA, "Staf Tidak Aktif Kebijakan");
    await asTenant((client) =>
      client.query(
        "UPDATE employees SET status = 'resigned' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, staff.employeeId],
      ),
    );
    const response = await staff.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
  });

  it("[legend-bf20 HR-01] exposes only effective outletId and policy, no private configuration", async () => {
    await storePolicy(outletB, OUTLET_OVERRIDE);
    const staff = await newStaff(outletB);
    const response = await staff.client.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Object.keys(response.body.data).sort()).toEqual(POLICY_FIELDS);
    expect(response.text).not.toContain("selfieRetentionDays");
    expect(response.text).not.toContain("sampling");
    expect(response.text).not.toContain(tenant.id);
    expect(response.body.data.outletId).toBe(outletB);
  });

  it("legend-j06v [TEN-03] another tenant's policy never leaks", async () => {
    // The other tenant's default (radius 4321, retention 321) exists since
    // beforeAll; no response of this tenant may carry any of its values.
    for (const outletId of [outletA, outletB]) {
      const staff = await newStaff(outletId);
      const response = await staff.client.get(PATH);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.geofenceRadiusM).not.toBe(
        OTHER_TENANT_POLICY.geofenceRadiusM,
      );
      expect(response.text).not.toContain("4321");
      expect(response.text).not.toContain(otherTenantIds[0]);
    }
  });
});
