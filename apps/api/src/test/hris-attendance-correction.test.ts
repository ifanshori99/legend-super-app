// Attendance corrections, sampling review, policy and duty meals over HTTP
// (PRD v1.7 §3 F25 "Koreksi Absensi" / supervisor sampling review, HR-02,
// TEN-01/02/03; WS-10 brief, "Gelombang 2"). Runs the real Express app, Better
// Auth, RBAC and PostgreSQL against the seeded Cafe Legend tenant. Expected
// behaviour comes from the PRD, the shared contract
// (packages/shared/src/hris/attendance.ts, endpoints.ts) and the brief, not
// from service code. Rows are seeded through the owner pool only where no
// endpoint exists (employees, roles, a locked payroll run, the approval policy).
//
// Assumptions (the spec leaves these open):
//  - Create/record answers 200 or 201; replays answer a 2xx with the same row.
//  - A correction goes through the approval policy for action type
//    `attendance_correction` (one level, outlet manager). The test seeds that
//    policy when the tenant has none, and the approver holds the template role
//    `outlet_manager` at the outlet, which carries hr.attendance.manage and
//    hr.attendance_correction.approve.
//  - The employee files a correction with `self.attendance.clock`.
//  - A correction whose business date lies in a locked payroll period is
//    refused 409 both when it is filed and when it is approved afterwards.
//    "Locked" means a payroll run with status locked and a covering period.
//  - A decision on an already decided correction, and a review transition the
//    log state machine forbids (accept a valid log, anything on a rejected
//    log), answer 409.
//  - Review rights: hr.attendance.manage within the outlet scope. A user
//    without it answers 403; a manager of another outlet answers 403 or 404;
//    an unauthenticated caller answers 401.
//  - Only a tenant-wide manager writes the tenant default policy; an
//    outlet-scoped manager gets 403 (or 404) for it and for another outlet.
//  - Duty meals are recorded by hr.attendance.manage. A second key for the
//    same employee, day and shift is either answered with the stored row or
//    refused 409, never stored twice.
//  - Sampling: with `flaggedAlways` flagged logs enter the queue as source
//    `flagged`; the sample is `rate` of the other valid logs (source
//    `sampled`), rate 1 takes all, rate 0 takes none; flaggedAlways=false with
//    rate 0 leaves flagged logs out. The sample is stable across calls.
//  - All attendance activity runs at the second Cafe Legend outlet (no
//    geofence, so a geo clock-in without usable coordinates is flagged
//    `outside_geofence`); the first outlet is only the "other outlet" in the
//    scope checks. Corrections use midday UTC of recent past days, far from
//    any real payroll period; the locked periods exist only while their test
//    runs.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  decideAttendanceReview,
  listAttendanceReviewQueue,
  type AttendancePhotoSigner,
} from "../services/hris-attendance-admin.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [otherOutlet, outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const KEY_PREFIX = "att-corr-api-";
const RUN_MARKER = "attendance-correction-api-test";
let insertedApprovalPolicy = false;
const insertedPolicyUsers: string[] = [];
const photoAuditedLogIds: string[] = [];

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

type Scope = { type: "tenant" } | { type: "outlet"; id: string };

async function assignRole(userId: string, roleId: string, scope: Scope) {
  await ownerTx((db) =>
    db.query(
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
    ),
  );
}

