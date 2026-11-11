// Fail-first tests for card legend-x0avw (Codex findings 2, 3, 4), written from
// docs/briefs/452-leave-codex-fixes.md and docs/briefs/452-plan.md, never from
// service code. Pattern: hris-attendance-leave-flag.test.ts,
// hris-attendance-leave-flag-outlet.test.ts, hris-leave-review-followups.test.ts,
// hris-leave-approve-flags-attendance.test.ts.
//
//  F2  migration 0258_leave_clash_backfill.sql: its LAST statement is one
//      idempotent UPDATE of public.attendance_logs that flags old clashes
//      (approved leave + `in` log on a covered date). The statement is read
//      from the file and re-run here (pattern inventory-uom-backfill-migration).
//  F3  review queue: a flagged log carrying `leave_approved` is always queued,
//      even when sampling.flaggedAlways is false; other flagged logs stay hidden.
//  F4  days in leave_requests.excluded_holiday_dates are NOT leave days: no flag
//      on clock-in or on approval, not returned by app.approved_leaves_on,
//      keep_leave answers 409 ATTENDANCE_LEAVE_NOT_APPROVED, accept is allowed.
//
// Assumptions (spec is silent, stated here and in the report):
//  - The backfill statement targets `public.attendance_logs`. To avoid touching
//    other test files' rows in the shared database, the test runs it against a
//    temporary updatable view limited to the seeded employees (the UPDATE
//    target is swapped for the view). If the statement cannot be scoped that
//    way, it runs unscoped.
//  - An accepted log (validity valid, review accepted) is reopened, like
//    app.flag_attendance_for_leave (0277); a rejected log and an `out` log are
//    never touched.
//  - A holiday known at request time is stored in leave excluded_holiday_dates;
//    the test sets it on the pending leave by SQL (the HTTP holiday path is not
//    under test here).
//  - Stale flag on a holiday-excluded day: HR may accept it (200), but
//    keep_leave is refused 409 ATTENDANCE_LEAVE_NOT_APPROVED.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
        `Leave clash backfill ${roleId.slice(0, 8)}`,
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
const key = () => `att-lcb-${randomUUID()}`;
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
        `LB-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-backfill ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Benturan Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LB-${id.slice(0, 8).toUpperCase()}`,
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
const noFlaggedSampling = {
  rate: 0,
  flaggedAlways: false,
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

  const admin = await signedInClient("HR Benturan Cuti", { mfa: true });
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
    code: `LCB_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji benturan",
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
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-lcb-%'",
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

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  manager: Client | null;
  today: string;
  year: number;
  seedLeave(input: {
    status: LeaveStatus;
    startOffsetDays: number;
    endOffsetDays: number;
    days: number;
    excludedOffsets?: number[];
  }): Promise<string>;
}

/** A fresh outlet (own review queue), staff, 12 leave days, optional outlet manager. */
async function newScenario(
  label: string,
  options: {
    sampling?: typeof alwaysSampling;
    withManager?: boolean;
  } = {},
): Promise<Scenario> {
  await avoidOutletMidnight();
  const outletId = await seedOutlet(label);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: options.sampling ?? alwaysSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Benturan ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  let manager: Client | null = null;
  if (options.withManager) {
    const managerSession = await signedInClient(`Manajer Benturan ${label}`, {
      mfa: true,
    });
    const roleId = await templateRoleId("outlet_manager");
    await asTenant((db) =>
      assign(db, managerSession.userId, roleId, {
        type: "outlet",
        id: outletId,
      }),
    );
    manager = managerSession.client;
  }

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
    manager,
    today,
    year,
    async seedLeave({
      status,
      startOffsetDays,
      endOffsetDays,
      days,
      excludedOffsets = [],
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
  };
}

interface SeedLog {
  type?: "in" | "out";
  validity: "valid" | "flagged" | "rejected";
  reviewStatus?: "none" | "pending" | "accepted" | "rejected";
  flagReasons?: string[];
  offsetDays: number;
}

/** Inserts a legacy attendance log straight into the table; returns its uuid. */
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
        `lcb-${randomUUID()}`,
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

async function dbLog(id: string): Promise<DbLog> {
  const { rows } = await asTenant((db) =>
    db.query<DbLog>(
      `SELECT validity, review_status, flag_reasons, reviewed_by, reviewed_at
         FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    ),
  );
  expect(rows[0], `log ${id} exists`).toBeDefined();
  return rows[0]!;
}

