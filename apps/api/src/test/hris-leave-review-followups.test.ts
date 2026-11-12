// Fail-first tests for the architect review (round 1) of branch 5nt2z-leave-partial:
// follow-ups F1, F2 and F3. Expected behaviour comes from
// docs/briefs/5nt2z-leave-partial.md, section "Review architect (putaran 1)",
// and the shared contract (packages/shared/src/hris), never from service code.
// Setup follows hris-leave-approve-flags-attendance.test.ts,
// hris-attendance-leave-flag.test.ts and hris-attendance-correction-leave-day.test.ts.
//
//  F1 (money): a log whose review HR already decided (accepted, e.g. after
//     cancel_leave made it valid) is flagged again when a NEW leave is approved
//     on that day: flagged, review pending, reviewed_by / reviewed_at empty, reason
//     leave_approved exactly once. Repeating the approval changes nothing more. A
//     rejected log is still never touched.
//  F2: a log written by an approved manual correction that is later flagged
//     leave_approved can be decided with keep_leave / cancel_leave (200); the other
//     actions (accept, reject) stay refused.
//  F3: a correction chain decided through the general approval inbox
//     (POST /api/approvals/:id/decisions, which skips the correction decision
//     endpoint's leave-day gate) on a day with an approved leave ends with the
//     correction REJECTED (not stuck pending) and no log written.
//
// Assumptions (the brief leaves these open):
//  - F1 "accepted" is reached two ways: cancel_leave on a leave-flagged log (log
//    becomes valid), and accept on an outside-geofence flagged log. The brief
//    says to flag accepted logs again, so this CONTRADICTS the test "a log whose
//    review HR already decided (accepted) is not reopened" (t2) in
//    hris-leave-approve-flags-attendance.test.ts: the engineer must update t2.
//  - F2: refused actions answer 409 or 422 (the brief says "tetap ditolak" with no
//    code). The log of an approved correction stays method "manual_correction".
//  - F3: the inbox request of a correction is found as the staff member's pending
//    approval_requests row with action_type 'attendance_correction' (one
//    correction per scenario). The inbox answers 200 (or 409); the observable
//    outcome is the correction status "rejected" and zero manual logs. The reason
//    "leave_approved" is checked loosely in its own test: it must appear in the
//    approval row, audit log or outbox event that names the correction.
//  - The leave-between-gate-and-settle race cannot be forced over HTTP; the inbox
//    path reaches the same settle branch.
//  - Leave and correction approvals are one level for the outlet manager of the
//    employee's outlet. F2/F3 use a day 4 days ago (WIB); tests assume that day
//    is in the same calendar year as today. The leave API accepts past dates
//    (brief 7o3hd).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { handleHrisApprovalResolved } from "../services/hris-approval-consumers.ts";
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
const KEY_PREFIX = "lrf-";
const POLICY_ACTIONS = ["leave", "attendance_correction"];
let savedPolicies: Record<string, unknown>[] = [];

