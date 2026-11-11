// Fail-first tests for legend-x0avw finding 1 (Codex P1): a clock-in racing a
// leave approval must never leave an APPROVED leave next to a VALID `in` log
// without the `leave_approved` flag (the day would be paid twice). Expected
// behaviour comes from docs/briefs/452-plan.md (F1) and
// docs/briefs/452-leave-codex-fixes.md (finding 1), not from service code.
//
// Technique (two real transactions, no sleeps):
//  - tx A is a plain pg client. It takes the shared advisory lock named in F1
//    (`hris:leave-attendance:<tenantId>:<lower(employeeId)>`, same hash as
//    lockEmployeeLeaveAttendance), then performs the "other side" of the race as
//    raw SQL (inserts an approved leave, or a valid `in` log), WITHOUT
//    committing yet.
//  - tx B is the real path under test (HTTP route or the edge applier). It
//    starts while A holds the lock. The test polls pg_locks until B shows up as
//    an UNGRANTED waiter on exactly that advisory key. If B finishes without
//    ever waiting, the test fails: that is the missing behavior (the path does
//    not take the shared lock).
//  - Only then A commits. B resumes and must see A's committed data, so the
//    final state must never be "approved leave + valid in log without flag".
//
// Both orders are covered: approval first (A = approved leave, B = clock-in /
// edge replay / manual correction approval) and clock-in first (A = valid in
// log, B = leave approval).
//
// Assumptions:
//  - Paths are exercised through the public HTTP routes (clock-in, leave
//    decision, leave filing, correction decision) and the edge
//    `attendance.logged` applier (which shares recordAttendanceLog with the
//    online path), because those are the entry points of recordAttendanceLog,
//    decideLeaveRequest/applyOutcome, createLeaveRequest and
//    applyApproved/settleAttendanceCorrection.
//  - "Flagged" = stored log validity "flagged", review_status "pending" and
//    flag_reasons contains "leave_approved" (names from the 9y6ri/7o3hd tests).
//  - Approved-on-filing is not tested: unreachable through the API (see the
//    note before the manual-correction tests).
//  - A refused manual correction answers 409 ATTENDANCE_CORRECTION_LEAVE_DAY
//    (name taken from hris-attendance-correction-leave-day.test.ts).
//  - Test data lives in a fresh outlet per test; leave and balance rows are
//    seeded with the same SQL as hris-attendance-leave-flag.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { attendanceLogged } from "@starter/shared/hris";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerAttendanceLoggedEdgeApplier } from "../edge/attendance-logged-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const LEAVE_DAY_CODE = "ATTENDANCE_CORRECTION_LEAVE_DAY";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
// Pool size: tx A, the pg_locks poller, fixture helpers.
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let insertedCorrectionPolicy = false;

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

async function assign(
  conn: PoolClient,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await conn.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Leave attendance race ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(conn, userId, roleId, scope);
  });
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