const countReason = (log: DbLog, reason: string) =>
  log.flag_reasons.filter((r) => r === reason).length;

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

async function clockIn(s: Scenario) {
  const response = await post(s.staff, "/api/hris/attendance/clock", clockInBody());
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; validity: string };
}

interface QueueItem {
  log: { id: string; validity: string; employeeId: string };
  source: string;
  flagReasons: string[];
  reviewStatus: string;
}

async function queueOf(s: Scenario, extra = ""): Promise<QueueItem[]> {
  const response = await hr.get(
    `/api/hris/attendance/review-queue?outletId=${s.outletId}${extra}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as QueueItem[];
}

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

const review = (logId: string, body: Record<string, unknown>) =>
  post(hr, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

// ---- F2: backfill migration 0258 -------------------------------------------

const MIGRATION = resolve(
  import.meta.dirname,
  "../../drizzle/0258_leave_clash_backfill.sql",
);

/** The migration's idempotent backfill UPDATE (a statement of its own). */
function backfillStatement(): string {
  expect(
    existsSync(MIGRATION),
    "apps/api/drizzle/0258_leave_clash_backfill.sql must exist",
  ).toBe(true);
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--.*$/gm, "").trim())
    .filter((part) => part.length > 0);
  const update = statements.find((part) =>
    /^UPDATE\s+(?:public\.)?"?attendance_logs"?/i.test(part),
  );
  expect(update, "0278 has one backfill UPDATE of attendance_logs").toBeDefined();
  return update!.replace(/;\s*$/, "");
}

/**
 * Runs the backfill as the table owner, narrowed to the given employees by
 * swapping the UPDATE target for a temporary updatable view, so rows that
 * parallel test files own are not touched.
 */
async function runBackfill(
  employeeIds: string[],
  options: { closedPeriodOffsets?: number[] } = {},
): Promise<void> {
  const sql = backfillStatement();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    // A locked payroll run per offset day, visible only inside this
    // transaction (removed again before the commit, so no other test sees it).
    const runIds: string[] = [];
    for (const offset of options.closedPeriodOffsets ?? []) {
      const runId = randomUUID();
      runIds.push(runId);
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO payroll_runs
           (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
            pay_date, status, config_snapshot, totals, approved_by_hr, approved_by_hr_at,
            approved_by_finance, approved_by_finance_at, locked_by, locked_at, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $5, $5, 'locked', '{"v":1}', '{"t":1}',
                 'hr-user', now(), 'finance-user', now(), 'lock-user', now(), 'lcb-test')`,
        [
          runId,
          tenant.id,
          cafeLegendPlatformFixtures.legalEntity.id,
          randomUUID(),
          dateAt(offset),
        ],
      );
      await client.query("SET LOCAL session_replication_role = origin");
    }
    const list = employeeIds.map((id) => `'${id}'::uuid`).join(", ");
    await client.query(
      `CREATE TEMP VIEW attendance_logs_scope AS
         SELECT * FROM public.attendance_logs WHERE employee_id IN (${list})`,
    );
    const scoped = sql.replace(
      /^UPDATE\s+(?:public\.)?"?attendance_logs"?/i,
      "UPDATE pg_temp.attendance_logs_scope",
    );
    await client.query(scoped);
    await client.query("DROP VIEW pg_temp.attendance_logs_scope");
    if (runIds.length > 0) {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM payroll_runs WHERE id = ANY($1::uuid[])", [
        runIds,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("[F2] 0278 backfill flags old leave + attendance clashes", () => {
  it("[F2] flags valid and accepted `in` logs inside an approved leave, leaves every other log alone", async () => {
    const s = await newScenario("f2a");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 3,
    });
    // pending leave on other dates: its logs are not a clash.
    await s.seedLeave({
      status: "pending",
      startOffsetDays: 4,
      endOffsetDays: 5,
      days: 2,
    });

    const valid = await seedLog(s, { validity: "valid", offsetDays: 0 });
    const accepted = await seedLog(s, {
      validity: "valid",
      reviewStatus: "accepted",
      offsetDays: -1,
    });
    const flaggedOther = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["outside_geofence"],
      offsetDays: 1,
    });
    const outsideAfter = await seedLog(s, { validity: "valid", offsetDays: 3 });
    const outsideBefore = await seedLog(s, {
      validity: "valid",
      offsetDays: -3,
    });
    const rejected = await seedLog(s, {
      validity: "rejected",
      reviewStatus: "rejected",
      offsetDays: 0,
    });
    const outLog = await seedLog(s, {
      type: "out",
      validity: "valid",
      offsetDays: 0,
    });
    const pendingLeaveDay = await seedLog(s, {
      validity: "valid",
      offsetDays: 4,
    });

    const unchangedBefore = new Map<string, DbLog>();
    for (const id of [
      outsideAfter,
      outsideBefore,
      rejected,
      outLog,
      pendingLeaveDay,
    ])
      unchangedBefore.set(id, await dbLog(id));

    await runBackfill([s.employeeId]);

    for (const id of [valid, accepted]) {
      const row = await dbLog(id);
      expect(row.validity).toBe("flagged");
      expect(row.review_status).toBe("pending");
      expect(countReason(row, "leave_approved")).toBe(1);
      expect(row.reviewed_by).toBeNull();
      expect(row.reviewed_at).toBeNull();
    }
    const other = await dbLog(flaggedOther);
    expect(other.validity).toBe("flagged");
    expect(other.review_status).toBe("pending");
    expect(other.flag_reasons).toEqual(["outside_geofence", "leave_approved"]);

    for (const [id, before] of unchangedBefore)
      expect(await dbLog(id), `log ${id} untouched`).toEqual(before);
  });

  it("[F2] running the backfill twice changes nothing the second time (idempotent)", async () => {
    const s = await newScenario("f2b");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 1,
      days: 2,
    });
    const first = await seedLog(s, { validity: "valid", offsetDays: 0 });
    const second = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["outside_geofence"],
      offsetDays: 1,
    });

    await runBackfill([s.employeeId]);
    const afterFirst = [await dbLog(first), await dbLog(second)];
    expect(afterFirst.map((row) => countReason(row, "leave_approved"))).toEqual([
      1, 1,
    ]);

    await runBackfill([s.employeeId]);
    expect([await dbLog(first), await dbLog(second)]).toEqual(afterFirst);
  });

  it("[F2] a log on a holiday-excluded day of an approved leave is not flagged", async () => {
    const s = await newScenario("f2c");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });
    const onHoliday = await seedLog(s, { validity: "valid", offsetDays: 0 });
    const onLeaveDay = await seedLog(s, { validity: "valid", offsetDays: 1 });
    const holidayBefore = await dbLog(onHoliday);

    await runBackfill([s.employeeId]);

    expect(await dbLog(onHoliday)).toEqual(holidayBefore);
    expect((await dbLog(onLeaveDay)).validity).toBe("flagged");
  });
});

