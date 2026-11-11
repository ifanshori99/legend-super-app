// Fail-first tests for bead legend-5nt2z (founder W8 Q27): cancel_leave on a
// MULTI-DAY approved leave cancels only the day of the attendance log. Expected
// behaviour comes from docs/briefs/5nt2z-leave-partial.md ("legend-5nt2z" and
// "Desain 5nt2z") and the shared contract, never from service code. Names
// (flag "leave_approved", review action "cancel_leave", POST
// /api/hris/attendance/logs/:logId/review) are the ones in
// hris-attendance-leave-flag.test.ts; the setup mirrors that file.
//
// Money rule behind every test: the leave day is never paid twice (leave AND
// work), the balance comes back exactly once, and in doubt the stricter
// outcome wins.
//
// Assumptions:
//  - Leave day D = the log's business date (outlet-local WIB). Clock-ins can
//    only be made for "today", so the first / middle / last day of a leave is
//    set up by moving the leave range around today. Logs on other days (for
//    the two-cancel test) are inserted straight into attendance_logs as valid
//    "in" logs; the HTTP id is looked up from the logs list.
//  - There is no half-day in the model (brief): one cancelled day refunds
//    exactly 1.0000.
//  - Split rule: D = start narrows the original row to [D+1..end]; D = end to
//    [start..D-1]; D in the middle narrows the original row to the head
//    [start..D-1] and adds ONE new approved row (new id) for the tail
//    [D+1..end] with decided_by copied. The original row keeps its id.
//  - A one-day leave stays "cancelled" as before (no tail row).
//  - D inside excluded_holiday_dates is not paid as leave: cancel_leave
//    answers 200, nothing is split, the balance does not move and the log is
//    valid. (Whether the clock-in is flagged in that case is not asserted.)
//  - HR without hr.leave.approve (tenant-wide, or only at another outlet)
//    gets 403 and nothing changes.
//  - Replay with the same key answers 2xx; a second cancel_leave with a new key
//    answers 200, 409 or 422. Either way nothing changes and no second refund.
//  - Audit: some audit_logs event of the tenant mentions the id of the new tail
//    row (uuid or its public ULID form); the action name is not asserted.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createUlid, ulidToUuid, uuidToUlid } from "@starter/shared/core";
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
        `Attendance leave split ${roleId.slice(0, 8)}`,
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
const key = () => `att-ls-${randomUUID()}`;
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
        `LS-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-pecah ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Pecah', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LS-${id.slice(0, 8).toUpperCase()}`,
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
/** Outlet-local (WIB) calendar date `offset` days from today. */
const dateAt = (offset: number) => wibDate(Date.now() + offset * DAY);
/** Inclusive list of ISO dates between two ISO dates. */
function expand(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let ms = Date.parse(`${start}T00:00:00Z`);
    ms <= Date.parse(`${end}T00:00:00Z`);
    ms += DAY
  )
    out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}

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
let outletA: string; // home outlet of every leave
let outletB: string; // "other" outlet

beforeAll(async () => {
  const admin = await signedInClient("HR Absen Cuti Pecah", { mfa: true });
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
    code: `LSPL_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji pecah",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-ls-%'",
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
  const session = await signedInClient(`Staf Cuti Pecah ${label}`);
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

/**
 * An approved leave (start..end offsets from today, WIB) at the HOME outlet A,
 * with its days already counted in the balance's used_days.
 */
async function seedApprovedLeave(
  staff: Staff,
  startOffsetDays: number,
  endOffsetDays: number,
  days: number,
  excludedOffsets: number[] = [],
) {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO leave_requests
         (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
          start_date, end_date, days, excluded_holiday_dates, status,
          requested_by, requested_at, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11::date[], 'approved',
               $10, clock_timestamp(), $10, now())`,
      [
        id,
        tenant.id,
        outletA,
        staff.employeeId,
        leaveTypeId,
        staff.year,
        dateAt(startOffsetDays),
        dateAt(endOffsetDays),
        String(days),
        hrUserId,
        excludedOffsets.map(dateAt),
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

/** A published shift at `outletId` that covers "now" with business date today. */
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
        dateAt(0),
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

/** A valid "in" log on the business date `offset` days from today (direct insert). */
async function insertValidLog(staff: Staff, offset: number, outletId = outletA) {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, business_date, client_event_id)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, now(), 'valid', $6, $7)`,
      [
        uuid,
        tenant.id,
        outletId,
        staff.employeeId,
        new Date(Date.now() + offset * DAY),
        dateAt(offset),
        createUlid(),
      ],
    ),
  );
  return uuid;
}

const looksLikeUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
const toUuid = (id: string) => (looksLikeUuid(id) ? id : ulidToUuid(id));

/** The id the HTTP API uses for a log whose database uuid we know. */
async function apiIdOf(staff: Staff, uuid: string) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${staff.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const found = (response.body.data as { id: string }[]).find(
    (item) => toUuid(item.id) === uuid,
  );
  expect(found, "inserted log listed by the API").toBeDefined();
  return found!.id;
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

interface LeaveRow {
  id: string;
  status: string;
  start: string;
  end: string;
  days: number;
  excluded: string[];
  decidedBy: string | null;
  attachmentKey: string | null;
  outletId: string;
}

async function leavesOf(staff: Staff): Promise<LeaveRow[]> {
  return asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, start_date::text AS start, end_date::text AS "end",
              days::float8 AS days,
              COALESCE(ARRAY(SELECT d::text FROM unnest(excluded_holiday_dates) d ORDER BY d), '{}') AS excluded,
              decided_by AS "decidedBy", attachment_key AS "attachmentKey",
              outlet_id AS "outletId"
         FROM leave_requests
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY start_date, id`,
      [tenant.id, staff.employeeId],
    );
    return rows as LeaveRow[];
  });
}

