// Fail-first tests for bead legend-7o3hd (founder W8): a clock-in that already
// exists when a leave is APPROVED afterwards. Expected behaviour comes from
// docs/briefs/5nt2z-leave-partial.md (card 7o3hd) and the shared contract
// (packages/shared/src/hris), never from service code. This is the mirror of
// hris-attendance-leave-flag.test.ts (clock-in AFTER approval): there the log
// is flagged at clock time, here it is flagged when HR/the manager approves
// the leave through the leave API (POST /api/hris/leave/requests/:id/decision).
// Setup follows hris-leave-api.test.ts (approval matrix row for "leave" =
// outlet manager, one level) and hris-attendance-leave-flag*.test.ts.
//
// NAMES USED (same as the 9y6ri tests; change here if the contract picks others):
//  - Flag reason "leave_approved" in item.flagReasons of
//    GET /api/hris/attendance/review-queue (item.source "flagged",
//    item.reviewStatus "pending"); the stored log validity becomes "flagged".
//  - HR actions on POST /api/hris/attendance/logs/:logId/review:
//    "accept" (409 on a leave-flagged log), "keep_leave", "cancel_leave".
//
// Assumptions:
//  - The leave is requested through the real API (staff POST
//    /api/hris/leave/requests) for today or a past date; the server computes
//    `days`, so balance assertions use the `days` returned by the request and
//    never a hard-coded count. A past-date request is accepted (brief: "Cuti
//    bisa diajukan untuk tanggal lalu").
//  - The log's date is its business date (outlet-local, WIB); a shift with
//    business date yesterday puts a clock-in made now on yesterday (same
//    technique as hris-attendance-leave-flag-outlet.test.ts).
//  - "Review already decided" = HR accepted a flagged log (outside geofence,
//    policy action "flag"); "rejected log" = HR rejected a valid log. An
//    accepted log is reopened (pending, reviewer cleared) when the leave is
//    approved later, so the day is not paid twice; a rejected log is never
//    touched.
//  - A log that is already flagged and pending for another reason keeps that
//    reason and gains "leave_approved" (the brief says valid OR flagged).
//  - Replaying the approval decision with the same key answers 200; a second
//    approval with a new key answers 409 (existing leave API behavior).
//  - Tests run in the current year; a request that would cross 1 January is
//    out of scope (leave API refuses cross-year requests).
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
let savedPolicies: Record<string, unknown>[] = [];

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
        `Leave approve flag ${roleId.slice(0, 8)}`,
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
/** About 1.1 km north of the outlet: outside the 100 m geofence. */
const FAR = { latitude: -6.19, longitude: 106.8 };
const key = () => `att-lfa-${randomUUID()}`;
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
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `LA-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-setuju ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Disetujui', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LA-${id.slice(0, 8).toUpperCase()}`,
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
let leaveTypeId: string;