async function asTenant<T>(
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
        `Leave review followup ${roleId.slice(0, 8)}`,
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
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `LR-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet tindak-lanjut cuti ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Tindak Lanjut Cuti', $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        id,
        tenant.id,
        userId,
        `LR-${id.slice(0, 8).toUpperCase()}`,
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
const noSampling = { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
// Midday UTC (12:00 WIB) is the same calendar day in every Indonesian time zone.
const middayUtc = (day: string) => `${day}T05:00:00.000Z`;
const PAST_OFFSET = -4;

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
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
      [tenant.id, POLICY_ACTIONS],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
    [tenant.id, POLICY_ACTIONS],
  );
  const managerRole = await templateRoleId("outlet_manager");
  for (const action of POLICY_ACTIONS)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, $2, NULL, $3, 1)`,
      [tenant.id, action, managerRole],
    );

  const admin = await signedInClient("HR Tindak Lanjut Cuti", { mfa: true });
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
    code: `LRF_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji tindak-lanjut",
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
  await step(() =>
    // Audit, outbox and log rows are protected by triggers; replica mode lets
    // the owner remove the rows that name our fixtures.
    asTenant(
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
        await db.query(
          "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [tenant.id, createdEmployees],
        );
        await db.query(
          "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
          [tenant.id, POLICY_ACTIONS],
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
      },
      { replica: true },
    ),
  );
  await step(() =>
    owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]),
  );
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
}, 60_000);

// ---- scenario helpers --------------------------------------------------------

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  staffUserId: string;
  manager: Client;
  /** Business date of the clock-in tests (today, WIB). */
  today: string;
  /** Business date used by the correction tests (4 days ago, WIB). */
  pastDay: string;
}

/**
 * A fresh outlet (own review queue), an employee who may clock, request leave
 * and file corrections there with 12 leave days, and the outlet manager who
 * approves both leave and corrections.
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

  const staffSession = await signedInClient(`Staf Tindak Lanjut ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const managerSession = await signedInClient(
    `Manajer Tindak Lanjut ${label}`,
    { mfa: true },
  );
  // A supervisor decides only for direct reports: the manager is an employee.
  const managerEmployeeId = await seedEmployee(managerSession.userId, outletId);
  const employeeId = await seedEmployee(
    staffSession.userId,
    outletId,
    managerEmployeeId,
  );
  const managerRoleId = await templateRoleId("outlet_manager");
  await asTenant((db) =>
    assign(db, managerSession.userId, managerRoleId, {
      type: "outlet",
      id: outletId,
    }),
  );

  const today = wibDate(Date.now());
  const pastDay = wibDate(Date.now() + PAST_OFFSET * DAY);
  const years = new Set([today, pastDay].map((d) => Number(d.slice(0, 4))));
  await asTenant(async (db) => {
    for (const year of years)
      await db.query(
        `INSERT INTO leave_balances
           (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
         VALUES ($1, $2, $3, $4, '12')`,
        [tenant.id, employeeId, leaveTypeId, year],
      );
  });
  return {
    outletId,
    employeeId,
    staff: staffSession.client,
    staffUserId: staffSession.userId,
    manager: managerSession.client,
    today,
    pastDay,
  };
}

interface Log {
  id: string;
  type: string;
  outletId: string;
  validity: string;
  method?: string;
  occurredAt?: string;
}

