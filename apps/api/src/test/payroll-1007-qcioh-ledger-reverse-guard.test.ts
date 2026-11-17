// Overtime correction ledger: settled -> reversed only after the target run is
// really reversed (bead legend-qcioh, brief 1007, finding of second opinion 971).
// Fail-first: written before migration 0621 exists.
//
// RULES UNDER TEST (as the application role `legend_app`, not a superuser)
//  1. [target-locked] A direct UPDATE settled -> reversed of a correction row
//     whose target run T is still 'locked' is refused by the database
//     (PAYR-02, SQLSTATE 23514). The row stays settled, so the next run does
//     not pay the correction a second time.
//  2. [target-paid] Same refusal while T is 'paid'.
//  3. [target-reversed] The same UPDATE is accepted once T is really
//     'reversed'. Identity and amount of the row can never change (even then),
//     and a reversed row never goes back to settled.
//  4. [official-reversal] The official reversal of T still reopens the
//     correction exactly once; the next run pays it again once, and never more
//     than the delta in total over the runs that are not reversed.
//  5. [other-tenant] Rows of another tenant are never touched.
//
// ASSUMPTIONS (spec silent; from the brief)
//  - Refusal is identified by SQLSTATE 23514 and a message containing
//    "PAYR-02" (the family of the existing guard of this table).
//  - The brief's "total active corrections <= Rp100.000" is read as "never more
//    than the delta f(approved now) - f(paid in S)". The delta is taken from an
//    oracle employee of the same run S (no hard-coded amount), as in
//    payroll-overtime-correction-983.test.ts.
//  - "T reversed" without the service (rule 3) is made by the table owner with
//    triggers off on payroll_runs only, so the ledger row stays 'settled' while
//    T is 'reversed'. 'paid' is set the same way (paid_at and paid_by set).
//  - Run months: S = 2026-05, T = 06, U = 07, V = 08.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  createUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  approveSimulatedRun,
  deleteStatutoryTables,
  insertDraftRun,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
} from "./payroll-simulate-kit.ts";

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];
const createdTenants: string[] = [];

const key = () => `ot-1007-${randomUUID()}`;
const SALARY = 15_000_000;
const KOREKSI = "LEMBUR_KOREKSI";
const POTONGAN = "LEMBUR_KOREKSI_POTONGAN";
const HOUR_MS = 3_600_000;
const OT_PARAMETERS = {
  monthlyHoursDivisor: 173,
  tiersByDayType: {
    workday: [
      { fromHour: 0, toHour: 1, multiplier: "1.5000" },
      { fromHour: 1, toHour: null, multiplier: "2.0000" },
    ],
    rest_day_6_day_week: [
      { fromHour: 0, toHour: 7, multiplier: "2.0000" },
      { fromHour: 7, toHour: 8, multiplier: "3.0000" },
      { fromHour: 8, toHour: null, multiplier: "4.0000" },
    ],
    rest_day_5_day_week: [
      { fromHour: 0, toHour: 8, multiplier: "2.0000" },
      { fromHour: 8, toHour: 9, multiplier: "3.0000" },
      { fromHour: 9, toHour: null, multiplier: "4.0000" },
    ],
  },
  roundingMode: "half_up",
} as const;
let formulaId: string;

const tenantScope = (tenantId: string = tenant.id): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

/** As the table owner with the tenant GUCs; `raw` switches triggers off. */
async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  raw = false,
  tenantId: string = tenant.id,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

