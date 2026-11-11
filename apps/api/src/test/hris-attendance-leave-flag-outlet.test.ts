// Round-2 tests for bead legend-9y6ri: clock-in on a day with APPROVED leave,
// the outlet-scope, multi-day and night-shift edges. Expected behaviour comes
// from docs/briefs/9y6ri-leave-clockin-flag.md ("Review architect (putaran 1)"
// point 5) and the shared contract (packages/shared/src/hris), never from
// service code. Names (flag "leave_approved", review actions "keep_leave" /
// "cancel_leave", queue GET /api/hris/attendance/review-queue) are the ones in
// hris-attendance-leave-flag.test.ts; setup mirrors that file.
//
// Money rule behind every test: the leave day is never paid twice, and when
// in doubt the stricter outcome wins (refuse and keep the leave).
//
// Assumptions:
//  - The leave request belongs to the employee's HOME outlet (leave_requests
//    .outlet_id = home). A clock-in at another outlet is made by publishing a
//    shift there (same technique as hris-attendance-clock-414.test.ts); the
//    log then carries that other outlet's id.
//  - "HR with partial outlet access" = outlet-scoped role assignment (only the
//    clock-in outlet B) holding hr.attendance.manage + hr.leave.approve. Leave
//    rows of home outlet A are invisible to that HR (per-outlet row security).
//    Allowed outcomes of cancel_leave for that HR: 200 with the leave really
//    cancelled, or 409 with everything unchanged. Never 200 while the leave
//    stays approved.
//  - `accept` on a log flagged leave_approved is refused (409 or 422) and the
//    log does not become "valid" (that would pay leave and work).
//  - cancel_leave on a multi-day leave cancels only the log's business date
//    (bead legend-5nt2z, founder W8 Q27): 200, the leave is split, exactly one
//    day goes back to the balance, the other days stay approved. Details are in
//    hris-attendance-leave-split.test.ts. keep_leave keeps the whole leave.
//  - Night shift: the shift's business date (yesterday, WIB) is the date used
//    for detection, so a leave on yesterday flags the clock-in and a leave
//    only on today (the wall-clock date) does not.
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
        `Attendance leave outlet ${roleId.slice(0, 8)}`,
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
const key = () => `att-lfo-${randomUUID()}`;
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
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `LO-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-outlet ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Outlet', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LO-${id.slice(0, 8).toUpperCase()}`,
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

let hr: Client; // tenant-wide HR: creates fixtures and reads state
let hrUserId: string;
let leaveTypeId: string;
let outletA: string; // home outlet of every employee here
let outletB: string; // "other" outlet: where the clock-in happens in some tests

beforeAll(async () => {
  const admin = await signedInClient("HR Absen Cuti Outlet", { mfa: true });
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
    code: `LFO_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji absen outlet",
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
  for (const outletId of [outletA, outletB]) {
    const policy = await put(hr, "/api/hris/attendance/policy", {
      outletId,
      policy: basePolicy,
      sampling: noSampling,
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  }
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-lfo-%'",
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

interface Staff {
  employeeId: string;
  client: Client;
  year: number;
}

/**
 * An employee whose home outlet is A, allowed to clock at A and B, with a
 * leave balance of 12 days and nothing used.
 */
async function newStaff(label: string): Promise<Staff> {
  await avoidOutletMidnight();
  const session = await signedInClient(`Staf Cuti Outlet ${label}`);
  await grantRole(
    session.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", outletIds: [outletA, outletB] },
  );
  const employeeId = await seedEmployee(session.userId, outletA);
  const year = Number(wibDate(Date.now()).slice(0, 4));
  await asTenant((client) =>
    client.query(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
       VALUES ($1, $2, $3, $4, '12')`,
      [tenant.id, employeeId, leaveTypeId, year],
    ),
  );
  return { employeeId, client: session.client, year };
}

/** An approved leave (start..end offsets from today, WIB) at the HOME outlet A. */
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