async function clock(
  s: Scenario,
  type: "in" | "out",
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

/** Staff requests leave; offsets are days from today (WIB). */
async function requestLeave(
  s: Scenario,
  startOffset: number,
  endOffset = startOffset,
) {
  const response = await post(s.staff, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: wibDate(Date.now() + startOffset * DAY),
    endDate: wibDate(Date.now() + endOffset * DAY),
    reason: "Cuti uji tindak-lanjut",
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
    ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
    idempotencyKey,
  });

async function approveLeave(s: Scenario, leaveId: string) {
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

async function balance(s: Scenario, day = s.today) {
  const response = await hr.get(
    `/api/hris/leave/balances?employeeId=${s.employeeId}&year=${day.slice(0, 4)}`,
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

/**
 * The log is flagged, pending, never reviewed (reviewer and time empty) and
 * carries the leave reason exactly once, in exactly one queue entry.
 */
async function expectFreshLeaveFlag(s: Scenario, log: Log) {
  expect(await validityOf(s, log.id)).toBe("flagged");
  const entries = await queueEntries(log.outletId, log.id);
  expect(entries, "exactly one queue entry for the log").toHaveLength(1);
  const entry = entries[0]!;
  expect(entry).toMatchObject({ source: "flagged", reviewStatus: "pending" });
  expect(entry.reviewedBy, "reviewed_by is empty again").toBeNull();
  expect(entry.reviewedAt, "reviewed_at is empty again").toBeNull();
  expect(
    entry.flagReasons.filter((reason) => reason === "leave_approved"),
  ).toHaveLength(1);
  expect(entry.log.employeeId).toBe(s.employeeId);
}

// ---- F1: a reviewed (accepted) log is flagged again by a new approved leave ----

describe("[F25] F1: leave approved on a day whose log HR already accepted", () => {
  it("[538-G4b P3] reopening a decided leave log clears stale decision metadata and keeps the new leave paid once", async () => {
    const s = await newScenario("reopen-metadata");
    const log = await clock(s, "in");
    const first = await requestLeave(s, 0);
    await approveLeave(s, first.id);
    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.decisionAction).toBe("cancel_leave");
    expect(cancelled.body.data.leave.leaveRequestId).toBe(first.id);
    expect(cancelled.body.data.caseKind).not.toBeNull();

    const stored = () =>
      asTenant((db) =>
        db.query<{
          decision_action: string | null;
          leave_snapshot: unknown;
          case_kind: string | null;
        }>(
          `SELECT decision_action, leave_snapshot, case_kind FROM attendance_logs
          WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, ulidToUuid(log.id)],
        ),
      );
    expect((await stored()).rows[0]).toMatchObject({
      decision_action: "cancel_leave",
      leave_snapshot: expect.any(Object),
      case_kind: expect.any(String),
    });

    const second = await requestLeave(s, 0);
    await approveLeave(s, second.id);

    expect((await stored()).rows[0]).toEqual({
      decision_action: null,
      leave_snapshot: null,
      case_kind: null,
    });
    await expectFreshLeaveFlag(s, log);
    expect(await leaveStatus(s, first.id)).toBe("cancelled");
    expect(await leaveStatus(s, second.id)).toBe("approved");
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: second.days,
      pending: "0.0000",
    });
    expect(
      (await logsOf(s)).filter((item) => item.validity === "valid"),
    ).toEqual([]);
  });

  it("[F25] F1 cancel_leave makes the log valid; a new leave approved that day flags it again (pending, no reviewer), once", async () => {
    const s = await newScenario("f1a");
    const log = await clock(s, "in");
    expect(log.validity).toBe("valid");

    const first = await requestLeave(s, 0);
    await approveLeave(s, first.id);
    expect(await validityOf(s, log.id)).toBe("flagged");

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reviewStatus).not.toBe("pending");
    expect(await leaveStatus(s, first.id)).toBe("cancelled");
    expect(await validityOf(s, log.id)).toBe("valid");
    expect((await balance(s)).used).toBe("0.0000");

    // A NEW leave for the same day is approved: the day must not be paid twice.
    const second = await requestLeave(s, 0);
    await approveLeave(s, second.id);

    await expectFreshLeaveFlag(s, log);
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: second.days,
      pending: "0.0000",
    });
    // No countable ("valid") log remains on the leave day: paid once, as leave.
    expect(
      (await logsOf(s)).filter((item) => item.validity === "valid"),
    ).toEqual([]);
  });

  it("[F25] F1 an outside-geofence log accepted by HR is flagged again by a later approved leave (money rule: when in doubt, stricter)", async () => {
    const s = await newScenario("f1b", "flag");
    const log = await clock(s, "in", FAR);
    expect(log.validity).toBe("flagged");
    const accepted = await review(log.id, { action: "accept" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await validityOf(s, log.id)).toBe("valid");

    const leave = await requestLeave(s, 0);
    await approveLeave(s, leave.id);

    await expectFreshLeaveFlag(s, log);
  });

  it("[F25] F1 repeating the approval adds no second reason, queue entry or deduction", async () => {
    const s = await newScenario("f1c");
    const log = await clock(s, "in");
    const first = await requestLeave(s, 0);
    await approveLeave(s, first.id);
    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const second = await requestLeave(s, 0);
    const decisionKey = key();
    const approved = await decide(s, second.id, "approve", decisionKey);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await expectFreshLeaveFlag(s, log);

    // Same key replays; a new key on an approved leave is a no-op or a conflict.
    const replay = await decide(s, second.id, "approve", decisionKey);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const again = await decide(s, second.id, "approve");
    expect([200, 409], JSON.stringify(again.body)).toContain(again.status);

    await expectFreshLeaveFlag(s, log);
    expect(await balance(s)).toEqual({
      entitled: "12.0000",
      used: second.days,
      pending: "0.0000",
    });
  });

  it("[F25] F1 a rejected log is still not touched by a later approved leave", async () => {
    const s = await newScenario("f1d");
    const log = await clock(s, "in");
    const rejected = await review(log.id, { action: "reject" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const leave = await requestLeave(s, 0);
    await approveLeave(s, leave.id);

    expect(await validityOf(s, log.id)).toBe("rejected");
    for (const entry of await queueEntries(log.outletId, log.id))
      expect(entry.flagReasons).not.toContain("leave_approved");
    expect(await leaveStatus(s, leave.id)).toBe("approved");
  });
});

// ---- F2: HR can decide a flagged manual-correction log -------------------------

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
  expect(response.body.data.status).toBe("pending");
  return response.body.data as { id: string };
}

const decideCorrection = (
  s: Scenario,
  correctionId: string,
  action: "approve" | "reject",
) =>
  post(s.manager, `/api/hris/attendance/corrections/${correctionId}/decision`, {
    action,
    note: "Diperiksa penyelia",
    idempotencyKey: key(),
  });

async function correctionStatus(s: Scenario, correctionId: string) {
  const response = await hr.get(
    `/api/hris/attendance/corrections?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { id: string; status: string }[]).find(
    (item) => item.id === correctionId,
  )?.status;
}

async function manualLogs(s: Scenario): Promise<Log[]> {
  return (await logsOf(s)).filter((log) => log.method === "manual_correction");
}

/**
 * An approved manual correction on the past day (valid manual log), then a leave
 * for the same day approved afterwards: the manual log must be flagged.
 */
async function manualLogThenLeave(label: string) {
  const s = await newScenario(label);
  const correction = await fileCorrection(s, s.pastDay);
  const approved = await decideCorrection(s, correction.id, "approve");
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const logs = await manualLogs(s);
  expect(logs, "approved correction writes one manual log").toHaveLength(1);
  const log = logs[0]!;
  expect(log.validity).toBe("valid");

  const leave = await requestLeave(s, PAST_OFFSET);
  await approveLeave(s, leave.id);
  await expectFreshLeaveFlag(s, log);
  expect(await balance(s, s.pastDay)).toMatchObject({ used: leave.days });
  return { s, log, leave };
}

describe("[F25] F2: HR decides a manual-correction log flagged by an approved leave", () => {
  it("[F25] F2 a manual-correction log is flagged leave_approved when a leave is approved on its day", async () => {
    const { log } = await manualLogThenLeave("f2a");
    expect(log.method).toBe("manual_correction");
  });

  it("[F25] F2 keep_leave answers 200: leave stays, balance unchanged, manual log rejected, flag resolved", async () => {
    const { s, log, leave } = await manualLogThenLeave("f2b");

    const kept = await review(log.id, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.data.reviewStatus).not.toBe("pending");

    expect(await leaveStatus(s, leave.id)).toBe("approved");
    expect(await balance(s, s.pastDay)).toMatchObject({ used: leave.days });
    expect(await validityOf(s, log.id)).toBe("rejected");
    expect(await queueOf(s.outletId, "&reviewStatus=pending")).toEqual([]);
  });

  it("[F25] F2 cancel_leave answers 200: leave cancelled, day refunded once, manual log valid", async () => {
    const { s, log, leave } = await manualLogThenLeave("f2c");

    const cancelled = await review(log.id, { action: "cancel_leave" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reviewStatus).not.toBe("pending");

    expect(await leaveStatus(s, leave.id)).toBe("cancelled");
    expect(await balance(s, s.pastDay)).toMatchObject({
      used: "0.0000",
      pending: "0.0000",
    });
    expect(await validityOf(s, log.id)).toBe("valid");
    expect(await queueOf(s.outletId, "&reviewStatus=pending")).toEqual([]);
  });

  it("[F25] F2 accept and reject stay refused (409 or 422) on the manual-correction log; nothing changes", async () => {
    const { s, log, leave } = await manualLogThenLeave("f2d");

    for (const action of ["accept", "reject"]) {
      const response = await review(log.id, { action });
      expect(
        [409, 422],
        `${action}: ${JSON.stringify(response.body)}`,
      ).toContain(response.status);
    }
    await expectFreshLeaveFlag(s, log);
    expect(await leaveStatus(s, leave.id)).toBe("approved");
    expect(await balance(s, s.pastDay)).toMatchObject({ used: leave.days });
  });
});

// ---- F3: correction chain decided through the general inbox --------------------

/** The staff member's open inbox request of the (single) correction. */
async function pendingInboxRequest(s: Scenario): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND action_type = 'attendance_correction'
        AND requested_by = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenant.id, s.staffUserId],
  );
  if (!rows[0]) throw new Error("No pending inbox request for the correction");
  return rows[0].id;
}

const decideInbox = (s: Scenario, approvalId: string) =>
  post(s.manager, `/api/approvals/${approvalId}/decisions`, {
    decision: "approved",
    reason: "Disetujui lewat inbox",
  });

/**
 * The inbox decision only appends approval.resolved to the outbox; the worker
 * delivers it to the HRIS consumer, which settles the correction. Tests have no
 * worker, so deliver the real event of the correction's chain the same way.
 */
async function deliverResolved(correctionId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT o.event FROM domain_event_outbox o
       JOIN attendance_corrections c
         ON o.event->'payload'->>'chainId' = c.approval_chain_id::text
      WHERE o.tenant_id = $1 AND c.id = $2
        AND o.destination = 'cloud-sync'
        AND o.event->>'name' = 'approval.resolved'`,
    [tenant.id, correctionId],
  );
  expect(rows).toHaveLength(1);
  const workerContext = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "job",
    } as Parameters<typeof establishTenantContext>[0]),
    { kind: "tenant" },
  );
  await handleHrisApprovalResolved(
    workerContext,
    eventEnvelopeSchema.parse(rows[0]?.event),
  );
}

describe("[F25] F3: a correction decided through the approval inbox on a leave day", () => {
  it("[F25] F3 control: on a day without leave the inbox approval applies the correction (one valid manual log)", async () => {
    const s = await newScenario("f3a");
    const correction = await fileCorrection(s, s.pastDay);

    const response = await decideInbox(s, await pendingInboxRequest(s));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await deliverResolved(correction.id);

    expect(await correctionStatus(s, correction.id)).toBe("approved");
    const logs = await manualLogs(s);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.validity).toBe("valid");
  });

  it("[F25] F3 a leave approved after filing, then inbox approval: correction ends rejected (not stuck pending), no log, leave and balance untouched", async () => {
    const s = await newScenario("f3b");
    const correction = await fileCorrection(s, s.pastDay);
    const inboxId = await pendingInboxRequest(s);
    const leave = await requestLeave(s, PAST_OFFSET);
    await approveLeave(s, leave.id);
    const balanceBefore = await balance(s, s.pastDay);
    expect(balanceBefore.used).toBe(leave.days);

    const response = await decideInbox(s, inboxId);
    expect([200, 409], JSON.stringify(response.body)).toContain(
      response.status,
    );
    await deliverResolved(correction.id);

    expect(await correctionStatus(s, correction.id)).toBe("rejected");
    expect(await manualLogs(s)).toEqual([]);
    expect(await leaveStatus(s, leave.id)).toBe("approved");
    expect(await balance(s, s.pastDay)).toEqual(balanceBefore);
  });

  it("[F25] F3 the rejection names the cause leave_approved (approval row, audit log or outbox event of the correction)", async () => {
    const s = await newScenario("f3c");
    const correction = await fileCorrection(s, s.pastDay);
    const inboxId = await pendingInboxRequest(s);
    const leave = await requestLeave(s, PAST_OFFSET);
    await approveLeave(s, leave.id);

    await decideInbox(s, inboxId);
    await deliverResolved(correction.id);
    expect(await correctionStatus(s, correction.id)).toBe("rejected");

    const { rows } = await owner.query<{ hit: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM approval_requests a
                  WHERE a.tenant_id = $1 AND a.requested_by = $2
                    AND a.action_type = 'attendance_correction'
                    AND row_to_json(a)::text LIKE '%leave_approved%')
         OR EXISTS (SELECT 1 FROM audit_logs l
                     WHERE l.tenant_id = $1 AND l.event::text LIKE '%' || $3 || '%'
                       AND l.event::text LIKE '%leave_approved%')
         OR EXISTS (SELECT 1 FROM domain_event_outbox o
                     WHERE o.tenant_id = $1 AND o.event::text LIKE '%' || $3 || '%'
                       AND o.event::text LIKE '%leave_approved%')
       ) AS hit`,
      [tenant.id, s.staffUserId, correction.id],
    );
    expect(rows[0]?.hit, "cause leave_approved recorded").toBe(true);
  });
});