describe("[P2-2] 0278 backfill leaves closed payroll periods alone", () => {
  it("[P2-2] a log on a day inside a locked payroll run is not reopened; a log on an open day is flagged", async () => {
    const s = await newScenario("p22");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 3,
    });
    const closedAccepted = await seedLog(s, {
      validity: "valid",
      reviewStatus: "accepted",
      offsetDays: 0,
    });
    const closedValid = await seedLog(s, { validity: "valid", offsetDays: -1 });
    const openAccepted = await seedLog(s, {
      validity: "valid",
      reviewStatus: "accepted",
      offsetDays: 1,
    });
    const closedBefore = [
      await dbLog(closedAccepted),
      await dbLog(closedValid),
    ];

    await runBackfill([s.employeeId], { closedPeriodOffsets: [0, -1] });

    expect([await dbLog(closedAccepted), await dbLog(closedValid)]).toEqual(
      closedBefore,
    );
    const open = await dbLog(openAccepted);
    expect(open.validity).toBe("flagged");
    expect(open.review_status).toBe("pending");
    expect(countReason(open, "leave_approved")).toBe(1);
  });
});

describe("[P2-2] app.flag_attendance_for_leave in a closed payroll period", () => {
  it("[P2-2] does not reopen an accepted log in a locked run, still flags a valid log there", async () => {
    const s = await newScenario("p22f");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 1,
      days: 2,
    });
    const accepted = await seedLog(s, {
      validity: "valid",
      reviewStatus: "accepted",
      offsetDays: 0,
    });
    const valid = await seedLog(s, { validity: "valid", offsetDays: 1 });
    const acceptedBefore = await dbLog(accepted);

    // Both days sit in a locked run that exists only inside this transaction,
    // which is rolled back after the reads.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO payroll_runs
           (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
            pay_date, status, config_snapshot, totals, approved_by_hr, approved_by_hr_at,
            approved_by_finance, approved_by_finance_at, locked_by, locked_at, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'locked', '{"v":1}', '{"t":1}',
                 'hr-user', now(), 'finance-user', now(), 'lock-user', now(), 'lcb-test')`,
        [
          randomUUID(),
          tenant.id,
          cafeLegendPlatformFixtures.legalEntity.id,
          randomUUID(),
          dateAt(0),
          dateAt(1),
        ],
      );
      await client.query("SET LOCAL session_replication_role = origin");
      const flagged = await client.query<{ log_id: string }>(
        "SELECT log_id FROM app.flag_attendance_for_leave($1::uuid, $2::uuid, $3::date, $4::date)",
        [tenant.id, s.employeeId, dateAt(0), dateAt(1)],
      );
      expect(flagged.rows.map((row) => row.log_id)).toEqual([valid]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await dbLog(accepted)).toEqual(acceptedBefore);
  });
});

// ---- F3: review queue with flaggedAlways=false -----------------------------

describe("[F3] review queue keeps leave_approved flags without flaggedAlways", () => {
  it("[F3] a clock-in on an approved leave day is queued even with flaggedAlways=false", async () => {
    const s = await newScenario("f3a", { sampling: noFlaggedSampling });
    await s.seedLeave({
      status: "approved",
      startOffsetDays: 0,
      endOffsetDays: 0,
      days: 1,
    });

    const log = await clockIn(s);
    expect(log.validity).toBe("flagged");

    const item = (await queueOf(s)).find((entry) => entry.log.id === log.id);
    expect(
      item,
      "leave_approved log must be queued without sampling",
    ).toBeDefined();
    expect(item).toMatchObject({ source: "flagged", reviewStatus: "pending" });
    expect(item?.flagReasons).toContain("leave_approved");
  });

  it("[F3] with flaggedAlways=false an ordinary flagged log stays hidden, a leave_approved one is shown", async () => {
    const s = await newScenario("f3b", { sampling: noFlaggedSampling });
    const plain = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["outside_geofence"],
      offsetDays: 0,
    });
    const leaveFlagged = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: -1,
    });

    const ids = (await queueOf(s)).map((entry) => toUuid(entry.log.id));
    expect(ids).toContain(leaveFlagged);
    expect(ids).not.toContain(plain);
  });

  it("[F3] with flaggedAlways=true both kinds are queued (unchanged)", async () => {
    const s = await newScenario("f3c");
    const plain = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["outside_geofence"],
      offsetDays: 0,
    });
    const leaveFlagged = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: -1,
    });

    const ids = (await queueOf(s)).map((entry) => toUuid(entry.log.id));
    expect(ids).toEqual(expect.arrayContaining([plain, leaveFlagged]));
  });
});

// ---- F4: holiday-excluded days are not leave days ---------------------------

describe("[F4] holiday-excluded leave days are not leave days", () => {
  it("[F4] a clock-in on an excluded holiday of an approved leave stays valid and is not queued", async () => {
    const s = await newScenario("f4a");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });

    const log = await clockIn(s);
    expect(log.validity).toBe("valid");
    const queued = (await queueOf(s)).filter((item) => item.log.id === log.id);
    expect(queued).toEqual([]);
  });

  it("[F4] approving a leave does not flag a log made on its holiday, but flags a log on a real leave day", async () => {
    const s = await newScenario("f4b", { withManager: true });
    const onHoliday = await clockIn(s);
    expect(onHoliday.validity).toBe("valid");
    const onLeaveDay = await seedLog(s, { validity: "valid", offsetDays: 1 });

    const requested = await post(s.staff, "/api/hris/leave/requests", {
      leaveTypeId,
      startDate: s.today,
      endDate: dateAt(1),
      reason: "Cuti uji hari libur",
      attachmentUploadRef: null,
      idempotencyKey: key(),
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    // The holiday is recorded on the pending leave (excluded date, 1 paid day),
    // as the request flow does for a holiday known at request time.
    await asTenant((db) =>
      db.query(
        `UPDATE leave_requests SET excluded_holiday_dates = $1::date[], days = '1'
          WHERE tenant_id = $2 AND id = $3`,
        [[s.today], tenant.id, requested.body.data.id],
      ),
    );

    const decided = await post(
      s.manager!,
      `/api/hris/leave/requests/${requested.body.data.id}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.status).toBe("approved");

    const queue = await queueOf(s);
    expect(
      queue.filter((item) => item.log.id === onHoliday.id),
      "holiday log must not be flagged",
    ).toEqual([]);
    const holidayLogs = await hr.get(
      `/api/hris/attendance/logs?employeeId=${s.employeeId}`,
    );
    expect(
      (holidayLogs.body.data as { id: string; validity: string }[]).find(
        (item) => item.id === onHoliday.id,
      )?.validity,
    ).toBe("valid");

    const flagged = await dbLog(onLeaveDay);
    expect(flagged.validity).toBe("flagged");
    expect(countReason(flagged, "leave_approved")).toBe(1);
  });

  it("[F4] app.approved_leaves_on omits a holiday-excluded date and still returns the real leave days", async () => {
    const s = await newScenario("f4c");
    const leaveId = await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });
    const leavesOn = (offset: number) =>
      asTenant((db) =>
        db.query<{ leave_request_id: string }>(
          "SELECT leave_request_id FROM app.approved_leaves_on($1::uuid, $2::uuid, $3::date)",
          [tenant.id, s.employeeId, dateAt(offset)],
        ),
      ).then((result) => result.rows.map((row) => row.leave_request_id));

    expect(await leavesOn(0), "holiday is not a leave day").toEqual([]);
    expect(await leavesOn(-1)).toEqual([leaveId]);
    expect(await leavesOn(1)).toEqual([leaveId]);
  });

  it("[F4] keep_leave on a log dated on an excluded holiday answers 409 ATTENDANCE_LEAVE_NOT_APPROVED", async () => {
    const s = await newScenario("f4d");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });
    // Stale flag from before the holiday was known.
    const stale = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: 0,
    });
    const apiId = await apiIdOf(s, stale);

    const kept = await review(apiId, { action: "keep_leave" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(409);
    expect(kept.body.error?.code, JSON.stringify(kept.body)).toBe(
      "ATTENDANCE_LEAVE_NOT_APPROVED",
    );
    expect((await dbLog(stale)).review_status).toBe("pending");
  });

  it("[F4] accept on a log dated on an excluded holiday is allowed", async () => {
    const s = await newScenario("f4e");
    await s.seedLeave({
      status: "approved",
      startOffsetDays: -1,
      endOffsetDays: 1,
      days: 2,
      excludedOffsets: [0],
    });
    const stale = await seedLog(s, {
      validity: "flagged",
      reviewStatus: "pending",
      flagReasons: ["leave_approved"],
      offsetDays: 0,
    });
    const apiId = await apiIdOf(s, stale);

    const accepted = await review(apiId, { action: "accept" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.reviewStatus).toBe("accepted");
    expect((await dbLog(stale)).review_status).toBe("accepted");
  });
});
