// Exit clearance over HTTP (PRD F24 offboarding: exit clearance with access
// revocation; TEN-01/02/03; bead legend-ovxw, tier K). Runs the real Express
// app, Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe
// Legend tenant plus a throwaway second tenant. Expected behaviour comes from
// docs/briefs/299-hr-lifecycle-kpi.md (Tests, Endpoints "Offboarding") and the
// top entry of docs/DECISIONS.md (section 2), not from the service code.
// Written fail-first: the offboarding routes do not exist when this is written.
//
// Endpoints used (all under /api/hris, manager needs hr.employee.manage):
//   POST employees/:employeeId/offboarding   {exitType, reason, lastWorkingDate}
//   GET  offboardings/:id
//   POST offboardings/:id/cancel             {reason}
//   POST offboardings/:id/revoke-access      {}
//
// Assumptions (the spec leaves these open):
//  - Success answers: create 201, revoke-access 200 (also for the repeated
//    call), cancel 200. The body is `{ data: offboarding }`, with
//    `data.status` open|revoked|completed|cancelled and `data.revocationResult`
//    {roleAssignmentIds, sessionsRevoked, pushSubscriptionsRemoved,
//    cancelledShiftIds, employeeStatus} (shared contract in the brief).
//  - "After the last working day only": the exit is created with a far future
//    last working day and then moved into the past with SQL, so the test does
//    not depend on the API accepting back-dated exits. A last working day in
//    the future is refused with 409 `EXIT_NOT_DUE`. A day strictly in the past
//    (2026-01-15) is due.
//  - A "staff session" is a `session` row of kind other than `customer` bound
//    to the tenant (`tenant_id`). The test marks the employee's browser session
//    as kind `management` bound to the Cafe Legend tenant, a second sign-in as
//    `management` bound to tenant B, and a third sign-in stays a `customer`
//    session with no tenant. Only the first is revoked (sessionsRevoked = 1).
//  - A revoked session answers 401 on a tenant route (GET /api/hris/shifts
//    with the employee's own self.schedule.view role, 200 before).
//  - After the role assignments end, the PIN verify endpoint
//    (POST /api/staff-pins/verify with a device token) refuses with 401, 403
//    or 404 and returns no `data`. The spec calls it `not_member`; the HTTP code
//    is not named. The staff_pins row is kept (DECISIONS 2.6).
//  - "Ended with reason offboarding": the role assignment gets `valid_until`
//    set, a `role_assignment.ended` audit row and outbox event whose JSON
//    mentions "offboarding".
//  - The revoke writes exactly one audit row whose objectId is the offboarding
//    id ("one audit row with counts only"), on top of the per-assignment
//    `role_assignment.ended` rows.
//  - Shifts after the last working day are cancelled and listed with status
//    `cancelled` by GET /shifts; a draft shift cancelled this way emits no
//    `shift.cancelled` event (only published shifts do), so none is asserted.
//  - The `access_revocation` checklist task completion (DECISIONS 2.8) is not
//    covered here: the task category/code values are not named in the spec.
//  - Review fixes (docs/briefs/299c-review-fixes.md D1-D7). Clearance is a
//    tenant-wide act: the caller needs hr.employee.manage at tenant scope.
//    Outlet HR who reach the record get 403 `CLEARANCE_NEEDS_TENANT_HR`; a
//    record out of reach stays 404. A leaver with an active or future-dated
//    tenant-scope assignment needs the caller to hold access.role.assign at
//    tenant scope too, else 409 `OFFBOARDING_ADMIN_ROLE` (nothing changes).
//    A future-dated assignment no longer blocks: it is ended with
//    valid_until = valid_from (empty window). Sessions of kind other than
//    `customer` with tenant_id = this tenant OR tenant_id NULL are revoked
//    (the tenant is not yet stamped on a fresh session); the user must sign in
//    again for other tenants. The exit is due only AFTER the last working day:
//    last working day = today in the home outlet's timezone is 409
//    `EXIT_NOT_DUE`, yesterday is due. D5 (clock read after the advisory lock)
//    cannot be observed over HTTP and is not tested here. Shift cancellation
//    reaches every outlet with the tenant actor (D6); the concurrent
//    hand-over race (row lock and re-check) is not testable over HTTP.
//  - Existing revoke calls use `hrTenant` (hr.employee.manage, tenant scope).
//    `hrTenantAdmin` also holds access.role.assign. Exits are still created by
//    the outlet manager `hrMgr`.
//  - An unknown offboarding id answers 404; a manager of another outlet gets
//    404, a user without hr.employee.manage gets 403, anonymous gets 401; a
//    body with an unknown key or a client-sent tenantId is 422.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  asTenant as asRlsTenant,
  createAppPool,
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const tenantContext: TenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = createAppPool();

const PASSWORD = "Test-password-123!";
const PIN = "582914";
const LAST_DAY = "2026-01-15"; // strictly in the past: the exit is due
const FAR_FUTURE = "2034-09-30"; // not due
const SHIFT_AFTER = "2034-03-14"; // after LAST_DAY
const SHIFT_BEFORE = "2026-01-14"; // before LAST_DAY

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
const createdDevices: string[] = [];
/** Device registry stand-in (WS-02): device id to outlet, as device-pin-service.test.ts does. */
const deviceOutlets = new Map<string, string>();
let tenantB: SecondTenant | null = null;

type Client = ReturnType<typeof agent>;

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

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

