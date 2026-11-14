// Edge people snapshot, cloud side (bead legend-ye4j1 card C2; design
// docs/design/hris-edge-replication.md 3.1, 3.2, 3.5, 4 and 9 T1). The cloud
// ships `GET /api/edge-sync/people-snapshot` to an edge node: the people an
// outlet needs to clock offline, as a strict read-only projection. Written from
// the brief and the shared contract (packages/shared/src/edge/people-snapshot.ts),
// not from the implementation (which does not exist yet).
//
// Fixture (outlet O = outletA, a clone of a fixture outlet; P, B, C are other
// clones in the same tenant; T2 is another tenant):
//   U1  pin at O + employee E1 (home O, active)            sent, user + employee
//   U2  employee E2 (home O, onboarding), no pin           sent via the employee
//   U3  pin at O, no employee                              sent as user only
//   U4  employee E4 (home P) with a published shift at O   sent, homeOutletId -> O
//   U9  employee E9 (home P) with a swapped shift at O     sent, homeOutletId -> O
//   U5/U6  terminated / suspended employee (suspended has a published shift at O)
//   E7  active, home O, user_id NULL (with a published shift at O)
//   E8  home P, published shift at O far outside the window
//   U10 pin at P only; UB pin at B + employee EB + shift SB at B; UT in tenant T2
//
// Assumptions (spec ambiguities):
//  - Shifts and windows are placed relative to the outlet business date taken as
//    UTC+7 (the fixture outlet zone). Included shifts sit at today+1 or today+2
//    and excluded ones at today+20 or beyond, so a one-day clock skew between UTC
//    and the outlet zone never changes the outcome.
//  - The cloud app runs with `createApp()` (cloud mode); the route verifies the
//    credential through the edge registry verifier, so the test installs it the
//    way server.ts does (`setEdgeCredentialVerifier(verifyEdgeNodeCredential)`).
//  - The route reads the selfie seal env per call (not frozen at import). The seal
//    key cases drive the service directly with `process.env` set around the call.
//  - Case 8 "same minute / day roll" drives `buildEdgePeopleSnapshot` with an
//    explicit `now` (the route has no such input). `now` is the UTC noon of the
//    day the file starts, so it cannot straddle UTC midnight.
//  - `deriveQrDayKeys(...)` entries are `{ dayIndex, key }` with `key` bytes (a
//    Buffer); a base64 string is tolerated too.
//  - The station-scoped assignment uses a random `scope_id` (assumed to have no
//    foreign key). Roles allow all four scope types so the seed row is valid.
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { inspect } from "node:util";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cafeLegendFixtures,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EDGE_PEOPLE_SNAPSHOT_ATTENDANCE_POLICY_KEYS,
  EDGE_PEOPLE_SNAPSHOT_EMPLOYEE_KEYS,
  EDGE_PEOPLE_SNAPSHOT_ROLE_ASSIGNMENT_KEYS,
  EDGE_PEOPLE_SNAPSHOT_ROLE_KEYS,
  EDGE_PEOPLE_SNAPSHOT_SHIFT_ASSIGNMENT_KEYS,
  EDGE_PEOPLE_SNAPSHOT_USER_KEYS,
  edgePeopleSnapshotSchema,
  type EdgePeopleSnapshot,
} from "@starter/shared/edge/people-snapshot";
import { createApp } from "../app.ts";
import { logger } from "../lib/logger.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { hashStaffPin } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import { buildEdgePeopleSnapshot } from "../services/edge-people-snapshot.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { deriveQrDayKeys } from "../services/hris-attendance-qr.ts";
import {
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const PATH = "/api/edge-sync/people-snapshot";
const DAY_MS = 86_400_000;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

async function asOwner(
  text: string,
  params: unknown[] = [],
  forTenant: string = tenantId,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenant],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const scopeOf = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

// ---- dates ------------------------------------------------------------------

const WIB_OFFSET = 7 * 3_600_000;
/** Outlet-local (UTC+7) calendar date, `days` from today. */
const dateAt = (days: number) =>
  new Date(Date.now() + WIB_OFFSET + days * DAY_MS).toISOString().slice(0, 10);

/** Fixed UTC noon of the day this file starts (see the assumptions above). */
const startedAt = new Date();
const NOW1 = new Date(
  Date.UTC(
    startedAt.getUTCFullYear(),
    startedAt.getUTCMonth(),
    startedAt.getUTCDate(),
    12,
    0,
    10,
  ),
);
const NOW1_SAME_MINUTE = new Date(NOW1.getTime() + 30_000);
const NOW1_NEXT_DAY = new Date(NOW1.getTime() + DAY_MS);
const dayIndexOf = (date: Date) => Math.floor(date.getTime() / DAY_MS);

async function avoidUtcMidnight() {
  const untilMidnight = DAY_MS - (Date.now() % DAY_MS);
  if (untilMidnight < 3 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, untilMidnight + 5_000));
}

// ---- fixture ----------------------------------------------------------------

const actor = randomUUID();
const tag = randomBytes(3).toString("hex").toUpperCase();
const createdOutlets: string[] = [];
const createdUsers: string[] = [];
const realEmails = new Map<string, string>();

async function cloneOutlet(label: string): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await asOwner(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $4, address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [
      id,
      `PS${id.slice(0, 8)}`.toUpperCase(),
      outlets[0].id,
      `Outlet uji snapshot ${label}`,
    ],
  );
  return id;
}

async function seedUser(label: string): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `Staf Snapshot ${label} ${tag}`;
  const email = `snapshot-${id.slice(0, 8)}@example.test`;
  await asOwner(
    `INSERT INTO "user" (id, name, email, email_verified, image) VALUES ($1, $2, $3, true, $4)`,
    [id, name, email, `https://cdn.example.test/${id}.png`],
  );
  createdUsers.push(id);
  realEmails.set(id, email);
  return { id, name };
}