beforeAll(async () => {
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
    [tenant.id, await templateRoleId("outlet_manager")],
  );

  const admin = await signedInClient("HR Cuti Disetujui", { mfa: true });
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
    code: `LAPR_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji setuju-absen",
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
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-lfa-%'",
      [tenant.id],
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
});

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  manager: Client;
  today: string;
  year: number;
}

/**
 * A fresh outlet (own review queue) with the given geofence action, an employee
 * who may clock there with a leave balance of 12 days, and an outlet manager
 * who is the leave approver for that outlet.
 */
async function newScenario(
  label: string,
  outsideGeofenceAction: "reject" | "flag" = "reject",
): Promise<Scenario> {
  await avoidOutletMidnight();
  const outletId = await seedOutlet(label);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: { ...basePolicy, outsideGeofenceAction },
    sampling: noSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Cuti Setuju ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  const managerSession = await signedInClient(`Manajer Cuti Setuju ${label}`, {
    mfa: true,
  });
  const managerRoleId = await templateRoleId("outlet_manager");
  await asTenant((db) =>
    assign(db, managerSession.userId, managerRoleId, {
      type: "outlet",
      id: outletId,
    }),
  );

  const today = wibDate(Date.now());
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
  };
}

/** A published shift at `outletId` covering "now", with the given business date. */
async function seedShift(s: Scenario, outletId: string, businessDate: string) {
  await asTenant((db) =>
    db.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        randomUUID(),
        tenant.id,
        outletId,
        s.employeeId,
        businessDate,
        JSON.stringify([
          {
            startsAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
            endsAt: new Date(Date.now() + 8 * 60 * MINUTE).toISOString(),
          },
        ]),
        createdUsers[0],
      ],
    ),
  );
}

interface Log {
  id: string;
  type: string;
  outletId: string;
  validity: string;
}

async function clock(
  s: Scenario,
  type: "in" | "out" | "break_start" | "break_end",
  location = CENTER,
): Promise<Log> {
  const response = await post(s.staff, "/api/hris/attendance/clock", {
    type,
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...location, accuracyM: 5 },
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
  });
  expect(response.status, `${type}: ${JSON.stringify(response.body)}`).toBe(
    201,
  );
  return response.body.data as Log;
}

/** Staff requests leave; start..end are offsets in days from today (WIB). */
async function requestLeave(
  s: Scenario,
  startOffsetDays: number,
  endOffsetDays: number,
) {
  const response = await post(s.staff, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: wibDate(Date.now() + startOffsetDays * DAY),
    endDate: wibDate(Date.now() + endOffsetDays * DAY),
    reason: "Cuti uji persetujuan",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return {
    id: response.body.data.id as string,
    days: response.body.data.days as string,
  };
}

const decide = (
  s: Scenario,
  leaveId: string,
  action: "approve" | "reject",
  idempotencyKey = key(),
) =>
  post(s.manager, `/api/hris/leave/requests/${leaveId}/decision`, {
    action,
    idempotencyKey,
  });

async function approve(s: Scenario, leaveId: string) {
  const response = await decide(s, leaveId, "approve");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("approved");
}

interface QueueItem {
  log: { id: string; validity: string; employeeId: string; outletId: string };
  source: string;
  flagReasons: string[];
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

async function queueOf(outletId: string, extra = ""): Promise<QueueItem[]> {
  const response = await hr.get(
    `/api/hris/attendance/review-queue?outletId=${outletId}${extra}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as QueueItem[];
}

async function queueEntries(outletId: string, logId: string) {
  return (await queueOf(outletId)).filter((item) => item.log.id === logId);
}

