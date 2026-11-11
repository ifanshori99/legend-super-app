// Fail-first tests for bead legend-eps6t: the HR review queue
// (GET /api/hris/attendance/review-queue) enriches every item so the leave
// review screen needs no extra calls. Expected behaviour comes from
// docs/briefs/538-g4-sub.md, bead legend-eps6t and the shared contract
// (AttendanceReviewItem in packages/shared/src/hris/attendance.ts), never from
// service code. Migration 0360 adds decision_action and the leave snapshot to
// attendance_logs; this file only uses the HTTP API plus rows seeded for
// non-leave logs (columns that already exist).
//
// New item fields (names from the bead; nesting is an assumption):
//   employeeName      string, the employee's full name
//   businessDate      "YYYY-MM-DD", the log's business date (outlet-local)
//   clockOutAt        ISO time of the same employee's clock-out that business
//                     date, null while there is none
//   caseKind          non-empty string for a leave case (new clock-in on leave
//                     vs leave approved later vs manual correction); the exact
//                     values are not asserted, only that it is present
//   canCancelLeave    true only when the caller holds hr.attendance.manage AND
//                     hr.leave.approve at the LEAVE's outlet; false otherwise
//   leave             snapshot { leaveRequestId, leaveTypeId, leaveTypeName,
//                     startDate, endDate } or null when the log is no leave case
//                     OR the caller lacks hr.leave.approve at the leave's outlet
//                     (CTO rule: leave data is only shown to people who may see
//                     leave; all other item fields stay as they are)
//   decisionAction    null while pending; the action that decided the item
//                     (keep_leave | cancel_leave | accept | ...) afterwards
//
// Assumptions (the brief leaves these open):
//  - The snapshot is taken when the log is flagged, so after cancel_leave on a
//    multi-day leave (which splits the leave) it still names the ORIGINAL
//    leaveRequestId and the ORIGINAL period.
//  - Non-leave items have `leave: null` and `canCancelLeave: false`.
//  - hr.leave.approve is the only hr.leave.* code in packages/shared access
//    (there is no hr.leave.view), so it is the right that gates `leave`. The
//    outlet that counts is the LEAVE's outlet (snapshot.leaveOutletId), not the
//    clock-in outlet; "within reach" means a role assignment covering it.
//  - A caller holding hr.attendance.manage at the clock-in outlet and
//    hr.leave.approve at the leave outlet (two separate assignments) may both
//    see the snapshot and cancel the leave.
//  - A hidden snapshot must not leak through the JSON at all: no leave type
//    name, leave type id or leave request id anywhere in the response text.
//  - The review decision response (an AttendanceReviewItem) carries the same
//    decisionAction.
//  - Roles without hr.attendance.manage get 403 on the queue; a foreign outlet
//    or tenant answers 403 or 404 and never leaks rows.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

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
let tenantB: SecondTenant;
const tenantBEmployeeName = `Karyawan Tenant Lain ${randomUUID().slice(0, 8)}`;
let tenantBLogId: string;

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
        `Queue case ${roleId.slice(0, 8)}`,
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
const key = () => `att-qc-${randomUUID()}`;
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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % DAY;
  const untilMidnight = DAY - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

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
        `QC-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet kasus antrean ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(
  userId: string | null,
  homeOutletId: string,
  fullName: string,
  tenantId: string = tenant.id,
) {
  const id = randomUUID();
  if (tenantId === tenant.id) createdEmployees.push(id);
  await asTenant(
    (client) =>
      client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
        [
          id,
          tenantId,
          userId,
          `QC-${id.slice(0, 8).toUpperCase()}`,
          fullName,
          homeOutletId,
        ],
      ),
    tenantId,
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

// ---- fixtures ---------------------------------------------------------------

let hr: Client; // tenant-wide: attendance.manage + leave.approve
let hrUserId: string;
let hrNoLeaveRight: Client; // outlet A: attendance.manage, NO hr.leave.approve
let hrB: Client; // outlet B only: attendance.manage + leave.approve
let hrSplit: Client; // attendance.manage at B, hr.leave.approve at A (leave outlet)
let selfOnly: Client; // may clock, no HR rights
let leaveTypeId: string;
const leaveTypeName = "Cuti tahunan uji kasus antrean";
let outletA: string; // home outlet of every employee here
let outletB: string;
let emptyOutlet: string;

beforeAll(async () => {
  requireDisposableDatabase();
  const admin = await signedInClient("HR Kasus Antrean", { mfa: true });
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
    code: `QC_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: leaveTypeName,
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

  outletA = await seedOutlet("A");
  outletB = await seedOutlet("B");
  emptyOutlet = await seedOutlet("kosong");
  for (const outletId of [outletA, outletB, emptyOutlet]) {
    const policy = await put(hr, "/api/hris/attendance/policy", {
      outletId,
      policy: basePolicy,
      sampling: noSampling,
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  }

  const noLeave = await signedInClient("HR Tanpa Izin Cuti", { mfa: true });
  await grantRole(
    noLeave.userId,
    ["hr.attendance.manage", "hr.employee.manage", "hr.employee.view"],
    { type: "outlet", outletIds: [outletA, outletB] },
  );
  hrNoLeaveRight = noLeave.client;

  const partial = await signedInClient("HR Outlet B Kasus", { mfa: true });
  await grantRole(
    partial.userId,
    [
      "hr.attendance.manage",
      "hr.leave.approve",
      "hr.employee.manage",
      "hr.employee.view",
    ],
    { type: "outlet", outletIds: [outletB] },
  );
  hrB = partial.client;

  const split = await signedInClient("HR Cuti A Absen B", { mfa: true });
  await grantRole(
    split.userId,
    ["hr.attendance.manage", "hr.employee.manage", "hr.employee.view"],
    { type: "outlet", outletIds: [outletB] },
  );
  await grantRole(split.userId, ["hr.leave.approve"], {
    type: "outlet",
    outletIds: [outletA],
  });
  hrSplit = split.client;

  const plain = await signedInClient("Karyawan Biasa Kasus");
  await grantRole(
    plain.userId,
    ["self.profile.view", "self.attendance.clock"],
    {
      type: "outlet",
      outletIds: [outletA],
    },
  );
  await seedEmployee(plain.userId, outletA, "Karyawan Biasa Kasus");
  selfOnly = plain.client;

  // Tenant B: an employee with a pending flagged log that must never leak.
  tenantB = await createSecondTenant(owner, "qcase");
  const employeeB = await seedEmployee(
    null,
    tenantB.outletId,
    tenantBEmployeeName,
    tenantB.tenantId,
  );
  tenantBLogId = await seedFlaggedLog({
    tenantId: tenantB.tenantId,
    outletId: tenantB.outletId,
    employeeId: employeeB,
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "attendance_logs",
      "shift_assignments",
      "attendance_policies",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2",
      [tenant.id, leaveTypeId],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-qc-%'",
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
  await asTenant(async (client) => {
    await client.query("DELETE FROM attendance_logs WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await client.query("DELETE FROM employees WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
  }, tenantB.tenantId);
  await removeSecondTenant(owner, tenantB);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

interface Staff {
  employeeId: string;
  name: string;
  client: Client;
  year: number;
}

/** An employee of home outlet A (may clock at A and B) with a 12-day balance. */
async function newStaff(label: string): Promise<Staff> {
  await avoidOutletMidnight();
  const name = `Staf Kasus ${label} ${randomUUID().slice(0, 6)}`;
  const session = await signedInClient(name);
  await grantRole(
    session.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", outletIds: [outletA, outletB] },
  );
  const employeeId = await seedEmployee(session.userId, outletA, name);
  const year = Number(wibDate(Date.now()).slice(0, 4));
  await asTenant((client) =>
    client.query(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
       VALUES ($1, $2, $3, $4, '12')`,
      [tenant.id, employeeId, leaveTypeId, year],
    ),
  );
  return { employeeId, name, client: session.client, year };
}

/** Approved leave at the HOME outlet A (start..end as day offsets from today, WIB). */
async function seedApprovedLeave(
  staff: Staff,
  startOffsetDays: number,
  endOffsetDays: number,
  days: number,
) {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO leave_requests
         (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
          start_date, end_date, days, excluded_holiday_dates, status,
          requested_by, requested_at, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::date[], 'approved',
               $10, clock_timestamp(), $10, now())`,
      [
        id,
        tenant.id,
        outletA,
        staff.employeeId,
        leaveTypeId,
        staff.year,
        wibDate(Date.now() + startOffsetDays * DAY),
        wibDate(Date.now() + endOffsetDays * DAY),
        String(days),
        hrUserId,
      ],
    );
    await client.query(
      `UPDATE leave_balances SET used_days = used_days + $1
        WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
      [String(days), tenant.id, staff.employeeId, leaveTypeId, staff.year],
    );
  });
  return id;
}

/** A published shift at `outletId` covering "now", so the clock-in lands there. */
async function seedShift(staff: Staff, outletId: string) {
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
        wibDate(Date.now()),
        JSON.stringify([
          {
            startsAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
            endsAt: new Date(Date.now() + 8 * 60 * MINUTE).toISOString(),
          },
        ]),
        hrUserId,
      ],
    ),
  );
}

async function clockIn(staff: Staff) {
  const response = await post(staff.client, "/api/hris/attendance/clock", {
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
  const log = response.body.data as {
    id: string;
    outletId: string;
    validity: string;
  };
  expect(log.validity, "clock-in on approved leave is flagged").toBe("flagged");
  return log;
}

/** A pending, flagged (outside geofence) log that is NOT a leave case. */
async function seedFlaggedLog(input: {
  tenantId: string;
  outletId: string;
  employeeId: string;
}) {
  const ulid = createUlid();
  await asTenant(
    (client) =>
      client.query(
        `INSERT INTO attendance_logs
           (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
            geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
         VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 400, 'flagged',
                 '["outside_geofence"]'::jsonb, $5, $6, 'pending')`,
        [
          ulidToUuid(ulid),
          input.tenantId,
          input.outletId,
          input.employeeId,
          wibDate(Date.now()),
          `qc-${ulid}`,
        ],
      ),
    input.tenantId,
  );
  return ulid;
}

interface LeaveSnapshot {
  leaveRequestId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
}
interface QueueItem {
  log: { id: string; outletId: string; employeeId: string };
  flagReasons: string[];
  reviewStatus: string;
  employeeName: string;
  caseKind: string | null;
  canCancelLeave: boolean;
  businessDate: string;
  clockOutAt: string | null;
  leave: LeaveSnapshot | null;
  decisionAction: string | null;
}

async function readQueue(
  client: Client,
  query: string,
): Promise<{ status: number; items: QueueItem[] }> {
  const items: QueueItem[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 30; pages += 1) {
    const response = await client.get(
      `/api/hris/attendance/review-queue?${query}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (response.status !== 200) return { status: response.status, items };
    items.push(...(response.body.data as QueueItem[]));
    cursor = response.body.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { status: 200, items };
}

async function itemFor(
  outletId: string,
  logId: string,
  client: Client = hr,
): Promise<QueueItem> {
  const { status, items } = await readQueue(
    client,
    `outletId=${outletId}&logId=${logId}`,
  );
  expect(status).toBe(200);
  const item = items.find((entry) => entry.log.id === logId);
  expect(item, `queue item for log ${logId}`).toBeDefined();
  return item!;
}

async function queueText(client: Client, outletId: string) {
  const response = await client.get(
    `/api/hris/attendance/review-queue?outletId=${outletId}&limit=100`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return JSON.stringify(response.body);
}

const review = (logId: string, body: Record<string, unknown>, client = hr) =>
  post(client, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

/** A staff member who clocked in on a day of approved leave (A, one day). */
async function flaggedLeaveCase(
  label: string,
  leave: { start: number; end: number; days: number } = {
    start: 0,
    end: 0,
    days: 1,
  },
) {
  const staff = await newStaff(label);
  const leaveId = await seedApprovedLeave(
    staff,
    leave.start,
    leave.end,
    leave.days,
  );
  const log = await clockIn(staff);
  return { staff, leaveId, log };
}

// ---- tests --------------------------------------------------------------------

describe("[538-G4b] by-id review queue eligibility", () => {
  it.each([
    { method: "selfie_geo", validity: "valid" },
    { method: "selfie_geo", validity: "rejected" },
    { method: "manual_correction", validity: "valid" },
  ])(
    "[538-G4b P2] hides unqueued $method/$validity logs by id",
    async (fixture) => {
      const employeeId = await seedEmployee(
        null,
        outletA,
        "Karyawan tanpa antrean",
      );
      const logId = createUlid();
      await asTenant((client) =>
        client.query(
          `INSERT INTO attendance_logs
             (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
              geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
           VALUES ($1, $2, $3, $4, 'in', $5, now(), now(), 10, $6,
                   '[]'::jsonb, $7, $8, 'none')`,
          [
            ulidToUuid(logId),
            tenant.id,
            outletA,
            employeeId,
            fixture.method,
            fixture.validity,
            wibDate(Date.now()),
            `qc-unqueued-${logId}`,
          ],
        ),
      );

      const response = await hr.get(
        `/api/hris/attendance/review-queue?outletId=${outletA}&logId=${logId}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        response.body.data,
        `${fixture.method}/${fixture.validity}`,
      ).toEqual([]);
      expect(response.body.meta.nextCursor).toBeNull();
    },
  );
});

describe("[eps6t] review queue item carries the leave case data", () => {
  it("[eps6t] a clock-in on approved leave shows employee name, business date, leave snapshot, case kind and cancel right", async () => {
    const { staff, leaveId, log } = await flaggedLeaveCase("d1");
    const item = await itemFor(log.outletId, log.id);

    expect(item.employeeName).toBe(staff.name);
    expect(item.businessDate).toBe(wibDate(Date.now()));
    expect(item.flagReasons).toContain("leave_approved");
    expect(item.leave).toEqual({
      leaveRequestId: leaveId,
      leaveTypeId,
      leaveTypeName,
      startDate: wibDate(Date.now()),
      endDate: wibDate(Date.now()),
    });
    expect(typeof item.caseKind).toBe("string");
    expect((item.caseKind ?? "").length).toBeGreaterThan(0);
    expect(item.canCancelLeave).toBe(true);
    expect(item.clockOutAt).toBeNull();
    expect(item.decisionAction).toBeNull();
    expect(item.reviewStatus).toBe("pending");
  });

  it("[eps6t] clockOutAt is the same employee's clock-out of that business date", async () => {
    const { staff, log } = await flaggedLeaveCase("d2");
    const item = await itemFor(log.outletId, log.id);
    expect(item.clockOutAt).toBeNull();

    // A valid clock-out of the same business date, written straight to the table.
    const outAt = new Date(Date.now() + 5 * MINUTE);
    await asTenant((client) =>
      client.query(
        `INSERT INTO attendance_logs
           (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
            geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
         VALUES ($1, $2, $3, $4, 'out', 'selfie_geo', $5, $5, 10, 'valid',
                 '[]'::jsonb, $6, $7, 'none')`,
        [
          ulidToUuid(createUlid()),
          tenant.id,
          log.outletId,
          staff.employeeId,
          outAt.toISOString(),
          item.businessDate,
          `qc-out-${randomUUID()}`,
        ],
      ),
    );

    const after = await itemFor(log.outletId, log.id);
    expect(after.clockOutAt).not.toBeNull();
    expect(new Date(after.clockOutAt as string).getTime()).toBe(
      outAt.getTime(),
    );
  });

  it("[eps6t] HR without hr.leave.approve still sees the item, but leave is null and canCancelLeave false", async () => {
    const { staff, log } = await flaggedLeaveCase("c1");
    const item = await itemFor(log.outletId, log.id, hrNoLeaveRight);
    expect(item.flagReasons).toContain("leave_approved");
    expect(item.employeeName).toBe(staff.name);
    expect(item.businessDate).toBe(wibDate(Date.now()));
    expect(item.reviewStatus).toBe("pending");
    expect(item.leave).toBeNull();
    expect(item.canCancelLeave).toBe(false);
  });

  it("[eps6t] canCancelLeave is false when the leave belongs to an outlet the caller does not hold hr.leave.approve for", async () => {
    // Leave at home outlet A, clock-in at outlet B; hrB reaches B only.
    const staff = await newStaff("c2");
    await seedApprovedLeave(staff, 0, 0, 1);
    await seedShift(staff, outletB);
    const log = await clockIn(staff);
    expect(log.outletId).toBe(outletB);

    const seenByB = await itemFor(outletB, log.id, hrB);
    expect(seenByB.canCancelLeave).toBe(false);
    const seenByTenantHr = await itemFor(outletB, log.id, hr);
    expect(seenByTenantHr.canCancelLeave).toBe(true);
  });

  it("[eps6t] a non-leave flagged log has no leave snapshot and no cancel right, but still names the employee and date", async () => {
    const name = `Karyawan Non Cuti ${randomUUID().slice(0, 6)}`;
    const employeeId = await seedEmployee(null, outletA, name);
    const logId = await seedFlaggedLog({
      tenantId: tenant.id,
      outletId: outletA,
      employeeId,
    });
    const item = await itemFor(outletA, logId);
    expect(item.employeeName).toBe(name);
    expect(item.businessDate).toBe(wibDate(Date.now()));
    expect(item.leave).toBeNull();
    expect(item.canCancelLeave).toBe(false);
    expect(item.decisionAction).toBeNull();
  });
});

describe("[eps6t] leave snapshot is only shown to holders of hr.leave.approve at the leave outlet", () => {
  /** Leave at home outlet A, clock-in at outlet B. */
  async function leaveAtAClockInAtB(label: string) {
    const staff = await newStaff(label);
    const leaveId = await seedApprovedLeave(staff, 0, 0, 1);
    await seedShift(staff, outletB);
    const log = await clockIn(staff);
    expect(log.outletId).toBe(outletB);
    return { staff, leaveId, log };
  }

  it("[eps6t] (a) HR with hr.attendance.manage but no hr.leave.approve sees the item with leave null", async () => {
    const { staff, log } = await flaggedLeaveCase("p1");
    // Control: a leave holder sees the snapshot for the very same item.
    const control = await itemFor(log.outletId, log.id, hr);
    expect(control.leave).not.toBeNull();

    const item = await itemFor(log.outletId, log.id, hrNoLeaveRight);
    expect(item.leave).toBeNull();
    expect(item.canCancelLeave).toBe(false);
    // Everything else about the item is unchanged.
    expect(item.employeeName).toBe(staff.name);
    expect(item.flagReasons).toContain("leave_approved");
    expect(item.businessDate).toBe(wibDate(Date.now()));
    expect(item.reviewStatus).toBe("pending");
    expect(item.decisionAction).toBeNull();
  });

  it("[eps6t] (b) hr.leave.approve at the clock-in outlet but not at the leave outlet: leave null", async () => {
    const { staff, log } = await leaveAtAClockInAtB("p2");
    // Control: tenant-wide HR sees the snapshot for this item.
    const control = await itemFor(outletB, log.id, hr);
    expect(control.leave).not.toBeNull();

    const item = await itemFor(outletB, log.id, hrB);
    expect(item.leave).toBeNull();
    expect(item.canCancelLeave).toBe(false);
    expect(item.employeeName).toBe(staff.name);
    expect(item.flagReasons).toContain("leave_approved");
    expect(item.reviewStatus).toBe("pending");
  });

  it("[eps6t] (c) hr.leave.approve at the leave outlet: leave is filled", async () => {
    const { leaveId, log } = await leaveAtAClockInAtB("p3");
    const item = await itemFor(outletB, log.id, hrSplit);
    expect(item.leave).toEqual({
      leaveRequestId: leaveId,
      leaveTypeId,
      leaveTypeName,
      startDate: wibDate(Date.now()),
      endDate: wibDate(Date.now()),
    });
    // attendance.manage at the clock-in outlet + hr.leave.approve at the leave outlet.
    expect(item.canCancelLeave).toBe(true);
  });

  it("[eps6t] (d) a null leave does not leak the leave type name, type id or request id in the response JSON", async () => {
    const sameOutlet = await flaggedLeaveCase("p4");
    const crossOutlet = await leaveAtAClockInAtB("p5");

    const cases = [
      { client: hrNoLeaveRight, outletId: sameOutlet.log.outletId },
      { client: hrB, outletId: outletB },
    ];
    for (const { client, outletId } of cases) {
      // Raw text of the whole queue of that outlet (every leave case seeded so far).
      const raw = await client.get(
        `/api/hris/attendance/review-queue?outletId=${outletId}&limit=100`,
      );
      expect(raw.status, JSON.stringify(raw.body)).toBe(200);
      const text = JSON.stringify(raw.body);
      // Control: the leave items are in this response, so the checks below bite.
      expect(text).toContain("leave_approved");
      expect(text).not.toContain(leaveTypeName);
      expect(text).not.toContain("Cuti tahunan");
      expect(text).not.toContain(leaveTypeId);
      expect(text).not.toContain(sameOutlet.leaveId);
      expect(text).not.toContain(crossOutlet.leaveId);
      for (const entry of raw.body.data as QueueItem[])
        expect(entry.leave).toBeNull();
    }

    // Control: the same data IS shown to a holder of the right.
    const shown = await queueText(hr, crossOutlet.log.outletId);
    expect(shown).toContain(leaveTypeName);
  });
});

describe("[eps6t] decisionAction after a decision", () => {
  it("[eps6t] keep_leave is recorded on the item and on the decision response", async () => {
    const { leaveId, log } = await flaggedLeaveCase("k1");
    const decided = await review(log.id, { action: "keep_leave" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.decisionAction).toBe("keep_leave");

    const item = await itemFor(log.outletId, log.id);
    expect(item.reviewStatus).not.toBe("pending");
    expect(item.decisionAction).toBe("keep_leave");
    expect(item.leave?.leaveRequestId).toBe(leaveId);
  });

  it("[eps6t] cancel_leave on a one-day leave keeps the leave snapshot although the leave is cancelled", async () => {
    const { leaveId, log } = await flaggedLeaveCase("k2");
    const decided = await review(log.id, { action: "cancel_leave" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.decisionAction).toBe("cancel_leave");

    const item = await itemFor(log.outletId, log.id);
    expect(item.decisionAction).toBe("cancel_leave");
    expect(item.leave).toEqual({
      leaveRequestId: leaveId,
      leaveTypeId,
      leaveTypeName,
      startDate: wibDate(Date.now()),
      endDate: wibDate(Date.now()),
    });
  });

  it("[eps6t] cancel_leave on a multi-day leave splits it, but the item still names the original leave and period", async () => {
    const { leaveId, log } = await flaggedLeaveCase("k3", {
      start: -1,
      end: 1,
      days: 3,
    });
    const before = await itemFor(log.outletId, log.id);
    expect(before.leave).toMatchObject({
      leaveRequestId: leaveId,
      startDate: wibDate(Date.now() - DAY),
      endDate: wibDate(Date.now() + DAY),
    });

    const decided = await review(log.id, { action: "cancel_leave" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const item = await itemFor(log.outletId, log.id);
    expect(item.decisionAction).toBe("cancel_leave");
    expect(item.leave).toEqual({
      leaveRequestId: leaveId,
      leaveTypeId,
      leaveTypeName,
      startDate: wibDate(Date.now() - DAY),
      endDate: wibDate(Date.now() + DAY),
    });
  });

  it("[eps6t] accepting a non-leave flagged log records decisionAction accept", async () => {
    const employeeId = await seedEmployee(null, outletA, "Karyawan Terima");
    const logId = await seedFlaggedLog({
      tenantId: tenant.id,
      outletId: outletA,
      employeeId,
    });
    const decided = await review(logId, { action: "accept" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.decisionAction).toBe("accept");

    const item = await itemFor(outletA, logId);
    expect(item.reviewStatus).toBe("accepted");
    expect(item.decisionAction).toBe("accept");
    expect(item.leave).toBeNull();
  });
});

describe("[eps6t] access, isolation and empty state", () => {
  it("[eps6t] a user without attendance review rights is refused 403", async () => {
    // Control: HR reads the same outlet, so 403 is about the role, not the outlet.
    const control = await readQueue(hr, `outletId=${outletA}`);
    expect(control.status).toBe(200);
    const response = await selfOnly.get(
      `/api/hris/attendance/review-queue?outletId=${outletA}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("[eps6t] a request without a session is refused 401", async () => {
    const response = await agent(app).get(
      `/api/hris/attendance/review-queue?outletId=${outletA}`,
    );
    expect(response.status).toBe(401);
  });

  it("[eps6t] another tenant's employee and log never appear in this tenant's queue", async () => {
    // Control: the enriched fields exist for this tenant's own items.
    const { log } = await flaggedLeaveCase("t1");
    const own = await itemFor(log.outletId, log.id);
    expect(own.employeeName).toBeTruthy();

    const everything = await readQueue(hr, "reviewStatus=pending");
    expect(everything.status).toBe(200);
    const serialized = JSON.stringify(everything.items);
    expect(serialized).not.toContain(tenantBEmployeeName);
    expect(
      everything.items.some((entry) => entry.log.id === tenantBLogId),
    ).toBe(false);

    const foreign = await readQueue(hr, `outletId=${tenantB.outletId}`);
    expect([200, 403, 404]).toContain(foreign.status);
    if (foreign.status === 200) expect(foreign.items).toEqual([]);
    expect(JSON.stringify(foreign.items)).not.toContain(tenantBEmployeeName);
  });

  it("[eps6t] an outlet outside the caller's reach is refused and leaks no names", async () => {
    const { log } = await flaggedLeaveCase("t2");
    // Own outlet first, so the refusal below is scope, not a broken setup.
    const own = await readQueue(hrNoLeaveRight, `outletId=${log.outletId}`);
    expect(own.status).toBe(200);
    expect(own.items.some((entry) => entry.log.id === log.id)).toBe(true);

    const foreign = await readQueue(hrB, `outletId=${log.outletId}`);
    expect([403, 404]).toContain(foreign.status);
    expect(foreign.items).toEqual([]);
  });

  it("[eps6t] an outlet without flagged logs answers 200 with an empty list", async () => {
    const response = await hr.get(
      `/api/hris/attendance/review-queue?outletId=${emptyOutlet}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta?.nextCursor ?? null).toBeNull();
  });
});