const CENTER = { latitude: -6.2, longitude: 106.8 };
const key = () => `att-race-${randomUUID()}`;
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

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `RC-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet balapan cuti-absen ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Balapan Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `RC-${id.slice(0, 8).toUpperCase()}`,
        homeOutletId,
      ],
    ),
  );
  return id;
}

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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
const dayStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
// Midday UTC is the same calendar day in every Indonesian time zone.
const middayUtc = (day: string) => `${day}T05:00:00.000Z`;

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % DAY;
  const untilMidnight = DAY - sinceMidnight;
  if (sinceMidnight < 2 * MINUTE || untilMidnight < 3 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 3 * MINUTE),
    );
}

// ---- fixtures ---------------------------------------------------------------

let hr: Client;
let leaveTypeId: string;
let managerRoleId: string;
const edgeActor = randomUUID();

beforeAll(async () => {
  setAuditWriter(coreAuditWriter);
  managerRoleId = await templateRoleId("outlet_manager");
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
    [tenant.id],
  );
  // Leave requests go to the outlet manager, one level (PRD matrix).
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenant.id, managerRoleId],
  );
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRoleId],
  );
  insertedCorrectionPolicy = (inserted.rowCount ?? 0) > 0;

  const admin = await signedInClient("HR Balapan Cuti", { mfa: true });
  await grantRole(
    admin.userId,
    [
      "hr.attendance.manage",
      "hr.leave.approve",
      "hr.employee.manage",
      "hr.employee.view",
    ],
    { type: "tenant" },
  );
  hr = admin.client;

  const type = await post(hr, "/api/hris/leave/types", {
    code: `RACE_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji balapan",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "12.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
      tracksBalance: true,
      accrual: "upfront",
      negativeAllowanceDays: "0.0000",
    },
    idempotencyKey: key(),
  });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  leaveTypeId = type.body.data.id;
}, 60_000);

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  await asTenant(async (conn) => {
    // attendance_logs <-> attendance_corrections reference each other.
    await conn.query("SET LOCAL session_replication_role = replica");
    await conn.query(
      "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await conn.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await conn.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2",
      [tenant.id, leaveTypeId],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-race-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    );
    if (insertedCorrectionPolicy)
      await conn.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
        [tenant.id],
      );
    for (const row of savedPolicies)
      await conn.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets and edge nodes stay: audit_logs is append-only and references
    // them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
}, 60_000);

interface Scenario {
  outletId: string;
  employeeId: string;
  staffUserId: string;
  staff: Client;
  manager: Client;
  today: string;
  year: number;
}

/**
 * A fresh outlet, an employee who may clock and file leave there with a
 * balance of 12 days, and an outlet manager who approves leave and corrections.
 */
async function newScenario(
  label: string,
): Promise<Scenario> {
  await avoidOutletMidnight();
  const outletId = await seedOutlet(label);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: noSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Balapan ${label}`, {
  });
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  const managerSession = await signedInClient(`Manajer Balapan ${label}`, {
    mfa: true,
  });
  await asTenant((conn) =>
    assign(conn, managerSession.userId, managerRoleId, {
      type: "outlet",
      id: outletId,
    }),
  );

  const today = wibDate(Date.now());
  const year = Number(today.slice(0, 4));
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
       VALUES ($1, $2, $3, $4, '12')`,
      [tenant.id, employeeId, leaveTypeId, year],
    ),
  );
  return {
    outletId,
    employeeId,
    staffUserId: staffSession.userId,
    staff: staffSession.client,
    manager: managerSession.client,
    today,
    year,
  };
}

// ---- tx A: the lock holder --------------------------------------------------

const lockName = (employeeId: string) =>
  `hris:leave-attendance:${tenant.id}:${employeeId.toLowerCase()}`;

/** Raw SQL for the "other side": an approved leave of one day (balance counted). */
async function insertApprovedLeave(
  conn: PoolClient,
  s: Scenario,
  day: string,
  decidedBy: string,
) {
  await conn.query(
    `INSERT INTO leave_requests
       (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
        start_date, end_date, days, excluded_holiday_dates, status,
        requested_by, requested_at, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, '1', '{}'::date[], 'approved',
             $8, clock_timestamp(), $9, clock_timestamp())`,
    [
      randomUUID(),
      tenant.id,
      s.outletId,
      s.employeeId,
      leaveTypeId,
      Number(day.slice(0, 4)),
      day,
      s.staffUserId,
      decidedBy,
    ],
  );
  await conn.query(
    `UPDATE leave_balances SET used_days = used_days + 1
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
    [tenant.id, s.employeeId, leaveTypeId, Number(day.slice(0, 4))],
  );
}

/** Raw SQL for the "other side": a clock-in already stored as valid. */
async function insertValidInLog(
  conn: PoolClient,
  s: Scenario,
  day: string,
  occurredAt: Date,
  method: "selfie_geo" | "manual_correction",
) {
  await conn.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        validity, flag_reasons, business_date, client_event_id, review_status)
     VALUES ($1, $2, $3, $4, 'in', $5, $6, now(), 'valid', '[]', $7, $8, 'none')`,
    [
      randomUUID(),
      tenant.id,
      s.outletId,
      s.employeeId,
      method,
      occurredAt,
      day,
      createUlid(),
    ],
  );
}

