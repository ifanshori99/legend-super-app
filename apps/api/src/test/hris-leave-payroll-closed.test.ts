// Fail-first tests for card legend-0c5yg (money: payroll), written from
// docs/briefs/hris-leave-guard.md and the card contract, never from service
// code. Patterns: hris-leave-clash-backfill.test.ts, hris-leave-db.test.ts,
// hris-attendance-correction.test.ts (frozen payroll run helper).
//
// Contract: leave (create incl. backdated, approve, requester cancel, HR
// cancel_leave on a flagged log) that touches a date inside a locked / paid /
// reversed payroll run is refused with 409 PAYROLL_PERIOD_LOCKED. Nothing
// changes after the refusal (leave row, balances, attendance logs). Open
// periods keep working. app.flag_attendance_for_leave never flags or alters a
// log inside a closed run (no double pay, no double deduction).
//
// Assumptions (spec is silent, stated here and in the report):
//  - "Closed" = payroll_runs.status in locked, paid, reversed. Draft and
//    approved runs are open.
//  - Every scenario gets its own legal entity (and outlet), so a frozen run
//    only closes that scenario's employees; runs are deleted again in finally.
//  - A leave "touches" a date when the date is inside start..end, so a leave
//    that only partly overlaps a closed run is refused as a whole (limits
//    payout: doubt = restrict).
//  - HR cancel_leave cancels the whole leave; it is refused when ANY date of
//    that leave is in a closed run, even if the flagged log's own day is open.
//  - Requester cancel of an approved leave is the guarded cancel path; a
//    pending request holds no pay, so it is not tested here.
//  - P2-2 in hris-leave-clash-backfill.test.ts expects a `valid` log inside a
//    locked run to be flagged by app.flag_attendance_for_leave. This contract
//    replaces that: such a log is not flagged either. The engineer must update
//    that one assertion (line ~900).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const RUN_MARKER = "lpc-test";
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
const createdEntities: string[] = [];
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
        `Leave payroll closed ${roleId.slice(0, 8)}`,
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
const key = () => `lpc-${randomUUID()}`;
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

async function seedLegalEntity(label: string) {
  const id = randomUUID();
  createdEntities.push(id);
  await asTenant((db) =>
    db.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
      [id, tenant.id, `PT Uji Cuti Payroll ${label} ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

async function seedOutlet(label: string, legalEntityId: string) {
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
        legalEntityId,
        `LP-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-payroll ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Payroll', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LP-${id.slice(0, 8).toUpperCase()}`,
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
    [tenant.id, await templateRoleId("outlet_manager")],
  );

  const admin = await signedInClient("HR Cuti Payroll Tutup", { mfa: true });
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
    code: `LPC_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji payroll tutup",
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
    // Replica mode skips the payroll lock-chain guard for the cleanup delete.
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND created_by = $2",
      [tenant.id, RUN_MARKER],
    );
    await db.query("SET LOCAL session_replication_role = origin");
    await db.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lpc-%'",
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
    // Outlets and legal entities stay: audit_logs is append-only and
    // references the outlets (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

interface Scenario {
  outletId: string;
  legalEntityId: string;
  employeeId: string;
  staff: Client;
  manager: Client;
  today: string;
  seedLeave(input: {
    startOffsetDays: number;
    endOffsetDays: number;
    days: number;
  }): Promise<string>;
}

/** A fresh legal entity + outlet, staff, 12 leave days and an outlet manager. */
async function newScenario(label: string): Promise<Scenario> {
  await avoidOutletMidnight();
  const legalEntityId = await seedLegalEntity(label);
  const outletId = await seedOutlet(label, legalEntityId);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: alwaysSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Cuti Payroll ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  const managerSession = await signedInClient(`Manajer Cuti Payroll ${label}`, {
    mfa: true,
  });
  const managerRoleId = await templateRoleId("outlet_manager");
  await asTenant((db) =>
    assign(db, managerSession.userId, managerRoleId, {
      type: "outlet",
      id: outletId,
    }),
  );

  // A balance row for every calendar year the scenario's dates can reach.
  const years = new Set(
    [-8, 0, 8].map((offset) => Number(dateAt(offset).slice(0, 4))),
  );
  for (const year of years)
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
    legalEntityId,
    employeeId,
    staff: staffSession.client,
    manager: managerSession.client,
    today: dateAt(0),
    async seedLeave({ startOffsetDays, endOffsetDays, days }) {
      const id = randomUUID();
      const year = Number(dateAt(startOffsetDays).slice(0, 4));
      await asTenant(async (db) => {
        await db.query(
          `INSERT INTO leave_requests
             (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
              start_date, end_date, days, excluded_holiday_dates, status,
              requested_by, requested_at, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::date[], 'approved', $10,
                   clock_timestamp(), $11, now())`,
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
            staffSession.userId,
            hrUserId,
          ],
        );
        await db.query(
          `UPDATE leave_balances SET used_days = used_days + $1
            WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
          [String(days), tenant.id, employeeId, leaveTypeId, year],
        );
      });
      return id;
    },
  };
}