/** The same, as the application database role (the API's path). */
async function asAppRole<T>(
  run: (client: PoolClient) => Promise<T>,
  tenantId: string = tenant.id,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
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

type PgFailure = { code?: string; message?: string };
const appRoleFailure = (run: (client: PoolClient) => Promise<unknown>) =>
  asAppRole(run).then(
    () => null,
    (error: unknown) => error as PgFailure,
  );

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `OT1007 ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hr: Client;
let lockerUserId: string;
let approverUserId: string;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type OtSpec = {
  date: string;
  minutes: number;
  status: "approved" | "pending";
};
type Emp = { id: string; name: string; reqs: string[] };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Guard Ledger Lembur ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/**
 * Attendance 'out' log plus the overtime request of the day. Timestamps are
 * explicit (never the database now()): seeds sit one hour before the test
 * starts, `at` places a seed after the source run was locked.
 */
async function seedOvertime(
  conn: PoolClient,
  employeeId: string,
  spec: OtSpec,
  at: Date = new Date(Date.now() - HOUR_MS),
): Promise<string> {
  const logId = ulidToUuid(createUlid());
  await conn.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        validity, flag_reasons, business_date, overtime_minutes, client_event_id,
        review_status)
     VALUES ($1, $2, $3, $4, 'out', 'selfie_geo', ($5::date + time '12:00') AT TIME ZONE 'UTC', now(),
             'valid', '[]'::jsonb, $5::date, $6, $7, 'none')`,
    [
      logId,
      tenant.id,
      outlet.id,
      employeeId,
      spec.date,
      spec.minutes,
      `ot1007-${logId}`,
    ],
  );
  const inserted = await conn.query<{ id: string }>(
    `INSERT INTO overtime_requests
       (tenant_id, outlet_id, employee_id, formula_id, date, minutes, day_type, reason,
        status, requested_by, decided_by, decided_at, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, 'workday', 'Guard ledger lembur 1007', $7::varchar, $8,
             CASE WHEN $7::varchar = 'approved' THEN $9::text END,
             CASE WHEN $7::varchar = 'approved' THEN $10::timestamptz END,
             $10::timestamptz, $10::timestamptz)
     RETURNING id`,
    [
      tenant.id,
      outlet.id,
      employeeId,
      formulaId,
      spec.date,
      spec.minutes,
      spec.status,
      lockerUserId,
      approverUserId,
      at,
    ],
  );
  return inserted.rows[0]!.id;
}

/** An active pkwtt employee TK/0 on the base salary plus overtime requests. */
async function makeEmployee(
  world: World,
  reqs: readonly OtSpec[] = [],
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: `Karyawan Guard Ledger ${++counter}`,
    reqs: [],
  };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: emp.name,
      joinDate: "2025-03-01",
      ptkpStatus: "TK/0",
      taxScheme: "gross",
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      scheme: "gross",
      createdBy: lockerUserId,
    });
    for (const spec of reqs)
      emp.reqs.push(await seedOvertime(conn, emp.id, spec));
  });
  const put = await hr
    .put(`/api/hris/employees/${emp.id}/pii`)
    .set(originHeader)
    .send({
      nik: digits(16),
      npwp: digits(15),
      bankAccount: digits(12),
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return emp;
}

// ---- runs ---------------------------------------------------------------

type RunDates = { periodStart: string; periodEnd: string; payDate: string };

const monthDates = (m: number, year = 2026): RunDates => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-28`,
  };
};
const S_MONTH = 5;
const T_MONTH = 6;
const U_MONTH = 7;
const V_MONTH = 8;

async function draftRun(world: World, dates: RunDates): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...dates,
    }),
  );
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), lockerUserId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

async function requestReversal(runId: string) {
  const { requestPayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      payrollRunIdSchema.parse(runId),
      "Salah hitung, dibatalkan",
    ),
  );
}

async function reverseRun(runId: string) {
  const { decidePayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  await requestReversal(runId);
  await withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      approverUserId,
      payrollRunIdSchema.parse(runId),
      "approve",
    ),
  );
}

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

async function approvedRun(world: World, month: number) {
  const runId = await draftRun(world, monthDates(month));
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  return runId;
}

async function lockedRun(world: World, month: number) {
  const runId = await approvedRun(world, month);
  await lockRun(runId);
  expect(await runStatus(runId)).toBe("locked");
  return runId;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("Expected a failure");
}

// ---- late approval (makes a settled correction in T) --------------------

async function lateAt(sourceRunId: string): Promise<Date> {
  const row = await scalar(
    "SELECT locked_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
    [tenant.id, sourceRunId],
  );
  if (!row.locked_at) throw new Error("S is not locked yet");
  return new Date((row.locked_at as Date).getTime() + HOUR_MS);
}

/** Pending -> approved one hour after S was locked (explicit timestamps). */
const approveLate = async (requestId: string, sourceRunId: string) => {
  const when = await lateAt(sourceRunId);
  return asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests
            SET status = 'approved', decided_by = $3, decided_at = $4::timestamptz, updated_at = $4::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, approverUserId, when],
      ),
    true,
  );
};

// ---- payslip oracle -----------------------------------------------------

type Line = {
  componentCode: string;
  category: string;
  kind: string;
  amountIdr: number;
};
type Calc = { netIdr: number; lines: Line[] };

async function slipOf(runId: string, emp: Emp): Promise<Calc | undefined> {
  const rows = await asTenant(async (conn) =>
    (
      await conn.query<{
        id: string;
        calculation_encrypted: Buffer;
        pii_key_version: number;
      }>(
        `SELECT id, calculation_encrypted, pii_key_version
           FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows.map(
      (row) =>
        JSON.parse(
          openPayrollValue(
            row.calculation_encrypted,
            {
              tenantId: tenant.id,
              table: "payslips",
              rowId: row.id,
              field: "calculation",
            },
            row.pii_key_version,
          ),
        ) as Calc,
    ),
  );
  return rows[0];
}

