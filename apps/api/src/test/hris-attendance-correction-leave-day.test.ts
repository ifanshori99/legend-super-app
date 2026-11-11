// Fail-first tests for bead legend-em8y2: an APPROVED manual attendance
// correction is refused on a day that has an approved leave. Expected behaviour
// comes from docs/briefs/5nt2z-leave-partial.md (card em8y2, money rule "no day
// paid twice, when in doubt the stricter outcome wins") and the shared contract
// (packages/shared/src/hris/attendance.ts), never from service code. Setup
// mirrors hris-attendance-correction.test.ts: real Express app, Better Auth,
// RBAC and PostgreSQL against the seeded Cafe Legend tenant.
//
// EXPECTED ERROR: HTTP 409 on the decision endpoint
// (POST /api/hris/attendance/corrections/:id/decision, action "approve") with
// body.error.code === "ATTENDANCE_CORRECTION_LEAVE_DAY". The brief only says
// "409 with a clear code"; this is the one name chosen here. If the engineer
// picks another code, change LEAVE_DAY_CODE below, nothing else.
//
// Assumptions (the brief leaves these open):
//  - FILING a correction on a leave day is allowed (201/200, status pending);
//    only the APPROVAL is refused. A refused approval leaves no manual log; the
//    correction is not "approved" afterwards (pending or rejected both fit).
//  - "Approved leave on the day" = leave_requests row with status approved whose
//    start_date..end_date (inclusive) contains the business date of the
//    requested instant (middayUtc is the same calendar day in WIB).
//  - Leave detection spans outlets: the leave row belongs to the employee's HOME
//    outlet (A); a correction filed and approved at outlet B (the approver only
//    holds outlet_manager at A and B, not tenant-wide) is still refused.
//  - A correction of any type (in/out/break_start/break_end) is refused the
//    same way. Success on a non-leave day is only asserted for type "in": other
//    types could be refused for unrelated sequencing reasons the spec does not
//    define.
//  - The approver holds the template role outlet_manager at both outlets, as
//    in hris-attendance-correction.test.ts; the employee files with
//    self.attendance.clock at both outlets.
//  - Leave balances are read through GET /api/hris/leave/balances; seeded
//    approved leave already counts in used_days, pending in pending_days.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const LEAVE_DAY_CODE = "ATTENDANCE_CORRECTION_LEAVE_DAY";

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
const KEY_PREFIX = "att-corr-leave-";
let insertedApprovalPolicy = false;
let leaveTypeId = "";

async function ownerTx<T>(
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
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
type Actor = { client: Client; userId: string };

async function signedInClient(
  name: string,
  options: { mfa?: boolean } = {},
): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function assignRole(
  userId: string,
  roleId: string,
  scopeId: string | null,
) {
  await ownerTx((db) =>
    db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, scopeId ? "outlet" : "tenant", scopeId],
    ),
  );
}