const key = () => `cl-api-${randomUUID()}`;

// ---- fixtures ---------------------------------------------------------------

let jkt: string;
let otherOutlet: string;
let hrMgr: Client;
let hrMgrOther: Client;
let hrTenant: Client;
let hrTenantUserId: string;
let hrTenantAdmin: Client;
let scheduler: Client;
let nobody: Client;
let tplPagi: string;
let tplOther: string;

async function newRole(
  permissions: string[],
  scopeTypes: string[],
  forTenant: string = tenant.id,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      forTenant,
      `Clearance API ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(scopeTypes),
    ],
  );
  return roleId;
}

/** Backdated one hour: the container clock may drift from the Node clock. */
async function assignRole(input: {
  userId: string;
  roleId: string;
  scope: { type: "tenant" } | { type: "outlet"; id: string };
  tenantId?: string;
  validFromSql?: string;
}) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, ${input.validFromSql ?? "now() - interval '1 hour'"}, $2)
     RETURNING id`,
    [
      input.tenantId ?? tenant.id,
      input.userId,
      input.roleId,
      input.scope.type,
      input.scope.type === "outlet" ? input.scope.id : null,
    ],
  );
  return rows[0]!.id;
}

async function templateRoleId(templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Keluar', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenant.id,
      cafeLegendPlatformFixtures.brand.id,
      cafeLegendPlatformFixtures.legalEntity.id,
      `CL-${id.slice(0, 8)}`.toUpperCase(),
      `Outlet keluar ${label}`,
    ],
  );
  return id;
}

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return {
    client,
    userId,
    email,
    sessionId: session.body.session.id as string,
  };
}

async function seedEmployee(userId: string | null, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Keluar API', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenant.id, userId, `CL-${id.slice(0, 8).toUpperCase()}`, outletId],
  );
  return id;
}

async function signInCookie(email: string) {
  const response = await request(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  const session = await request(app)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  expect(session.status).toBe(200);
  return { cookie, sessionId: session.body.session.id as string };
}

type Leaver = {
  client: Client;
  email: string;
  userId: string;
  employeeId: string;
  /** Custom role (self.* views) and cashier template, both outlet scoped. */
  assignmentIds: string[];
  sessionId: string;
};

/**
 * An employee with a login: two role assignments at the outlet, a staff
 * session bound to this tenant, and an employee row.
 */
async function makeLeaver(homeOutlet: string = jkt): Promise<Leaver> {
  const { client, userId, email, sessionId } = await signedInClient(
    "Karyawan Keluar API",
    { mfa: true },
  );
  const selfRole = await newRole(
    ["self.profile.view", "self.schedule.view"],
    ["outlet"],
  );
  const assignmentIds = [
    await assignRole({
      userId,
      roleId: selfRole,
      scope: { type: "outlet", id: homeOutlet },
    }),
    await assignRole({
      userId,
      roleId: await templateRoleId("cashier"),
      scope: { type: "outlet", id: homeOutlet },
    }),
  ];
  await owner.query(
    `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
    [sessionId, tenant.id],
  );
  const employeeId = await seedEmployee(userId, homeOutlet);
  return { client, email, userId, employeeId, assignmentIds, sessionId };
}

type Offboarding = {
  id: string;
  status: string;
  employeeId: string;
  lastWorkingDate: string;
  accessRevokedAt: string | null;
  revocationResult: {
    roleAssignmentIds: string[];
    sessionsRevoked: number;
    pushSubscriptionsRemoved: number;
    cancelledShiftIds: string[];
    employeeStatus: string;
  } | null;
};

async function createOffboarding(
  employeeId: string,
  exitType: "resignation" | "termination" | "contract_end" = "termination",
  client: Client = hrMgr,
) {
  const created = await post(
    client,
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType,
      reason: "Akhir hubungan kerja uji.",
      lastWorkingDate: FAR_FUTURE,
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as Offboarding;
}

/** Moves the stored last working day (see Assumptions). */
async function setLastDay(offboardingId: string, date: string) {
  await asTenant((client) =>
    client.query(
      "UPDATE hris_offboardings SET last_working_date = $2 WHERE tenant_id = $3 AND id = $1",
      [offboardingId, date, tenant.id],
    ),
  );
}

const revoke = (offboardingId: string, client: Client = hrTenant) =>
  post(client, `/api/hris/offboardings/${offboardingId}/revoke-access`, {});

async function employeeRow(employeeId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{
      status: string;
      end_date: string | null;
    }>(
      "SELECT status, end_date::text AS end_date FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return rows[0]!;
  });
}

async function endedFlags(assignmentIds: string[]) {
  const { rows } = await owner.query<{ id: string; ended: boolean }>(
    "SELECT id, valid_until IS NOT NULL AS ended FROM role_assignments WHERE id = ANY($1::uuid[])",
    [assignmentIds],
  );
  return new Map(rows.map((row) => [row.id, row.ended]));
}

async function sessionRevoked(sessionId: string) {
  const { rows } = await owner.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM "session" WHERE id = $1`,
    [sessionId],
  );
  return rows[0]!.revoked;
}

async function endedAuditCount(assignmentId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'role_assignment.ended'`,
      [tenant.id, assignmentId],
    );
    return rows[0]!.count;
  });
}

async function endedAuditText(assignmentId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ event: unknown }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'role_assignment.ended'`,
      [tenant.id, assignmentId],
    );
    return JSON.stringify(rows.map((row) => row.event));
  });
}