const codeSum = (calc: Calc | undefined, code: string) =>
  (calc?.lines ?? [])
    .filter((l) => l.componentCode === code)
    .reduce((total, l) => total + l.amountIdr, 0);
const koreksiOf = (calc: Calc | undefined) => codeSum(calc, KOREKSI);
const potonganOf = (calc: Calc | undefined) => codeSum(calc, POTONGAN);
const overtimeOf = (calc: Calc | undefined) =>
  (calc?.lines ?? [])
    .filter(
      (l) =>
        l.category === "overtime" &&
        l.componentCode !== KOREKSI &&
        l.componentCode !== POTONGAN,
    )
    .reduce((total, l) => total + l.amountIdr, 0);

const A: OtSpec = { date: "2026-05-05", minutes: 60, status: "approved" };
const B_PENDING: OtSpec = {
  date: "2026-05-06",
  minutes: 60,
  status: "pending",
};
const B_APPROVED: OtSpec = { ...B_PENDING, status: "approved" };

/**
 * Subject (A approved, B pending) and oracle (A and B approved) of the same
 * run S: delta = LEMBUR(oracle) - LEMBUR(subject) is what B adds once approved.
 */
async function lateApprovalWorld() {
  const world = await makeWorld();
  const subject = await makeEmployee(world, [A, B_PENDING]);
  const oracle = await makeEmployee(world, [A, B_APPROVED]);
  return { world, subject, oracle };
}

async function deltaOfS(sourceRun: string, subject: Emp, oracle: Emp) {
  const subjectSlip = await slipOf(sourceRun, subject);
  const oracleSlip = await slipOf(sourceRun, oracle);
  expect(
    overtimeOf(subjectSlip),
    "S pays the approved request",
  ).toBeGreaterThan(0);
  const delta = overtimeOf(oracleSlip) - overtimeOf(subjectSlip);
  expect(delta, "the late request adds overtime pay").toBeGreaterThan(0);
  return delta;
}

/** S locked, B approved late, T locked: one settled correction row in T. */
async function settledCorrection() {
  const { world, subject, oracle } = await lateApprovalWorld();
  const s = await lockedRun(world, S_MONTH);
  const delta = await deltaOfS(s, subject, oracle);
  await approveLate(subject.reqs[1]!, s);
  const t = await lockedRun(world, T_MONTH);
  expect(koreksiOf(await slipOf(t, subject)), "T pays the delta").toBe(delta);
  return { world, subject, oracle, s, t, delta };
}

// ---- ledger access --------------------------------------------------------

type LedgerRow = {
  target_run_id: string;
  employee_id: string;
  source_run_id: string;
  direction: string;
  amount_idr: number;
  status: string;
  reversed_at: Date | null;
};