/**
 * A published shift at `outletId` that covers "now" (business date given in
 * WIB, so a night shift can belong to yesterday).
 */
async function seedShift(
  staff: Staff,
  outletId: string,
  businessDate: string,
) {
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
        businessDate,
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

interface Log {
  id: string;
  outletId: string;
  validity: string;
}

async function clockIn(staff: Staff): Promise<Log> {
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
  return response.body.data as Log;
}

interface QueueItem {
  log: { id: string; validity: string; outletId: string };
  source: string;
  flagReasons: string[];
  reviewStatus: string;
}

async function queueOf(
  outletId: string,
  client: Client = hr,
  extra = "",
): Promise<QueueItem[]> {
  const response = await client.get(
    `/api/hris/attendance/review-queue?outletId=${outletId}${extra}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as QueueItem[];
}

async function queueEntry(outletId: string, logId: string, client = hr) {
  return (await queueOf(outletId, client)).find((item) => item.log.id === logId);
}

async function balance(staff: Staff) {
  const response = await hr.get(
    `/api/hris/leave/balances?employeeId=${staff.employeeId}&year=${staff.year}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const row = (
    response.body.data as {
      leaveTypeId: string;
      entitledDays: string;
      usedDays: string;
      pendingDays: string;
    }[]
  ).find((entry) => entry.leaveTypeId === leaveTypeId);
  expect(row, "leave balance row").toBeDefined();
  return {
    entitled: row!.entitledDays,
    used: row!.usedDays,
    pending: row!.pendingDays,
  };
}

async function leaveStatus(staff: Staff, leaveId: string) {
  const response = await hr.get(
    `/api/hris/leave/requests?employeeId=${staff.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (
    response.body.data as { id: string; status: string }[]
  ).find((entry) => entry.id === leaveId)?.status;
}

async function validityOf(staff: Staff, logId: string) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${staff.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (
    response.body.data as { id: string; validity: string }[]
  ).find((item) => item.id === logId)?.validity;
}

const review = (logId: string, body: Record<string, unknown>, client = hr) =>
  post(client, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

/** Everything about the leave day that a refused or rolled-back decision must leave alone. */
async function expectUntouched(
  staff: Staff,
  leaveId: string,
  log: Log,
  usedDays: string,
) {
  expect(await leaveStatus(staff, leaveId)).toBe("approved");
  expect(await balance(staff)).toMatchObject({
    entitled: "12.0000",
    used: usedDays,
    pending: "0.0000",
  });
  expect(await validityOf(staff, log.id)).toBe("flagged");
  expect((await queueEntry(log.outletId, log.id))?.reviewStatus).toBe(
    "pending",
  );
}

// ---- 1. clock-in at an outlet other than the home outlet -----------------------

describe("[F25] clock-in at another outlet than the home outlet", () => {
  it("[F25] approved leave (home outlet A) still flags a clock-in made at outlet B", async () => {
    const staff = await newStaff("o1");
    const leaveId = await seedApprovedLeave(staff, 0, 0, 1);
    await seedShift(staff, outletB, wibDate(Date.now()));

    const log = await clockIn(staff);
    expect(log.outletId, "the clock-in is stored at outlet B").toBe(outletB);
    expect(log.validity).toBe("flagged");

    const item = await queueEntry(outletB, log.id);
    expect(item, "flagged log is in the queue of outlet B").toBeDefined();
    expect(item).toMatchObject({ source: "flagged", reviewStatus: "pending" });
    expect(item?.flagReasons).toContain("leave_approved");

    // Nothing is paid twice while HR has not decided.
    expect(await leaveStatus(staff, leaveId)).toBe("approved");
    expect((await balance(staff)).used).toBe("1.0000");
  });

  it("[F25] control: the same clock-in at outlet B without any leave is valid and not queued", async () => {
    const staff = await newStaff("o2");
    await seedShift(staff, outletB, wibDate(Date.now()));

    const log = await clockIn(staff);
    expect(log.outletId).toBe(outletB);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(outletB, log.id)).toBeUndefined();
  });
});

// ---- 2. HR with access to only part of the outlets ----------------------------

describe("[F25] HR with access to outlet B only decides a leave that belongs to outlet A", () => {
  let hrB: Client;

  beforeAll(async () => {
    const partial = await signedInClient("HR Outlet B Saja", { mfa: true });
    await grantRole(
      partial.userId,
      ["hr.attendance.manage", "hr.leave.approve", "hr.employee.view"],
      { type: "outlet", outletIds: [outletB] },
    );
    hrB = partial.client;
  });

  /** Staff of home outlet A clocking in at B on a day of approved leave. */
  async function flaggedAtB(label: string) {
    const staff = await newStaff(label);
    const leaveId = await seedApprovedLeave(staff, 0, 0, 1);
    await seedShift(staff, outletB, wibDate(Date.now()));
    const log = await clockIn(staff);
    expect(log.outletId).toBe(outletB);
    expect(log.validity).toBe("flagged");
    return { staff, leaveId, log };
  }

  it("[F25] the partial-access HR sees the leave-flagged log in the queue of outlet B", async () => {
    const { log } = await flaggedAtB("p1");
    const item = await queueEntry(outletB, log.id, hrB);
    expect(item?.flagReasons).toContain("leave_approved");
    expect(item?.reviewStatus).toBe("pending");
  });

  it("[F25] cancel_leave either really cancels the hidden leave (refund once, log valid) or answers 409 and changes nothing; never a valid log with the leave still approved", async () => {
    const { staff, leaveId, log } = await flaggedAtB("p2");

    const response = await review(log.id, { action: "cancel_leave" }, hrB);
    // 403 is also safe: this HR lacks hr.leave.approve at the leave's own outlet A.
    expect([200, 403, 409], JSON.stringify(response.body)).toContain(
      response.status,
    );

    if (response.status === 200) {
      expect(await leaveStatus(staff, leaveId)).toBe("cancelled");
      expect(await balance(staff)).toMatchObject({
        entitled: "12.0000",
        used: "0.0000",
        pending: "0.0000",
      });
      expect(await validityOf(staff, log.id)).toBe("valid");
    } else {
      await expectUntouched(staff, leaveId, log, "1.0000");
    }
  });

  it("[F25] accept is refused on a leave-flagged log for the partial-access HR and nothing changes", async () => {
    const { staff, leaveId, log } = await flaggedAtB("p3");

    const response = await review(log.id, { action: "accept" }, hrB);
    expect([409, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    await expectUntouched(staff, leaveId, log, "1.0000");
  });

  it("[F25] accept is refused for the tenant-wide HR too (leave and work would both be paid)", async () => {
    const { staff, leaveId, log } = await flaggedAtB("p4");

    const response = await review(log.id, { action: "accept" });
    expect([409, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    await expectUntouched(staff, leaveId, log, "1.0000");
  });

  it("[F25] keep_leave by the partial-access HR resolves the flag and leaves leave and balance alone", async () => {
    const { staff, leaveId, log } = await flaggedAtB("p5");

    const response = await review(log.id, { action: "keep_leave" }, hrB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.reviewStatus).not.toBe("pending");

    expect(await leaveStatus(staff, leaveId)).toBe("approved");
    expect((await balance(staff)).used).toBe("1.0000");
    expect(await validityOf(staff, log.id)).toBe("rejected");
  });
});

// ---- 3. multi-day leave -------------------------------------------------------

describe("[F25] cancel_leave on a leave that spans several days (day-only cancel)", () => {
  it("[F25] cancel_leave cancels only today: the leave is split, one day goes back, the other two stay approved", async () => {
    const staff = await newStaff("m1");
    // Yesterday..tomorrow, 3 days: today is one day inside a longer leave.
    const leaveId = await seedApprovedLeave(staff, -1, 1, 3);
    const log = await clockIn(staff);
    expect(log.validity).toBe("flagged");
    expect((await queueEntry(outletA, log.id))?.flagReasons).toContain(
      "leave_approved",
    );

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reviewStatus).not.toBe("pending");

    // The original row (yesterday) stays approved; a new approved row (tomorrow) exists.
    expect(await leaveStatus(staff, leaveId)).toBe("approved");
    const rows = await asTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status, start_date::text AS start, end_date::text AS "end", days::float8 AS days
           FROM leave_requests
          WHERE tenant_id = $1 AND employee_id = $2
          ORDER BY start_date`,
        [tenant.id, staff.employeeId],
      );
      return rows as {
        id: string;
        status: string;
        start: string;
        end: string;
        days: number;
      }[];
    });
    expect(rows.map((row) => [row.start, row.end, row.days, row.status])).toEqual(
      [
        [wibDate(Date.now() - DAY), wibDate(Date.now() - DAY), 1, "approved"],
        [wibDate(Date.now() + DAY), wibDate(Date.now() + DAY), 1, "approved"],
      ],
    );
    // Exactly one of the three days is refunded.
    expect(await balance(staff)).toMatchObject({
      entitled: "12.0000",
      used: "2.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    expect((await queueEntry(outletA, log.id))?.reviewStatus).not.toBe(
      "pending",
    );
  });

  it("[F25] keep_leave on a multi-day leave keeps all three days and rejects the log", async () => {
    const staff = await newStaff("m3");
    const leaveId = await seedApprovedLeave(staff, -1, 1, 3);
    const log = await clockIn(staff);
    expect(log.validity).toBe("flagged");

    const kept = await review(log.id, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.data.reviewStatus).not.toBe("pending");
    expect(await leaveStatus(staff, leaveId)).toBe("approved");
    expect((await balance(staff)).used).toBe("3.0000");
    expect(await validityOf(staff, log.id)).toBe("rejected");
  });

  it("[F25] a one-day leave on the same day is still cancelled normally (control)", async () => {
    const staff = await newStaff("m2");
    const leaveId = await seedApprovedLeave(staff, 0, 0, 1);
    const log = await clockIn(staff);

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await leaveStatus(staff, leaveId)).toBe("cancelled");
    expect((await balance(staff)).used).toBe("0.0000");
    expect(await validityOf(staff, log.id)).toBe("valid");
  });
});

