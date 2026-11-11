// Fail-first tests for bead legend-9y6ri: clock-in on a day with APPROVED leave.
// Expected behaviour comes from docs/briefs/9y6ri-leave-clockin-flag.md
// (founder W8 Q21) and the shared contract (packages/shared/src/hris), never
// from service code. Same setup as hris-attendance-clock-414.test.ts: real
// Express app, Better Auth, RBAC resolver and PostgreSQL, seeded Cafe Legend
// tenant.
//
// NAMES THE IMPLEMENTER MUST MATCH (the brief leaves them open; change here if
// the contract picks others):
//  - Flag reason: "leave_approved", added to attendanceStoredFlagReasonSchema.
//    The flag is visible on the existing HR review queue
//    (GET /api/hris/attendance/review-queue): item.source "flagged",
//    item.flagReasons contains "leave_approved", item.reviewStatus "pending".
//  - The clock-in itself answers 201 and the stored log is validity "flagged"
//    (not "valid", not "rejected").
//  - HR actions reuse POST /api/hris/attendance/logs/:logId/review with two new
//    `action` values: "keep_leave" and "cancel_leave" (needs
//    hr.attendance.manage; cancel_leave also needs hr.leave.approve).
//      keep_leave:   leave stays approved, balance untouched, flag leaves the
//                    pending state, the log becomes "rejected" (never "valid":
//                    the day is already paid as leave, and payroll skips
//                    rejected logs).
//      cancel_leave: leave request becomes "cancelled", used days go back to
//                    the balance exactly once, flag leaves the pending state,
//                    the log becomes "valid" (the day is now paid as worked).
//    Either action on a log that carries no leave flag answers 409 or 422.
//
// Assumptions:
//  - Payroll counts attendance from logs whose validity is "valid". There is no
//    HTTP surface that exposes payroll day counts, so "no double pay" is proven
//    through that proxy: while HR has not decided, the leave stays approved
//    with unchanged balance AND the employee has zero "valid" logs on the leave
//    day; after cancel_leave the day is paid once (leave gone, log valid).
//  - A leave counts for the clock-in day when it is approved and its
//    start..end range (inclusive) contains the outlet-local (WIB) business date.
//  - Replaying a review decision with the same idempotency key answers the same
//    result (2xx). A second cancel_leave with a NEW key is a no-op or a
//    conflict (200/409/422), never a second balance refund.
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
        `Attendance leave flag ${roleId.slice(0, 8)}`,
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
const key = () => `att-lf-${randomUUID()}`;
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
        `LF-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-absen ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Absen', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LF-${id.slice(0, 8).toUpperCase()}`,
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

let hr: Client;
let hrUserId: string;
let leaveTypeId: string;
let plainStaffUserId: string;