const byStatus = (rows: LeaveRow[], status: string) =>
  rows.filter((row) => row.status === status);

interface DbLog {
  id: string;
  validity: string;
  businessDate: string;
}

async function dbLogsOf(staff: Staff): Promise<DbLog[]> {
  return asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT id, validity, business_date::text AS "businessDate"
         FROM attendance_logs
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY business_date, id`,
      [tenant.id, staff.employeeId],
    );
    return rows as DbLog[];
  });
}

async function validityOf(staff: Staff, logId: string) {
  return (await dbLogsOf(staff)).find((item) => item.id === toUuid(logId))
    ?.validity;
}

const review = (logId: string, body: Record<string, unknown>, client = hr) =>
  post(client, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

/** Everything a refused, replayed or no-op decision must leave alone. */
async function snapshot(staff: Staff) {
  return {
    leaves: await leavesOf(staff),
    balance: await balance(staff),
    logs: await dbLogsOf(staff),
  };
}

/**
 * Money invariants after any decision: no calendar day is covered by two
 * approved leaves, the approved days are exactly `expectedOffsets`, and no day
 * with a valid log is still covered by an approved leave.
 */
async function expectConsistent(staff: Staff, expectedOffsets: number[]) {
  const approved = byStatus(await leavesOf(staff), "approved");
  const covered = approved.flatMap((row) => expand(row.start, row.end));
  expect(new Set(covered).size, "a day is covered by two approved leaves").toBe(
    covered.length,
  );
  expect([...covered].sort()).toEqual(expectedOffsets.map(dateAt).sort());
  const validDays = (await dbLogsOf(staff))
    .filter((item) => item.validity === "valid")
    .map((item) => item.businessDate);
  for (const day of validDays)
    expect(covered, `valid log on ${day} and approved leave`).not.toContain(day);
}

const sumDays = (rows: LeaveRow[]) =>
  rows.reduce((total, row) => total + row.days, 0);

async function auditMentions(...uuids: string[]) {
  const needles = uuids.flatMap((id) => [id, uuidToUlid(id)]);
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event::text ILIKE ANY($2::text[])`,
    [tenant.id, needles.map((needle) => `%${needle}%`)],
  );
  return rows.length;
}

/** Staff with a flagged clock-in today inside a leave `start..end` (offsets). */
async function flaggedInside(
  label: string,
  startOffset: number,
  endOffset: number,
  days: number,
) {
  const staff = await newStaff(label);
  const leaveId = await seedApprovedLeave(staff, startOffset, endOffset, days);
  const log = await clockIn(staff);
  // Guard: the log is flagged, otherwise the review below proves nothing.
  expect(log.validity).toBe("flagged");
  expect(await balance(staff)).toMatchObject({
    entitled: "12.0000",
    used: `${days}.0000`,
  });
  return { staff, leaveId, log };
}

// ---- first / middle / last day ----------------------------------------------