// ---- 4. night shift: detection date equals the review date --------------------

describe("[F25] night shift that belongs to yesterday's business date", () => {
  it("[F25] a leave on the shift's business date (yesterday) flags the clock-in and cancel_leave cancels that same leave", async () => {
    const staff = await newStaff("n1");
    const yesterday = wibDate(Date.now() - DAY);
    const leaveId = await seedApprovedLeave(staff, -1, -1, 1);
    await seedShift(staff, outletA, yesterday);

    const log = await clockIn(staff);
    expect(log.validity).toBe("flagged");
    const item = await queueEntry(outletA, log.id);
    expect(item?.flagReasons).toContain("leave_approved");

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await leaveStatus(staff, leaveId)).toBe("cancelled");
    expect((await balance(staff)).used).toBe("0.0000");
    expect(await validityOf(staff, log.id)).toBe("valid");
  });

  it("[F25] a leave only on today's wall-clock date does not flag a clock-in that belongs to yesterday's shift", async () => {
    const staff = await newStaff("n2");
    const leaveId = await seedApprovedLeave(staff, 0, 0, 1);
    await seedShift(staff, outletA, wibDate(Date.now() - DAY));

    const log = await clockIn(staff);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(outletA, log.id)).toBeUndefined();
    expect(await leaveStatus(staff, leaveId)).toBe("approved");
    expect((await balance(staff)).used).toBe("1.0000");
  });
});