// ---- payroll run helper -----------------------------------------------------

type RunStatus =
  | "draft"
  | "simulated"
  | "hr_approved"
  | "approved"
  | "locked"
  | "paid"
  | "reversed";
const CLOSED_STATUSES = ["locked", "paid", "reversed"] as const;

/**
 * Inserts a payroll run for the scenario's legal entity on the given client.
 * Replica mode skips the lock-chain guard and the free-standing policy
 * reference, so one insert makes a frozen run.
 */
async function insertRun(
  client: PoolClient,
  s: Scenario,
  status: RunStatus,
  fromOffset: number,
  toOffset: number,
): Promise<string> {
  const id = randomUUID();
  const frozen = ["locked", "paid", "reversed"].includes(status);
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(
    `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
        pay_date, status, config_snapshot, totals, approved_by_hr, approved_by_hr_at,
        approved_by_finance, approved_by_finance_at, locked_by, locked_at,
        paid_by, paid_at, reversal, created_by)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, $7, '{"v":1}', '{"t":1}',
             'hr-user', now(), 'finance-user', now(),
             $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      id,
      tenant.id,
      s.legalEntityId,
      randomUUID(),
      dateAt(fromOffset),
      dateAt(toOffset),
      status,
      frozen ? "lock-user" : null,
      frozen ? new Date() : null,
      status === "paid" ? "pay-user" : null,
      status === "paid" ? new Date() : null,
      status === "reversed" ? JSON.stringify({ status: "approved" }) : null,
      RUN_MARKER,
    ],
  );
  await client.query("SET LOCAL session_replication_role = origin");
  return id;
}

/** Runs `body` while a payroll run exists (committed), removes it after. */
async function withRun(
  s: Scenario,
  status: RunStatus,
  fromOffset: number,
  toOffset: number,
  body: () => Promise<void>,
): Promise<void> {
  const runId = await asTenant((db) =>
    insertRun(db, s, status, fromOffset, toOffset),
  );
  try {
    await body();
  } finally {
    await asTenant(async (db) => {
      await db.query("SET LOCAL session_replication_role = replica");
      await db.query("DELETE FROM payroll_runs WHERE id = $1", [runId]);
    });
  }
}

// ---- readers and API helpers -----------------------------------------------

async function balancesOf(s: Scenario) {
  const { rows } = await asTenant((db) =>
    db.query<{ period_year: number; used_days: string; pending_days: string }>(
      `SELECT period_year, used_days::text, pending_days::text FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        ORDER BY period_year`,
      [tenant.id, s.employeeId, leaveTypeId],
    ),
  );
  return rows;
}

async function leaveRows(s: Scenario) {
  const { rows } = await asTenant((db) =>
    db.query<{ id: string; status: string }>(
      "SELECT id, status FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2 ORDER BY requested_at",
      [tenant.id, s.employeeId],
    ),
  );
  return rows;
}

async function leaveStatus(leaveId: string) {
  const { rows } = await asTenant((db) =>
    db.query<{ status: string }>(
      "SELECT status FROM leave_requests WHERE tenant_id = $1 AND id = $2",
      [tenant.id, leaveId],
    ),
  );
  return rows[0]?.status;
}

const requestLeaveRaw = (s: Scenario, startOffset: number, endOffset: number) =>
  post(s.staff, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: dateAt(startOffset),
    endDate: dateAt(endOffset),
    reason: "Cuti uji payroll tutup",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });

async function requestLeave(
  s: Scenario,
  startOffset: number,
  endOffset: number,
) {
  const response = await requestLeaveRaw(s, startOffset, endOffset);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

const decideAs = (
  client: Client,
  leaveId: string,
  action: "approve" | "reject" | "cancel",
) =>
  post(client, `/api/hris/leave/requests/${leaveId}/decision`, {
    action,
    ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
    idempotencyKey: key(),
  });

async function approveLeave(s: Scenario, leaveId: string) {
  const response = await decideAs(s.manager, leaveId, "approve");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("approved");
}

function expectLocked(response: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error?.code, JSON.stringify(response.body)).toBe(
    "PAYROLL_PERIOD_LOCKED",
  );
}

interface SeedLog {
  type?: "in" | "out";
  validity: "valid" | "flagged" | "rejected";
  reviewStatus?: "none" | "pending" | "accepted" | "rejected";
  flagReasons?: string[];
  offsetDays: number;
}

/** Inserts an attendance log straight into the table; returns its uuid. */
async function seedLog(s: Scenario, log: SeedLog): Promise<string> {
  const id = ulidToUuid(createUlid());
  const reviewStatus = log.reviewStatus ?? "none";
  const decided = reviewStatus === "accepted" || reviewStatus === "rejected";
  await asTenant((db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id,
          review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, 'selfie_geo', $6, now(), $7, $8::jsonb, $9, $10,
               $11, $12, $13)`,
      [
        id,
        tenant.id,
        s.outletId,
        s.employeeId,
        log.type ?? "in",
        new Date(Date.now() + log.offsetDays * DAY),
        log.validity,
        JSON.stringify(log.flagReasons ?? []),
        dateAt(log.offsetDays),
        `lpc-${randomUUID()}`,
        reviewStatus,
        decided ? hrUserId : null,
        decided ? new Date() : null,
      ],
    ),
  );
  return id;
}

