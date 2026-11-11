// Fail-first tests for finding 501-2 (P1): a multi-day leave carries
// `excluded_holiday_dates` (holidays inside the range are not leave days).
// Written from docs/briefs/hris-leave-guard.md section "502 follow-up" item C
// and the existing contract used by hris-leave-clash-backfill.test.ts and
// hris-attendance-correction-leave-day.test.ts, never from service code.
//
// Rule under test: on an excluded holiday date of an approved leave
//  - clock-in is not flagged and not queued, before AND after approval,
//  - a manual correction is NOT refused (no ATTENDANCE_CORRECTION_LEAVE_DAY)
//    and its manual log stays valid,
//  - app.approved_leaves_on omits the date,
//  - app.flag_attendance_for_leave never flags a log on that date,
// while the real leave days of the same leave still flag / block.
//
// Assumptions (spec is silent, stated here and in the report):
//  - The holiday is recorded on the leave by SQL (excluded_holiday_dates plus
//    the reduced `days`), as hris-leave-clash-backfill.test.ts does; the HTTP
//    holiday path is not under test.
//  - "Before approval" = leave still pending when the log is made; "after
//    approval" = the leave is approved through the real decision endpoint first.
//  - A clock-in on a real leave day is flagged `leave_approved` (validity
//    flagged) and queued, per hris-attendance-leave-flag.test.ts.
//  - Corrections use past days only (a correction cannot be in the future);
//    the correction decision endpoint answers 409 ATTENDANCE_CORRECTION_LEAVE_DAY
//    on a real leave day (code from hris-attendance-correction-leave-day.test.ts).
//  - Test file runs alone (shared tenant), like the sibling files.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const LEAVE_DAY_CODE = "ATTENDANCE_CORRECTION_LEAVE_DAY";
const KEY_PREFIX = "att-leh-";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
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
    await client.query("ROLLBACK").catch(() => undefined);
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
  db: PoolClient,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await db.query(
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
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Leave excluded holiday ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(db, userId, roleId, scope);
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
const key = () => `${KEY_PREFIX}${randomUUID()}`;
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
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Libur', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `EH-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-libur ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(
  userId: string,
  homeOutletId: string,
  managerId: string | null = null,
) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Libur Cuti', $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        id,
        tenant.id,
        userId,
        `EH-${id.slice(0, 8).toUpperCase()}`,
        homeOutletId,
        managerId,
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
// flaggedAlways=true: any flagged log is queued, so "not queued" is meaningful.
const alwaysSampling = {
  rate: 0,
  flaggedAlways: true,
  minPerSupervisorPerWeek: 0,
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
const dateAt = (offsetDays: number) => wibDate(Date.now() + offsetDays * DAY);
// Midday UTC is the same calendar day in WIB.
const middayUtc = (day: string) => `${day}T05:00:00.000Z`;

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % DAY;
  const untilMidnight = DAY - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

// ---- fixtures ---------------------------------------------------------------

let hr: Client;
let hrUserId: string;
let leaveTypeId: string;

beforeAll(async () => {
  const managerRole = await templateRoleId("outlet_manager");
  // Leave requests go to the outlet manager, one level (PRD matrix).
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
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenant.id, managerRole],
  );
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRole],
  );
  insertedCorrectionPolicy = (inserted.rowCount ?? 0) > 0;

  const admin = await signedInClient("HR Libur Cuti", { mfa: true });
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
  hrUserId = admin.userId;

  const type = await post(hr, "/api/hris/leave/types", {
    code: `LEH_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji hari libur",
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
}, 120_000);

afterAll(async () => {
  await asTenant(async (db) => {
    // attendance_logs and attendance_corrections reference each other (result
    // log / correction id), so no delete order works: the owner skips the FKs.
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query("DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2", [
      tenant.id,
      leaveTypeId,
    ]);
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await db.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    );
    if (insertedCorrectionPolicy)
      await db.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
        [tenant.id],
      );
    for (const row of savedPolicies)
      await db.query(
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
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
}, 60_000);

// ---- scenario helpers -------------------------------------------------------

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  manager: Client;
  today: string;
  year: number;
  /** Direct SQL leave row; offsets in days from today; approved counts in used_days. */
  seedLeave(input: {
    status: "pending" | "approved";
    startOffsetDays: number;
    endOffsetDays: number;
    days: number;
    excludedOffsets: number[];
  }): Promise<string>;
  /**
   * Real flow: staff requests today..endOffsetDays, today is recorded as an
   * excluded holiday (days = end offset), the outlet manager approves.
   */
  requestLeaveExcludingToday(
    endOffsetDays: number,
    approve: boolean,
  ): Promise<string>;
}

/** A fresh outlet (own review queue), staff, outlet manager, 12 leave days. */
async function newScenario(label: string): Promise<Scenario> {
  await avoidOutletMidnight();
  const outletId = await seedOutlet(label);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: alwaysSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Libur ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const managerSession = await signedInClient(`Manajer Libur ${label}`, {
    mfa: true,
  });
  // A supervisor decides only for direct reports: the manager is an employee.
  const managerEmployeeId = await seedEmployee(managerSession.userId, outletId);
  const employeeId = await seedEmployee(
    staffSession.userId,
    outletId,
    managerEmployeeId,
  );
  const managerRole = await templateRoleId("outlet_manager");
  await asTenant((db) =>
    assign(db, managerSession.userId, managerRole, {
      type: "outlet",
      id: outletId,
    }),
  );

  const today = dateAt(0);
  const year = Number(today.slice(0, 4));
  await asTenant((db) =>
    db.query(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
       VALUES ($1, $2, $3, $4, '12')`,
      [tenant.id, employeeId, leaveTypeId, year],
    ),
  );

  return {
    outletId,
    employeeId,
    staff: staffSession.client,
    manager: managerSession.client,
    today,
    year,
    async seedLeave({
      status,
      startOffsetDays,
      endOffsetDays,
      days,
      excludedOffsets,
    }) {
      const id = randomUUID();
      await asTenant(async (db) => {
        await db.query(
          `INSERT INTO leave_requests
             (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
              start_date, end_date, days, excluded_holiday_dates, status,
              requested_by, requested_at, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date[], $11, $12,
                   clock_timestamp(), $13, $14)`,
          [
            id,
            tenant.id,
            outletId,
            employeeId,
            leaveTypeId,
            year,
            dateAt(startOffsetDays),
            dateAt(endOffsetDays),
            String(days),
            excludedOffsets.map(dateAt),
            status,
            staffSession.userId,
            status === "pending" ? null : hrUserId,
            status === "pending" ? null : new Date(),
          ],
        );
        if (status === "approved")
          await db.query(
            `UPDATE leave_balances SET used_days = used_days + $1
              WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
            [String(days), tenant.id, employeeId, leaveTypeId, year],
          );
      });
      return id;
    },
    async requestLeaveExcludingToday(endOffsetDays, approve) {
      const requested = await post(
        staffSession.client,
        "/api/hris/leave/requests",
        {
          leaveTypeId,
          startDate: today,
          endDate: dateAt(endOffsetDays),
          reason: "Cuti uji hari libur",
          attachmentUploadRef: null,
          idempotencyKey: key(),
        },
      );
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);
      const leaveId = requested.body.data.id as string;
      await asTenant((db) =>
        db.query(
          `UPDATE leave_requests SET excluded_holiday_dates = $1::date[], days = $2
            WHERE tenant_id = $3 AND id = $4`,
          [[today], String(endOffsetDays), tenant.id, leaveId],
        ),
      );
      if (approve) {
        const decided = await post(
          managerSession.client,
          `/api/hris/leave/requests/${leaveId}/decision`,
          { action: "approve", idempotencyKey: key() },
        );
        expect(decided.status, JSON.stringify(decided.body)).toBe(200);
        expect(decided.body.data.status).toBe("approved");
      }
      return leaveId;
    },
  };
}

interface DbLog {
  validity: string;
  review_status: string;
  flag_reasons: string[];
}

async function dbLog(id: string): Promise<DbLog> {
  const { rows } = await asTenant((db) =>
    db.query<DbLog>(
      `SELECT validity, review_status, flag_reasons
         FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    ),
  );
  expect(rows[0], `log ${id} exists`).toBeDefined();
  return rows[0]!;
}

/** Inserts a valid `in` log straight into the table; returns its uuid. */
async function seedValidLog(s: Scenario, offsetDays: number): Promise<string> {
  const id = ulidToUuid(createUlid());
  await asTenant((db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, now(), 'valid', '[]'::jsonb, $6, $7, 'none')`,
      [
        id,
        tenant.id,
        s.outletId,
        s.employeeId,
        new Date(Date.now() + offsetDays * DAY),
        dateAt(offsetDays),
        `leh-${randomUUID()}`,
      ],
    ),
  );
  return id;
}

const looksLikeUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
const toUuid = (id: string) => (looksLikeUuid(id) ? id : ulidToUuid(id));

async function clockIn(s: Scenario) {
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
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; validity: string };
}

interface QueueItem {
  log: { id: string; validity: string; employeeId: string };
}

async function queuedLogIds(s: Scenario): Promise<string[]> {
  const response = await hr.get(
    `/api/hris/attendance/review-queue?outletId=${s.outletId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as QueueItem[]).map((item) => toUuid(item.log.id));
}

async function leavesOn(s: Scenario, offsetDays: number): Promise<string[]> {
  const result = await asTenant((db) =>
    db.query<{ leave_request_id: string }>(
      "SELECT leave_request_id FROM app.approved_leaves_on($1::uuid, $2::uuid, $3::date)",
      [tenant.id, s.employeeId, dateAt(offsetDays)],
    ),
  );
  return result.rows.map((row) => row.leave_request_id);
}

// Response bodies are untyped JSON in these HTTP-level tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRow = Record<string, any>;

async function fileCorrection(s: Scenario, day: string): Promise<JsonRow> {
  const response = await post(s.staff, "/api/hris/attendance/corrections", {
    outletId: s.outletId,
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: middayUtc(day),
    reason: "Lupa absen, mesin tidak terbaca",
    idempotencyKey: key(),
  });
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data as JsonRow;
}

const approveCorrection = (s: Scenario, correctionId: string) =>
  post(s.manager, `/api/hris/attendance/corrections/${correctionId}/decision`, {
    action: "approve",
    note: "Diperiksa penyelia",
    idempotencyKey: key(),
  });

async function manualLogsOn(s: Scenario, day: string): Promise<JsonRow[]> {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${s.employeeId}&limit=100`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as JsonRow[]).filter(
    (log) =>
      log.method === "manual_correction" &&
      Date.parse(log.occurredAt) === Date.parse(middayUtc(day)),
  );
}

// ---- 501-2: clock-in ---------------------------------------------------------

describe("[501-2] clock-in on an excluded holiday of a multi-day leave", () => {
  it("[501-2] clock-in on the excluded holiday is valid and not queued when the leave is approved first", async () => {
    const s = await newScenario("ci-after");
    // today (excluded), +1, +2 are the leave range; the holiday is the first day.
    await s.requestLeaveExcludingToday(2, true);

    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    const stored = await dbLog(toUuid(log.id));
    expect(stored.validity).toBe("valid");
    expect(stored.flag_reasons).not.toContain("leave_approved");
    expect(await queuedLogIds(s)).not.toContain(toUuid(log.id));
  });

  it("[501-2] clock-in on the holiday made before approval stays valid and unqueued after the leave is approved, while real leave days flag", async () => {
    const s = await newScenario("ci-before");
    const leaveId = await s.requestLeaveExcludingToday(2, false);

    // Leave is pending: nothing blocks or flags the holiday clock-in.
    const onHoliday = await clockIn(s);
    expect(onHoliday.validity).toBe("valid");
    const realDayOne = await seedValidLog(s, 1);
    const realDayTwo = await seedValidLog(s, 2);

    const decided = await post(
      s.manager,
      `/api/hris/leave/requests/${leaveId}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.status).toBe("approved");

    const holiday = await dbLog(toUuid(onHoliday.id));
    expect(holiday.validity).toBe("valid");
    expect(holiday.flag_reasons).not.toContain("leave_approved");
    const queued = await queuedLogIds(s);
    expect(queued).not.toContain(toUuid(onHoliday.id));

    // The real leave days of the same leave are still flagged and queued.
    for (const real of [realDayOne, realDayTwo]) {
      const stored = await dbLog(real);
      expect(stored.validity).toBe("flagged");
      expect(
        stored.flag_reasons.filter((reason) => reason === "leave_approved"),
      ).toHaveLength(1);
      expect(queued).toContain(real);
    }
  });

  it("[501-2] clock-in on a real leave day of the same leave is still flagged leave_approved", async () => {
    const s = await newScenario("ci-real");
    // today is a real leave day, +1 is the excluded holiday.
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 2,
      days: 2,
      excludedOffsets: [1],
    });

    const log = await clockIn(s);
    const stored = await dbLog(toUuid(log.id));
    expect(stored.validity).toBe("flagged");
    expect(stored.flag_reasons).toContain("leave_approved");
    expect(await queuedLogIds(s)).toContain(toUuid(log.id));
  });
});