async function endedEventCount(assignmentId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'role_assignment.ended'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenant.id, assignmentId],
    );
    return rows[0]!.count;
  });
}

async function auditCountByActor(actorId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'actorId' = $2`,
      [tenant.id, actorId],
    );
    return rows[0]!.count;
  });
}

async function auditCountByObject(objectId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2`,
      [tenant.id, objectId],
    );
    return rows[0]!.count;
  });
}

async function pushCount(userId: string, tenantId: string) {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM push_subscriptions WHERE tenant_id = $1 AND user_id::text = $2",
    [tenantId, userId],
  );
  return rows[0]!.count;
}

async function seedPush(userId: string, tenantId: string) {
  await owner.query(
    `INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version)
     VALUES ($1, $2, $3, $4, 'encrypted', 'v1')`,
    [tenantId, randomUUID(), userId, `cl-${randomUUID()}`],
  );
}

async function createShift(
  employeeId: string,
  businessDate: string,
  outletId: string = jkt,
  templateId: string = tplPagi,
) {
  const body = {
    outletId,
    employeeId,
    businessDate,
    shiftTemplateId: templateId,
    stationId: null,
    idempotencyKey: key(),
  };
  const direct = await post(scheduler, "/api/hris/shifts", body);
  if (direct.status === 201) return direct.body.data as { id: string };
  // The roster may refuse a shift in the past: create it in the future, then
  // move its business date (fixture setup only, not the behaviour under test).
  const created = await post(scheduler, "/api/hris/shifts", {
    ...body,
    businessDate: SHIFT_AFTER,
    idempotencyKey: key(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const shift = created.body.data as { id: string };
  await asTenant((client) =>
    client.query(
      "UPDATE shift_assignments SET business_date = $2 WHERE tenant_id = $3 AND id = $1",
      [shift.id, businessDate, tenant.id],
    ),
  );
  return shift;
}

/**
 * Stored status of a shift. Read from the table: the roster list hides
 * cancelled shifts, so it cannot show the cancellation itself.
 */
async function shiftStatus(shiftId: string, businessDate: string) {
  const { rows } = await asTenant((client) =>
    client.query<{ status: string }>(
      `SELECT status FROM shift_assignments
        WHERE tenant_id = $1 AND id = $2 AND business_date = $3::date`,
      [tenant.id, shiftId, businessDate],
    ),
  );
  expect(rows, `shift ${shiftId} stored on ${businessDate}`).toHaveLength(1);
  return rows[0].status;
}

/** A device enrolled at the outlet and a signed token for it. */
async function deviceToken() {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenant((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir keluar', $4)`,
      [deviceId, tenant.id, jkt, new Date(issuedAt * 1000)],
    ),
  );
  createdDevices.push(deviceId);
  deviceOutlets.set(deviceId, jkt);
  return signDeviceToken({
    version: 1,
    tenantId: tenant.id,
    brandId: null,
    deviceId,
    issuedAt,
  });
}

const verifyPin = (token: string, userId: string) =>
  request(app)
    .post("/api/staff-pins/verify")
    .set("X-Device-Token", token)
    .send({ userId, pin: PIN });

const READ_OWN_SHIFTS = "/api/hris/shifts?from=2034-01-03&to=2034-01-09";

beforeAll(async () => {
  setDeviceOutletResolver(async ({ tenantId: id, deviceId }) =>
    id === tenant.id ? (deviceOutlets.get(deviceId) ?? null) : null,
  );
  jkt = await seedOutlet("A");
  otherOutlet = await seedOutlet("B");
  tenantB = await createSecondTenant(owner, "clearance");

  const manager = await signedInClient("Manajer HR Keluar API", { mfa: true });
  await assignRole({
    userId: manager.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["outlet"],
    ),
    scope: { type: "outlet", id: jkt },
  });
  hrMgr = manager.client;

  const other = await signedInClient("Manajer Outlet Lain Keluar API", {
    mfa: true,
  });
  await assignRole({
    userId: other.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["outlet"],
    ),
    scope: { type: "outlet", id: otherOutlet },
  });
  hrMgrOther = other.client;

  const tenantHr = await signedInClient("HR Pusat Keluar API", { mfa: true });
  await assignRole({
    userId: tenantHr.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["tenant"],
    ),
    scope: { type: "tenant" },
  });
  hrTenant = tenantHr.client;
  hrTenantUserId = tenantHr.userId;

  const tenantAdmin = await signedInClient("HR Admin Akses Keluar API", {
    mfa: true,
  });
  await assignRole({
    userId: tenantAdmin.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view", "access.role.assign"],
      ["tenant"],
    ),
    scope: { type: "tenant" },
  });
  hrTenantAdmin = tenantAdmin.client;

  const sched = await signedInClient("Penjadwal Keluar API", { mfa: true });
  const schedRole = await newRole(["hr.schedule.manage"], ["outlet"]);
  for (const outletId of [jkt, otherOutlet])
    await assignRole({
      userId: sched.userId,
      roleId: schedRole,
      scope: { type: "outlet", id: outletId },
    });
  scheduler = sched.client;

  const none = await signedInClient("Tanpa Izin Keluar API", { mfa: true });
  await assignRole({
    userId: none.userId,
    roleId: await newRole(["self.profile.view"], ["outlet"]),
    scope: { type: "outlet", id: jkt },
  });
  nobody = none.client;

  const template = await post(scheduler, "/api/hris/shift-templates", {
    outletId: jkt,
    name: "Pagi keluar",
    segments: [{ startTime: "08:00", endTime: "16:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
  });
  expect(template.status, JSON.stringify(template.body)).toBe(201);
  tplPagi = template.body.data.id as string;
  const templateOther = await post(scheduler, "/api/hris/shift-templates", {
    outletId: otherOutlet,
    name: "Pagi keluar lain",
    segments: [{ startTime: "08:00", endTime: "16:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
  });
  expect(templateOther.status, JSON.stringify(templateOther.body)).toBe(201);
  tplOther = templateOther.body.data.id as string;
}, 180_000);

afterAll(async () => {
  setDeviceOutletResolver(null);
  await asTenant(async (client) => {
    await client.query(
      `DELETE FROM hris_checklist_task_actions WHERE tenant_id = $1 AND task_id IN
         (SELECT id FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[]))`,
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    for (const table of ["shift_assignments", "shift_templates"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN
         (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[]))`,
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cl-api-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM push_subscriptions WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdDevices],
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
  if (tenantB) {
    await owner.query("DELETE FROM push_subscriptions WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM hris_offboardings WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM employees WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  if (tenantB) await removeSecondTenant(owner, tenantB);
  await appPool.end();
  await owner.end();
});

// ---- access and validation -----------------------------------------------------

describe("offboarding access and validation", () => {
  it("[TEN-01] anonymous requests to the offboarding routes answer 401", async () => {
    const anonymous = agent(app);
    const id = randomUUID();
    expect((await anonymous.get(`/api/hris/offboardings/${id}`)).status).toBe(
      401,
    );
    expect(
      (
        await anonymous
          .post(`/api/hris/offboardings/${id}/revoke-access`)
          .set(originHeader)
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await anonymous
          .post(`/api/hris/employees/${id}/offboarding`)
          .set(originHeader)
          .send({})
      ).status,
    ).toBe(401);
  });

  it("[HR-01] a user without hr.employee.manage cannot start, read or clear an exit (403)", async () => {
    const leaver = await makeLeaver();
    const refusedCreate = await post(
      nobody,
      `/api/hris/employees/${leaver.employeeId}/offboarding`,
      { exitType: "resignation", reason: "x", lastWorkingDate: FAR_FUTURE },
    );
    expect(refusedCreate.status).toBe(403);

    const offboarding = await createOffboarding(leaver.employeeId);
    expect(
      (await nobody.get(`/api/hris/offboardings/${offboarding.id}`)).status,
    ).toBe(403);
    expect((await revoke(offboarding.id, nobody)).status).toBe(403);
    expect(
      (
        await post(nobody, `/api/hris/offboardings/${offboarding.id}/cancel`, {
          reason: "x",
        })
      ).status,
    ).toBe(403);
    // Nothing happened to the employee or the exit.
    expect((await employeeRow(leaver.employeeId)).status).toBe("active");
    const read = await hrMgr.get(`/api/hris/offboardings/${offboarding.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ status: "open" });
  }, 90_000);

  it("[TEN-01] a manager of another outlet gets 404 for that employee's exit", async () => {
    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);

    expect(
      (
        await post(
          hrMgrOther,
          `/api/hris/employees/${leaver.employeeId}/offboarding`,
          { exitType: "resignation", reason: "x", lastWorkingDate: FAR_FUTURE },
        )
      ).status,
    ).toBe(404);
    expect(
      (await hrMgrOther.get(`/api/hris/offboardings/${offboarding.id}`)).status,
    ).toBe(404);
    expect((await revoke(offboarding.id, hrMgrOther)).status).toBe(404);
    expect(
      (
        await post(
          hrMgrOther,
          `/api/hris/offboardings/${offboarding.id}/cancel`,
          { reason: "x" },
        )
      ).status,
    ).toBe(404);
    // The employee still has all access.
    expect((await employeeRow(leaver.employeeId)).status).toBe("active");
    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      false,
      false,
    ]);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(200);
  }, 90_000);

  it("[TEN-01] an unknown offboarding or employee answers 404", async () => {
    const missing = randomUUID();
    expect((await hrMgr.get(`/api/hris/offboardings/${missing}`)).status).toBe(
      404,
    );
    expect((await revoke(missing)).status).toBe(404);
    expect(
      (
        await post(hrMgr, `/api/hris/employees/${missing}/offboarding`, {
          exitType: "resignation",
          reason: "x",
          lastWorkingDate: FAR_FUTURE,
        })
      ).status,
    ).toBe(404);
  });

  it("[HR-01] creating an exit validates the body strictly and allows one open exit per employee", async () => {
    const employeeId = await seedEmployee(null, jkt);
    const path = `/api/hris/employees/${employeeId}/offboarding`;
    const valid = {
      exitType: "resignation",
      reason: "Pindah kota.",
      lastWorkingDate: FAR_FUTURE,
    };
    expect(
      (await post(hrMgr, path, { ...valid, reason: undefined })).status,
    ).toBe(422);
    expect((await post(hrMgr, path, { ...valid, reason: "" })).status).toBe(
      422,
    );
    expect(
      (await post(hrMgr, path, { ...valid, exitType: "fired" })).status,
    ).toBe(422);
    expect(
      (await post(hrMgr, path, { ...valid, lastWorkingDate: "besok" })).status,
    ).toBe(422);
    expect(
      (await post(hrMgr, path, { ...valid, tenantId: tenant.id })).status,
    ).toBe(422);
    expect((await post(hrMgr, path, { ...valid, extra: 1 })).status).toBe(422);

    const created = await post(hrMgr, path, valid);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      employeeId,
      exitType: "resignation",
      status: "open",
      lastWorkingDate: FAR_FUTURE,
      accessRevokedAt: null,
      revocationResult: null,
    });
    // The employee is not changed by opening the exit.
    expect(await employeeRow(employeeId)).toMatchObject({ status: "active" });

    expect((await post(hrMgr, path, valid)).status).toBe(409);

    // A cancelled exit frees the employee for a new one.
    const cancelled = await post(
      hrMgr,
      `/api/hris/offboardings/${created.body.data.id}/cancel`,
      { reason: "Karyawan membatalkan pengunduran diri." },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: "cancelled" });
    expect((await post(hrMgr, path, valid)).status).toBe(201);
  });

  it("[TEN-01] another tenant's exit and employee are not reachable, and RLS hides them", async () => {
    const b = tenantB!;
    const employeeB = randomUUID();
    const offboardingB = randomUUID();
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeB,
        b.tenantId,
        `TB-${employeeB.slice(0, 8).toUpperCase()}`,
        b.outletId,
      ],
    );
    await owner.query(
      `INSERT INTO hris_offboardings
         (id, tenant_id, employee_id, exit_type, reason, last_working_date, status, created_by)
       VALUES ($1, $2, $3, 'resignation', 'Tenant B', $4, 'open', $5)`,
      [offboardingB, b.tenantId, employeeB, LAST_DAY, randomUUID()],
    );

    expect(
      (await hrMgr.get(`/api/hris/offboardings/${offboardingB}`)).status,
    ).toBe(404);
    expect((await revoke(offboardingB)).status).toBe(404);
    expect(
      (
        await post(hrMgr, `/api/hris/offboardings/${offboardingB}/cancel`, {
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(hrMgr, `/api/hris/employees/${employeeB}/offboarding`, {
          exitType: "resignation",
          reason: "x",
          lastWorkingDate: FAR_FUTURE,
        })
      ).status,
    ).toBe(404);
    const untouched = await owner.query(
      "SELECT status FROM hris_offboardings WHERE id = $1",
      [offboardingB],
    );
    expect(untouched.rows).toEqual([{ status: "open" }]);

    const asA = await asRlsTenant(appPool, tenant.id, (client) =>
      client.query("SELECT id FROM hris_offboardings WHERE id = $1", [
        offboardingB,
      ]),
    );
    expect(asA.rows).toEqual([]);
    const asB = await asRlsTenant(appPool, b.tenantId, (client) =>
      client.query("SELECT id FROM hris_offboardings WHERE id = $1", [
        offboardingB,
      ]),
    );
    expect(asB.rows).toHaveLength(1);
  });
});