/** A custom role with `permissions`, assigned tenant-wide or at each outlet. */
async function grantCustomRole(
  userId: string,
  permissions: string[],
  outletIds: string[] | "tenant",
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Corr leave day ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([outletIds === "tenant" ? "tenant" : "outlet"]),
      ],
    ),
  );
  if (outletIds === "tenant") await assignRole(userId, roleId, null);
  else for (const id of outletIds) await assignRole(userId, roleId, id);
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

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Koreksi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `CL-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet koreksi-cuti ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    ),
  );
  return id;
}

const key = () => `${KEY_PREFIX}${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

const dayStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
// Midday UTC is the same calendar day in every Indonesian time zone.
const middayUtc = (day: string) => `${day}T05:00:00.000Z`;

// Response bodies are untyped JSON in these HTTP-level tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRow = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

async function collect(client: Client, path: string) {
  const items: JsonRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: JsonBody = await client.get(
      `${path}${separator}limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    items.push(...response.body.data);
    cursor = response.body.meta.nextCursor;
    if (!cursor) break;
  }
  return items;
}

// ---- fixtures ---------------------------------------------------------------

let hr: Actor; // tenant-wide reader: logs, leave requests, balances
let manager: Actor; // outlet_manager template at outlets A and B
let outletA = ""; // home outlet of every test employee
let outletB = ""; // "other" outlet

const STAFF_PERMISSIONS = ["self.profile.view", "self.attendance.clock"];

beforeAll(async () => {
  const managerRole = await templateRoleId("outlet_manager");
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRole],
  );
  insertedApprovalPolicy = (inserted.rowCount ?? 0) > 0;

  outletA = await seedOutlet("A");
  outletB = await seedOutlet("B");

  hr = await signedInClient("HR Koreksi Cuti", { mfa: true });
  await grantCustomRole(
    hr.userId,
    [
      "hr.attendance.manage",
      "hr.leave.approve",
      "hr.employee.manage",
      "hr.employee.view",
    ],
    "tenant",
  );
  manager = await signedInClient("Manajer Koreksi Cuti", { mfa: true });
  await assignRole(manager.userId, managerRole, outletA);
  await assignRole(manager.userId, managerRole, outletB);

  const type = await post(hr.client, "/api/hris/leave/types", {
    code: `CLD_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji koreksi",
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
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await step(() =>
      // Audit, outbox and log rows are protected by triggers; replica mode lets
      // the owner remove the rows that name our fixtures.
      ownerTx(
        async (db) => {
          await db.query(
            "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2",
            [tenant.id, leaveTypeId],
          );
          await db.query(
            "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
            [tenant.id, `${KEY_PREFIX}%`],
          );
          await db.query(
            "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
            [tenant.id, createdUsers],
          );
          await db.query(
            `DELETE FROM domain_event_outbox
              WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
            [tenant.id, createdEmployees],
          );
          await db.query(
            `DELETE FROM audit_logs
              WHERE tenant_id = $1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS e(id)
                             WHERE audit_logs.event::text LIKE '%' || e.id || '%')`,
            [tenant.id, createdEmployees],
          );
          if (insertedApprovalPolicy)
            await db.query(
              "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
              [tenant.id],
            );
          await db.query(
            "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
            [tenant.id, createdUsers],
          );
          await db.query(
            "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [tenant.id, createdRoles],
          );
          // Outlets stay: audit_logs is append-only and references them
          // (disposable DB).
        },
        { replica: true },
      ),
    );
    await step(() =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        createdUsers,
      ]),
    );
  } finally {
    await step(() => owner.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

// ---- scenario helpers -------------------------------------------------------

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

interface Scenario {
  employeeId: string;
  staff: Actor;
  /** Seeds a leave of the employee at its home outlet A; days ago, inclusive. */
  seedLeave(input: {
    status: LeaveStatus;
    startDaysAgo: number;
    endDaysAgo: number;
    days: number;
  }): Promise<string>;
}

/** Fresh employee (home outlet A) with a 12-day balance in the relevant years. */
async function newScenario(label: string): Promise<Scenario> {
  const staff = await signedInClient(`Pemohon Koreksi Cuti ${label}`);
  await grantCustomRole(staff.userId, STAFF_PERMISSIONS, [outletA, outletB]);
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Koreksi Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        staff.userId,
        `CL-${employeeId.slice(0, 8).toUpperCase()}`,
        outletA,
      ],
    ),
  );
  // Balances for the calendar years the used days (0..30 days ago) can fall in.
  const years = new Set(
    [dayStr(0), dayStr(30)].map((d) => Number(d.slice(0, 4))),
  );
  await ownerTx(async (db) => {
    for (const year of years)
      await db.query(
        `INSERT INTO leave_balances
           (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
         VALUES ($1, $2, $3, $4, '12')`,
        [tenant.id, employeeId, leaveTypeId, year],
      );
  });

  return {
    employeeId,
    staff,
    async seedLeave({ status, startDaysAgo, endDaysAgo, days }) {
      const start = dayStr(startDaysAgo);
      const end = dayStr(endDaysAgo);
      const year = Number(start.slice(0, 4));
      const id = randomUUID();
      await ownerTx(async (db) => {
        await db.query(
          `INSERT INTO leave_requests
             (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
              start_date, end_date, days, excluded_holiday_dates, status,
              requested_by, requested_at, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::date[], $10, $11,
                   clock_timestamp(), $12, $13)`,
          [
            id,
            tenant.id,
            outletA,
            employeeId,
            leaveTypeId,
            year,
            start,
            end,
            String(days),
            status,
            staff.userId,
            status === "pending" ? null : hr.userId,
            status === "pending" ? null : new Date(),
          ],
        );
        if (status === "approved")
          await db.query(
            `UPDATE leave_balances SET used_days = used_days + $1
              WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
            [String(days), tenant.id, employeeId, leaveTypeId, year],
          );
        if (status === "pending")
          await db.query(
            `UPDATE leave_balances SET pending_days = pending_days + $1
              WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
            [String(days), tenant.id, employeeId, leaveTypeId, year],
          );
      });
      return id;
    },
  };
}

/** Files a correction as the employee; filing must succeed (assumption above). */
async function requestCorrection(
  s: Scenario,
  day: string,
  options: { outletId?: string; type?: string } = {},
) {
  const response = await post(
    s.staff.client,
    "/api/hris/attendance/corrections",
    {
      outletId: options.outletId ?? outletA,
      attendanceLogId: null,
      requestedType: options.type ?? "in",
      requestedOccurredAt: middayUtc(day),
      reason: "Lupa absen, mesin tidak terbaca",
      idempotencyKey: key(),
    },
  );
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data as JsonRow;
}

const approve = (correctionId: string) =>
  post(
    manager.client,
    `/api/hris/attendance/corrections/${correctionId}/decision`,
    {
      action: "approve",
      note: "Diperiksa penyelia",
      idempotencyKey: key(),
    },
  );

/** File then approve; returns the approval response. */
async function fileAndApprove(
  s: Scenario,
  day: string,
  options: { outletId?: string; type?: string } = {},
) {
  const correction = await requestCorrection(s, day, options);
  const response = await approve(correction.id);
  return { correction, response };
}

async function manualLogs(s: Scenario) {
  const logs = await collect(
    hr.client,
    `/api/hris/attendance/logs?employeeId=${s.employeeId}`,
  );
  return logs.filter((log) => log.method === "manual_correction");
}

async function manualLogsOn(s: Scenario, day: string) {
  return (await manualLogs(s)).filter(
    (log) => Date.parse(log.occurredAt) === Date.parse(middayUtc(day)),
  );
}

async function correctionStatus(s: Scenario, correctionId: string) {
  const corrections = await collect(
    hr.client,
    `/api/hris/attendance/corrections?employeeId=${s.employeeId}`,
  );
  return corrections.find((item) => item.id === correctionId)?.status;
}

async function leaveRows(s: Scenario) {
  const response = await hr.client.get(
    `/api/hris/leave/requests?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { id: string; status: string }[])
    .map((row) => ({ id: row.id, status: row.status }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function balances(s: Scenario) {
  const out: Record<string, { used: string; pending: string }> = {};
  const years = new Set([dayStr(0), dayStr(30)].map((d) => d.slice(0, 4)));
  for (const year of years) {
    const response = await hr.client.get(
      `/api/hris/leave/balances?employeeId=${s.employeeId}&year=${year}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const row = (
      response.body.data as {
        leaveTypeId: string;
        usedDays: string;
        pendingDays: string;
      }[]
    ).find((entry) => entry.leaveTypeId === leaveTypeId);
    out[year] = {
      used: row?.usedDays ?? "none",
      pending: row?.pendingDays ?? "none",
    };
  }
  return out;
}

/** The decision answered 409 with the leave-day code and wrote nothing. */
async function expectRefusedOnLeaveDay(
  s: Scenario,
  correction: JsonRow,
  response: JsonBody,
  day: string,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error?.code, JSON.stringify(response.body)).toBe(
    LEAVE_DAY_CODE,
  );
  expect(await manualLogsOn(s, day)).toHaveLength(0);
  expect(await correctionStatus(s, correction.id)).not.toBe("approved");
}

// ---- tests ------------------------------------------------------------------

describe("hris.attendance.correction on a day with approved leave", () => {
  it("[em8y2] refuses approval on an approved leave day: 409, no log, leave and balance untouched", async () => {
    const s = await newScenario("a1");
    const day = dayStr(5);
    const leaveId = await s.seedLeave({
      status: "approved",
      startDaysAgo: 5,
      endDaysAgo: 5,
      days: 1,
    });
    const leavesBefore = await leaveRows(s);
    const balanceBefore = await balances(s);
    // Guard: the seeded leave is really approved and counted, else "untouched"
    // proves nothing.
    expect(leavesBefore).toEqual([{ id: leaveId, status: "approved" }]);
    expect(Object.values(balanceBefore).some((b) => b.used === "1.0000")).toBe(
      true,
    );

    const { correction, response } = await fileAndApprove(s, day);
    expect(correction.status).toBe("pending");
    await expectRefusedOnLeaveDay(s, correction, response, day);

    expect(await manualLogs(s)).toHaveLength(0);
    expect(await leaveRows(s)).toEqual(leavesBefore);
    expect(await balances(s)).toEqual(balanceBefore);
  });

  it("[em8y2] a retry of the refused approval stays refused and still writes nothing", async () => {
    const s = await newScenario("a2");
    const day = dayStr(6);
    await s.seedLeave({
      status: "approved",
      startDaysAgo: 6,
      endDaysAgo: 6,
      days: 1,
    });
    const { correction, response } = await fileAndApprove(s, day);
    await expectRefusedOnLeaveDay(s, correction, response, day);

    const retry = await approve(correction.id);
    await expectRefusedOnLeaveDay(s, correction, retry, day);
    expect(await manualLogs(s)).toHaveLength(0);
  });

  it("[em8y2] a day without leave is approved as usual: one valid manual log", async () => {
    const s = await newScenario("b1");
    const day = dayStr(7);
    const { correction, response } = await fileAndApprove(s, day);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("approved");
    const logs = await manualLogsOn(s, day);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      employeeId: s.employeeId,
      type: "in",
      method: "manual_correction",
      validity: "valid",
    });
    expect(await correctionStatus(s, correction.id)).toBe("approved");
  });

  it("[em8y2] an approved leave on another day does not block the correction", async () => {
    const s = await newScenario("b2");
    await s.seedLeave({
      status: "approved",
      startDaysAgo: 9,
      endDaysAgo: 8,
      days: 2,
    });
    await s.seedLeave({
      status: "approved",
      startDaysAgo: 4,
      endDaysAgo: 3,
      days: 2,
    });
    const day = dayStr(6); // between the two leaves
    const { response } = await fileAndApprove(s, day);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await manualLogsOn(s, day)).toHaveLength(1);
  });

  for (const status of ["pending", "rejected", "cancelled"] as const) {
    it(`[em8y2] a ${status} leave on the day does not block the correction`, async () => {
      const s = await newScenario(`c-${status}`);
      const day = dayStr(10);
      const leaveId = await s.seedLeave({
        status,
        startDaysAgo: 10,
        endDaysAgo: 10,
        days: 1,
      });
      const balanceBefore = await balances(s);

      const { response } = await fileAndApprove(s, day);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("approved");
      expect(await manualLogsOn(s, day)).toHaveLength(1);
      // The correction never touches the leave itself.
      expect(await leaveRows(s)).toEqual([{ id: leaveId, status }]);
      expect(await balances(s)).toEqual(balanceBefore);
    });
  }

  // A correction at an outlet other than the employee's home outlet cannot be
  // filed at all (422 "Outlet harus outlet utama karyawan"), so a cross-outlet
  // correction on a leave day is unreachable; cross-outlet leave detection is
  // covered by hris-attendance-leave-flag-outlet.test.ts.

  it("[em8y2] a multi-day leave refuses only the days inside its range", async () => {
    const s = await newScenario("e1");
    // Leave covers 14, 13 and 12 days ago (inclusive).
    await s.seedLeave({
      status: "approved",
      startDaysAgo: 14,
      endDaysAgo: 12,
      days: 3,
    });
    const balanceBefore = await balances(s);

    // Inside the range, including both edge days: refused.
    for (const ago of [14, 13, 12]) {
      const day = dayStr(ago);
      const { correction, response } = await fileAndApprove(s, day);
      await expectRefusedOnLeaveDay(s, correction, response, day);
    }
    // The day before the start and the day after the end: approved.
    for (const ago of [15, 11]) {
      const day = dayStr(ago);
      const { response } = await fileAndApprove(s, day);
      expect(response.status, `${ago}: ${JSON.stringify(response.body)}`).toBe(
        200,
      );
      expect(await manualLogsOn(s, day)).toHaveLength(1);
    }
    expect(await manualLogs(s)).toHaveLength(2);
    expect(await balances(s)).toEqual(balanceBefore);
  });

  it("[em8y2] every correction type is refused on an approved leave day", async () => {
    const s = await newScenario("f1");
    const day = dayStr(16);
    await s.seedLeave({
      status: "approved",
      startDaysAgo: 16,
      endDaysAgo: 16,
      days: 1,
    });
    for (const type of ["in", "out", "break_start", "break_end"]) {
      const { correction, response } = await fileAndApprove(s, day, { type });
      expect(correction.requestedType).toBe(type);
      await expectRefusedOnLeaveDay(s, correction, response, day);
    }
    expect(await manualLogs(s)).toHaveLength(0);
  });
});