async function balance(s: Scenario) {
  const response = await hr.get(
    `/api/hris/leave/balances?employeeId=${s.employeeId}&year=${s.year}`,
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

async function leaveStatus(s: Scenario, leaveId: string) {
  const response = await hr.get(
    `/api/hris/leave/requests?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { id: string; status: string }[]).find(
    (entry) => entry.id === leaveId,
  )?.status;
}

async function logsOf(s: Scenario) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Log[];
}

async function validityOf(s: Scenario, logId: string) {
  return (await logsOf(s)).find((item) => item.id === logId)?.validity;
}

const review = (logId: string, body: Record<string, unknown>) =>
  post(hr, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

/** The log is flagged, pending, and carries the leave reason exactly once. */
async function expectLeaveFlagged(s: Scenario, log: Log) {
  expect(await validityOf(s, log.id)).toBe("flagged");
  const entries = await queueEntries(log.outletId, log.id);
  expect(entries, "exactly one queue entry for the log").toHaveLength(1);
  expect(entries[0]).toMatchObject({
    source: "flagged",
    reviewStatus: "pending",
  });
  expect(entries[0]?.flagReasons).toContain("leave_approved");
  expect(
    entries[0]?.flagReasons.filter((reason) => reason === "leave_approved"),
  ).toHaveLength(1);
  expect(entries[0]?.log.employeeId).toBe(s.employeeId);
}

/** The log was not touched by the approval. */
async function expectNotFlaggedByLeave(
  s: Scenario,
  log: Log,
  validity: string,
) {
  expect(await validityOf(s, log.id)).toBe(validity);
  for (const entry of await queueEntries(log.outletId, log.id))
    expect(entry.flagReasons).not.toContain("leave_approved");
}

// ---- main flow --------------------------------------------------------------

describe("[F25] approving a leave flags the existing clock-in", () => {
  it("[F25] a valid clock-in today becomes flagged, pending, with reason leave_approved, and appears in the review queue", async () => {
    const s = await newScenario("m1");
    const log = await clock(s, "in");
    expect(log.validity).toBe("valid");
    expect(await queueEntries(log.outletId, log.id)).toEqual([]);

    const leave = await requestLeave(s, 0, 0);
    // Pending leave does not flag anything yet.
    expect(await validityOf(s, log.id)).toBe("valid");
    expect(await queueEntries(log.outletId, log.id)).toEqual([]);

    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    const pending = await queueOf(s.outletId, "&reviewStatus=pending");
    expect(
      pending.find((item) => item.log.id === log.id)?.flagReasons,
    ).toContain("leave_approved");
  });

  it("[F25] a valid clock-in on a past date is flagged by a leave approved later for that date", async () => {
    const s = await newScenario("m2");
    const yesterday = wibDate(Date.now() - DAY);
    await seedShift(s, s.outletId, yesterday);
    const log = await clock(s, "in");
    expect(log.validity).toBe("valid");

    const leave = await requestLeave(s, -1, -1);
    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
  });

  it("[F25] a rejected leave flags nothing", async () => {
    const s = await newScenario("m3");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 0, 0);

    const rejected = await decide(s, leave.id, "reject");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    await expectNotFlaggedByLeave(s, log, "valid");
    expect(await queueEntries(log.outletId, log.id)).toEqual([]);
  });

  it("[F25] an already flagged and pending log (outside geofence) keeps its reason and gains leave_approved", async () => {
    const s = await newScenario("m4", "flag");
    const log = await clock(s, "in", FAR);
    expect(log.validity).toBe("flagged");
    const before = (await queueEntries(log.outletId, log.id))[0];
    expect(before?.flagReasons).toContain("outside_geofence");
    expect(before?.flagReasons).not.toContain("leave_approved");

    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    const after = (await queueEntries(log.outletId, log.id))[0];
    expect(after?.flagReasons).toContain("outside_geofence");
  });
});

// ---- other outlet -----------------------------------------------------------

describe("[F25] the clock-in at another outlet is flagged too", () => {
  it("[F25] leave of home outlet A flags a clock-in made at outlet B (queue of B)", async () => {
    const s = await newScenario("o1");
    const outletB = await seedOutlet("o1-B");
    const policy = await put(hr, "/api/hris/attendance/policy", {
      outletId: outletB,
      policy: basePolicy,
      sampling: noSampling,
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    // The employee may also clock at B.
    const roleId = randomUUID();
    createdRoles.push(roleId);
    const staffUser = (await s.staff.get("/api/auth/get-session")).body.user
      .id as string;
    await asTenant(async (db) => {
      await db.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, $3, false, $4, $5)`,
        [
          roleId,
          tenant.id,
          `Leave approve flag B ${roleId.slice(0, 8)}`,
          JSON.stringify(["self.attendance.clock"]),
          JSON.stringify(["outlet"]),
        ],
      );
      await assign(db, staffUser, roleId, { type: "outlet", id: outletB });
    });
    await seedShift(s, outletB, wibDate(Date.now()));

    const log = await clock(s, "in");
    expect(log.outletId, "clock-in stored at outlet B").toBe(outletB);
    expect(log.validity).toBe("valid");

    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    expect((await queueOf(s.outletId)).find((i) => i.log.id === log.id)).toBe(
      undefined,
    );
  });
});

// ---- logs that must stay untouched -----------------------------------------