async function grantCustomRole(
  userId: string,
  permissions: string[],
  scope: Scope,
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
        `Att Corr API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    ),
  );
  await assignRole(userId, roleId, scope);
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

/**
 * A supervisor sees only direct reports, so every employee of the outlet under
 * test (once the manager's own employee exists) reports to that manager.
 */
async function seedEmployee(
  userId: string | null,
  outletId: string,
  managerId: string | null = outletId === outlet?.id
    ? (managerEmployeeId ?? null)
    : null,
) {
  const id = randomUUID();
  createdEmployees.push(id);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi API', $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        id,
        tenant.id,
        userId,
        `AC-${id.slice(0, 8).toUpperCase()}`,
        outletId,
        managerId,
      ],
    ),
  );
  return id;
}

const key = () => `${KEY_PREFIX}${randomUUID()}`;
const send = (
  method: "post" | "put",
  client: Client,
  path: string,
  body: unknown,
) =>
  client[method](path)
    .set(originHeader)
    .send(body as object);
const post = (client: Client, path: string, body: unknown) =>
  send("post", client, path, body);
const put = (client: Client, path: string, body: unknown) =>
  send("put", client, path, body);

const STAFF_PERMISSIONS = ["self.profile.view", "self.attendance.clock"];
const BASE_POLICY = {
  geofenceRadiusM: 150,
  outsideGeofenceAction: "flag",
  unboundDeviceAction: "flag",
  requireSelfie: false,
  requireDeviceBinding: false,
  allowRotatingQr: true,
  selfieRetentionDays: 90,
};
const sampling = (rate: number, flaggedAlways: boolean) => ({
  rate,
  flaggedAlways,
  minPerSupervisorPerWeek: 0,
});

const dayStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
// Midday UTC is the same calendar day in every Indonesian time zone.
const middayUtc = (day: string) => `${day}T05:00:00.000Z`;

let hr: Actor; // hr.attendance.manage, whole tenant, no approve permission
let manager: Actor; // outlet_manager template at the outlet under test
let managerOther: Actor; // outlet_manager template at the other outlet
let noAccess: Actor; // staff without manage or approve permission
let corrStaff: Actor;
let employeeCorr: string;
let managerEmployeeId: string | undefined;
let employeeMealId: string;

type ClockKind = "valid" | "flagged";
type ClockedLog = { id: string; employeeId: string; validity: string };
const clocked: Record<string, ClockedLog> = {};

async function currentQr(): Promise<string> {
  const qr = await hr.client.get(
    `/api/hris/attendance/qr?outletId=${outlet.id}`,
  );
  expect(qr.status, JSON.stringify(qr.body)).toBe(200);
  return qr.body.data.token as string;
}

/** A fresh employee clocks in; "valid" via the outlet QR, "flagged" via geo. */
async function clockIn(label: string, kind: ClockKind) {
  const staff = await signedInClient(`Absen ${label} API`);
  await grantCustomRole(staff.userId, STAFF_PERMISSIONS, {
    type: "outlet",
    id: outlet.id,
  });
  const employeeId = await seedEmployee(staff.userId, outlet.id);
  const response = await post(staff.client, "/api/hris/attendance/clock", {
    type: "in",
    method: kind === "valid" ? "rotating_qr" : "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: null,
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: kind === "valid" ? await currentQr() : null,
    idempotencyKey: key(),
  });
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  expect(response.body.data.validity).toBe(kind);
  clocked[label] = {
    id: response.body.data.id,
    employeeId,
    validity: response.body.data.validity,
  };
  return clocked[label];
}

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

const queueOf = (client: Client, extra = "") =>
  collect(
    client,
    `/api/hris/attendance/review-queue?outletId=${outlet.id}${extra}`,
  );
const queueEntry = (items: JsonRow[], logId: string) =>
  items.find((item) => item.log.id === logId);

async function setSampling(rate: number, flaggedAlways: boolean) {
  const response = await put(hr.client, "/api/hris/attendance/policy", {
    outletId: outlet.id,
    policy: BASE_POLICY,
    sampling: sampling(rate, flaggedAlways),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

beforeAll(async () => {
  // The approval flow needs a policy for the action; keep an existing one.
  const managerRole = await templateRoleId("outlet_manager");
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRole],
  );
  insertedApprovalPolicy = (inserted.rowCount ?? 0) > 0;

  hr = await signedInClient("HR Absensi API", { mfa: true });
  await grantCustomRole(
    hr.userId,
    ["hr.attendance.manage", "hr.employee.view"],
    { type: "tenant" },
  );
  insertedPolicyUsers.push(hr.userId);
  manager = await signedInClient("Manajer Absensi API", { mfa: true });
  await assignRole(manager.userId, managerRole, {
    type: "outlet",
    id: outlet.id,
  });
  managerEmployeeId = await seedEmployee(manager.userId, outlet.id, null);
  managerOther = await signedInClient("Manajer Lain Absensi API", {
    mfa: true,
  });
  await assignRole(managerOther.userId, managerRole, {
    type: "outlet",
    id: otherOutlet.id,
  });
  noAccess = await signedInClient("Tanpa Akses Absensi API");
  await grantCustomRole(noAccess.userId, STAFF_PERMISSIONS, {
    type: "outlet",
    id: outlet.id,
  });
  await seedEmployee(noAccess.userId, outlet.id);

  corrStaff = await signedInClient("Pemohon Koreksi API");
  await grantCustomRole(corrStaff.userId, STAFF_PERMISSIONS, {
    type: "outlet",
    id: outlet.id,
  });
  employeeCorr = await seedEmployee(corrStaff.userId, outlet.id);
  employeeMealId = await seedEmployee(null, outlet.id);

  // Outlet override: QR clock-ins are valid, geo clock-ins without usable
  // coordinates are flagged (never rejected), sample every valid log.
  await setSampling(1, true);
  await clockIn("sample-valid", "valid");
  await clockIn("sample-flagged", "flagged");
  await clockIn("accept-flagged", "flagged");
  await clockIn("reject-valid", "valid");
  await clockIn("flag-valid", "valid");
  await clockIn("accept-valid", "valid");
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
      // Locked runs, audit and outbox rows are protected by triggers; replica
      // mode lets the owner remove the rows that name our fixtures.
      ownerTx(
        async (db) => {
          await db.query(
            "DELETE FROM payroll_runs WHERE tenant_id = $1 AND created_by = $2",
            [tenant.id, RUN_MARKER],
          );
          await db.query(
            "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM attendance_duty_meals WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
            [tenant.id, createdEmployees],
          );
          await db.query(
            "DELETE FROM attendance_policies WHERE tenant_id = $1 AND updated_by = ANY($2::text[])",
            [tenant.id, insertedPolicyUsers],
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
              WHERE tenant_id = $1 AND (event->>'objectId' = ANY($3::text[])
                 OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS e(id)
                             WHERE audit_logs.event::text LIKE '%' || e.id || '%'))`,
            [tenant.id, createdEmployees, photoAuditedLogIds],
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

// ---- corrections ---------------------------------------------------------

const correctionBody = (
  day: string,
  overrides: Record<string, unknown> = {},
) => ({
  outletId: outlet.id,
  attendanceLogId: null,
  requestedType: "in",
  requestedOccurredAt: middayUtc(day),
  reason: "Lupa absen masuk, mesin tidak terbaca",
  idempotencyKey: key(),
  ...overrides,
});

async function requestCorrection(
  day: string,
  client: Client = corrStaff.client,
) {
  const response = await post(
    client,
    "/api/hris/attendance/corrections",
    correctionBody(day),
  );
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data as JsonRow;
}

const decide = (
  client: Client,
  correctionId: string,
  action: "approve" | "reject",
  idempotencyKey = key(),
) =>
  post(client, `/api/hris/attendance/corrections/${correctionId}/decision`, {
    action,
    note: "Diperiksa penyelia",
    idempotencyKey,
  });

/** Manual-correction logs of the employee at the exact requested instant. */
async function manualLogsAt(day: string) {
  const logs = await collect(
    hr.client,
    `/api/hris/attendance/logs?employeeId=${employeeCorr}`,
  );
  return logs.filter(
    (log) =>
      log.method === "manual_correction" &&
      Date.parse(log.occurredAt) === Date.parse(middayUtc(day)),
  );
}

async function correctionStatus(correctionId: string) {
  const corrections = await collect(
    hr.client,
    `/api/hris/attendance/corrections?employeeId=${employeeCorr}`,
  );
  return corrections.find((item) => item.id === correctionId)?.status;
}

async function withLockedPeriod(coveringDay: string, run: () => Promise<void>) {
  const start = new Date(Date.parse(middayUtc(coveringDay)) - 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.parse(middayUtc(coveringDay)) + 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const runId = randomUUID();
  await ownerTx(
    (db) =>
      // Replica mode skips the lock-chain guard so one insert makes a frozen
      // run; the policy reference is deliberately free-standing.
      db.query(
        `INSERT INTO payroll_runs
           (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
            pay_date, status, config_snapshot, totals, approved_by_hr, approved_by_hr_at,
            approved_by_finance, approved_by_finance_at, locked_by, locked_at, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'locked', '{"v":1}', '{"t":1}',
                 'hr-user', now(), 'finance-user', now(), 'lock-user', now(), $7)`,
        [
          runId,
          tenant.id,
          outlet.legalEntityId,
          randomUUID(),
          start,
          end,
          RUN_MARKER,
        ],
      ),
    { replica: true },
  );
  try {
    await run();
  } finally {
    await ownerTx(
      (db) => db.query("DELETE FROM payroll_runs WHERE id = $1", [runId]),
      { replica: true },
    );
  }
}

describe("hris.attendance.correction", () => {
  it("files a correction as pending and writes no attendance log until it is approved", async () => {
    const day = dayStr(2);
    const correction = await requestCorrection(day);
    expect(correction.status).toBe("pending");
    expect(correction.employeeId).toBe(employeeCorr);
    expect(correction.outletId).toBe(outlet.id);
    expect(correction.requestedType).toBe("in");
    expect(correction.decidedBy).toBeNull();
    expect(correction.decidedAt).toBeNull();
    expect(Date.parse(correction.requestedOccurredAt)).toBe(
      Date.parse(middayUtc(day)),
    );
    expect(await manualLogsAt(day)).toHaveLength(0);
    expect(await correctionStatus(correction.id)).toBe("pending");
  });

  it("approving creates one valid manual_correction log and closes the correction", async () => {
    const day = dayStr(3);
    const correction = await requestCorrection(day);
    expect(await manualLogsAt(day)).toHaveLength(0);

    const approvalKey = key();
    const approved = await decide(
      manager.client,
      correction.id,
      "approve",
      approvalKey,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    expect(approved.body.data.decidedBy).toBe(manager.userId);
    expect(approved.body.data.decidedAt).not.toBeNull();

    const logs = await manualLogsAt(day);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      employeeId: employeeCorr,
      outletId: outlet.id,
      type: "in",
      method: "manual_correction",
      validity: "valid",
    });
    expect(await correctionStatus(correction.id)).toBe("approved");

    // The employee sees the corrected log among their own.
    const own = await collect(corrStaff.client, "/api/hris/attendance/logs");
    expect(own.some((log) => log.id === logs[0].id)).toBe(true);

    // A replay of the same decision never creates a second log.
    const replay = await decide(
      manager.client,
      correction.id,
      "approve",
      approvalKey,
    );
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(await manualLogsAt(day)).toHaveLength(1);

    // A decision is final.
    const again = await decide(manager.client, correction.id, "reject");
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(await correctionStatus(correction.id)).toBe("approved");
  });

  it("rejecting records the decision and creates no attendance log", async () => {
    const day = dayStr(4);
    const correction = await requestCorrection(day);
    const rejected = await decide(manager.client, correction.id, "reject");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe("rejected");
    expect(rejected.body.data.decidedBy).toBe(manager.userId);
    expect(await manualLogsAt(day)).toHaveLength(0);
    expect(await correctionStatus(correction.id)).toBe("rejected");

    const late = await decide(manager.client, correction.id, "approve");
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(await manualLogsAt(day)).toHaveLength(0);
  });

  it("answers a replayed request with the same correction", async () => {
    const day = dayStr(5);
    const body = correctionBody(day);
    const first = await post(
      corrStaff.client,
      "/api/hris/attendance/corrections",
      body,
    );
    const second = await post(
      corrStaff.client,
      "/api/hris/attendance/corrections",
      body,
    );
    expect([200, 201]).toContain(first.status);
    expect([200, 201], JSON.stringify(second.body)).toContain(second.status);
    expect(second.body.data.id).toBe(first.body.data.id);
    const listed = await collect(
      hr.client,
      `/api/hris/attendance/corrections?employeeId=${employeeCorr}`,
    );
    expect(
      listed.filter((item) => item.id === first.body.data.id),
    ).toHaveLength(1);
  });

  it("refuses a correction request without a reason or with another tenant's field", async () => {
    const day = dayStr(6);
    const blank = await post(
      corrStaff.client,
      "/api/hris/attendance/corrections",
      correctionBody(day, { reason: "" }),
    );
    expect([400, 422], JSON.stringify(blank.body)).toContain(blank.status);
    const smuggled = await post(
      corrStaff.client,
      "/api/hris/attendance/corrections",
      correctionBody(day, { tenantId: randomUUID() }),
    );
    expect([400, 422], JSON.stringify(smuggled.body)).toContain(
      smuggled.status,
    );
    expect(await manualLogsAt(day)).toHaveLength(0);
  });

  it("only the approver decides: staff and unauthenticated callers cannot", async () => {
    const correction = await requestCorrection(dayStr(7));
    const byStaff = await decide(corrStaff.client, correction.id, "approve");
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(403);
    const byHr = await decide(hr.client, correction.id, "approve");
    expect(byHr.status, JSON.stringify(byHr.body)).toBe(403);
    const anonymous = await post(
      agent(app),
      `/api/hris/attendance/corrections/${correction.id}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(anonymous.status).toBe(401);
    expect(await correctionStatus(correction.id)).toBe("pending");
  });

  it("refuses to file a correction in a locked payroll period (409)", async () => {
    const day = dayStr(40);
    await withLockedPeriod(day, async () => {
      const response = await post(
        corrStaff.client,
        "/api/hris/attendance/corrections",
        correctionBody(day),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });
    expect(await manualLogsAt(day)).toHaveLength(0);
    const corrections = await collect(
      hr.client,
      `/api/hris/attendance/corrections?employeeId=${employeeCorr}`,
    );
    expect(
      corrections.filter(
        (item) =>
          Date.parse(item.requestedOccurredAt) === Date.parse(middayUtc(day)),
      ),
    ).toHaveLength(0);
  });

  it("refuses to approve a correction once its payroll period is locked (409)", async () => {
    const day = dayStr(30);
    const correction = await requestCorrection(day);
    await withLockedPeriod(day, async () => {
      const response = await decide(manager.client, correction.id, "approve");
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });
    expect(await manualLogsAt(day)).toHaveLength(0);
    expect(await correctionStatus(correction.id)).toBe("pending");
  });
});

// ---- sampling review -----------------------------------------------------

describe("hris.attendance.review", () => {
  it("queues flagged logs and a sample of valid logs, with the source of each", async () => {
    await setSampling(1, true);
    const items = await queueOf(hr.client);
    const flagged = queueEntry(items, clocked["sample-flagged"].id);
    const sampled = queueEntry(items, clocked["sample-valid"].id);
    expect(flagged?.source).toBe("flagged");
    expect(flagged?.flagReasons).toContain("outside_geofence");
    expect(flagged?.log.validity).toBe("flagged");
    expect(flagged?.log.employeeId).toBe(clocked["sample-flagged"].employeeId);
    expect(sampled?.source).toBe("sampled");
    expect(sampled?.log.validity).toBe("valid");
  });

  it("queues a flagged log made on the outlet attendance screen (method outlet_device, legend-hwn02)", async () => {
    await setSampling(0, true);
    const log = clocked["sample-flagged"];
    await owner.query(
      "UPDATE attendance_logs SET method = 'outlet_device' WHERE id = $1",
      [ulidToUuid(log.id)],
    );
    try {
      const items = await queueOf(hr.client);
      const entry = queueEntry(items, log.id);
      expect(entry?.source).toBe("flagged");
      expect(entry?.log.method).toBe("outlet_device");
    } finally {
      await owner.query(
        "UPDATE attendance_logs SET method = 'selfie_geo' WHERE id = $1",
        [ulidToUuid(log.id)],
      );
    }
  });

  it("with sampling rate 0 only flagged logs stay in the queue", async () => {
    await setSampling(0, true);
    const items = await queueOf(hr.client);
    expect(queueEntry(items, clocked["sample-flagged"].id)).toBeDefined();
    expect(queueEntry(items, clocked["sample-valid"].id)).toBeUndefined();
  });

  it("leaves flagged logs out when they are not always reviewed and the rate is 0", async () => {
    await setSampling(0, false);
    const items = await queueOf(hr.client);
    expect(queueEntry(items, clocked["sample-flagged"].id)).toBeUndefined();
    expect(queueEntry(items, clocked["sample-valid"].id)).toBeUndefined();
  });

  it("keeps the same sample across calls (deterministic)", async () => {
    await setSampling(0.5, true);
    const first = await queueOf(hr.client);
    const second = await queueOf(hr.client);
    expect(second.map((item) => item.log.id)).toEqual(
      first.map((item) => item.log.id),
    );
    expect(queueEntry(first, clocked["sample-flagged"].id)).toBeDefined();
  });

  it("narrows the queue by business date", async () => {
    await setSampling(1, true);
    const items = await queueOf(hr.client, `&businessDate=${dayStr(400)}`);
    expect(queueEntry(items, clocked["sample-flagged"].id)).toBeUndefined();
    expect(queueEntry(items, clocked["sample-valid"].id)).toBeUndefined();
  });

  it("a supervisor of the outlet accepts a flagged log, which becomes valid", async () => {
    await setSampling(1, true);
    const log = clocked["accept-flagged"];
    const reviewKey = key();
    const accepted = await post(
      manager.client,
      `/api/hris/attendance/logs/${log.id}/review`,
      { action: "accept", note: "Sudah dicek CCTV", idempotencyKey: reviewKey },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.log.id).toBe(log.id);
    expect(accepted.body.data.log.validity).toBe("valid");
    expect(accepted.body.data.reviewStatus).toBe("accepted");
    expect(accepted.body.data.reviewedBy).toBe(manager.userId);
    expect(accepted.body.data.reviewedAt).not.toBeNull();

    const logs = await collect(
      hr.client,
      `/api/hris/attendance/logs?employeeId=${log.employeeId}`,
    );
    expect(logs.find((item) => item.id === log.id)?.validity).toBe("valid");
    const done = await queueOf(hr.client, "&reviewStatus=accepted");
    expect(queueEntry(done, log.id)?.reviewStatus).toBe("accepted");

    const replay = await post(
      manager.client,
      `/api/hris/attendance/logs/${log.id}/review`,
      { action: "accept", idempotencyKey: reviewKey },
    );
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.reviewStatus).toBe("accepted");
  });

  it("HR rejects a valid log; a rejected log is final", async () => {
    const log = clocked["reject-valid"];
    const rejected = await post(
      hr.client,
      `/api/hris/attendance/logs/${log.id}/review`,
      { action: "reject", note: "Bukan di lokasi", idempotencyKey: key() },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.log.validity).toBe("rejected");
    expect(rejected.body.data.reviewStatus).toBe("rejected");

    for (const action of ["accept", "flag", "reject"]) {
      const again = await post(
        hr.client,
        `/api/hris/attendance/logs/${log.id}/review`,
        { action, idempotencyKey: key() },
      );
      expect(again.status, `${action}: ${JSON.stringify(again.body)}`).toBe(
        409,
      );
    }
    const logs = await collect(
      hr.client,
      `/api/hris/attendance/logs?employeeId=${log.employeeId}`,
    );
    expect(logs.find((item) => item.id === log.id)?.validity).toBe("rejected");
  });

  it("flags a valid log after the fact", async () => {
    const log = clocked["flag-valid"];
    const flagged = await post(
      hr.client,
      `/api/hris/attendance/logs/${log.id}/review`,
      { action: "flag", note: "Bukti baru masuk", idempotencyKey: key() },
    );
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);
    expect(flagged.body.data.log.validity).toBe("flagged");
    const logs = await collect(
      hr.client,
      `/api/hris/attendance/logs?employeeId=${log.employeeId}`,
    );
    expect(logs.find((item) => item.id === log.id)?.validity).toBe("flagged");
  });

  it("refuses to accept a log that is already valid (409)", async () => {
    const log = clocked["accept-valid"];
    const response = await post(
      hr.client,
      `/api/hris/attendance/logs/${log.id}/review`,
      { action: "accept", idempotencyKey: key() },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(409);
  });

  it("answers 404 or 422 for an unknown or malformed log id", async () => {
    const unknown = await post(
      hr.client,
      "/api/hris/attendance/logs/01ARZ3NDEKTSV4RRFFQ69G5FAV/review",
      { action: "reject", idempotencyKey: key() },
    );
    expect([404, 422], JSON.stringify(unknown.body)).toContain(unknown.status);
    const malformed = await post(
      hr.client,
      `/api/hris/attendance/logs/${randomUUID()}/review`,
      { action: "reject", idempotencyKey: key() },
    );
    expect([400, 404, 422], JSON.stringify(malformed.body)).toContain(
      malformed.status,
    );
  });

  it("limits the queue and decisions to authorised users", async () => {
    const log = clocked["sample-flagged"];
    const queuePath = `/api/hris/attendance/review-queue?outletId=${outlet.id}`;
    expect((await noAccess.client.get(queuePath)).status).toBe(403);
    expect((await agent(app).get(queuePath)).status).toBe(401);
    expect([403, 404]).toContain(
      (await managerOther.client.get(queuePath)).status,
    );

    const reviewPath = `/api/hris/attendance/logs/${log.id}/review`;
    const byStaff = await post(noAccess.client, reviewPath, {
      action: "reject",
      idempotencyKey: key(),
    });
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(403);
    const byOtherOutlet = await post(managerOther.client, reviewPath, {
      action: "reject",
      idempotencyKey: key(),
    });
    expect([403, 404], JSON.stringify(byOtherOutlet.body)).toContain(
      byOtherOutlet.status,
    );
    const anonymous = await post(agent(app), reviewPath, {
      action: "reject",
      idempotencyKey: key(),
    });
    expect(anonymous.status).toBe(401);

    // The log is untouched by the refused attempts.
    const logs = await collect(
      hr.client,
      `/api/hris/attendance/logs?employeeId=${log.employeeId}`,
    );
    expect(logs.find((item) => item.id === log.id)?.validity).toBe("flagged");
    // The other outlet's manager does not see this outlet's logs in its queue.
    const own = await collect(
      managerOther.client,
      "/api/hris/attendance/review-queue",
    );
    expect(queueEntry(own, log.id)).toBeUndefined();
  });
});

describe("hris.attendance.review own logs and sensitive data", () => {
  const deviceA = "a".repeat(64);
  const deviceB = "b".repeat(64);

  async function supervisorWithEmployee(label: string) {
    const actor = await signedInClient(label, { mfa: true });
    await assignRole(actor.userId, await templateRoleId("outlet_manager"), {
      type: "outlet",
      id: outlet.id,
    });
    await grantCustomRole(actor.userId, STAFF_PERMISSIONS, {
      type: "outlet",
      id: outlet.id,
    });
    const employeeId = await seedEmployee(actor.userId, outlet.id);
    return { ...actor, employeeId };
  }

  /** A flagged selfie/geo clock-in by `actor`, optionally from a device. */
  async function clockFlagged(actor: Actor, deviceIdHash: string | null) {
    const response = await post(actor.client, "/api/hris/attendance/clock", {
      type: "in",
      method: "selfie_geo",
      occurredAt: new Date().toISOString(),
      location: null,
      deviceIdHash,
      photoUploadRef: null,
      qrToken: null,
      idempotencyKey: key(),
    });
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data.validity).toBe("flagged");
    return response.body.data.id as string;
  }

  it("a supervisor cannot decide the review of their own log (403)", async () => {
    await setSampling(1, true);
    const supervisor = await supervisorWithEmployee("Penyelia Sendiri API");
    const logId = await clockFlagged(supervisor, null);
    for (const action of ["accept", "reject", "flag"]) {
      const own = await post(
        supervisor.client,
        `/api/hris/attendance/logs/${logId}/review`,
        { action, idempotencyKey: key() },
      );
      expect(own.status, `${action}: ${JSON.stringify(own.body)}`).toBe(403);
    }
    const queue = await queueOf(hr.client);
    expect(queueEntry(queue, logId)?.log.validity).toBe("flagged");
    expect(queueEntry(queue, logId)?.reviewStatus).not.toBe("accepted");

    // Another supervisor of the outlet still decides it.
    const other = await post(
      manager.client,
      `/api/hris/attendance/logs/${logId}/review`,
      { action: "accept", idempotencyKey: key() },
    );
    expect(other.status, JSON.stringify(other.body)).toBe(200);
  });

  it("returns the device hash to a reviewer only for their own log", async () => {
    await setSampling(1, true);
    const supervisor = await supervisorWithEmployee("Penyelia Perangkat API");
    const staff = await signedInClient("Staf Perangkat API");
    await grantCustomRole(staff.userId, STAFF_PERMISSIONS, {
      type: "outlet",
      id: outlet.id,
    });
    // This supervisor reviews only their own direct report.
    await seedEmployee(staff.userId, outlet.id, supervisor.employeeId);
    const staffLog = await clockFlagged(staff, deviceA);
    const ownLog = await clockFlagged(supervisor, deviceB);

    const asHr = await queueOf(hr.client);
    expect(queueEntry(asHr, staffLog)?.log.deviceIdHash).toBeNull();
    expect(queueEntry(asHr, ownLog)?.log.deviceIdHash).toBeNull();

    const asSupervisor = await queueOf(supervisor.client);
    expect(queueEntry(asSupervisor, staffLog)?.log.deviceIdHash).toBeNull();
    expect(queueEntry(asSupervisor, ownLog)?.log.deviceIdHash).toBe(deviceB);

    // A decision returns the same redacted item.
    const decided = await post(
      hr.client,
      `/api/hris/attendance/logs/${staffLog}/review`,
      { action: "accept", idempotencyKey: key() },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.log.deviceIdHash).toBeNull();
  });

  it("audits every selfie URL issued in the queue and on a decision", async () => {
    await setSampling(1, true);
    const first = await clockIn("photo-audit-a", "flagged");
    const second = await clockIn("photo-audit-b", "flagged");
    photoAuditedLogIds.push(first.id, second.id);
    await ownerTx((db) =>
      db.query(
        "UPDATE attendance_logs SET photo_key = 'photo-' || id::text WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
        [tenant.id, [first.employeeId, second.employeeId]],
      ),
    );
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.id),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const signer = vi.fn<AttendancePhotoSigner>(
      async (_context, photoKey) => `https://files.test/${photoKey}`,
    );
    const issued = async (logId: string) => {
      const { rows } = await owner.query(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'hris.attendance.photo_url_issued'`,
        [tenant.id, logId],
      );
      return rows.map((row) => row.event as JsonRow);
    };

    const page = await listAttendanceReviewQueue(
      context,
      hr.userId,
      { outletId: outlet.id, limit: 100 },
      signer,
    );
    for (const log of [first, second]) {
      const item = page.data.find((entry) => entry.log.id === log.id);
      expect(item?.log.photoUrl).toMatch(/^https:\/\/files\.test\/photo-/);
      const events = await issued(log.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.sensitiveAccess).toBe(true);
      expect(events[0]?.actorId).toBe(hr.userId);
    }

    await decideAttendanceReview(
      context,
      hr.userId,
      second.id,
      { action: "flag", idempotencyKey: key() },
      signer,
    );
    expect(await issued(first.id)).toHaveLength(1);
    expect(await issued(second.id)).toHaveLength(2);
  });
});

// ---- policy and sampling configuration -----------------------------------

describe("hris.attendance.policy", () => {
  it("stores an outlet override and reads it back with the sampling config", async () => {
    const policy = { ...BASE_POLICY, geofenceRadiusM: 137 };
    const written = await put(hr.client, "/api/hris/attendance/policy", {
      outletId: outlet.id,
      policy,
      sampling: {
        rate: 0.25,
        flaggedAlways: false,
        minPerSupervisorPerWeek: 3,
      },
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: outlet.id,
      inherited: false,
      policy,
      sampling: {
        rate: 0.25,
        flaggedAlways: false,
        minPerSupervisorPerWeek: 3,
      },
    });

    const read = await hr.client.get(
      `/api/hris/attendance/policy?outletId=${outlet.id}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({
      outletId: outlet.id,
      inherited: false,
      policy,
      sampling: {
        rate: 0.25,
        flaggedAlways: false,
        minPerSupervisorPerWeek: 3,
      },
    });

    // The manager of the outlet can read it too.
    const asManager = await manager.client.get(
      `/api/hris/attendance/policy?outletId=${outlet.id}`,
    );
    expect(asManager.status, JSON.stringify(asManager.body)).toBe(200);
    expect(asManager.body.data.policy.geofenceRadiusM).toBe(137);
    await setSampling(1, true);
  });

  it("returns the tenant default when no outlet is named, and rewrites it unchanged", async () => {
    const before = await ownerTx((db) =>
      db.query(
        "SELECT count(*)::int AS n FROM attendance_policies WHERE tenant_id = $1 AND outlet_id IS NULL",
        [tenant.id],
      ),
    );
    const read = await hr.client.get("/api/hris/attendance/policy");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.outletId).toBeNull();
    expect(read.body.data.tenantId).toBe(tenant.id);
    expect(typeof read.body.data.policy.geofenceRadiusM).toBe("number");

    // Writing back the values just read keeps the shared default unchanged.
    const rewritten = await put(hr.client, "/api/hris/attendance/policy", {
      outletId: null,
      policy: read.body.data.policy,
      sampling: read.body.data.sampling,
    });
    expect(rewritten.status, JSON.stringify(rewritten.body)).toBe(200);
    expect(rewritten.body.data).toMatchObject({
      outletId: null,
      inherited: false,
      policy: read.body.data.policy,
      sampling: read.body.data.sampling,
    });
    if (before.rows[0].n === 0)
      await ownerTx((db) =>
        db.query(
          "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id IS NULL",
          [tenant.id],
        ),
      );
  });

  it("refuses out-of-range policy and sampling values", async () => {
    const badRate = await put(hr.client, "/api/hris/attendance/policy", {
      outletId: outlet.id,
      policy: BASE_POLICY,
      sampling: sampling(1.5, true),
    });
    expect([400, 422], JSON.stringify(badRate.body)).toContain(badRate.status);
    const badRadius = await put(hr.client, "/api/hris/attendance/policy", {
      outletId: outlet.id,
      policy: { ...BASE_POLICY, geofenceRadiusM: 5 },
      sampling: sampling(0.5, true),
    });
    expect([400, 422], JSON.stringify(badRadius.body)).toContain(
      badRadius.status,
    );
    const read = await hr.client.get(
      `/api/hris/attendance/policy?outletId=${outlet.id}`,
    );
    expect(read.body.data.policy.geofenceRadiusM).toBe(150);
    expect(read.body.data.sampling.rate).toBe(1);
  });

  it("refuses a policy for an unknown outlet", async () => {
    const response = await put(hr.client, "/api/hris/attendance/policy", {
      outletId: randomUUID(),
      policy: BASE_POLICY,
      sampling: sampling(0.5, true),
    });
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("limits who may write the policy", async () => {
    const body = {
      outletId: outlet.id,
      policy: { ...BASE_POLICY, geofenceRadiusM: 999 },
      sampling: sampling(0.9, true),
    };
    const byStaff = await put(
      noAccess.client,
      "/api/hris/attendance/policy",
      body,
    );
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(403);
    const byOtherOutlet = await put(
      managerOther.client,
      "/api/hris/attendance/policy",
      body,
    );
    expect([403, 404], JSON.stringify(byOtherOutlet.body)).toContain(
      byOtherOutlet.status,
    );
    const tenantWide = await put(
      manager.client,
      "/api/hris/attendance/policy",
      {
        ...body,
        outletId: null,
      },
    );
    expect([403, 404], JSON.stringify(tenantWide.body)).toContain(
      tenantWide.status,
    );
    const anonymous = await put(
      agent(app),
      "/api/hris/attendance/policy",
      body,
    );
    expect(anonymous.status).toBe(401);
    const read = await hr.client.get(
      `/api/hris/attendance/policy?outletId=${outlet.id}`,
    );
    expect(read.body.data.policy.geofenceRadiusM).toBe(150);
  });
});

// ---- duty meals ----------------------------------------------------------

describe("hris.attendance.duty_meal", () => {
  const mealBody = (overrides: Record<string, unknown> = {}) => ({
    outletId: outlet.id,
    employeeId: employeeMealId,
    shiftAssignmentId: null,
    businessDate: "2026-03-03",
    mealCount: 1,
    idempotencyKey: key(),
    ...overrides,
  });

  it("records a duty meal once, however often the same request is sent", async () => {
    const body = mealBody();
    const first = await post(
      hr.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);
    expect(first.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: outlet.id,
      employeeId: employeeMealId,
      businessDate: "2026-03-03",
      mealCount: 1,
      shiftAssignmentId: null,
      recordedBy: hr.userId,
    });

    const replay = await post(
      hr.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);

    // Another key for the same employee, day and shift never stores a second
    // meal: it answers the stored one or a conflict.
    const other = await post(
      hr.client,
      "/api/hris/attendance/duty-meals",
      mealBody(),
    );
    expect([200, 201, 409], JSON.stringify(other.body)).toContain(other.status);
    if (other.status !== 409)
      expect(other.body.data.id).toBe(first.body.data.id);

    const listed = await collect(
      hr.client,
      `/api/hris/attendance/duty-meals?employeeId=${employeeMealId}&businessDate=2026-03-03`,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(first.body.data.id);
  });

  it("lists nothing for an employee without duty meals", async () => {
    const listed = await collect(
      hr.client,
      `/api/hris/attendance/duty-meals?employeeId=${randomUUID()}`,
    );
    expect(listed).toEqual([]);
  });

  it("refuses an invalid meal count", async () => {
    for (const mealCount of [0, 11, 1.5]) {
      const response = await post(
        hr.client,
        "/api/hris/attendance/duty-meals",
        mealBody({ businessDate: "2026-03-04", mealCount }),
      );
      expect(
        [400, 422],
        `${mealCount}: ${JSON.stringify(response.body)}`,
      ).toContain(response.status);
    }
    const listed = await collect(
      hr.client,
      `/api/hris/attendance/duty-meals?employeeId=${employeeMealId}&businessDate=2026-03-04`,
    );
    expect(listed).toEqual([]);
  });

  it("limits who may record duty meals", async () => {
    const body = mealBody({ businessDate: "2026-03-05" });
    const byStaff = await post(
      noAccess.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(403);
    const byOtherOutlet = await post(
      managerOther.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([403, 404], JSON.stringify(byOtherOutlet.body)).toContain(
      byOtherOutlet.status,
    );
    const anonymous = await post(
      agent(app),
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect(anonymous.status).toBe(401);
    const listed = await collect(
      hr.client,
      `/api/hris/attendance/duty-meals?employeeId=${employeeMealId}&businessDate=2026-03-05`,
    );
    expect(listed).toEqual([]);
  });
});

// ---- expectedEmployeeId guard (card legend-2boxs) -------------------------
//
// Assumptions (the card leaves these open):
//  - `expectedEmployeeId` is an optional body field on the correction request.
//    When present it must equal the caller's own employee id (compared
//    case-insensitively); otherwise the server refuses with 403 or 409 before
//    anything is written: no correction row, no approval request, no audit
//    event, no stored idempotency key.
//  - An id of an employee of another outlet or of another tenant is refused
//    the same way as a colleague's (never 404/422, so the answer does not
//    reveal whether the employee exists).
//  - A matching or omitted field behaves exactly as before (200 or 201).
describe("hris.attendance.correction expectedEmployeeId (legend-2boxs)", () => {
  const otherTenantId = randomUUID();
  const otherTenantEmployee = randomUUID();
  let colleagueEmployee: string;
  let otherOutletEmployee: string;

  beforeAll(async () => {
    colleagueEmployee = await seedEmployee(null, outlet.id);
    otherOutletEmployee = await seedEmployee(null, otherOutlet.id);
    // An employee of a different tenant. Replica mode skips the foreign keys
    // so no second tenant, brand or outlet has to be provisioned.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenantId],
      );
      await client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, NULL, $3, 'Karyawan Tenant Lain', $4, 'pkwtt', '2025-03-01', 'active')`,
        [
          otherTenantEmployee,
          otherTenantId,
          `XT-${otherTenantEmployee.slice(0, 8).toUpperCase()}`,
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenantId],
      );
      await client.query("DELETE FROM employees WHERE id = $1", [
        otherTenantEmployee,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  /** Everything a filed correction could leave behind for the requester. */
  async function footprint(idempotencyKey: string) {
    return ownerTx(async (db) => {
      const count = async (sql: string, params: unknown[]) =>
        Number((await db.query(sql, params)).rows[0].n);
      return {
        corrections: await count(
          "SELECT count(*) AS n FROM attendance_corrections WHERE tenant_id = $1 AND employee_id = $2",
          [tenant.id, employeeCorr],
        ),
        approvals: await count(
          "SELECT count(*) AS n FROM approval_requests WHERE tenant_id = $1 AND requested_by = $2",
          [tenant.id, corrStaff.userId],
        ),
        audits: await count(
          "SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'actorId' = $2",
          [tenant.id, corrStaff.userId],
        ),
        idempotency: await count(
          "SELECT count(*) AS n FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
          [tenant.id, idempotencyKey],
        ),
      };
    });
  }

  const file = (body: unknown) =>
    post(corrStaff.client, "/api/hris/attendance/corrections", body);

  // Every mismatch answers the same 409 + code, so nothing reveals whether
  // the expected id exists in another outlet or tenant.
  function expectIdentityMismatch(
    response: { status: number; body: unknown },
    label = "mismatch",
  ) {
    expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(
      409,
    );
    expect((response.body as { error?: { code?: string } }).error?.code).toBe(
      "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH",
    );
  }

  async function expectRefusedWithoutTrace(
    day: string,
    expectedEmployeeId: string,
  ) {
    const idempotencyKey = key();
    const before = await footprint(idempotencyKey);
    const response = await file(
      correctionBody(day, { expectedEmployeeId, idempotencyKey }),
    );
    expectIdentityMismatch(response);
    expect(await footprint(idempotencyKey)).toEqual(before);
    expect(await manualLogsAt(day)).toHaveLength(0);
  }

  it("refuses a colleague of the same outlet and leaves no trace", async () => {
    await expectRefusedWithoutTrace(dayStr(21), colleagueEmployee);
  });

  it("refuses an employee of another outlet and leaves no trace", async () => {
    await expectRefusedWithoutTrace(dayStr(22), otherOutletEmployee);
  });

  it("refuses an employee of another tenant and leaves no trace", async () => {
    await expectRefusedWithoutTrace(dayStr(23), otherTenantEmployee);
  });

  it("refuses an employee id that exists nowhere the same way", async () => {
    await expectRefusedWithoutTrace(dayStr(24), randomUUID());
  });

  it("files the correction when expectedEmployeeId is the caller's own employee", async () => {
    const day = dayStr(25);
    const idempotencyKey = key();
    const response = await file(
      correctionBody(day, { expectedEmployeeId: employeeCorr, idempotencyKey }),
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data.employeeId).toBe(employeeCorr);
    expect(response.body.data.status).toBe("pending");
    expect(await correctionStatus(response.body.data.id)).toBe("pending");
  });

  it("compares the expected id case-insensitively", async () => {
    const response = await file(
      correctionBody(dayStr(26), {
        expectedEmployeeId: employeeCorr.toUpperCase(),
      }),
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data.employeeId).toBe(employeeCorr);
  });

  it("behaves as before when expectedEmployeeId is omitted", async () => {
    const response = await file(correctionBody(dayStr(27)));
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data.employeeId).toBe(employeeCorr);
    expect(response.body.data.status).toBe("pending");
  });

  it("still refuses a malformed expectedEmployeeId as a validation error", async () => {
    const response = await file(
      correctionBody(dayStr(28), { expectedEmployeeId: "bukan-uuid" }),
    );
    expect([400, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("keeps refusing a mismatch when the same idempotency key is sent again", async () => {
    const day = dayStr(29);
    const idempotencyKey = key();
    const before = await footprint(idempotencyKey);
    const body = correctionBody(day, {
      expectedEmployeeId: colleagueEmployee,
      idempotencyKey,
    });
    for (const attempt of [1, 2]) {
      const response = await file(body);
      expectIdentityMismatch(response, `attempt ${attempt}`);
    }
    // A refused request must not store its key, or a later honest request
    // with the same key would replay a refusal (or worse, a success).
    expect(await footprint(idempotencyKey)).toEqual(before);
  });

  it("refuses a mismatch even when the key already filed a correction for the caller", async () => {
    const day = dayStr(30);
    const idempotencyKey = key();
    const first = await file(correctionBody(day, { idempotencyKey }));
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);
    const before = await footprint(idempotencyKey);
    const replay = await file(
      correctionBody(day, {
        idempotencyKey,
        expectedEmployeeId: colleagueEmployee,
      }),
    );
    expectIdentityMismatch(replay);
    expect(await footprint(idempotencyKey)).toEqual(before);
  });
});