// ---- clearance ---------------------------------------------------------------

describe("exit clearance (POST /offboardings/:id/revoke-access)", () => {
  it("[HR-01] before the last working day the clearance is refused with 409 EXIT_NOT_DUE and nothing changes", async () => {
    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);

    const refused = await revoke(offboarding.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("EXIT_NOT_DUE");

    expect(await employeeRow(leaver.employeeId)).toMatchObject({
      status: "active",
      end_date: null,
    });
    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      false,
      false,
    ]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(false);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(200);
    const read = await hrMgr.get(`/api/hris/offboardings/${offboarding.id}`);
    expect(read.body.data).toMatchObject({
      status: "open",
      accessRevokedAt: null,
      revocationResult: null,
    });
  }, 90_000);

  it("[HR-01] clears every access path of the employee in this tenant and leaves everything else alone", async () => {
    const leaver = await makeLeaver();

    // Same login elsewhere: a tenant B role and session, a customer session.
    const b = tenantB!;
    const roleB = await newRole([], ["tenant"], b.tenantId);
    const assignmentB = await assignRole({
      userId: leaver.userId,
      roleId: roleB,
      scope: { type: "tenant" },
      tenantId: b.tenantId,
    });
    const sessionB = await signInCookie(leaver.email);
    await owner.query(
      `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
      [sessionB.sessionId, b.tenantId],
    );
    const customer = await signInCookie(leaver.email);

    // Push: one subscription per tenant. PIN: set at the outlet.
    await seedPush(leaver.userId, tenant.id);
    await seedPush(leaver.userId, b.tenantId);
    await setStaffPin(
      tenantContext,
      leaver.userId,
      { outletId: jkt, userId: leaver.userId },
      { pin: PIN },
    );
    const token = await deviceToken();

    // Shifts: one before the last working day, one after.
    const before = await createShift(leaver.employeeId, SHIFT_BEFORE);
    const after = await createShift(leaver.employeeId, SHIFT_AFTER);

    // Controls: all access works now.
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(200);
    const pinBefore = await verifyPin(token, leaver.userId);
    expect(pinBefore.status, JSON.stringify(pinBefore.body)).toBe(200);
    expect(await pushCount(leaver.userId, tenant.id)).toBe(1);

    const offboarding = await createOffboarding(
      leaver.employeeId,
      "termination",
    );
    await setLastDay(offboarding.id, LAST_DAY);
    const auditByObjectBefore = await auditCountByObject(offboarding.id);

    const first = await revoke(offboarding.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const data = first.body.data as Offboarding;
    expect(data).toMatchObject({ id: offboarding.id, status: "revoked" });
    expect(data.accessRevokedAt).not.toBeNull();
    expect(data.revocationResult).toMatchObject({
      sessionsRevoked: 1,
      pushSubscriptionsRemoved: 1,
      cancelledShiftIds: [after.id],
      employeeStatus: "terminated",
    });
    expect([...data.revocationResult!.roleAssignmentIds].sort()).toEqual(
      [...leaver.assignmentIds].sort(),
    );

    // Employee: terminated, end date = last working day.
    expect(await employeeRow(leaver.employeeId)).toEqual({
      status: "terminated",
      end_date: LAST_DAY,
    });

    // Roles: ended, each with an audit row and an event that name the reason.
    const ended = await endedFlags(leaver.assignmentIds);
    for (const id of leaver.assignmentIds) {
      expect(ended.get(id), `assignment ${id} ended`).toBe(true);
      expect(await endedAuditCount(id)).toBe(1);
      expect(await endedAuditText(id)).toContain("offboarding");
      expect(await endedEventCount(id)).toBeGreaterThanOrEqual(1);
    }

    // Sessions: the employee's old cookie is dead, other sessions live.
    expect(await sessionRevoked(leaver.sessionId)).toBe(true);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(401);
    expect(await sessionRevoked(sessionB.sessionId)).toBe(false);
    expect(
      (
        await request(app)
          .get("/api/auth/get-session")
          .set("Cookie", sessionB.cookie)
      ).body?.user?.id,
    ).toBe(leaver.userId);
    expect(await sessionRevoked(customer.sessionId)).toBe(false);
    expect(
      (
        await request(app)
          .get("/api/auth/get-session")
          .set("Cookie", customer.cookie)
      ).body?.user?.id,
    ).toBe(leaver.userId);

    // Push: this tenant's subscription is gone, tenant B's stays.
    expect(await pushCount(leaver.userId, tenant.id)).toBe(0);
    expect(await pushCount(leaver.userId, b.tenantId)).toBe(1);

    // Tenant B role assignment is untouched.
    expect((await endedFlags([assignmentB])).get(assignmentB)).toBe(false);

    // PIN: refused as a non member, the stored PIN row is kept.
    const pinAfter = await verifyPin(token, leaver.userId);
    expect([401, 403, 404]).toContain(pinAfter.status);
    expect(pinAfter.body.data).toBeUndefined();
    const pinRows = await owner.query(
      "SELECT 1 FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
      [tenant.id, leaver.userId],
    );
    expect(pinRows.rowCount).toBe(1);

    // Shifts: after the last day cancelled, before kept.
    expect(await shiftStatus(after.id, SHIFT_AFTER)).toBe("cancelled");
    expect(await shiftStatus(before.id, SHIFT_BEFORE)).not.toBe("cancelled");

    // One audit row for the clearance itself, on top of the role rows.
    expect(await auditCountByObject(offboarding.id)).toBe(
      auditByObjectBefore + 1,
    );

    // The exit reads back as revoked with the stored result.
    const read = await hrMgr.get(`/api/hris/offboardings/${offboarding.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual(data);
  }, 180_000);

  it("[HR-01] a second revoke returns the first result and writes no audit row or event", async () => {
    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);

    const first = await revoke(offboarding.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const auditActorBefore = await auditCountByActor(hrTenantUserId);
    const auditObjectBefore = await auditCountByObject(offboarding.id);
    const eventsBefore = await Promise.all(
      leaver.assignmentIds.map(endedEventCount),
    );
    const rolesAuditBefore = await Promise.all(
      leaver.assignmentIds.map(endedAuditCount),
    );

    const second = await revoke(offboarding.id);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data).toEqual(first.body.data);

    expect(await auditCountByActor(hrTenantUserId)).toBe(auditActorBefore);
    expect(await auditCountByObject(offboarding.id)).toBe(auditObjectBefore);
    expect(
      await Promise.all(leaver.assignmentIds.map(endedEventCount)),
    ).toEqual(eventsBefore);
    expect(
      await Promise.all(leaver.assignmentIds.map(endedAuditCount)),
    ).toEqual(rolesAuditBefore);
    expect(await employeeRow(leaver.employeeId)).toEqual({
      status: "terminated",
      end_date: LAST_DAY,
    });
  }, 90_000);

  it.each([
    ["resignation", "resigned"],
    ["contract_end", "resigned"],
  ] as const)(
    "[HR-01] a %s exit leaves the employee %s with the last working day as end date",
    async (exitType, expectedStatus) => {
      const leaver = await makeLeaver();
      const offboarding = await createOffboarding(leaver.employeeId, exitType);
      await setLastDay(offboarding.id, LAST_DAY);

      const cleared = await revoke(offboarding.id);
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(cleared.body.data.revocationResult).toMatchObject({
        employeeStatus: expectedStatus,
        sessionsRevoked: 1,
        pushSubscriptionsRemoved: 0,
        cancelledShiftIds: [],
      });
      expect(await employeeRow(leaver.employeeId)).toEqual({
        status: expectedStatus,
        end_date: LAST_DAY,
      });
      expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(401);
    },
    90_000,
  );

  it("[HR-01] an employee without a login account is cleared without touching anyone else", async () => {
    const employeeId = await seedEmployee(null, jkt);
    const offboarding = await createOffboarding(employeeId, "resignation");
    await setLastDay(offboarding.id, LAST_DAY);

    const cleared = await revoke(offboarding.id);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.revocationResult).toMatchObject({
      roleAssignmentIds: [],
      sessionsRevoked: 0,
      pushSubscriptionsRemoved: 0,
      employeeStatus: "resigned",
    });
    expect(await employeeRow(employeeId)).toEqual({
      status: "resigned",
      end_date: LAST_DAY,
    });
  });

  it("[HR-01] an employee who holds an Owner assignment is refused with 409 OFFBOARDING_OWNER and keeps all access", async () => {
    const leaver = await makeLeaver();
    const ownerAssignment = await assignRole({
      userId: leaver.userId,
      roleId: await templateRoleId("owner"),
      scope: { type: "tenant" },
    });
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);

    // A caller who may assign roles, so the Owner rule is what refuses.
    const refused = await revoke(offboarding.id, hrTenantAdmin);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("OFFBOARDING_OWNER");

    // All or nothing: no assignment ended, no session revoked, employee kept.
    const flags = await endedFlags([...leaver.assignmentIds, ownerAssignment]);
    expect([...flags.values()]).toEqual([false, false, false]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(false);
    expect(await employeeRow(leaver.employeeId)).toMatchObject({
      status: "active",
    });
    const read = await hrMgr.get(`/api/hris/offboardings/${offboarding.id}`);
    expect(read.body.data).toMatchObject({
      status: "open",
      revocationResult: null,
    });
  }, 90_000);

  it("[HR-01] D1 outlet HR who reach the employee cannot clear: 403 CLEARANCE_NEEDS_TENANT_HR and nothing changes", async () => {
    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);

    // hrMgr holds hr.employee.manage at the leaver's outlet only.
    const refused = await revoke(offboarding.id, hrMgr);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe("CLEARANCE_NEEDS_TENANT_HR");

    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      false,
      false,
    ]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(false);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(200);
    expect(await employeeRow(leaver.employeeId)).toMatchObject({
      status: "active",
    });
    const read = await hrMgr.get(`/api/hris/offboardings/${offboarding.id}`);
    expect(read.body.data).toMatchObject({
      status: "open",
      revocationResult: null,
    });

    // Control: tenant HR clears the same exit.
    const cleared = await revoke(offboarding.id, hrTenant);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  }, 90_000);

  it.each([
    ["active", "now() - interval '1 hour'"],
    ["future-dated", "now() + interval '30 days'"],
  ] as const)(
    "[HR-01] D2 a %s tenant-scope assignment needs access.role.assign: 409 OFFBOARDING_ADMIN_ROLE without it, cleared with it",
    async (_label, validFromSql) => {
      const leaver = await makeLeaver();
      const tenantAssignment = await assignRole({
        userId: leaver.userId,
        roleId: await newRole(["self.profile.view"], ["tenant"]),
        scope: { type: "tenant" },
        validFromSql,
      });
      const all = [...leaver.assignmentIds, tenantAssignment];
      const offboarding = await createOffboarding(leaver.employeeId);
      await setLastDay(offboarding.id, LAST_DAY);

      // Tenant HR without access.role.assign: refused, all or nothing.
      const refused = await revoke(offboarding.id, hrTenant);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe("OFFBOARDING_ADMIN_ROLE");
      expect([...(await endedFlags(all)).values()]).toEqual([
        false,
        false,
        false,
      ]);
      expect(await sessionRevoked(leaver.sessionId)).toBe(false);
      expect(await employeeRow(leaver.employeeId)).toMatchObject({
        status: "active",
      });
      const read = await hrTenant.get(
        `/api/hris/offboardings/${offboarding.id}`,
      );
      expect(read.body.data).toMatchObject({
        status: "open",
        revocationResult: null,
      });

      // Tenant HR who may assign roles clears the exit, tenant role included.
      const cleared = await revoke(offboarding.id, hrTenantAdmin);
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(
        [...cleared.body.data.revocationResult.roleAssignmentIds].sort(),
      ).toEqual([...all].sort());
      expect([...(await endedFlags(all)).values()]).toEqual([true, true, true]);
      expect(await sessionRevoked(leaver.sessionId)).toBe(true);
    },
    120_000,
  );

  it("[HR-01] D3 a future-dated assignment no longer blocks: it is ended as an empty window with its audit row and event", async () => {
    const leaver = await makeLeaver();
    const futureAssignment = await assignRole({
      userId: leaver.userId,
      roleId: await templateRoleId("cashier"),
      scope: { type: "outlet", id: otherOutlet },
      validFromSql: "now() + interval '30 days'",
    });
    const all = [...leaver.assignmentIds, futureAssignment];
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);

    const cleared = await revoke(offboarding.id);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data).toMatchObject({ status: "revoked" });
    expect(
      [...cleared.body.data.revocationResult.roleAssignmentIds].sort(),
    ).toEqual([...all].sort());

    expect([...(await endedFlags(all)).values()]).toEqual([true, true, true]);
    // Never active: the window closes at the instant it would have opened.
    const window = await owner.query<{ empty: boolean }>(
      "SELECT valid_until = valid_from AS empty FROM role_assignments WHERE id = $1",
      [futureAssignment],
    );
    expect(window.rows).toEqual([{ empty: true }]);
    expect(await endedAuditCount(futureAssignment)).toBe(1);
    expect(await endedAuditText(futureAssignment)).toContain("offboarding");
    expect(await endedEventCount(futureAssignment)).toBeGreaterThanOrEqual(1);
    expect(await employeeRow(leaver.employeeId)).toEqual({
      status: "terminated",
      end_date: LAST_DAY,
    });
  }, 90_000);

  it("[HR-01] D4 sessions without a tenant stamp are revoked too; other tenants' and customer sessions stay", async () => {
    const leaver = await makeLeaver();
    // A fresh session has no tenant yet: unstamp the employee's own session.
    await owner.query(`UPDATE "session" SET tenant_id = NULL WHERE id = $1`, [
      leaver.sessionId,
    ]);
    const stamped = await signInCookie(leaver.email);
    await owner.query(
      `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
      [stamped.sessionId, tenant.id],
    );
    const b = tenantB!;
    const sessionB = await signInCookie(leaver.email);
    await owner.query(
      `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
      [sessionB.sessionId, b.tenantId],
    );
    const customer = await signInCookie(leaver.email);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(200);

    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);
    const cleared = await revoke(offboarding.id);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.revocationResult.sessionsRevoked).toBe(2);

    expect(await sessionRevoked(leaver.sessionId)).toBe(true);
    expect(await sessionRevoked(stamped.sessionId)).toBe(true);
    expect((await leaver.client.get(READ_OWN_SHIFTS)).status).toBe(401);
    expect(await sessionRevoked(sessionB.sessionId)).toBe(false);
    expect(await sessionRevoked(customer.sessionId)).toBe(false);
    for (const live of [sessionB, customer])
      expect(
        (
          await request(app)
            .get("/api/auth/get-session")
            .set("Cookie", live.cookie)
        ).body?.user?.id,
      ).toBe(leaver.userId);
  }, 120_000);

  it("[HR-01] D6 shifts of an employee at another outlet are cancelled by tenant HR: after the last day cancelled, before kept", async () => {
    // Homed at an outlet that the outlet manager hrMgr does not reach.
    const leaver = await makeLeaver(otherOutlet);
    const before = await createShift(
      leaver.employeeId,
      SHIFT_BEFORE,
      otherOutlet,
      tplOther,
    );
    const after = await createShift(
      leaver.employeeId,
      SHIFT_AFTER,
      otherOutlet,
      tplOther,
    );
    const offboarding = await createOffboarding(
      leaver.employeeId,
      "termination",
      hrTenant,
    );
    await setLastDay(offboarding.id, LAST_DAY);

    const cleared = await revoke(offboarding.id);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.revocationResult.cancelledShiftIds).toEqual([
      after.id,
    ]);
    expect(await shiftStatus(after.id, SHIFT_AFTER)).toBe("cancelled");
    expect(await shiftStatus(before.id, SHIFT_BEFORE)).not.toBe("cancelled");
  }, 120_000);

  it("[HR-01] D7 the exit is due only after the last working day: today in the home outlet's timezone is 409 EXIT_NOT_DUE, yesterday is due", async () => {
    const jakartaDay = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString(
        "en-CA",
        { timeZone: "Asia/Jakarta" },
      );

    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, jakartaDay(0));
    const refused = await revoke(offboarding.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("EXIT_NOT_DUE");
    expect(await employeeRow(leaver.employeeId)).toMatchObject({
      status: "active",
      end_date: null,
    });
    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      false,
      false,
    ]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(false);

    // Same exit, last working day moved to yesterday: now due.
    const yesterday = jakartaDay(-1);
    await setLastDay(offboarding.id, yesterday);
    const cleared = await revoke(offboarding.id);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(await employeeRow(leaver.employeeId)).toEqual({
      status: "terminated",
      end_date: yesterday,
    });
  }, 90_000);

  it("[HR-01] a cancelled exit cannot be cleared, and a cleared exit cannot be cancelled (409)", async () => {
    const cancelledLeaver = await makeLeaver();
    const cancelledExit = await createOffboarding(cancelledLeaver.employeeId);
    await setLastDay(cancelledExit.id, LAST_DAY);
    const cancel = await post(
      hrMgr,
      `/api/hris/offboardings/${cancelledExit.id}/cancel`,
      { reason: "Salah input." },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await revoke(cancelledExit.id)).status).toBe(409);
    expect([
      ...(await endedFlags(cancelledLeaver.assignmentIds)).values(),
    ]).toEqual([false, false]);
    expect(await employeeRow(cancelledLeaver.employeeId)).toMatchObject({
      status: "active",
    });

    const clearedLeaver = await makeLeaver();
    const clearedExit = await createOffboarding(clearedLeaver.employeeId);
    await setLastDay(clearedExit.id, LAST_DAY);
    expect((await revoke(clearedExit.id)).status).toBe(200);
    const lateCancel = await post(
      hrMgr,
      `/api/hris/offboardings/${clearedExit.id}/cancel`,
      { reason: "Terlambat." },
    );
    expect(lateCancel.status).toBe(409);
    expect(await employeeRow(clearedLeaver.employeeId)).toMatchObject({
      status: "terminated",
    });
  }, 120_000);

  it("[HR-01] the revoke route rejects a body with unknown keys (422)", async () => {
    const leaver = await makeLeaver();
    const offboarding = await createOffboarding(leaver.employeeId);
    await setLastDay(offboarding.id, LAST_DAY);
    const response = await post(
      hrTenant,
      `/api/hris/offboardings/${offboarding.id}/revoke-access`,
      { tenantId: tenant.id },
    );
    expect(response.status).toBe(422);
    expect(await employeeRow(leaver.employeeId)).toMatchObject({
      status: "active",
    });
  }, 90_000);
});