describe("[F25] logs the approval must not touch", () => {
  it("[F25] a rejected log stays rejected and gets no leave reason", async () => {
    const s = await newScenario("t1");
    const log = await clock(s, "in");
    const rejected = await review(log.id, { action: "reject" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(await validityOf(s, log.id)).toBe("rejected");

    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    await expectNotFlaggedByLeave(s, log, "rejected");
    // Leave itself is unaffected.
    expect(await leaveStatus(s, leave.id)).toBe("approved");
  });

  it("[F25] a log HR already accepted is reopened (pending, reviewer cleared) when the leave is approved", async () => {
    const s = await newScenario("t2", "flag");
    const log = await clock(s, "in", FAR);
    expect(log.validity).toBe("flagged");
    const accepted = await review(log.id, { action: "accept" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await validityOf(s, log.id)).toBe("valid");

    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    const [entry] = await queueEntries(log.outletId, log.id);
    expect(entry?.reviewedBy).toBeNull();
    expect(entry?.reviewedAt).toBeNull();
  });

  it("[F25] out, break_start and break_end logs are not flagged; only the in log is", async () => {
    const s = await newScenario("t3");
    const clockIn = await clock(s, "in");
    const breakStart = await clock(s, "break_start");
    const breakEnd = await clock(s, "break_end");
    const clockOut = await clock(s, "out");

    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    await expectLeaveFlagged(s, clockIn);
    for (const other of [breakStart, breakEnd, clockOut]) {
      expect(other.validity, `${other.type} before approval`).toBe("valid");
      await expectNotFlaggedByLeave(s, other, "valid");
      expect(await queueEntries(other.outletId, other.id)).toEqual([]);
    }
  });
});

// ---- multi-day range ---------------------------------------------------------

describe("[F25] multi-day leave flags only the log in its range", () => {
  it("[F25] a clock-in inside a multi-day range (yesterday..tomorrow) is flagged", async () => {
    const s = await newScenario("r1");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, -1, 1);

    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: leave.days,
      pending: "0.0000",
    });
  });

  it("[F25] a clock-in before the range (leave tomorrow..+2) is not flagged", async () => {
    const s = await newScenario("r2");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 1, 2);

    await approve(s, leave.id);

    await expectNotFlaggedByLeave(s, log, "valid");
    expect(await queueEntries(log.outletId, log.id)).toEqual([]);
    expect(await leaveStatus(s, leave.id)).toBe("approved");
  });

  it("[F25] a clock-in after the range (leave today..tomorrow, log belongs to yesterday) is not flagged", async () => {
    const s = await newScenario("r3");
    await seedShift(s, s.outletId, wibDate(Date.now() - DAY));
    const log = await clock(s, "in");
    expect(log.validity).toBe("valid");
    const leave = await requestLeave(s, 0, 1);

    await approve(s, leave.id);

    await expectNotFlaggedByLeave(s, log, "valid");
    expect(await queueEntries(log.outletId, log.id)).toEqual([]);
  });
});

// ---- idempotency and money ----------------------------------------------------

describe("[F25] repeated approval and the leave balance", () => {
  it("[F25] approving again adds no second reason, no second queue entry, no second deduction", async () => {
    const s = await newScenario("i1");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 0, 0);
    const decisionKey = key();

    const first = await decide(s, leave.id, "approve", decisionKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await expectLeaveFlagged(s, log);

    const replay = await decide(s, leave.id, "approve", decisionKey);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    // A new key on an already approved leave is a conflict (nothing re-applied).
    const again = await decide(s, leave.id, "approve");
    expect([200, 409], JSON.stringify(again.body)).toContain(again.status);

    await expectLeaveFlagged(s, log);
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: leave.days,
      pending: "0.0000",
    });
  });

  it("[F25] flagging changes neither the leave status nor the balance", async () => {
    const s = await newScenario("i2");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 0, 0);
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: "0.0000",
      pending: leave.days,
    });

    await approve(s, leave.id);

    await expectLeaveFlagged(s, log);
    expect(await leaveStatus(s, leave.id)).toBe("approved");
    // Pending days moved to used exactly once (approval), nothing from flagging.
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: leave.days,
      pending: "0.0000",
    });
    // No countable ("valid") log remains on the leave day: paid once, as leave.
    expect(
      (await logsOf(s)).filter((item) => item.validity === "valid"),
    ).toEqual([]);
  });
});

// ---- HR decisions after the flag ---------------------------------------------

describe("[F25] HR decides the log flagged by the approval", () => {
  it("[F25] accept is refused (409), nothing changes; keep_leave then keeps the leave and rejects the log", async () => {
    const s = await newScenario("h1");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);

    const accepted = await review(log.id, { action: "accept" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(409);
    await expectLeaveFlagged(s, log);
    expect(await leaveStatus(s, leave.id)).toBe("approved");

    const kept = await review(log.id, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.data.reviewStatus).not.toBe("pending");
    expect(await leaveStatus(s, leave.id)).toBe("approved");
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: leave.days,
      pending: "0.0000",
    });
    expect(await validityOf(s, log.id)).toBe("rejected");
    expect(await queueOf(s.outletId, "&reviewStatus=pending")).toEqual([]);
  });

  it("[F25] cancel_leave cancels the one-day leave, refunds the day once and makes the log valid", async () => {
    const s = await newScenario("h2");
    const log = await clock(s, "in");
    const leave = await requestLeave(s, 0, 0);
    await approve(s, leave.id);
    expect(await balance(s)).toMatchObject({ used: leave.days });

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reviewStatus).not.toBe("pending");

    expect(await leaveStatus(s, leave.id)).toBe("cancelled");
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: "0.0000",
      pending: "0.0000",
    });
    expect(await validityOf(s, log.id)).toBe("valid");
    expect(await queueOf(s.outletId, "&reviewStatus=pending")).toEqual([]);
  });
});