describe("[F25] cancel_leave on a multi-day leave cancels only the log's day", () => {
  it("[F25] first day: the original row shrinks to the remaining days, balance back by exactly 1", async () => {
    const { staff, leaveId, log } = await flaggedInside("s1", 0, 4, 5);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.reviewStatus).not.toBe("pending");

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: leaveId,
      status: "approved",
      start: dateAt(1),
      end: dateAt(4),
      days: 4,
    });
    expect(await balance(staff)).toMatchObject({
      entitled: "12.0000",
      used: "4.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    await expectConsistent(staff, [1, 2, 3, 4]);
  });

  it("[F25] last day: the original row shrinks to the days before, balance back by exactly 1", async () => {
    const { staff, leaveId, log } = await flaggedInside("s2", -4, 0, 5);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: leaveId,
      status: "approved",
      start: dateAt(-4),
      end: dateAt(-1),
      days: 4,
    });
    expect(await balance(staff)).toMatchObject({
      used: "4.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    await expectConsistent(staff, [-4, -3, -2, -1]);
  });

  it("[F25] middle day: head keeps the original id, a new approved tail row is added, days add up to 4", async () => {
    const { staff, leaveId, log } = await flaggedInside("s3", -2, 2, 5);
    const before = (await leavesOf(staff))[0]!;

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.reviewStatus).not.toBe("pending");
    expect(response.body.data.log.validity).toBe("valid");

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(2);
    expect(byStatus(rows, "approved")).toHaveLength(2);
    const head = rows.find((row) => row.id === leaveId)!;
    const tail = rows.find((row) => row.id !== leaveId)!;
    expect(head).toMatchObject({ start: dateAt(-2), end: dateAt(-1), days: 2 });
    expect(tail).toMatchObject({
      status: "approved",
      start: dateAt(1),
      end: dateAt(2),
      days: 2,
      outletId: before.outletId,
      decidedBy: before.decidedBy,
      attachmentKey: null,
    });
    expect(sumDays([head, tail])).toBe(4);

    // Exactly one day refunded, the other four days stay used (and approved).
    expect(await balance(staff)).toMatchObject({
      entitled: "12.0000",
      used: "4.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    await expectConsistent(staff, [-2, -1, 1, 2]);

    // Audit trail names the new tail row.
    expect(await auditMentions(tail.id)).toBeGreaterThan(0);
  });

  it("[F25] a leave of three days with the log in the middle leaves two one-day leaves", async () => {
    const { staff, leaveId, log } = await flaggedInside("s4", -1, 1, 3);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.start, row.end, row.days, row.status])).toEqual(
      [
        [dateAt(-1), dateAt(-1), 1, "approved"],
        [dateAt(1), dateAt(1), 1, "approved"],
      ],
    );
    expect(rows.some((row) => row.id === leaveId)).toBe(true);
    expect(await balance(staff)).toMatchObject({ used: "2.0000" });
    await expectConsistent(staff, [-1, 1]);
  });
});

// ---- idempotency --------------------------------------------------------------

describe("[F25] repeating cancel_leave does not refund twice", () => {
  it("[F25] same key replays and a new key is a no-op; leave rows, balance and logs stay as after the first call", async () => {
    const { staff, log } = await flaggedInside("i1", -2, 2, 5);
    const decisionKey = key();

    const first = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const after = await snapshot(staff);
    expect(after.balance.used).toBe("4.0000");
    expect(after.leaves).toHaveLength(2);

    const replay = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(await snapshot(staff)).toEqual(after);

    const again = await review(log.id, { action: "cancel_leave" });
    expect([200, 409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await snapshot(staff)).toEqual(after);
    await expectConsistent(staff, [-2, -1, 1, 2]);
  });
});

// ---- excluded holiday ----------------------------------------------------------

describe("[F25] day D is an excluded holiday of the leave", () => {
  it("[F25] nothing is split, the balance does not move, the log is valid", async () => {
    const staff = await newStaff("h1");
    // Five calendar days, today is an excluded holiday: 4 paid days.
    const leaveId = await seedApprovedLeave(staff, -2, 2, 4, [0]);
    const log = await clockIn(staff);
    expect(await balance(staff)).toMatchObject({ used: "4.0000" });
    const before = (await leavesOf(staff))[0]!;

    // legend-x0avw (F4): an excluded holiday is not a leave day, so the log is
    // not flagged and there is no leave to cancel on it: the decision is refused
    // and nothing changes.
    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED");

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before);
    expect(rows[0]).toMatchObject({ id: leaveId, status: "approved", days: 4 });
    expect(await balance(staff)).toMatchObject({
      entitled: "12.0000",
      used: "4.0000",
      pending: "0.0000",
    });
    // The holiday is not paid as leave, so working it is paid once.
    expect(await validityOf(staff, log.id)).toBe("valid");
  });
});

// ---- one-day leave (control) ---------------------------------------------------

describe("[F25] one-day leave", () => {
  it("[F25] stays cancelled as before: no tail row, balance back by 1", async () => {
    const { staff, leaveId, log } = await flaggedInside("o1", 0, 0, 1);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: leaveId, status: "cancelled" });
    expect(await balance(staff)).toMatchObject({
      used: "0.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    await expectConsistent(staff, []);
  });
});

// ---- permissions ---------------------------------------------------------------