// ---- 501-2: lookup and flagging functions ------------------------------------

describe("[501-2] approved-leave lookup and flagging skip excluded holidays", () => {
  it("[501-2] app.approved_leaves_on omits the excluded date and returns every real day", async () => {
    const s = await newScenario("lookup");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });

    expect(await leavesOn(s, 0), "holiday is not a leave day").toEqual([]);
    expect(await leavesOn(s, -1)).toEqual([leaveId]);
    expect(await leavesOn(s, 1)).toEqual([leaveId]);
    expect(await leavesOn(s, 2), "outside the range").toEqual([]);
  });

  it("[501-2] app.flag_attendance_for_leave flags logs on real days only, never on the excluded date", async () => {
    const s = await newScenario("flagfn");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 2,
      days: 2,
      excludedOffsets: [1],
    });
    const dayZero = await seedValidLog(s, 0);
    const holiday = await seedValidLog(s, 1);
    const dayTwo = await seedValidLog(s, 2);

    const flagged = await asTenant((db) =>
      db.query<{ log_id: string }>(
        "SELECT log_id FROM app.flag_attendance_for_leave($1::uuid, $2::uuid, $3::date, $4::date)",
        [tenant.id, s.employeeId, dateAt(0), dateAt(2)],
      ),
    );
    expect(flagged.rows.map((row) => row.log_id).sort()).toEqual(
      [dayZero, dayTwo].sort(),
    );
    expect((await dbLog(holiday)).validity).toBe("valid");
    expect((await dbLog(holiday)).flag_reasons).not.toContain("leave_approved");
    expect((await dbLog(dayZero)).validity).toBe("flagged");
    expect((await dbLog(dayTwo)).validity).toBe("flagged");
  });
});