interface DbLog {
  validity: string;
  review_status: string;
  flag_reasons: string[];
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

async function dbLogOn(db: PoolClient, id: string): Promise<DbLog> {
  const { rows } = await db.query<DbLog>(
    `SELECT validity, review_status, flag_reasons, reviewed_by, reviewed_at
       FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, id],
  );
  expect(rows[0], `log ${id} exists`).toBeDefined();
  return rows[0]!;
}

const dbLog = (id: string) => asTenant((db) => dbLogOn(db, id));

const countReason = (log: DbLog, reason: string) =>
  log.flag_reasons.filter((r) => r === reason).length;

const looksLikeUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
const toUuid = (id: string) => (looksLikeUuid(id) ? id : ulidToUuid(id));

/** The id the HTTP API uses for a log whose database uuid we know. */
async function apiIdOf(s: Scenario, uuid: string) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const found = (response.body.data as { id: string }[]).find(
    (item) => toUuid(item.id) === uuid,
  );
  expect(found, "seeded log listed by the API").toBeDefined();
  return found!.id;
}

const reviewLog = (logId: string, body: Record<string, unknown>) =>
  post(hr, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

// ---- create (incl. backdated) -----------------------------------------------

describe("[legend-0c5yg] leave create in a closed payroll period", () => {
  for (const status of CLOSED_STATUSES) {
    it(`[0c5yg] create inside a ${status} run is refused 409 PAYROLL_PERIOD_LOCKED and changes nothing`, async () => {
      const s = await newScenario(`create-${status}`);
      const balancesBefore = await balancesOf(s);

      await withRun(s, status, -2, 2, async () => {
        const response = await requestLeaveRaw(s, 0, 1);
        expectLocked(response);
      });

      expect(await leaveRows(s), "no leave request stored").toEqual([]);
      expect(await balancesOf(s)).toEqual(balancesBefore);
    });
  }

  it("[0c5yg] backdated create inside a closed run is refused 409 PAYROLL_PERIOD_LOCKED", async () => {
    const s = await newScenario("create-backdated");
    const balancesBefore = await balancesOf(s);

    await withRun(s, "locked", -5, -1, async () => {
      const response = await requestLeaveRaw(s, -3, -2);
      expectLocked(response);
    });

    expect(await leaveRows(s)).toEqual([]);
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg] a leave that only partly overlaps a closed run (last day inside) is refused as a whole", async () => {
    const s = await newScenario("create-straddle");
    const balancesBefore = await balancesOf(s);

    await withRun(s, "locked", 3, 3, async () => {
      const response = await requestLeaveRaw(s, 0, 3);
      expectLocked(response);
    });

    expect(await leaveRows(s)).toEqual([]);
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg] once the period is no longer closed the same request goes through", async () => {
    const s = await newScenario("create-after");
    await withRun(s, "locked", -2, 2, async () => {
      expectLocked(await requestLeaveRaw(s, 0, 1));
    });
    const created = await requestLeaveRaw(s, 0, 1);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe("pending");
  });

  it("[0c5yg] a closed run on other dates does not block a current or a backdated request", async () => {
    const s = await newScenario("create-elsewhere");
    await withRun(s, "locked", -20, -10, async () => {
      const current = await requestLeaveRaw(s, 0, 1);
      expect(current.status, JSON.stringify(current.body)).toBe(201);
      const backdated = await requestLeaveRaw(s, -4, -3);
      expect(backdated.status, JSON.stringify(backdated.body)).toBe(201);
    });
  });

  for (const status of ["draft", "approved"] as const) {
    it(`[0c5yg] a ${status} (open) run covering the dates does not block the request`, async () => {
      const s = await newScenario(`create-open-${status}`);
      await withRun(s, status, -2, 2, async () => {
        const response = await requestLeaveRaw(s, 0, 1);
        expect(response.status, JSON.stringify(response.body)).toBe(201);
      });
    });
  }
});

// ---- approve ----------------------------------------------------------------

describe("[legend-0c5yg] leave approve in a closed payroll period", () => {
  it("[0c5yg] approving a pending leave whose dates are now in a closed run is refused 409 and nothing changes", async () => {
    const s = await newScenario("approve-closed");
    const leaveId = await requestLeave(s, 0, 1);
    const logToday = await seedLog(s, { validity: "valid", offsetDays: 0 });
    const logBefore = await dbLog(logToday);
    const balancesBefore = await balancesOf(s);
    expect(
      balancesBefore.some((row) => Number(row.pending_days) > 0),
      "pending days are held after the request",
    ).toBe(true);

    await withRun(s, "paid", -1, 1, async () => {
      expectLocked(await decideAs(s.manager, leaveId, "approve"));
    });

    expect(await leaveStatus(leaveId)).toBe("pending");
    expect(await balancesOf(s)).toEqual(balancesBefore);
    // No double deduction: the day's log is neither flagged nor reopened.
    expect(await dbLog(logToday)).toEqual(logBefore);
    expect(countReason(await dbLog(logToday), "leave_approved")).toBe(0);

    // The refusal left the request decidable: with the period open it works.
    await approveLeave(s, leaveId);
    expect(await leaveStatus(leaveId)).toBe("approved");
  });

  it("[0c5yg] approve with only the last leave day inside a reversed run is refused 409", async () => {
    const s = await newScenario("approve-straddle");
    const leaveId = await requestLeave(s, 0, 2);
    const balancesBefore = await balancesOf(s);

    await withRun(s, "reversed", 2, 4, async () => {
      expectLocked(await decideAs(s.manager, leaveId, "approve"));
    });

    expect(await leaveStatus(leaveId)).toBe("pending");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg] open period: create and approve still work, balances move once, the clash log is flagged once", async () => {
    const s = await newScenario("approve-open");
    const logToday = await seedLog(s, { validity: "valid", offsetDays: 0 });

    // A closed run elsewhere must not interfere.
    await withRun(s, "locked", -20, -10, async () => {
      const leaveId = await requestLeave(s, 0, 1);
      await approveLeave(s, leaveId);
      expect(await leaveStatus(leaveId)).toBe("approved");
    });

    const rows = await balancesOf(s);
    const used = rows.reduce((sum, row) => sum + Number(row.used_days), 0);
    const pending = rows.reduce(
      (sum, row) => sum + Number(row.pending_days),
      0,
    );
    expect(used).toBe(2);
    expect(pending).toBe(0);

    const flagged = await dbLog(logToday);
    expect(flagged.validity).toBe("flagged");
    expect(countReason(flagged, "leave_approved")).toBe(1);
  });
});

// ---- requester cancel -------------------------------------------------------

describe("[legend-0c5yg] requester cancel in a closed payroll period", () => {
  it("[0c5yg] cancelling an approved leave whose dates are in a closed run is refused 409; the leave and balances stay", async () => {
    const s = await newScenario("cancel-closed");
    const leaveId = await requestLeave(s, 2, 3);
    await approveLeave(s, leaveId);
    const balancesBefore = await balancesOf(s);

    await withRun(s, "locked", 3, 5, async () => {
      expectLocked(await decideAs(s.staff, leaveId, "cancel"));
    });

    expect(await leaveStatus(leaveId)).toBe("approved");
    expect(await balancesOf(s), "no days handed back").toEqual(balancesBefore);

    // Open period control: the cancel works and the days come back once.
    const cancelled = await decideAs(s.staff, leaveId, "cancel");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    const used = (await balancesOf(s)).reduce(
      (sum, row) => sum + Number(row.used_days),
      0,
    );
    expect(used).toBe(0);
  });

  it("[0c5yg] a paid run covering every leave day also refuses the cancel", async () => {
    const s = await newScenario("cancel-paid");
    const leaveId = await requestLeave(s, 2, 3);
    await approveLeave(s, leaveId);
    const balancesBefore = await balancesOf(s);

    await withRun(s, "paid", 1, 4, async () => {
      expectLocked(await decideAs(s.staff, leaveId, "cancel"));
    });

    expect(await leaveStatus(leaveId)).toBe("approved");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });
});

// ---- HR cancel_leave on a flagged log --------------------------------------

describe("[legend-0c5yg] HR cancel_leave (cancelApprovedLeaveOnDateByHr) in a closed payroll period", () => {
  /** Approved leave -1..+1 via the API, then a flagged log on `logOffset`. */
  async function flaggedScenario(label: string, logOffset: number) {
    const s = await newScenario(label);
    const leaveId = await requestLeave(s, -1, 1);
    await approveLeave(s, leaveId);
    const logId = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: logOffset,
    });
    return { s, leaveId, logId, apiId: await apiIdOf(s, logId) };
  }

  it("[0c5yg] cancel_leave on a log whose day is in a closed run is refused 409; leave, balance and log stay", async () => {
    const { s, leaveId, logId, apiId } = await flaggedScenario("hr-closed", 0);
    const balancesBefore = await balancesOf(s);
    const logBefore = await dbLog(logId);

    await withRun(s, "locked", 0, 0, async () => {
      expectLocked(await reviewLog(apiId, { action: "cancel_leave" }));
    });

    expect(await leaveStatus(leaveId)).toBe("approved");
    expect(await balancesOf(s)).toEqual(balancesBefore);
    expect(await dbLog(logId)).toEqual(logBefore);
  });

  it("[0c5yg] cancel_leave is refused 409 when another day of the leave is in a closed run, even if the log's own day is open", async () => {
    const { s, leaveId, logId, apiId } = await flaggedScenario("hr-other", 0);
    const balancesBefore = await balancesOf(s);
    const logBefore = await dbLog(logId);

    // Only yesterday is frozen; cancelling the leave would change its pay.
    await withRun(s, "paid", -1, -1, async () => {
      expectLocked(await reviewLog(apiId, { action: "cancel_leave" }));
    });

    expect(await leaveStatus(leaveId)).toBe("approved");
    expect(await balancesOf(s)).toEqual(balancesBefore);
    expect(await dbLog(logId)).toEqual(logBefore);
  });

  it("[0c5yg] open period: cancel_leave still cancels the leave and hands the days back once", async () => {
    // One-day leave: cancelling a day of a longer leave splits it (the
    // range narrows, the status stays approved), only a lone day cancels.
    const s = await newScenario("hr-open");
    const leaveId = await requestLeave(s, 0, 0);
    await approveLeave(s, leaveId);
    expect(
      (await balancesOf(s)).reduce(
        (sum, row) => sum + Number(row.used_days),
        0,
      ),
    ).toBe(1);
    const logId = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: 0,
    });
    const apiId = await apiIdOf(s, logId);

    await withRun(s, "locked", -20, -10, async () => {
      const cancelled = await reviewLog(apiId, { action: "cancel_leave" });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    });

    expect(await leaveStatus(leaveId)).toBe("cancelled");
    const used = (await balancesOf(s)).reduce(
      (sum, row) => sum + Number(row.used_days),
      0,
    );
    expect(used).toBe(0);
  });
});

// ---- SQL flag function ------------------------------------------------------

describe("[legend-0c5yg] app.flag_attendance_for_leave and closed payroll runs", () => {
  /**
   * Runs the function inside a transaction that holds a payroll run and is
   * rolled back after `read`, so no other test ever sees the run or the flags.
   */
  async function inRunTx<T>(
    s: Scenario,
    status: RunStatus,
    fromOffset: number,
    toOffset: number,
    read: (db: PoolClient, flagged: string[]) => Promise<T>,
    fromDate = dateAt(-1),
    toDate = dateAt(1),
  ): Promise<T> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      await insertRun(client, s, status, fromOffset, toOffset);
      const flagged = await client.query<{ log_id: string }>(
        "SELECT log_id FROM app.flag_attendance_for_leave($1::uuid, $2::uuid, $3::date, $4::date)",
        [tenant.id, s.employeeId, fromDate, toDate],
      );
      return await read(
        client,
        flagged.rows.map((row) => row.log_id),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  for (const status of CLOSED_STATUSES) {
    it(`[0c5yg] ${status} run: valid and accepted logs inside it are neither flagged nor altered, an open-day log is flagged`, async () => {
      const s = await newScenario(`fn-${status}`);
      await s.seedLeave({ startOffsetDays: -1, endOffsetDays: 1, days: 3 });
      const closedValid = await seedLog(s, {
        validity: "valid",
        offsetDays: 0,
      });
      const closedAccepted = await seedLog(s, {
        validity: "valid",
        reviewStatus: "accepted",
        offsetDays: -1,
      });
      const openValid = await seedLog(s, { validity: "valid", offsetDays: 1 });
      const closedValidBefore = await dbLog(closedValid);
      const closedAcceptedBefore = await dbLog(closedAccepted);

      // Run covers yesterday and today; tomorrow stays open.
      await inRunTx(s, status, -1, 0, async (db, flagged) => {
        expect(flagged, "only the open-day log is returned as flagged").toEqual(
          [openValid],
        );
        expect(await dbLogOn(db, closedValid)).toEqual(closedValidBefore);
        expect(await dbLogOn(db, closedAccepted)).toEqual(closedAcceptedBefore);
        const open = await dbLogOn(db, openValid);
        expect(open.validity).toBe("flagged");
        expect(countReason(open, "leave_approved")).toBe(1);
      });
    });
  }

  it("[0c5yg] a closed run covering every leave day flags nothing at all", async () => {
    const s = await newScenario("fn-all-closed");
    await s.seedLeave({ startOffsetDays: 0, endOffsetDays: 1, days: 2 });
    const first = await seedLog(s, { validity: "valid", offsetDays: 0 });
    const second = await seedLog(s, { validity: "valid", offsetDays: 1 });
    const firstBefore = await dbLog(first);
    const secondBefore = await dbLog(second);

    await inRunTx(
      s,
      "locked",
      0,
      1,
      async (db, flagged) => {
        expect(flagged).toEqual([]);
        expect(await dbLogOn(db, first)).toEqual(firstBefore);
        expect(await dbLogOn(db, second)).toEqual(secondBefore);
      },
      dateAt(0),
      dateAt(1),
    );
  });

  it("[0c5yg] an open (draft) run does not stop the function from flagging", async () => {
    const s = await newScenario("fn-draft");
    await s.seedLeave({ startOffsetDays: 0, endOffsetDays: 1, days: 2 });
    const first = await seedLog(s, { validity: "valid", offsetDays: 0 });

    await inRunTx(
      s,
      "draft",
      0,
      1,
      async (db, flagged) => {
        expect(flagged).toEqual([first]);
        const row = await dbLogOn(db, first);
        expect(row.validity).toBe("flagged");
        expect(countReason(row, "leave_approved")).toBe(1);
      },
      dateAt(0),
      dateAt(1),
    );
  });
});