/** How many transactions wait (ungranted) on the employee's shared lock. */
async function waitersOn(employeeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [lockName(employeeId)],
  );
  return rows[0]!.n;
}

/**
 * Tx A takes the shared lock and runs `sideA` (uncommitted). Then tx B
 * (`startB`) starts; the test waits until B is a lock waiter (fails if B
 * finishes without waiting), then A commits and B's result is returned.
 */
async function race<T>(
  s: Scenario,
  sideA: (conn: PoolClient) => Promise<void>,
  startB: () => Promise<T>,
): Promise<T> {
  const a = await owner.connect();
  let finished = false;
  let outcome = "";
  let committed = false;
  let b: Promise<T> | null = null;
  try {
    await a.query("BEGIN");
    await a.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await a.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      lockName(s.employeeId),
    ]);
    await sideA(a);

    b = (async () => await startB())()
      .then((value) => {
        outcome = JSON.stringify(
          (value as { body?: unknown; status?: number })?.status ?? "ok",
        ) + " " + JSON.stringify((value as { body?: unknown })?.body ?? "").slice(280, 700);
        return value;
      })
      .finally(() => {
        finished = true;
      });
    b.catch(() => undefined);

    // Condition-based wait: poll until B queues on the lock; give up the moment
    // B has finished (it did not wait) or after a generous bound.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (finished)
        throw new Error(
          `tx B finished while tx A held the leave-attendance lock: the path does not take lockEmployeeLeaveAttendance (B answered: ${outcome})`,
        );
      if ((await waitersOn(s.employeeId)) > 0) break;
      if (Date.now() > deadline)
        throw new Error("tx B never queued on the lock and never finished");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await a.query("COMMIT");
    committed = true;
    return await b;
  } finally {
    if (!committed) await a.query("ROLLBACK").catch(() => undefined);
    a.release();
    if (b) await b.catch(() => undefined);
  }
}

// ---- tx B starters ----------------------------------------------------------

async function startClockIn(s: Scenario) {
  const response = await post(s.staff, "/api/hris/attendance/clock", {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...CENTER, accuracyM: 5 },
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
  });
  return response;
}

/** Staff files a one-day leave on `day` (pending until the manager decides). */
async function fileLeave(s: Scenario, day: string, client = s.staff) {
  return post(client, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: day,
    endDate: day,
    reason: "Cuti uji balapan",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });
}

async function fileLeaveOk(s: Scenario, day: string) {
  const response = await fileLeave(s, day);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("pending");
  return response.body.data.id as string;
}

const decideLeave = (s: Scenario, leaveId: string) =>
  post(s.manager, `/api/hris/leave/requests/${leaveId}/decision`, {
    action: "approve",
    idempotencyKey: key(),
  });

async function fileCorrection(s: Scenario, day: string) {
  const response = await post(s.staff, "/api/hris/attendance/corrections", {
    outletId: s.outletId,
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: middayUtc(day),
    reason: "Lupa absen, mesin tidak terbaca",
    idempotencyKey: key(),
  });
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data.id as string;
}

const decideCorrection = (s: Scenario, correctionId: string) =>
  post(s.manager, `/api/hris/attendance/corrections/${correctionId}/decision`, {
    action: "approve",
    note: "Diperiksa penyelia",
    idempotencyKey: key(),
  });

// ---- edge (offline replay) --------------------------------------------------