beforeAll(async () => {
  const admin = await signedInClient("HR Absen Cuti", { mfa: true });
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
    code: `LFLAG_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji absen",
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

  plainStaffUserId = (await signedInClient("Staf Tanpa Hak HR")).userId;
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-lf-%'",
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

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  today: string;
  /** Inserts a leave request (and the balance that backs it) for this employee. */
  seedLeave(input: {
    status: LeaveStatus;
    startOffsetDays: number;
    endOffsetDays: number;
    days: number;
  }): Promise<string>;
}

/**
 * A fresh outlet (own review queue), a staff member allowed to clock there, and
 * a leave balance of 12 days with nothing used.
 */
async function newScenario(label: string): Promise<Scenario> {
  await avoidOutletMidnight();
  const outletId = await seedOutlet(label);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: noSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Cuti Absen ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", outletIds: [outletId] },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);
  const today = wibDate(Date.now());
  const year = Number(today.slice(0, 4));

  await asTenant((client) =>
    client.query(
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
    today,
    async seedLeave({ status, startOffsetDays, endOffsetDays, days }) {
      const start = wibDate(Date.now() + startOffsetDays * DAY);
      const end = wibDate(Date.now() + endOffsetDays * DAY);
      const id = randomUUID();
      await asTenant(async (client) => {
        await client.query(
          `INSERT INTO leave_requests
             (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
              start_date, end_date, days, excluded_holiday_dates, status,
              requested_by, requested_at, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::date[], $10, $11,
                   clock_timestamp(), $12, $13)`,
          [
            id,
            tenant.id,
            outletId,
            employeeId,
            leaveTypeId,
            year,
            start,
            end,
            String(days),
            status,
            staffSession.userId,
            status === "pending" ? null : hrUserId,
            status === "pending" ? null : new Date(),
          ],
        );
        if (status === "approved")
          await client.query(
            `UPDATE leave_balances SET used_days = used_days + $1
              WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
            [String(days), tenant.id, employeeId, leaveTypeId, year],
          );
        if (status === "pending")
          await client.query(
            `UPDATE leave_balances SET pending_days = pending_days + $1
              WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
            [String(days), tenant.id, employeeId, leaveTypeId, year],
          );
      });
      return id;
    },
  };
}

function clockInBody() {
  return {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...CENTER, accuracyM: 5 },
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
  };
}

async function clockIn(scenario: Scenario) {
  const response = await post(
    scenario.staff,
    "/api/hris/attendance/clock",
    clockInBody(),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; validity: string };
}

interface QueueItem {
  log: { id: string; validity: string; employeeId: string };
  source: string;
  flagReasons: string[];
  reviewStatus: string;
}

async function queueOf(scenario: Scenario, extra = ""): Promise<QueueItem[]> {
  const response = await hr.get(
    `/api/hris/attendance/review-queue?outletId=${scenario.outletId}${extra}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as QueueItem[];
}

async function queueEntry(scenario: Scenario, logId: string) {
  return (await queueOf(scenario)).find((item) => item.log.id === logId);
}

async function balance(scenario: Scenario) {
  const response = await hr.get(
    `/api/hris/leave/balances?employeeId=${scenario.employeeId}&year=${scenario.today.slice(0, 4)}`,
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

async function leaveStatus(scenario: Scenario, leaveId: string) {
  const response = await hr.get(
    `/api/hris/leave/requests?employeeId=${scenario.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (
    response.body.data as { id: string; status: string }[]
  ).find((entry) => entry.id === leaveId)?.status;
}

async function logsOf(scenario: Scenario) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${scenario.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; validity: string }[];
}

const review = (logId: string, body: Record<string, unknown>, client = hr) =>
  post(client, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

// ---- (a) + (g): clock-in on an approved leave day ---------------------------

describe("[F25] clock-in on a day with approved leave", () => {
  it("[F25] succeeds and the log is flagged for HR review with reason leave_approved", async () => {
    const s = await newScenario("a1");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });

    const log = await clockIn(s);
    expect(log.validity).toBe("flagged");

    const item = await queueEntry(s, log.id);
    expect(item, "flagged log must be in the HR review queue").toBeDefined();
    expect(item).toMatchObject({ source: "flagged", reviewStatus: "pending" });
    expect(item?.flagReasons).toContain("leave_approved");
  });

  it("[F25] a multi-day approved leave that contains today flags the clock-in too", async () => {
    const s = await newScenario("a2");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 3,
    });

    const log = await clockIn(s);
    const item = await queueEntry(s, log.id);
    expect(item?.flagReasons).toContain("leave_approved");
  });

  it("[F25] (g) the HR review queue lists the flag and reason, filtered by pending status", async () => {
    const s = await newScenario("g1");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);

    const pending = await queueOf(s, "&reviewStatus=pending");
    const found = pending.find((item) => item.log.id === log.id);
    expect(found?.flagReasons).toContain("leave_approved");
    expect(found?.log.employeeId).toBe(s.employeeId);
  });
});

// ---- (b) + (e): leave and payroll stay untouched until HR decides ------------

describe("[F25] leave and pay stay unchanged until HR decides", () => {
  it("[F25] the leave stays approved and the balance does not change after the clock-in", async () => {
    const s = await newScenario("b1");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const before = await balance(s);
    expect(before).toMatchObject({ entitled: "12.0000", used: "1.0000" });

    const log = await clockIn(s);
    // Guard: the flag exists, otherwise "nothing changed" proves nothing.
    expect((await queueEntry(s, log.id))?.flagReasons).toContain(
      "leave_approved",
    );

    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect(await balance(s)).toEqual(before);
  });

  it("[F25] no double pay: while HR has not decided, the leave day is paid once (leave), the clock-in counts for nothing", async () => {
    const s = await newScenario("e1");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);

    // Paid leave still approved with its day used ...
    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect((await balance(s)).used).toBe("1.0000");
    // ... and the clock-in is not a countable ("valid") attendance log.
    const valid = (await logsOf(s)).filter((item) => item.validity === "valid");
    expect(valid).toEqual([]);
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "flagged",
    );
  });

  it("[F25] no double pay: keep_leave leaves the day paid as leave only", async () => {
    const s = await newScenario("e2");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);

    const kept = await review(log.id, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);

    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect((await balance(s)).used).toBe("1.0000");
    const valid = (await logsOf(s)).filter((item) => item.validity === "valid");
    expect(valid).toEqual([]);
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "rejected",
    );
  });

  it("[F25] no double pay: cancel_leave pays the day once, as work", async () => {
    const s = await newScenario("e3");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    expect(await leaveStatus(s, leaveId)).toBe("cancelled");
    expect((await balance(s)).used).toBe("0.0000");
    const valid = (await logsOf(s)).filter((item) => item.validity === "valid");
    expect(valid.map((item) => item.id)).toEqual([log.id]);
  });
});

// ---- (c) + (d): no flag without an approved leave on that day ----------------

describe("[F25] no leave flag without an approved leave on the day", () => {
  it("[F25] (c) a normal day clocks in valid with no leave flag", async () => {
    const s = await newScenario("c1");
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(s, log.id)).toBeUndefined();
  });

  it("[F25] (c) approved leave on another day does not flag today's clock-in", async () => {
    const s = await newScenario("c2");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 1,
      endOffsetDays: 2,
      days: 2,
    });
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -3,
      endOffsetDays: -2,
      days: 2,
    });
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(s, log.id)).toBeUndefined();
  });

  it("[F25] (d) a pending leave on the day does not flag the clock-in", async () => {
    const s = await newScenario("d1");
    await s.seedLeave({
      status: "pending",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(s, log.id)).toBeUndefined();
  });

  it("[F25] (d) a rejected leave on the day does not flag the clock-in", async () => {
    const s = await newScenario("d2");
    await s.seedLeave({
      status: "rejected",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(s, log.id)).toBeUndefined();
  });

  it("[F25] (d) a cancelled leave on the day does not flag the clock-in", async () => {
    const s = await newScenario("d3");
    await s.seedLeave({
      status: "cancelled",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect(await queueEntry(s, log.id)).toBeUndefined();
  });
});

// ---- (f): HR actions ---------------------------------------------------------

describe("[F25] HR decides a leave-flagged clock-in", () => {
  it("[F25] keep_leave: flag is resolved, leave stays approved, balance unchanged", async () => {
    const s = await newScenario("f1");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);
    const before = await balance(s);

    const kept = await review(log.id, {
      action: "keep_leave",
      note: "Cuti tetap, absen salah tekan",
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.data.log.id).toBe(log.id);
    expect(kept.body.data.reviewStatus).not.toBe("pending");
    expect(kept.body.data.reviewedBy).toBe(hrUserId);
    expect(kept.body.data.reviewedAt).not.toBeNull();

    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect(await balance(s)).toEqual(before);
    expect(await queueOf(s, "&reviewStatus=pending")).toEqual([]);
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "rejected",
    );
  });

  it("[F25] cancel_leave: leave is cancelled, balance returns once, flag is resolved", async () => {
    const s = await newScenario("f2");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);
    expect(await balance(s)).toMatchObject({ used: "1.0000" });

    const cancelled = await review(log.id, {
      action: "cancel_leave",
      note: "Karyawan masuk kerja",
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reviewStatus).not.toBe("pending");
    expect(cancelled.body.data.log.validity).toBe("valid");

    expect(await leaveStatus(s, leaveId)).toBe("cancelled");
    expect(await balance(s)).toMatchObject({
      entitled: "12.0000",
      used: "0.0000",
      pending: "0.0000",
    });
    expect(await queueOf(s, "&reviewStatus=pending")).toEqual([]);
  });

  it("[F25] cancel_leave is idempotent: same key replays, a new key never refunds twice", async () => {
    const s = await newScenario("f3");
    // One approved day plus an unrelated one: a double refund would show as used = 0 instead of 1.
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    // A second, unrelated approved day that must stay used.
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 5,
      endOffsetDays: 5,
      days: 1,
    });
    const log = await clockIn(s);
    expect(await balance(s)).toMatchObject({ used: "2.0000" });

    const decisionKey = key();
    const first = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await balance(s)).toMatchObject({ used: "1.0000" });

    const replay = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(await balance(s)).toMatchObject({ used: "1.0000" });

    const again = await review(log.id, { action: "cancel_leave" });
    expect([200, 409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await leaveStatus(s, leaveId)).toBe("cancelled");
    expect(await balance(s)).toMatchObject({ used: "1.0000", pending: "0.0000" });
  });

  it("[F25] keep_leave and cancel_leave are refused (409 or 422) on a log with no leave flag", async () => {
    const s = await newScenario("f4");
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");

    for (const action of ["keep_leave", "cancel_leave"]) {
      const response = await review(log.id, { action });
      expect([409, 422], `${action}: ${JSON.stringify(response.body)}`).toContain(
        response.status,
      );
    }
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "valid",
    );
  });

  it("[F25] a valid log (no flag) whose leave was approved later: accept is 409, cancel_leave is 200 for a one-day leave", async () => {
    const s = await newScenario("f6");
    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    expect((await queueEntry(s, log.id))?.flagReasons ?? []).not.toContain(
      "leave_approved",
    );
    // The leave is approved after the clock-in: nothing flagged the log.
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });

    const accepted = await review(log.id, { action: "accept" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(409);
    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect((await balance(s)).used).toBe("1.0000");

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await leaveStatus(s, leaveId)).toBe("cancelled");
    expect((await balance(s)).used).toBe("0.0000");
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "valid",
    );
  });

  it("[F25] a valid log (no flag) whose leave was approved later: keep_leave rejects the log and the leave stays", async () => {
    const s = await newScenario("f7");
    const log = await clockIn(s);
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });

    const kept = await review(log.id, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect((await balance(s)).used).toBe("1.0000");
    expect((await logsOf(s)).find((item) => item.id === log.id)?.validity).toBe(
      "rejected",
    );
  });

  it("[F25] only HR may decide: the employee and an unprivileged user get 403, anonymous 401, and nothing changes", async () => {
    const s = await newScenario("f5");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });
    const log = await clockIn(s);

    const other = agent(app);
    const email = await signUp(other, "Staf Tanpa Akses Review");
    expect(email).toBeTruthy();
    for (const action of ["keep_leave", "cancel_leave"]) {
      expect((await review(log.id, { action }, s.staff)).status, action).toBe(
        403,
      );
      expect((await review(log.id, { action }, other)).status, action).toBe(
        403,
      );
      expect((await review(log.id, { action }, agent(app))).status, action).toBe(
        401,
      );
    }
    expect(plainStaffUserId).toBeTruthy();
    expect(await leaveStatus(s, leaveId)).toBe("approved");
    expect((await balance(s)).used).toBe("1.0000");
    expect((await queueEntry(s, log.id))?.reviewStatus).toBe("pending");
  });
});