describe("[F25] only HR with hr.leave.approve at the leave's outlet may cancel a leave day", () => {
  async function expectRefused(label: string, client: Client) {
    const { staff, log } = await flaggedInside(label, -2, 2, 5);
    const before = await snapshot(staff);

    const response = await review(log.id, { action: "cancel_leave" }, client);
    expect(response.status, JSON.stringify(response.body)).toBe(403);

    expect(await snapshot(staff)).toEqual(before);
    expect(byStatus(await leavesOf(staff), "approved")).toHaveLength(1);
  }

  it("[F25] HR with hr.attendance.manage but without hr.leave.approve gets 403 and nothing changes", async () => {
    const limited = await signedInClient("HR Tanpa Hak Cuti", { mfa: true });
    await grantRole(
      limited.userId,
      ["hr.attendance.manage", "hr.employee.view"],
      { type: "tenant" },
    );
    await expectRefused("p1", limited.client);
  });

  it("[F25] HR whose hr.leave.approve is only at another outlet gets 403 and nothing changes", async () => {
    const limited = await signedInClient("HR Cuti Outlet Lain", { mfa: true });
    await grantRole(
      limited.userId,
      ["hr.attendance.manage", "hr.employee.view"],
      { type: "tenant" },
    );
    await grantRole(limited.userId, ["hr.leave.approve"], {
      type: "outlet",
      outletIds: [outletB],
    });
    await expectRefused("p2", limited.client);
  });
});

// ---- leave of another outlet ---------------------------------------------------

describe("[F25] leave of another outlet than the clock-in outlet", () => {
  it("[F25] a clock-in at outlet B splits a leave that belongs to home outlet A", async () => {
    const staff = await newStaff("x1");
    const leaveId = await seedApprovedLeave(staff, -2, 2, 5);
    await seedShift(staff, outletB);
    const log = await clockIn(staff);
    expect(log.outletId, "the clock-in is stored at outlet B").toBe(outletB);
    expect(log.validity).toBe("flagged");

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await leavesOf(staff);
    expect(rows).toHaveLength(2);
    const head = rows.find((row) => row.id === leaveId)!;
    const tail = rows.find((row) => row.id !== leaveId)!;
    expect(head).toMatchObject({ start: dateAt(-2), end: dateAt(-1), days: 2 });
    expect(tail).toMatchObject({
      status: "approved",
      start: dateAt(1),
      end: dateAt(2),
      days: 2,
      outletId: outletA,
    });
    expect(await balance(staff)).toMatchObject({
      used: "4.0000",
      pending: "0.0000",
    });
    expect(await validityOf(staff, log.id)).toBe("valid");
    await expectConsistent(staff, [-2, -1, 1, 2]);
  });
});

// ---- two cancels on different days of the same leave ---------------------------

describe("[F25] two cancel_leave on different days of the same leave", () => {
  it("[F25] day 2 then day 4 of a 5-day leave: three pieces, balance back by 2 in total", async () => {
    const staff = await newStaff("t1");
    // Days: -4 (1), -3 (2), -2 (3), -1 (4), 0 (5).
    const leaveId = await seedApprovedLeave(staff, -4, 0, 5);
    const day2 = await insertValidLog(staff, -3);
    const day4 = await insertValidLog(staff, -1);
    expect(await balance(staff)).toMatchObject({ used: "5.0000" });

    const first = await review(await apiIdOf(staff, day2), {
      action: "cancel_leave",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await balance(staff)).toMatchObject({ used: "4.0000" });
    let rows = byStatus(await leavesOf(staff), "approved");
    expect(rows.map((row) => [row.start, row.end, row.days])).toEqual([
      [dateAt(-4), dateAt(-4), 1],
      [dateAt(-2), dateAt(0), 3],
    ]);

    const second = await review(await apiIdOf(staff, day4), {
      action: "cancel_leave",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    rows = byStatus(await leavesOf(staff), "approved");
    expect(rows.map((row) => [row.start, row.end, row.days])).toEqual([
      [dateAt(-4), dateAt(-4), 1],
      [dateAt(-2), dateAt(-2), 1],
      [dateAt(0), dateAt(0), 1],
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.some((row) => row.id === leaveId)).toBe(true);
    expect(sumDays(rows)).toBe(3);
    expect(await balance(staff)).toMatchObject({
      entitled: "12.0000",
      used: "3.0000",
      pending: "0.0000",
    });
    // Both cancelled days are paid once, as work.
    const logs = await dbLogsOf(staff);
    expect(logs.map((item) => [item.businessDate, item.validity])).toEqual([
      [dateAt(-3), "valid"],
      [dateAt(-1), "valid"],
    ]);
    await expectConsistent(staff, [-4, -2, 0]);
  });
});