async function ledgerOf(
  tenantId: string,
  filter: { target?: string; employee?: string } = {},
): Promise<LedgerRow[]> {
  return asTenant(
    async (conn) =>
      (
        await conn.query<LedgerRow>(
          `SELECT target_run_id, employee_id, source_run_id, direction,
                  amount_idr::int AS amount_idr, status, reversed_at
             FROM payroll_overtime_corrections
            WHERE tenant_id = $1
              AND ($2::uuid IS NULL OR target_run_id = $2)
              AND ($3::uuid IS NULL OR employee_id = $3)
            ORDER BY created_at, target_run_id`,
          [tenantId, filter.target ?? null, filter.employee ?? null],
        )
      ).rows,
    false,
    tenantId,
  );
}

/** The direct UPDATE of the finding: settled -> reversed, as `legend_app`. */
const directReverse = (
  row: { target: string; employee: string; source: string },
  tenantId: string = tenant.id,
  extraSet = "",
) =>
  appRoleFailure((conn) =>
    conn.query(
      `UPDATE payroll_overtime_corrections
          SET status = 'reversed', reversed_at = now()${extraSet}
        WHERE tenant_id = $1 AND target_run_id = $2 AND employee_id = $3
          AND source_run_id = $4`,
      [tenantId, row.target, row.employee, row.source],
    ),
  );

function expectGuardRefusal(error: PgFailure | null, label: string) {
  expect(error, `${label}: the database refuses`).not.toBeNull();
  expect(error!.code, `${label}: check violation`).toBe("23514");
  expect(error!.message, `${label}: guard of the ledger`).toContain("PAYR-02");
}

/** Runs of `owner` set to a status without the service (triggers off). */
const forceRunStatus = (runId: string, status: "paid" | "reversed") =>
  asTenant(
    (conn) =>
      status === "paid"
        ? conn.query(
            `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'tester1007'
              WHERE tenant_id = $1 AND id = $2`,
            [tenant.id, runId],
          )
        : conn.query(
            `UPDATE payroll_runs SET status = 'reversed', reversal = '{"status":"approved"}'::jsonb
              WHERE tenant_id = $1 AND id = $2`,
            [tenant.id, runId],
          ),
    true,
  );

// ---- bystander tenant -------------------------------------------------------