const scopeOf = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function edgeNodeFor(outletId: string): Promise<AuthenticatedEdgeNode> {
  const registered = await registerEdgeNode(scopeOf(outletId), edgeActor, {
    outletId,
    role: "primary",
    label: `Utama ${randomBytes(3).toString("hex")}`,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return node;
}

let clockSeq = Date.now();
function offlineClockInEvent(s: Scenario, clockedAt: Date): EventEnvelope {
  clockSeq += 1_000;
  const attendanceLogId = createUlid(clockSeq);
  return attendanceLogged.envelopeSchema.parse({
    id: createUlid(clockSeq),
    tenantId: tenant.id,
    outletId: s.outletId,
    name: "attendance.logged",
    version: 1,
    aggregateType: "attendance",
    aggregateId: attendanceLogId,
    sequence: 1,
    occurredAt: new Date(clockedAt.getTime() + 5_000).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `attendance.logged:${attendanceLogId}`,
    payloadSchemaRef: "attendance.logged.v1",
    payload: {
      attendanceLogId,
      employeeId: s.employeeId,
      outletId: s.outletId,
      type: "in",
      method: "selfie_geo",
      occurredAt: clockedAt.toISOString(),
      validity: "valid",
      shiftAssignmentId: null,
    },
  }) as EventEnvelope;
}

async function startEdgeReplay(s: Scenario, node: AuthenticatedEdgeNode) {
  resetEdgeApplierRegistryForTests();
  registerAttendanceLoggedEdgeApplier();
  const event = offlineClockInEvent(s, new Date(Date.now() - 30_000));
  const meta: EdgeApplyMeta = {
    edgeNodeId: node.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context: node.context,
  };
  await withTenant(db, node.context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, meta),
  );
}

// ---- final-state checks -----------------------------------------------------

interface LogRow {
  type: string;
  method: string;
  offline: boolean;
  validity: string;
  review_status: string;
  flag_reasons: string[];
}

async function logsOf(s: Scenario) {
  return asTenant(async (conn) => {
    const { rows } = await conn.query<LogRow>(
      `SELECT type, method, offline, validity, review_status, flag_reasons
         FROM attendance_logs WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, s.employeeId],
    );
    return rows;
  });
}

async function approvedLeaveCount(s: Scenario) {
  return asTenant(async (conn) => {
    const { rows } = await conn.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM leave_requests
        WHERE tenant_id = $1 AND employee_id = $2 AND status = 'approved'`,
      [tenant.id, s.employeeId],
    );
    return rows[0]!.n;
  });
}

/**
 * The invariant: an approved leave exists, there is at least `expectedLogs`
 * `in` logs, and every one of them is flagged/pending with leave_approved
 * (never a valid `in` log next to an approved leave: the day is paid twice).
 */
async function expectLeaveAndFlaggedLogs(s: Scenario, expectedLogs: number) {
  expect(await approvedLeaveCount(s), "approved leave").toBe(1);
  const logs = (await logsOf(s)).filter((log) => log.type === "in");
  expect(logs).toHaveLength(expectedLogs);
  for (const log of logs) {
    expect(log.validity, JSON.stringify(log)).toBe("flagged");
    expect(log.review_status, JSON.stringify(log)).toBe("pending");
    expect(log.flag_reasons, JSON.stringify(log)).toContain("leave_approved");
  }
}

// ---- tests ------------------------------------------------------------------

describe("[x0avw-F1] clock-in vs leave approval share one per-employee lock", () => {
  it("[x0avw-F1] online clock-in waits for a leave approval in flight, then is flagged leave_approved (approval first)", async () => {
    const s = await newScenario("online-approval-first");
    const response = await race(
      s,
      (a) => insertApprovedLeave(a, s, s.today, s.staffUserId),
      () => startClockIn(s),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("flagged");
    await expectLeaveAndFlaggedLogs(s, 1);
  });

  it("[x0avw-F1] a leave approval waits for a clock-in in flight, then flags that log leave_approved (clock-in first)", async () => {
    const s = await newScenario("online-clockin-first");
    const leaveId = await fileLeaveOk(s, s.today);
    const response = await race(
      s,
      (a) => insertValidInLog(a, s, s.today, new Date(), "selfie_geo"),
      () => decideLeave(s, leaveId),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("approved");
    await expectLeaveAndFlaggedLogs(s, 1);
  });

  it("[x0avw-F1] an offline/edge replayed clock-in waits for a leave approval in flight, then is flagged leave_approved (approval first)", async () => {
    const s = await newScenario("edge-approval-first");
    const node = await edgeNodeFor(s.outletId);
    await race(
      s,
      (a) => insertApprovedLeave(a, s, s.today, s.staffUserId),
      () => startEdgeReplay(s, node),
    );
    const logs = await logsOf(s);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.offline).toBe(true);
    await expectLeaveAndFlaggedLogs(s, 1);
  });

  it("[x0avw-F1] a leave approval waits for an offline/edge log in flight, then flags it leave_approved (clock-in first)", async () => {
    const s = await newScenario("edge-clockin-first");
    const leaveId = await fileLeaveOk(s, s.today);
    const response = await race(
      s,
      async (a) => {
        // What an edge replay stores: an offline log, flagged for review only
        // because the edge vetting cannot be verified (no leave flag yet).
        await a.query(
          `INSERT INTO attendance_logs
             (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
              offline, validity, flag_reasons, business_date, client_event_id, review_status)
           VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now() - interval '30 seconds', now(),
                   true, 'flagged', '["offline_unverified"]', $5, $6, 'pending')`,
          [
            randomUUID(),
            tenant.id,
            s.outletId,
            s.employeeId,
            s.today,
            createUlid(),
          ],
        );
      },
      () => decideLeave(s, leaveId),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await expectLeaveAndFlaggedLogs(s, 1);
    const [log] = await logsOf(s);
    expect(log!.flag_reasons).toContain("offline_unverified");
  });
});

// Approved-on-filing (createLeaveRequest, branch "below every tier") is NOT
// tested here: it cannot be reached through the API. A leave filing carries no
// amount, an unknown amount applies every tier of the matrix (fail closed, see
// platform-approval.test.ts), and no `leave` policy at all answers 409
// APPROVAL_POLICY_MISSING (hris-leave-release-event-db.test.ts). Probed: with a
// single tier at a huge threshold the filing still answers status "pending",
// and filing by an outlet_manager is pending too. So the branch is dead code
// behind the matrix and the lock there cannot be raced from a test.

describe("[x0avw-F1] manual correction shares the lock", () => {
  it("[x0avw-F1] approving a correction waits for a leave approval in flight, then is refused 409 and writes no log (approval first)", async () => {
    const s = await newScenario("correction-approval-first");
    const day = dayStr(5);
    const correctionId = await fileCorrection(s, day);
    const response = await race(
      s,
      (a) => insertApprovedLeave(a, s, day, s.staffUserId),
      () => decideCorrection(s, correctionId),
    );
    // Once the approval commits the correction loses: either the decision is
    // refused 409 (leave seen before the decision) or it settles as rejected
    // (leave seen when the correction is applied). Both pay nothing.
    if (response.status === 409) {
      expect(response.body.error?.code, JSON.stringify(response.body)).toBe(
        LEAVE_DAY_CODE,
      );
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data?.status, JSON.stringify(response.body)).toBe(
        "rejected",
      );
    }
    expect(await approvedLeaveCount(s)).toBe(1);
    expect(
      (await logsOf(s)).filter((log) => log.method === "manual_correction"),
    ).toHaveLength(0);
  });

  it("[x0avw-F1] a leave approval waits for a manual-correction log in flight, then flags it leave_approved (correction first)", async () => {
    const s = await newScenario("correction-first");
    const day = dayStr(5);
    const leaveId = await fileLeaveOk(s, day);
    const response = await race(
      s,
      (a) =>
        insertValidInLog(
          a,
          s,
          day,
          new Date(middayUtc(day)),
          "manual_correction",
        ),
      () => decideLeave(s, leaveId),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("approved");
    await expectLeaveAndFlaggedLogs(s, 1);
    const [log] = await logsOf(s);
    expect(log!.method).toBe("manual_correction");
  });
});