async function seedPin(
  forTenant: string,
  outletId: string,
  userId: string,
): Promise<void> {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(forTenant, outletId),
    binding: { tenantId: forTenant, outletId, userId },
    pin: "482916",
  });
  const at = new Date();
  await asOwner(
    `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
        pepper_version, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $4, $11, $11, $11, $11)`,
    [
      randomUUID(),
      forTenant,
      outletId,
      userId,
      hashed.pinHash,
      hashed.salt,
      hashed.params.N,
      hashed.params.r,
      hashed.params.p,
      currentStaffPinPepperVersion(),
      at,
    ],
    forTenant,
  );
}

type Seeded = { id: string; employeeNo: string; fullName: string };

async function seedEmployee(input: {
  forTenant?: string;
  homeOutletId: string;
  userId: string | null;
  status: "onboarding" | "active" | "suspended" | "terminated";
  label: string;
}): Promise<Seeded> {
  const forTenant = input.forTenant ?? tenantId;
  const id = randomUUID();
  const employeeNo = `PS-${id.slice(0, 8).toUpperCase()}`;
  const fullName = `Karyawan Snapshot ${input.label} ${tag}`;
  await asOwner(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', $7, $8)`,
    [
      id,
      forTenant,
      input.userId,
      employeeNo,
      fullName,
      input.homeOutletId,
      input.status,
      input.status === "terminated" ? "2025-06-30" : null,
    ],
    forTenant,
  );
  return { id, employeeNo, fullName };
}

async function seedShift(input: {
  forTenant?: string;
  outletId: string;
  employeeId: string;
  daysFromToday: number;
  status: "published" | "swapped" | "cancelled";
  createdBy: string;
}): Promise<string> {
  const forTenant = input.forTenant ?? tenantId;
  const id = randomUUID();
  const date = dateAt(input.daysFromToday);
  await asOwner(
    `INSERT INTO shift_assignments
       (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
        status, source, published_by, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'user', $8, now(), $8)`,
    [
      id,
      forTenant,
      input.outletId,
      input.employeeId,
      date,
      JSON.stringify([
        { startsAt: `${date}T02:00:00.000Z`, endsAt: `${date}T10:00:00.000Z` },
      ]),
      input.status,
      input.createdBy,
    ],
    forTenant,
  );
  return id;
}

async function seedRole(
  forTenant: string,
  label: string,
  scopes = ["tenant", "brand", "outlet", "station"],
): Promise<string> {
  const { rows } = await asOwner(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, '["self.attendance.clock"]'::jsonb, false, $3::jsonb)
     RETURNING id`,
    [forTenant, `Peran snapshot ${label} ${tag}`, JSON.stringify(scopes)],
    forTenant,
  );
  return rows[0].id as string;
}

async function seedAssignment(input: {
  forTenant?: string;
  userId: string;
  roleId: string;
  scopeType: "tenant" | "brand" | "outlet" | "station";
  scopeId: string | null;
  validUntil?: string | null; // SQL interval from now, e.g. "30 days"
  expired?: boolean;
  assignedBy: string;
}): Promise<string> {
  const forTenant = input.forTenant ?? tenantId;
  const { rows } = await asOwner(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '2 days',
             CASE WHEN $6::boolean THEN now() - interval '1 day'
                  WHEN $7::text IS NOT NULL THEN now() + $7::interval
                  ELSE NULL END, $8)
     RETURNING id`,
    [
      forTenant,
      input.userId,
      input.roleId,
      input.scopeType,
      input.scopeId,
      input.expired ?? false,
      input.validUntil ?? null,
      input.assignedBy,
    ],
    forTenant,
  );
  return rows[0].id as string;
}

let outletA = "";
let outletP = "";
let outletB = "";
let outletC = "";
let brandId = "";
let tenant2: SecondTenant;
let nodeA: { id: string; credential: string };
let nodeB: { id: string; credential: string };
let nodeC: { id: string; credential: string };

// Fixture ids, filled by beforeAll.
const ids = {
  users: {} as Record<string, { id: string; name: string }>,
  employees: {} as Record<string, Seeded>,
  shifts: {} as Record<string, string>,
  roles: {} as Record<string, string>,
  assignments: {} as Record<string, string>,
};

const sortedIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const sort = (values: string[]) => [...values].sort();

const app = createApp();

function get(credential: string | null, headers: Record<string, string> = {}) {
  let req = request(app).get(PATH);
  if (credential !== null)
    req = req.set("Authorization", `Bearer ${credential}`);
  for (const [name, value] of Object.entries(headers))
    req = req.set(name, value);
  return req;
}

async function snapshotOf(credential: string): Promise<EdgePeopleSnapshot> {
  const res = await get(credential);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as EdgePeopleSnapshot;
}

const keyOf = (node: { id: string }, outletId: string): VerifiedEdgeNode =>
  ({
    tenantId: tenantIdSchema.parse(tenantId),
    outletId: outletIdSchema.parse(outletId),
    edgeNodeId: node.id,
  }) as unknown as VerifiedEdgeNode;

const bytesToBase64 = (value: unknown) =>
  typeof value === "string"
    ? value
    : Buffer.from(value as Uint8Array).toString("base64");