/** Another tenant with one settled ledger row (ids are not real runs). */
async function bystander() {
  const tenantId = randomUUID();
  const row = {
    target: randomUUID(),
    employee: randomUUID(),
    source: randomUUID(),
  };
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Penonton guard ledger lembur', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `qcioh-${tenantId}`, lockerUserId],
  );
  // Triggers (guard and foreign keys) are off: the row only has to exist.
  await asTenant(
    (conn) =>
      conn.query(
        `INSERT INTO payroll_overtime_corrections
           (tenant_id, target_run_id, employee_id, source_run_id, direction, amount_idr)
         VALUES ($1, $2, $3, $4, 'positive', 12345)`,
        [tenantId, row.target, row.employee, row.source],
      ),
    true,
    tenantId,
  );
  const snapshot = async () => JSON.stringify(await ledgerOf(tenantId));
  return { tenantId, row, snapshot };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OT1007 locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("OT1007 approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OT1007 HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  // No tenant PPh 21 policy version: the default policy applies.
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
  formulaId = randomUUID();
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO overtime_formulas
         (id, tenant_id, version, effective_from, status, parameters, rest_day_type,
          legal_basis, published_at, published_by, created_by)
       VALUES ($1, $2, $3, '2026-01-01', 'published', $4, 'rest_day_6_day_week',
               'Guard ledger lembur 1007 fixture', now(), $5, $5)`,
      [
        formulaId,
        tenant.id,
        1_000_000 + Math.floor(Math.random() * 1_000_000_000),
        JSON.stringify(OT_PARAMETERS),
        lockerUserId,
      ],
    ),
  );
});

afterAll(async () => {
  const dropLedger = async (tenantId: string) => {
    try {
      await asTenant(
        async (conn) => {
          for (const table of [
            "payroll_overtime_corrections",
            "payroll_overtime_correction_activations",
          ])
            if (
              (
                await conn.query("SELECT to_regclass($1) AS t", [
                  `public.${table}`,
                ])
              ).rows[0].t !== null
            )
              await conn.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
                tenantId,
              ]);
        },
        true,
        tenantId,
      );
    } catch {
      // cleanup only
    }
  };
  await dropLedger(tenant.id);
  for (const tenantId of createdTenants) await dropLedger(tenantId);
  await asTenant(async (conn) => {
    for (const table of [
      "payroll_run_results",
      "payroll_run_month_priors",
      "payslip_bank_snapshots",
    ])
      if (
        (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
          .rows[0].t !== null
      )
        await conn.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
          [tenant.id, createdRuns],
        );
    await conn.query(
      "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ot-1007-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    await conn.query(
      "DELETE FROM overtime_requests WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM overtime_formulas WHERE tenant_id = $1 AND id = $2",
      [tenant.id, formulaId],
    );
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND code LIKE 'SM\\_%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      createdEntities,
    ]);
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRoles],
    );
  }, true);
  for (const tenantId of createdTenants) {
    try {
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    } catch {
      // cleanup only
    }
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-qcioh: ledger of overtime corrections is reversed only with its target run", () => {
  it("[target-locked] direct UPDATE settled -> reversed is refused while T is locked; the row stays settled and the next run does not pay again", async () => {
    const { world, subject, s, t, delta } = await settledCorrection();
    const other = await bystander();
    const otherBefore = await other.snapshot();
    const key = { target: t, employee: subject.id, source: s };

    const refused = await directReverse(key);
    expectGuardRefusal(refused, "T locked");

    const rows = await ledgerOf(tenant.id, {
      target: t,
      employee: subject.id,
    });
    expect(rows, "one row in T").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "settled",
      reversed_at: null,
      source_run_id: s,
      direction: "positive",
      amount_idr: delta,
    });
    expect(await runStatus(t), "T stays locked").toBe("locked");

    // The ledger is intact, so U does not pay the same hours a second time.
    const u = await lockedRun(world, U_MONTH);
    expect(koreksiOf(await slipOf(u, subject)), "not paid twice").toBe(0);
    expect(potonganOf(await slipOf(u, subject))).toBe(0);
    expect(await other.snapshot(), "other tenant unchanged").toBe(otherBefore);
  }, 900_000);

  it("[target-paid] direct UPDATE settled -> reversed is refused while T is paid", async () => {
    const { subject, s, t, delta } = await settledCorrection();
    await forceRunStatus(t, "paid");
    expect(await runStatus(t)).toBe("paid");

    const refused = await directReverse({
      target: t,
      employee: subject.id,
      source: s,
    });
    expectGuardRefusal(refused, "T paid");

    const rows = await ledgerOf(tenant.id, { target: t });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "settled",
      reversed_at: null,
      amount_idr: delta,
    });
  }, 600_000);

  it("[target-reversed] the same UPDATE is accepted once T is reversed; identity and amount never change, reversed never returns to settled; other tenant untouched", async () => {
    const { subject, s, t, delta } = await settledCorrection();
    const other = await bystander();
    const otherBefore = await other.snapshot();
    const key = { target: t, employee: subject.id, source: s };

    // Control of the refusal first (T is still locked): no side effect.
    expectGuardRefusal(await directReverse(key), "T locked");

    // T becomes 'reversed' without the service, so the ledger is not synced.
    await forceRunStatus(t, "reversed");
    expect(await runStatus(t)).toBe("reversed");
    expect(
      (await ledgerOf(tenant.id, { target: t }))[0]?.status,
      "still settled until the update",
    ).toBe("settled");

    // Identity and amount stay frozen even when T is reversed.
    const tamperAmount = await directReverse(
      key,
      tenant.id,
      ", amount_idr = amount_idr + 1",
    );
    expectGuardRefusal(tamperAmount, "amount changed");
    const tamperDirection = await directReverse(
      key,
      tenant.id,
      ", direction = 'negative'",
    );
    expectGuardRefusal(tamperDirection, "direction changed");
    // A settled -> settled edit is refused as before.
    const edit = await appRoleFailure((conn) =>
      conn.query(
        `UPDATE payroll_overtime_corrections SET amount_idr = amount_idr + 1
          WHERE tenant_id = $1 AND target_run_id = $2 AND employee_id = $3
            AND source_run_id = $4`,
        [tenant.id, t, subject.id, s],
      ),
    );
    expectGuardRefusal(edit, "settled edited");
    expect((await ledgerOf(tenant.id, { target: t }))[0]).toMatchObject({
      status: "settled",
      amount_idr: delta,
    });

    // The plain reversal is accepted now.
    expect(await directReverse(key), "T reversed: accepted").toBeNull();
    const rows = await ledgerOf(tenant.id, { target: t });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "reversed", amount_idr: delta });
    expect(rows[0]!.reversed_at).not.toBeNull();

    // A reversed row never goes back to settled.
    const back = await appRoleFailure((conn) =>
      conn.query(
        `UPDATE payroll_overtime_corrections SET status = 'settled', reversed_at = NULL
          WHERE tenant_id = $1 AND target_run_id = $2 AND employee_id = $3
            AND source_run_id = $4`,
        [tenant.id, t, subject.id, s],
      ),
    );
    expectGuardRefusal(back, "reversed -> settled");

    // Another tenant's row: invisible to this tenant's session, so an UPDATE
    // naming it changes nothing, and the row is exactly as before.
    const crossTenant = await asAppRole(
      (conn) =>
        conn.query(
          `UPDATE payroll_overtime_corrections
              SET status = 'reversed', reversed_at = now()
            WHERE tenant_id = $1 AND target_run_id = $2`,
          [other.tenantId, other.row.target],
        ),
      tenant.id,
    );
    expect(crossTenant.rowCount, "other tenant not reachable").toBe(0);
    expect(await other.snapshot(), "other tenant unchanged").toBe(otherBefore);
  }, 600_000);

  it("[official-reversal] reversing T through the service reopens the correction exactly once; the next run pays it once and never more than the delta", async () => {
    const { world, subject, s, t, delta } = await settledCorrection();
    const other = await bystander();
    const otherBefore = await other.snapshot();

    await reverseRun(t);
    expect(await runStatus(t)).toBe("reversed");

    const afterReversal = await ledgerOf(tenant.id, {
      target: t,
      employee: subject.id,
    });
    expect(afterReversal, "one row in T, not duplicated").toHaveLength(1);
    expect(afterReversal[0]).toMatchObject({
      status: "reversed",
      source_run_id: s,
      amount_idr: delta,
    });
    expect(afterReversal[0]!.reversed_at).not.toBeNull();

    // A second reversal of the same run is refused (4xx) and changes nothing.
    const again = await failure(reverseRun(t));
    expect(again.status ?? 0, again.message).toBeGreaterThanOrEqual(400);
    expect(again.status ?? 0, again.message).toBeLessThan(500);
    expect(
      await ledgerOf(tenant.id, { target: t, employee: subject.id }),
    ).toHaveLength(1);

    // Opened exactly once: U pays the delta, V pays nothing more.
    const u = await lockedRun(world, U_MONTH);
    expect(koreksiOf(await slipOf(u, subject)), "U pays it again").toBe(delta);
    const v = await lockedRun(world, V_MONTH);
    expect(koreksiOf(await slipOf(v, subject)), "and only once").toBe(0);

    // Active (settled) corrections of the employee never exceed the delta,
    // and the reversed row of T is not one of them.
    const all = await ledgerOf(tenant.id, { employee: subject.id });
    const active = all.filter((row) => row.status === "settled");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ target_run_id: u, source_run_id: s });
    expect(
      active.reduce((total, row) => total + row.amount_idr, 0),
      "total active correction <= delta",
    ).toBeLessThanOrEqual(delta);
    expect(all.filter((row) => row.status === "reversed")).toHaveLength(1);
    expect(await other.snapshot(), "other tenant unchanged").toBe(otherBefore);
  }, 900_000);
});