// ---- 501-2: manual correction ------------------------------------------------

describe("[501-2] manual correction on an excluded holiday of a multi-day leave", () => {
  it("[501-2] approval on the excluded holiday is not refused and its manual log stays valid and unqueued", async () => {
    const s = await newScenario("corr-after");
    // Past range -4..-2, the holiday is the middle day (-3).
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -4,
      endOffsetDays: -2,
      days: 2,
      excludedOffsets: [-3],
    });
    const day = dateAt(-3);

    const correction = await fileCorrection(s, day);
    const approved = await approveCorrection(s, correction.id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.error?.code).not.toBe(LEAVE_DAY_CODE);

    const logs = await manualLogsOn(s, day);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.validity).toBe("valid");
    const queued = await queuedLogIds(s);
    expect(queued).not.toContain(toUuid(logs[0]!.id));
  });

  it("[501-2] approval on the holiday still works while the leave is pending", async () => {
    const s = await newScenario("corr-before");
    await s.seedLeave({
      status: "pending",
      startOffsetDays: -4,
      endOffsetDays: -2,
      days: 2,
      excludedOffsets: [-3],
    });
    const day = dateAt(-3);

    const correction = await fileCorrection(s, day);
    const approved = await approveCorrection(s, correction.id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const logs = await manualLogsOn(s, day);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.validity).toBe("valid");
  });

  it("[501-2] approval on a real leave day of the same leave is still refused 409 ATTENDANCE_CORRECTION_LEAVE_DAY", async () => {
    const s = await newScenario("corr-real");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -4,
      endOffsetDays: -2,
      days: 2,
      excludedOffsets: [-3],
    });

    for (const offset of [-4, -2]) {
      const day = dateAt(offset);
      const correction = await fileCorrection(s, day);
      const refused = await approveCorrection(s, correction.id);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error?.code, JSON.stringify(refused.body)).toBe(
        LEAVE_DAY_CODE,
      );
      expect(await manualLogsOn(s, day)).toHaveLength(0);
    }
  });
});