async function seedOf(outletId: string): Promise<Buffer | null> {
  const { rows } = await asOwner(
    "SELECT seed FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? (rows[0].seed as Buffer) : null;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  await avoidUtcMidnight();

  outletA = await cloneOutlet("O");
  outletP = await cloneOutlet("P");
  outletB = await cloneOutlet("B");
  outletC = await cloneOutlet("C");
  brandId = (
    await asOwner("SELECT brand_id FROM outlets WHERE id = $1", [outletA])
  ).rows[0].brand_id as string;

  const register = async (outletId: string, label: string) => {
    const registered = await registerEdgeNode(scopeOf(outletId), actor, {
      outletId,
      role: "primary",
      label,
    });
    return { id: registered.edgeNode.id, credential: registered.credential };
  };
  nodeA = await register(outletA, "Mini PC uji snapshot O");
  nodeB = await register(outletB, "Mini PC uji snapshot B");
  nodeC = await register(outletC, "Mini PC uji snapshot C");

  // People.
  const names = [
    "U1",
    "U2",
    "U3",
    "U4",
    "U5",
    "U6",
    "U8",
    "U9",
    "U10",
    "UB",
    "MGR",
  ];
  for (const label of names) ids.users[label] = await seedUser(label);
  const u = (label: string) => ids.users[label]!.id;
  const mgr = u("MGR");

  await seedPin(tenantId, outletA, u("U1"));
  await seedPin(tenantId, outletA, u("U3"));
  await seedPin(tenantId, outletP, u("U10"));
  await seedPin(tenantId, outletB, u("UB"));

  const employee = async (
    key: string,
    home: string,
    userLabel: string | null,
    status: "onboarding" | "active" | "suspended" | "terminated",
  ) => {
    ids.employees[key] = await seedEmployee({
      homeOutletId: home,
      userId: userLabel === null ? null : u(userLabel),
      status,
      label: key,
    });
  };
  await employee("E1", outletA, "U1", "active");
  await employee("E2", outletA, "U2", "onboarding");
  await employee("E4", outletP, "U4", "active");
  await employee("E9", outletP, "U9", "active");
  await employee("E5", outletA, "U5", "terminated");
  await employee("E6", outletA, "U6", "suspended");
  await employee("E7", outletA, null, "active");
  await employee("E8", outletP, "U8", "active");
  await employee("E10", outletP, "U10", "active");
  await employee("EB", outletB, "UB", "active");
  const e = (key: string) => ids.employees[key]!.id;

  // Shifts.
  const shift = async (
    key: string,
    outletId: string,
    employeeKey: string,
    days: number,
    status: "published" | "swapped" | "cancelled" = "published",
  ) => {
    ids.shifts[key] = await seedShift({
      outletId,
      employeeId: e(employeeKey),
      daysFromToday: days,
      status,
      createdBy: mgr,
    });
  };
  await shift("S1", outletA, "E1", 2); // sent
  await shift("S1cancelled", outletA, "E1", 3, "cancelled"); // status
  await shift("S1far", outletA, "E1", 20); // window
  await shift("S1atP", outletP, "E1", 5); // other outlet
  await shift("S2", outletA, "E2", 1); // sent
  await shift("S4", outletA, "E4", 2); // sent, home P
  await shift("S9", outletA, "E9", 1, "swapped"); // sent, swapped
  await shift("S6", outletA, "E6", 2); // suspended employee
  await shift("S7", outletA, "E7", 2); // employee without user
  await shift("S8far", outletA, "E8", 20); // outside the window
  await shift("SB", outletB, "EB", 2); // outlet B

  // Roles and assignments.
  ids.roles.R1 = await seedRole(tenantId, "R1");
  ids.roles.R2 = await seedRole(tenantId, "R2");
  ids.roles.station = await seedRole(tenantId, "station");
  ids.roles.expired = await seedRole(tenantId, "expired");
  ids.roles.otherOutlet = await seedRole(tenantId, "other-outlet");
  ids.roles.unsentUser = await seedRole(tenantId, "unsent-user");
  const assign = async (
    key: string,
    userLabel: string,
    role: string,
    scopeType: "tenant" | "brand" | "outlet" | "station",
    scopeId: string | null,
    extra: { validUntil?: string; expired?: boolean } = {},
  ) => {
    ids.assignments[key] = await seedAssignment({
      userId: u(userLabel),
      roleId: ids.roles[role]!,
      scopeType,
      scopeId,
      assignedBy: mgr,
      ...extra,
    });
  };
  await assign("tenant", "U1", "R1", "tenant", null);
  await assign("brand", "U2", "R1", "brand", brandId, {
    validUntil: "30 days",
  });
  await assign("outletO", "U3", "R2", "outlet", outletA);
  await assign("station", "U1", "station", "station", randomUUID());
  await assign("expired", "U2", "expired", "tenant", null, { expired: true });
  await assign("otherOutlet", "U3", "otherOutlet", "outlet", outletP);
  await assign("unsentUser", "U5", "unsentUser", "tenant", null);
  await assign("userB", "UB", "R1", "outlet", outletB);

  // Attendance policies: the override for O is sent, the one for P is not.
  const policy = JSON.stringify({
    geofenceRadiusM: 100,
    outsideGeofenceAction: "flag",
    unboundDeviceAction: "flag",
    requireSelfie: true,
    requireDeviceBinding: false,
    allowRotatingQr: true,
    selfieRetentionDays: 30,
  });
  const sampling = JSON.stringify({
    rate: 0.1,
    flaggedAlways: true,
    minPerSupervisorPerWeek: 0,
  });
  for (const outletId of [outletA, outletP])
    await asOwner(
      `INSERT INTO attendance_policies (tenant_id, outlet_id, policy, sampling, updated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, outletId, policy, sampling, mgr],
    );

  // Another tenant with the same kinds of rows.
  tenant2 = await createSecondTenant(owner, "edgesnap");
  const t2User = await seedUser("UT");
  ids.users.UT = t2User;
  await seedPin(tenant2.tenantId, tenant2.outletId, t2User.id);
  ids.employees.ET = await seedEmployee({
    forTenant: tenant2.tenantId,
    homeOutletId: tenant2.outletId,
    userId: t2User.id,
    status: "active",
    label: "ET",
  });
  ids.shifts.ST = await seedShift({
    forTenant: tenant2.tenantId,
    outletId: tenant2.outletId,
    employeeId: ids.employees.ET.id,
    daysFromToday: 2,
    status: "published",
    createdBy: t2User.id,
  });
  ids.roles.RT = await seedRole(tenant2.tenantId, "RT");
  ids.assignments.AT = await seedAssignment({
    forTenant: tenant2.tenantId,
    userId: t2User.id,
    roleId: ids.roles.RT,
    scopeType: "tenant",
    scopeId: null,
    assignedBy: t2User.id,
  });
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  // Best effort: a failed cleanup must not hide a test failure, and every row
  // sits on private outlets, users and a private tenant.
  const run = async (
    text: string,
    params: unknown[],
    forTenant: string = tenantId,
  ) => {
    try {
      await asOwner(text, params, forTenant);
    } catch {
      // leave rows behind; harmless for other files
    }
  };
  const outletIds = createdOutlets;
  for (const [forTenant, outletList] of [
    [tenantId, outletIds],
    [tenant2?.tenantId, tenant2 ? [tenant2.outletId] : []],
  ] as const) {
    if (!forTenant) continue;
    for (const sql of [
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      "DELETE FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      "DELETE FROM staff_pins WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      "DELETE FROM edge_nodes WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
    ])
      await run(sql, [forTenant, outletList], forTenant);
  }
  for (const forTenant of [tenantId, tenant2?.tenantId]) {
    if (!forTenant) continue;
    await run(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [forTenant, createdUsers],
      forTenant,
    );
    await run(
      "DELETE FROM employees WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [forTenant, createdUsers],
      forTenant,
    );
    await run(
      "DELETE FROM employees WHERE tenant_id = $1 AND employee_no LIKE 'PS-%' AND full_name LIKE $2",
      [forTenant, `Karyawan Snapshot % ${tag}`],
      forTenant,
    );
    await run(
      "DELETE FROM roles WHERE tenant_id = $1 AND name LIKE $2",
      [forTenant, `Peran snapshot % ${tag}`],
      forTenant,
    );
  }
  await run('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers]);
  await run("DELETE FROM outlets WHERE id = ANY($1::uuid[])", [createdOutlets]);
  try {
    if (tenant2) await removeSecondTenant(owner, tenant2);
  } catch {
    // see above
  }
  await owner.end();
});

// ---------------------------------------------------------------------------

describe("legend-ye4j1 T1 snapshot scope: only outlet O", () => {
  it("T1 sends the users who hold a staff PIN at O plus the user of every employee sent, and nobody else", async () => {
    const body = await snapshotOf(nodeA.credential);
    const u = (label: string) => ids.users[label]!.id;
    // U1 (pin + employee), U3 (pin only), U2/U4/U9 (employee only).
    expect(sortedIds(body.users)).toEqual(
      sort([u("U1"), u("U2"), u("U3"), u("U4"), u("U9")]),
    );
    for (const label of ["U5", "U6", "U8", "U10", "UB", "UT", "MGR"])
      expect(body.users.map((x) => x.id)).not.toContain(u(label));
  });

  it("T1 sends the roles referenced by the assignments sent and no other role", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(sortedIds(body.roles)).toEqual(sort([ids.roles.R1!, ids.roles.R2!]));
    expect(sortedIds(body.roleAssignments)).toEqual(
      sort([
        ids.assignments.tenant!,
        ids.assignments.brand!,
        ids.assignments.outletO!,
      ]),
    );
    const roleIds = new Set(body.roles.map((r) => r.id));
    for (const assignment of body.roleAssignments)
      expect(roleIds.has(assignment.roleId)).toBe(true);
  });

  it("T1 sends the attendance policy override of O and not the one of outlet P", async () => {
    const body = await snapshotOf(nodeA.credential);
    const outletIdsSent = body.attendancePolicies.map((p) => p.outletId);
    expect(outletIdsSent).toContain(outletA);
    expect(outletIdsSent).not.toContain(outletP);
    // Anything else is the tenant default (outlet null).
    for (const id of outletIdsSent) expect([outletA, null]).toContain(id);
  });
});

describe("legend-ye4j1 T1 employees and shifts", () => {
  it("T1 sends employees by home outlet O or a published/swapped shift at O in the window", async () => {
    const body = await snapshotOf(nodeA.credential);
    const e = (key: string) => ids.employees[key]!;
    // E1/E2: home O. E4/E9: home P with a shift at O inside the window.
    expect(sortedIds(body.employees)).toEqual(
      sort([e("E1").id, e("E2").id, e("E4").id, e("E9").id]),
    );
    const byId = new Map<string, (typeof body.employees)[number]>(
      body.employees.map((x) => [x.id, x]),
    );
    expect(byId.get(e("E1").id)).toMatchObject({
      employeeNo: e("E1").employeeNo,
      fullName: e("E1").fullName,
      userId: ids.users.U1!.id,
      status: "active",
    });
    expect(byId.get(e("E2").id)?.status).toBe("onboarding");
    // Shifts only count at O: E1's shift at P and E8's far-off shift do not pull
    // in anyone, and E10 (home P, no shift at O) stays out.
    for (const key of ["E5", "E6", "E7", "E8", "E10", "EB"])
      expect(body.employees.map((x) => x.id)).not.toContain(e(key).id);
  });

  it("T1 excludes terminated and suspended employees, even one with a published shift at O", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.employees.map((x) => x.id)).not.toContain(ids.employees.E5!.id);
    expect(body.employees.map((x) => x.id)).not.toContain(ids.employees.E6!.id);
    // The shift of the suspended employee is not sent either (FK on the edge).
    expect(body.shiftAssignments.map((x) => x.id)).not.toContain(
      ids.shifts.S6!,
    );
    for (const employee of body.employees)
      expect(["onboarding", "active"]).toContain(employee.status);
  });

  it("T1 excludes an employee without a user, even one with a published shift at O", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.employees.map((x) => x.id)).not.toContain(ids.employees.E7!.id);
    expect(body.shiftAssignments.map((x) => x.id)).not.toContain(
      ids.shifts.S7!,
    );
    for (const employee of body.employees) expect(employee.userId).toBeTruthy();
  });

  it("T1 sends an employee with a shift at O and home outlet P with homeOutletId = O", async () => {
    const body = await snapshotOf(nodeA.credential);
    const byId = new Map<string, (typeof body.employees)[number]>(
      body.employees.map((x) => [x.id, x]),
    );
    expect(byId.get(ids.employees.E4!.id)?.homeOutletId).toBe(outletA);
    expect(byId.get(ids.employees.E9!.id)?.homeOutletId).toBe(outletA);
    for (const employee of body.employees)
      expect(employee.homeOutletId).toBe(outletA);
  });

  it("T1 sends only published or swapped shifts at O between today-1 and today+7, for employees sent", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(sortedIds(body.shiftAssignments)).toEqual(
      sort([ids.shifts.S1!, ids.shifts.S2!, ids.shifts.S4!, ids.shifts.S9!]),
    );
    for (const shift of body.shiftAssignments) {
      expect(shift.outletId).toBe(outletA);
      expect(["published", "swapped"]).toContain(shift.status);
      expect(shift.businessDate >= dateAt(-2)).toBe(true);
      expect(shift.businessDate <= dateAt(8)).toBe(true);
    }
    const swapped = body.shiftAssignments.find((x) => x.id === ids.shifts.S9);
    expect(swapped?.status).toBe("swapped");
    const sentEmployees = new Set(body.employees.map((x) => x.id));
    for (const shift of body.shiftAssignments)
      expect(sentEmployees.has(shift.employeeId)).toBe(true);
  });
});

describe("legend-ye4j1 T1 isolation", () => {
  it("T1 never sends another tenant's users, employees, shifts or assignments", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.users.map((x) => x.id)).not.toContain(ids.users.UT!.id);
    expect(body.employees.map((x) => x.id)).not.toContain(ids.employees.ET!.id);
    expect(body.shiftAssignments.map((x) => x.id)).not.toContain(
      ids.shifts.ST!,
    );
    expect(body.roles.map((x) => x.id)).not.toContain(ids.roles.RT!);
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.AT!,
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain(tenant2.tenantId);
    for (const row of [...body.employees, ...body.roles])
      expect(row.tenantId).toBe(tenantId);
  });

  it("T1 never sends data of another outlet of the same tenant", async () => {
    const body = await snapshotOf(nodeA.credential);
    const text = JSON.stringify(body);
    // Outlet B and P rows and ids stay out (positive control: the same rows are
    // in the B snapshot, see the next case).
    expect(body.users.map((x) => x.id)).not.toContain(ids.users.UB!.id);
    expect(body.users.map((x) => x.id)).not.toContain(ids.users.U10!.id);
    expect(body.shiftAssignments.map((x) => x.id)).not.toContain(
      ids.shifts.SB!,
    );
    expect(body.shiftAssignments.map((x) => x.id)).not.toContain(
      ids.shifts.S1atP!,
    );
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.userB!,
    );
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.otherOutlet!,
    );
    expect(text).not.toContain(outletB);
    expect(text).not.toContain(outletP);
  });

  it("T1 the credential of outlet B (same tenant) gets none of outlet A's shifts or home-outlet-A-only employees", async () => {
    const bodyB = await snapshotOf(nodeB.credential);
    const shiftIdsA = [
      ids.shifts.S1!,
      ids.shifts.S2!,
      ids.shifts.S4!,
      ids.shifts.S9!,
    ];
    for (const id of shiftIdsA)
      expect(bodyB.shiftAssignments.map((x) => x.id)).not.toContain(id);
    for (const key of ["E1", "E2", "E4", "E9"])
      expect(bodyB.employees.map((x) => x.id)).not.toContain(
        ids.employees[key]!.id,
      );
    for (const label of ["U1", "U2", "U3", "U4", "U9"])
      expect(bodyB.users.map((x) => x.id)).not.toContain(ids.users[label]!.id);
    // Positive control: B receives its own people.
    expect(bodyB.shiftAssignments.map((x) => x.id)).toContain(ids.shifts.SB!);
    expect(bodyB.employees.map((x) => x.id)).toContain(ids.employees.EB!.id);
    expect(
      bodyB.employees.find((x) => x.id === ids.employees.EB!.id)?.homeOutletId,
    ).toBe(outletB);
    expect(bodyB.users.map((x) => x.id)).toContain(ids.users.UB!.id);
  });
});

describe("legend-ye4j1 T1 whitelist and strict contract", () => {
  it("T1 every object carries exactly the whitelisted keys and never a sensitive field or real email", async () => {
    const res = await get(nodeA.credential);
    expect(res.status).toBe(200);
    const body = res.body as EdgePeopleSnapshot;
    const keysOf = (row: object) => Object.keys(row).sort();
    const expectKeys = (rows: object[], keys: readonly string[]) => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(keysOf(row)).toEqual([...keys].sort());
    };
    expectKeys(body.users, EDGE_PEOPLE_SNAPSHOT_USER_KEYS);
    expectKeys(body.employees, EDGE_PEOPLE_SNAPSHOT_EMPLOYEE_KEYS);
    expectKeys(
      body.shiftAssignments,
      EDGE_PEOPLE_SNAPSHOT_SHIFT_ASSIGNMENT_KEYS,
    );
    expectKeys(body.roles, EDGE_PEOPLE_SNAPSHOT_ROLE_KEYS);
    expectKeys(body.roleAssignments, EDGE_PEOPLE_SNAPSHOT_ROLE_ASSIGNMENT_KEYS);
    expectKeys(
      body.attendancePolicies,
      EDGE_PEOPLE_SNAPSHOT_ATTENDANCE_POLICY_KEYS,
    );

    const text = res.text;
    for (const forbidden of [
      "password",
      "Encrypted",
      "encrypted",
      "Hmac",
      "hmac",
      "nik",
      "npwp",
      "bpjs",
      "bank",
      "image",
    ])
      expect(text, `body contains "${forbidden}"`).not.toContain(forbidden);
    for (const email of realEmails.values()) expect(text).not.toContain(email);
    expect(text).not.toContain("@example.test");
    for (const image of ["cdn.example.test", ".png"])
      expect(text).not.toContain(image);
  });

  it("T1 the user email is <id>@edge.invalid and email is never verified", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.users.length).toBeGreaterThan(0);
    for (const user of body.users) {
      expect(user.email).toBe(`${user.id}@edge.invalid`);
      expect(user.emailVerified).toBe(false);
    }
    const u1 = body.users.find((x) => x.id === ids.users.U1!.id);
    expect(u1?.name).toBe(ids.users.U1!.name);
    expect(u1?.banned).toBe(false);
  });

  it("T1 assignedBy is the assignee and the assigning admin is not shipped", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.roleAssignments.length).toBeGreaterThan(0);
    for (const assignment of body.roleAssignments)
      expect(assignment.assignedBy).toBe(assignment.userId);
    expect(JSON.stringify(body.roleAssignments)).not.toContain(
      ids.users.MGR!.id,
    );
  });

  it("T1 does not send a station-scoped assignment", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.station!,
    );
    expect(body.roles.map((x) => x.id)).not.toContain(ids.roles.station!);
    for (const assignment of body.roleAssignments)
      expect(assignment.scope.type).not.toBe("station");
  });

  it("T1 does not send an assignment whose validUntil is in the past", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.expired!,
    );
    expect(body.roles.map((x) => x.id)).not.toContain(ids.roles.expired!);
    // The one with a future validUntil is still sent.
    expect(body.roleAssignments.map((x) => x.id)).toContain(
      ids.assignments.brand!,
    );
  });

  it("T1 does not send an assignment scoped to another outlet, and sends tenant, brand of O and O scopes", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.roleAssignments.map((x) => x.id)).not.toContain(
      ids.assignments.otherOutlet!,
    );
    expect(body.roles.map((x) => x.id)).not.toContain(ids.roles.otherOutlet!);
    const scopes = body.roleAssignments.map((x) => x.scope);
    expect(scopes.map((s) => s.type).sort()).toEqual(
      ["brand", "outlet", "tenant"].sort(),
    );
    expect(JSON.stringify(scopes)).toContain(brandId);
    expect(JSON.stringify(scopes)).toContain(outletA);
  });

  it("T1 shiftTemplateId and stationId are always null", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.shiftAssignments.length).toBeGreaterThan(0);
    for (const shift of body.shiftAssignments) {
      expect(shift.shiftTemplateId).toBeNull();
      expect(shift.stationId).toBeNull();
    }
  });

  it("T1 the body parses with edgePeopleSnapshotSchema", async () => {
    const body = await snapshotOf(nodeA.credential);
    const parsed = edgePeopleSnapshotSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("T1 strips extra columns on the snapshot and its records", async () => {
    const body = await snapshotOf(nodeA.credential);
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.employees.length).toBeGreaterThan(0);
    expect(body.shiftAssignments.length).toBeGreaterThan(0);
    const withExtra = <K extends "users" | "employees" | "shiftAssignments">(
      key: K,
      column: string,
    ) => {
      const copy = structuredClone(body) as unknown as Record<
        string,
        Record<string, unknown>[]
      >;
      copy[key]![0]![column] = "leak";
      return edgePeopleSnapshotSchema.parse(copy);
    };
    expect(withExtra("users", "passwordHash").users[0]).not.toHaveProperty(
      "passwordHash",
    );
    expect(
      withExtra("employees", "ptkpStatus").employees[0],
    ).not.toHaveProperty("ptkpStatus");
    expect(
      withExtra("shiftAssignments", "createIdempotencyKey").shiftAssignments[0],
    ).not.toHaveProperty("createIdempotencyKey");
    expect(
      edgePeopleSnapshotSchema.parse({ ...body, seed: "leak" }),
    ).not.toHaveProperty("seed");
  });
});

describe("legend-ye4j1 T1 QR day keys (design 4)", () => {
  it("T1 qrKeys carry UTC days today-1 to today+3, equal to the keys derived from the seed, and never the seed", async () => {
    // No seed yet: the snapshot creates it (the edge must be able to ask first).
    await asOwner(
      "DELETE FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletA],
    );
    expect(await seedOf(outletA)).toBeNull();

    const result = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    const seed = await seedOf(outletA);
    expect(seed, "the seed exists after the call").not.toBeNull();

    const today = dayIndexOf(NOW1);
    const keys = [...result.body.qrKeys].sort(
      (a, b) => a.dayIndex - b.dayIndex,
    );
    expect(keys.map((k) => k.dayIndex)).toEqual([
      today - 1,
      today,
      today + 1,
      today + 2,
      today + 3,
    ]);
    const expected = deriveQrDayKeys(seed!, tenantId, outletA, today - 1, 5);
    expect(keys.map((k) => [k.dayIndex, k.key] as const)).toEqual(
      [...expected]
        .sort((a, b) => a.dayIndex - b.dayIndex)
        .map((k) => [k.dayIndex, bytesToBase64(k.key)] as const),
    );

    const text = JSON.stringify(result.body);
    expect(text).not.toContain(seed!.toString("base64"));
    expect(text).not.toContain(seed!.toString("hex"));
    expect(text).not.toContain(seed!.toString("base64url"));
  });
});

describe("legend-ye4j1 T1 ETag and 304", () => {
  it("T1 an unchanged ETag in If-None-Match gives 304 with no body", async () => {
    const first = await get(nodeA.credential);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(
      Number.isNaN(
        Date.parse(first.headers["x-legend-snapshot-generated-at"] as string),
      ),
    ).toBe(false);

    const second = await get(nodeA.credential, { "If-None-Match": etag });
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    expect(second.headers.etag).toBe(etag);

    // A different tag is a full answer again.
    const other = await get(nodeA.credential, {
      "If-None-Match": `"${"0".repeat(64)}"`,
    });
    expect(other.status).toBe(200);
  });

  it("T1 the ETag is stable across two calls in the same minute (generatedAt is not hashed)", async () => {
    const one = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    const two = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1_SAME_MINUTE,
    });
    expect(one.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(two.etag).toBe(one.etag);
    expect(Number.isNaN(Date.parse(one.generatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(two.generatedAt))).toBe(false);
    expect(edgePeopleSnapshotSchema.safeParse(one.body).success).toBe(true);
    expect(JSON.stringify(one.body)).not.toContain(one.generatedAt);
  });

  it("T1 the ETag changes after a shift is added", async () => {
    const before = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    const added = await seedShift({
      outletId: outletA,
      employeeId: ids.employees.E2!.id,
      daysFromToday: 4,
      status: "published",
      createdBy: ids.users.MGR!.id,
    });
    try {
      const after = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
        now: NOW1,
      });
      expect(after.body.shiftAssignments.map((x) => x.id)).toContain(added);
      expect(after.etag).not.toBe(before.etag);
    } finally {
      await asOwner("DELETE FROM shift_assignments WHERE id = $1", [added]);
    }
    const restored = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(restored.etag).toBe(before.etag);
  });

  it("T1 the ETag changes when a QR day key rolls (one UTC day later)", async () => {
    const today = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    const tomorrow = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1_NEXT_DAY,
    });
    expect(tomorrow.etag).not.toBe(today.etag);
    expect(Math.min(...tomorrow.body.qrKeys.map((k) => k.dayIndex))).toBe(
      dayIndexOf(NOW1_NEXT_DAY) - 1,
    );
    const keyOfDay = (
      snapshot: typeof today,
      dayIndex: number,
    ): string | undefined =>
      snapshot.body.qrKeys.find((k) => k.dayIndex === dayIndex)?.key;
    // A day both snapshots carry keeps its key; only the set moves.
    expect(keyOfDay(tomorrow, dayIndexOf(NOW1))).toBe(
      keyOfDay(today, dayIndexOf(NOW1)),
    );
  });
});

describe("legend-ye4j1 T1 authentication and caching headers", () => {
  it("T1 without an Authorization header the answer is 401", async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(ids.users.U1!.id);
    expect(res.body.users).toBeUndefined();
  });

  it("T1 an unknown credential gets 401", async () => {
    const res = await get(`edge_${randomBytes(24).toString("hex")}`);
    expect(res.status).toBe(401);
    expect(res.body.users).toBeUndefined();
  });

  it("T1 a revoked edge node gets 401", async () => {
    // Works before the revoke (positive control), refused after it.
    expect((await get(nodeC.credential)).status).toBe(200);
    await revokeEdgeNode(scopeOf(outletC), actor, {
      edgeNodeId: nodeC.id,
      reason: "Unit dicabut uji snapshot",
    });
    const res = await get(nodeC.credential);
    expect(res.status).toBe(401);
    expect(res.body.users).toBeUndefined();
  });

  it("T1 Cache-Control contains no-store on 200 and on 304", async () => {
    const first = await get(nodeA.credential);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toContain("no-store");
    expect(first.headers["cache-control"]).toContain("private");
    const second = await get(nodeA.credential, {
      "If-None-Match": first.headers.etag as string,
    });
    expect(second.status).toBe(304);
    expect(second.headers["cache-control"]).toContain("no-store");
  });
});

describe("legend-ye4j1 T1 selfie seal public key (design 5)", () => {
  const KEYS = "ATTENDANCE_SELFIE_SEAL_KEYS";
  const ACTIVE = "ATTENDANCE_SELFIE_SEAL_ACTIVE_KID";

  async function withEnv<T>(
    values: Record<string, string | undefined>,
    run: () => Promise<T>,
  ): Promise<T> {
    const saved = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return await run();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it("T1 with the seal key env set, selfieSealKey is { kid, publicKeyPem } and no private key text is sent", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 3072,
    });
    const privatePem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const kid = `kid-${tag.toLowerCase()}`;
    const result = await withEnv(
      { [KEYS]: JSON.stringify({ [kid]: privatePem }), [ACTIVE]: kid },
      () => buildEdgePeopleSnapshot(keyOf(nodeA, outletA), { now: NOW1 }),
    );
    expect(result.body.selfieSealKey).not.toBeNull();
    expect(result.body.selfieSealKey!.kid).toBe(kid);
    expect(result.body.selfieSealKey!.publicKeyPem).toMatch(
      /^-----BEGIN PUBLIC KEY-----/,
    );
    // Same key, whatever the PEM line layout.
    const sent = createPublicKey(
      result.body.selfieSealKey!.publicKeyPem,
    ).export({
      type: "spki",
      format: "der",
    });
    const expected = publicKey.export({ type: "spki", format: "der" });
    expect(Buffer.compare(sent, expected)).toBe(0);
    expect(Object.keys(result.body.selfieSealKey!).sort()).toEqual([
      "kid",
      "publicKeyPem",
    ]);
    const text = JSON.stringify(result.body);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(
      privatePem
        .split("\n")
        .filter((line) => line && !line.startsWith("-----"))[1]!,
    );
    expect(edgePeopleSnapshotSchema.safeParse(result.body).success).toBe(true);
  });

  it("T1 a seal key that is not RSA-3072 (EC, RSA-2048) is never sent", async () => {
    const kid = `kid-weak-${tag.toLowerCase()}`;
    const weak = [
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
    ];
    for (const key of weak) {
      const pem = key.export({ type: "pkcs8", format: "pem" }).toString();
      const result = await withEnv(
        { [KEYS]: JSON.stringify({ [kid]: pem }), [ACTIVE]: kid },
        () => buildEdgePeopleSnapshot(keyOf(nodeA, outletA), { now: NOW1 }),
      );
      expect(result.body.selfieSealKey).toBeNull();
    }
  });

  it("T1 with no seal key configured, selfieSealKey is null", async () => {
    const result = await withEnv(
      { [KEYS]: undefined, [ACTIVE]: undefined },
      () => buildEdgePeopleSnapshot(keyOf(nodeA, outletA), { now: NOW1 }),
    );
    expect(result.body.selfieSealKey).toBeNull();
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE KEY");
  });
});

describe("legend-ye4j1 T1 logging", () => {
  const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

  /** Every call on the shared logger or one of its children is recorded. */
  function captureLogs(): unknown[][] {
    const calls: unknown[][] = [];
    const sink = (...args: unknown[]) => {
      calls.push(args);
    };
    const originalChild = logger.child.bind(logger) as (
      ...args: unknown[]
    ) => unknown;
    for (const level of LEVELS)
      vi.spyOn(logger, level).mockImplementation(sink as never);
    vi.spyOn(logger, "child").mockImplementation(((...args: unknown[]) => {
      const child = originalChild(...args) as Record<string, unknown>;
      for (const level of LEVELS) child[level] = sink;
      return child;
    }) as never);
    return calls;
  }

  it("T1 a 200 logs no person name and no employee number from the seed", async () => {
    const calls = captureLogs();
    const res = await get(nodeA.credential);
    expect(res.status).toBe(200);
    const logged = inspect(calls, { depth: 10, maxArrayLength: null });
    for (const user of Object.values(ids.users))
      expect(logged).not.toContain(user.name);
    for (const employee of Object.values(ids.employees)) {
      expect(logged).not.toContain(employee.employeeNo);
      expect(logged).not.toContain(employee.fullName);
    }
    for (const email of realEmails.values())
      expect(logged).not.toContain(email);
    // The credential is not asserted here: the shared request logger holds the
    // raw request object (pino redacts `authorization` when it serialises it),
    // which is the same for every edge route and not part of the snapshot.
  });
});

describe("legend-ye4j1 T1 ban expiry and contract refusal", () => {
  const u1 = () => ids.users.U1!.id;
  const restore = () =>
    asOwner(
      `UPDATE "user" SET banned = false, ban_expires = NULL, name = $2 WHERE id = $1`,
      [u1(), ids.users.U1!.name],
    );
  afterEach(restore);

  it("T1 a ban that has expired is sent as banned=false, a running ban as true", async () => {
    await asOwner(
      `UPDATE "user" SET banned = true, ban_expires = $2 WHERE id = $1`,
      [u1(), new Date(NOW1.getTime() - 60_000).toISOString()],
    );
    const expired = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(expired.body.users.find((x) => x.id === u1())?.banned).toBe(false);
    await asOwner(`UPDATE "user" SET ban_expires = $2 WHERE id = $1`, [
      u1(),
      new Date(NOW1.getTime() + 3_600_000).toISOString(),
    ]);
    const running = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(running.body.users.find((x) => x.id === u1())?.banned).toBe(true);
    await asOwner(`UPDATE "user" SET ban_expires = NULL WHERE id = $1`, [u1()]);
    const permanent = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(permanent.body.users.find((x) => x.id === u1())?.banned).toBe(true);
  });

  it("T1 a user who is banned right now is sent with no role assignment, an expired ban keeps the assignment (legend-tkycp)", async () => {
    const assignmentsOf = (
      body: Awaited<ReturnType<typeof buildEdgePeopleSnapshot>>["body"],
      userId: string,
    ) => body.roleAssignments.filter((row) => row.userId === userId);
    // The edge refuses an assignment for a banned grantee (trigger
    // role_assignments_grantee_guard), so the cloud does not send one.
    await asOwner(
      `UPDATE "user" SET banned = true, ban_expires = NULL WHERE id = $1`,
      [u1()],
    );
    const banned = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(banned.body.users.find((x) => x.id === u1())?.banned).toBe(true);
    expect(assignmentsOf(banned.body, u1())).toEqual([]);
    // Other users keep theirs.
    expect(
      banned.body.roleAssignments.some(
        (row) => row.id === ids.assignments.outletO,
      ),
    ).toBe(true);
    // A ban that has run out no longer blocks: the assignment comes back.
    await asOwner(`UPDATE "user" SET ban_expires = $2 WHERE id = $1`, [
      u1(),
      new Date(NOW1.getTime() - 60_000).toISOString(),
    ]);
    const expired = await buildEdgePeopleSnapshot(keyOf(nodeA, outletA), {
      now: NOW1,
    });
    expect(expired.body.users.find((x) => x.id === u1())?.banned).toBe(false);
    expect(assignmentsOf(expired.body, u1()).map((row) => row.id)).toContain(
      ids.assignments.tenant,
    );
  });

  it("T1 a row the contract refuses fails with a 500-class error and logs paths only", async () => {
    await asOwner(`UPDATE "user" SET name = '' WHERE id = $1`, [u1()]);
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expect(
        buildEdgePeopleSnapshot(keyOf(nodeA, outletA), { now: NOW1 }),
      ).rejects.toThrow("failed contract validation");
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain("users.");
      expect(logged).not.toContain(ids.users.U1!.name);
      expect(logged).not.toContain(ids.users.U1!.id);
    } finally {
      error.mockRestore();
    }
  });
});
