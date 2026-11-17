// Follow-ups of legend-72nod (overtime correction for frozen periods), brief
// docs/briefs/983-hr-sisa.md and brief 992. Fail-first: written before the fixes.
//
// legend-pxzhy  LOCK ORDER. Locking run T and a reversal REQUEST of an earlier
//   run S of the same tax year (S is a prior of T) must never deadlock
//   (SQLSTATE 40P01). The test makes the unlucky interleaving deterministic:
//   a holder transaction owns the advisory key(s) that a reversal request takes
//   (learned from the database itself, pg_locks, from a rolled-back probe
//   request, never from code), the reversal request queues first, the lock of T
//   queues second, then the holder commits. Whichever order the services take
//   their locks in, they must finish without 40P01. Money: nobody is paid twice
//   (LEMBUR_KOREKSI of the subject over all runs <= the delta, = delta when T
//   locked) and a bystander tenant's rows are untouched.
// legend-xrop2  AUDIT SCAN BOUND. The approve time of a chained request may be
//   read from the audit row `hris.overtime_request.approved` (brief 983 R3).
//   Only audit rows created at or after the earliest requestedAt of the
//   requests in question may count: an older row (any row older than the
//   request itself cannot be its approval) is ignored. The result of an
//   approve stays right.
//
// ASSUMPTIONS (spec silent)
//  - Audit approve row: event.action = 'hris.overtime_request.approved',
//    event.objectType = 'overtime_request', event.objectId = the request id,
//    created_at = the approve time (explicit; inserted with triggers off, the
//    retention trigger would force now()).
//  - Without a usable approve audit a cancelled chained request is held (brief
//    R3, covered by payroll-overtime-correction-983.test.ts): nothing deducted.
//  - A reversal request / lock racing each other may legitimately end in 4xx
//    (conflict); never in 5xx, never in 40P01.
//  - Run months: S = 2026-05, T = 06, U = 07 (same tax year).
//  - Expected amounts come from an ORACLE employee of S (approved before S was
//    locked), as in the 983 test file.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
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
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];
const createdRequests: string[] = [];
const createdTenants: string[] = [];

const key = () => `ot-lo-${randomUUID()}`;
const SALARY = 15_000_000;
const KOREKSI = "LEMBUR_KOREKSI";
const POTONGAN = "LEMBUR_KOREKSI_POTONGAN";
const APPROVED_ACTION = "hris.overtime_request.approved";
const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 24 * HOUR_MS;
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
        `OTLO ${roleId.slice(0, 8)}`,
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
      [world.entityId, tenant.id, `PT Urutan Kunci ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/** Attendance 'out' log (accepted) plus the overtime request of the day. */
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
      `otlo-${logId}`,
    ],
  );
  const inserted = await conn.query<{ id: string }>(
    `INSERT INTO overtime_requests
       (tenant_id, outlet_id, employee_id, formula_id, date, minutes, day_type, reason,
        status, requested_by, decided_by, decided_at, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, 'workday', 'Urutan kunci lembur', $7::varchar, $8,
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
  createdRequests.push(inserted.rows[0]!.id);
  return inserted.rows[0]!.id;
}

/** An active pkwtt employee TK/0 with NPWP, bank account and overtime requests in May 2026. */
async function makeEmployee(
  world: World,
  reqs: readonly OtSpec[] = [],
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: `Karyawan Urutan ${++counter}`,
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

const REVERSAL_REASON = "Salah hitung, dibatalkan";

async function requestReversal(runId: string) {
  const { requestPayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      payrollRunIdSchema.parse(runId),
      REVERSAL_REASON,
    ),
  );
}

async function approveReversal(runId: string) {
  const { decidePayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
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

type Settled =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown; status: number | undefined };

const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error,
      status: (error as { status?: number }).status,
    }),
  );

/** SQLSTATE 40P01, however the driver or ORM wrapped the error. */
function isDeadlock(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    const e = current as { code?: string; message?: string; cause?: unknown };
    if (e.code === "40P01" || /deadlock detected/i.test(String(e.message)))
      return true;
    current = e.cause;
  }
  return false;
}

const describeFailure = (s: Settled) =>
  s.ok
    ? "ok"
    : `${(s.error as { code?: string }).code ?? ""} ${s.status ?? ""} ${String((s.error as Error).message).slice(0, 200)}`;

// ---- payslip oracle -----------------------------------------------------

type Line = { componentCode: string; category: string; amountIdr: number };
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
  return { delta };
}

// ---- request changes after S was locked ----------------------------------

async function lockedAtOf(runId: string): Promise<Date> {
  const row = await scalar(
    "SELECT locked_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
    [tenant.id, runId],
  );
  if (!row.locked_at) throw new Error("run is not locked yet");
  return row.locked_at as Date;
}

async function simulatedAtOf(runId: string): Promise<Date> {
  const row = await scalar(
    "SELECT last_simulated_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
    [tenant.id, runId],
  );
  return row.last_simulated_at as Date;
}

/** One hour (plus `afterMs`) after the run was locked, from the run row. */
const lateAfter = async (runId: string, afterMs = 0) =>
  new Date((await lockedAtOf(runId)).getTime() + HOUR_MS + afterMs);

const approveLate = (requestId: string, at: Date) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests
            SET status = 'approved', decided_by = $3, decided_at = $4::timestamptz, updated_at = $4::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, approverUserId, at],
      ),
    true,
  );

const cancelLate = (requestId: string, at: Date) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests SET status = 'cancelled', updated_at = $3::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, at],
      ),
    true,
  );

/** Moves decision and update time of a request (chain case: decided early, settled late). */
const retimeRequest = (
  requestId: string,
  times: { decidedAt: Date; updatedAt: Date },
) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests SET decided_at = $3::timestamptz, updated_at = $4::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, times.decidedAt, times.updatedAt],
      ),
    true,
  );

/** The chain (approval_requests) the approver decided at `chainAt`, linked to the request. */
async function chainApproval(requestId: string, chainAt: Date) {
  const id = randomUUID();
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
          object_id, payload, requested_by, source, level, required_levels,
          required_steps, status, request_reason, decided_by, decided_at, reason,
          deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $1, 'hris', 'overtime_request', 'overtime_request', $4, '{}', $5,
               'user', 1, 1, '[]', 'approved', 'Lembur urutan kunci chain', $6, $7::timestamptz,
               'Disetujui', $7::timestamptz + interval '1 day',
               $7::timestamptz - interval '1 hour', $7::timestamptz)`,
      [
        id,
        tenant.id,
        outlet.id,
        requestId,
        lockerUserId,
        approverUserId,
        chainAt,
      ],
    ),
  );
  await asTenant((conn) =>
    conn.query(
      "UPDATE overtime_requests SET approval_chain_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, requestId, id],
    ),
  );
}

/**
 * Audit row `hris.overtime_request.approved` for a request at `createdAt`
 * (explicit; inserted with triggers off, the retention trigger would force now()).
 */
async function approveAudit(requestId: string, createdAt: Date) {
  const ulid = createUlid(createdAt.getTime());
  const event = {
    id: ulid,
    tenantId: tenant.id,
    outletId: outlet.id,
    actorType: "user",
    actorId: approverUserId,
    deviceId: null,
    action: APPROVED_ACTION,
    objectType: "overtime_request",
    objectId: requestId,
    reason: null,
    maskedChanges: {
      before: { status: "pending" },
      after: { status: "approved" },
    },
    ipHash: null,
    sensitiveAccess: false,
    retentionClass: "audit_2y",
    createdAt: createdAt.toISOString(),
  };
  await asTenant(
    (conn) =>
      conn.query(
        `INSERT INTO audit_logs (tenant_id, id, outlet_id, event, retention_class, created_at)
         VALUES ($1, $2, $3, $4::jsonb, 'audit_2y', $5::timestamptz)`,
        [
          tenant.id,
          ulidToUuid(ulid),
          outlet.id,
          JSON.stringify(event),
          createdAt,
        ],
      ),
    true,
  );
}

// ---- bystander tenant ------------------------------------------------------

/**
 * A second tenant with its own entity, policy and draft run. Its rows are
 * snapshotted before and after the race: nothing may change.
 */
async function bystander() {
  const tenantId = randomUUID();
  const entityId = randomUUID();
  const policyId = randomUUID();
  const runId = randomUUID();
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Penonton urutan kunci', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `otlo-${tenantId}`, lockerUserId],
  );
  await asTenant(
    async (conn) => {
      await conn.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Penonton', false)`,
        [entityId, tenantId],
      );
      await insertPolicy(conn, tenantId, entityId, policyId);
      await insertDraftRun(conn, {
        tenantId,
        runId,
        entityId,
        policyId,
        ...monthDates(T_MONTH),
      });
    },
    true,
    tenantId,
  );
  const snapshot = async () =>
    asTenant(
      async (conn) => {
        const runs = await conn.query(
          "SELECT to_jsonb(r) AS row FROM payroll_runs r WHERE tenant_id = $1 ORDER BY id",
          [tenantId],
        );
        const ledger = await conn.query(
          "SELECT count(*)::int AS n FROM payroll_overtime_corrections WHERE tenant_id = $1",
          [tenantId],
        );
        const slips = await conn.query(
          "SELECT count(*)::int AS n FROM payslips WHERE tenant_id = $1",
          [tenantId],
        );
        return JSON.stringify({
          runs: runs.rows,
          ledger: ledger.rows[0],
          slips: slips.rows[0],
        });
      },
      true,
      tenantId,
    );
  return { tenantId, snapshot };
}

// ---- advisory lock helpers (observed from pg_locks, not from code) ---------

class ProbeDone extends Error {
  constructor(readonly keys: string[]) {
    super("probe done");
  }
}

/**
 * The advisory keys a reversal request takes: a probe request on `runId` is
 * made inside a transaction that is rolled back right after pg_locks is read.
 */
async function reversalAdvisoryKeys(runId: string): Promise<string[]> {
  const { requestPayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  try {
    await withTenant(db, tenantScope(), async (tx) => {
      await requestPayrollRunReversalInTransaction(
        tx,
        tenantScope(),
        lockerUserId,
        payrollRunIdSchema.parse(runId),
        REVERSAL_REASON,
      );
      const result = await tx.execute(
        sql`SELECT ((classid::bigint << 32) | objid::bigint)::text AS key, objsubid
              FROM pg_locks
             WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
             ORDER BY 1`,
      );
      for (const row of result.rows)
        if (Number(row.objsubid) !== 1)
          throw new Error("unexpected two-int advisory key");
      throw new ProbeDone(result.rows.map((row) => String(row.key)));
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current; depth++) {
      if (current instanceof ProbeDone) return current.keys;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
  throw new Error("probe finished without reading the locks");
}

/** Distinct sessions waiting (not granted) on any of the keys. */
async function waiters(conn: PoolClient, keys: string[]): Promise<number> {
  const { rows } = await conn.query<{ n: number }>(
    `SELECT count(DISTINCT pid)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = ANY($1::bigint[])`,
    [keys],
  );
  return rows[0]!.n;
}

async function waitForWaiters(
  conn: PoolClient,
  keys: string[],
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await waiters(conn, keys)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OTLO locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("OTLO approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OTLO HR");
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
               'Urutan kunci lembur fixture', now(), $5, $5)`,
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
  const ownerTables = async (tenantIds: string[]) => {
    await asTenant(async (conn) => {
      for (const table of [
        "payroll_overtime_corrections",
        "payroll_overtime_correction_activations",
      ])
        if (
          (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
            .rows[0].t !== null
        )
          await conn.query(
            `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`,
            [tenantIds],
          );
    }, true);
  };
  try {
    await ownerTables([tenant.id, ...createdTenants]);
  } catch {
    // cleanup only
  }
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ot-lo-%'",
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
      "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = ANY($3::text[])",
      [tenant.id, APPROVED_ACTION, createdRequests],
    );
    await conn.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[]) AND request_reason = 'Lembur urutan kunci chain'",
      [tenant.id, createdUsers],
    );
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
      await asTenant(
        async (conn) => {
          for (const table of ["payroll_runs", "payroll_policies"])
            await conn.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
              tenantId,
            ]);
          await conn.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
            tenantId,
          ]);
        },
        true,
        tenantId,
      );
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    } catch {
      // cleanup only
    }
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-pxzhy: lock T and a reversal request of S (same tax year) take their locks in one order", () => {
  it("legend-pxzhy lock of T queued behind a reversal request of S finishes without 40P01, pays nobody twice and leaves another tenant alone", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!, await lateAfter(s));
    // T (June) is simulated and approved, not yet locked: it carries the correction.
    const t = await approvedRun(world, T_MONTH);
    const other = await bystander();
    const otherBefore = await other.snapshot();

    const keys = await reversalAdvisoryKeys(s);
    expect(
      keys.length,
      "a reversal request takes an advisory lock",
    ).toBeGreaterThan(0);

    const holder = await owner.connect();
    let reversal: Promise<Settled> | undefined;
    let locking: Promise<Settled> | undefined;
    let queuedReversal = false;
    let queuedBoth = false;
    try {
      await holder.query("BEGIN");
      for (const k of keys)
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [k]);

      // The reversal request queues first, the lock of T second.
      reversal = settle(requestReversal(s));
      queuedReversal = await waitForWaiters(holder, keys, 1, 30_000);
      locking = settle(lockRun(t));
      queuedBoth = await waitForWaiters(holder, keys, 2, 60_000);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    const [reversalResult, lockResult] = await Promise.all([
      reversal!,
      locking!,
    ]);

    expect(queuedReversal, "the reversal request queued on the held key").toBe(
      true,
    );
    expect(queuedBoth, "the lock of T queued on the held key too").toBe(true);
    // 1. No deadlock, whoever won.
    expect(
      isDeadlock(!reversalResult.ok ? reversalResult.error : null),
      `reversal request: ${describeFailure(reversalResult)}`,
    ).toBe(false);
    expect(
      isDeadlock(!lockResult.ok ? lockResult.error : null),
      `lock of T: ${describeFailure(lockResult)}`,
    ).toBe(false);
    // Neither transaction crashes (no 5xx); a refusal is a 4xx conflict. At
    // least one of them went through.
    for (const result of [reversalResult, lockResult])
      if (!result.ok) {
        expect(
          result.status ?? 0,
          `refused with 4xx, not a crash: ${describeFailure(result)}`,
        ).toBeGreaterThanOrEqual(400);
        expect(result.status ?? 0).toBeLessThan(500);
      }
    expect(reversalResult.ok || lockResult.ok, "not both refused").toBe(true);

    // 2. Money: the correction is paid exactly once over T and U, never
    // twice and never lost, whichever transaction won the race.
    const tStatus = await runStatus(t);
    expect(
      tStatus === "locked",
      `T is locked iff its lock succeeded (${describeFailure(lockResult)})`,
    ).toBe(lockResult.ok);
    const slipT = await slipOf(t, subject);
    if (tStatus === "locked") {
      expect(koreksiOf(slipT), "T paid the correction once").toBe(delta);
      // S is the source of a settled correction: it cannot be reversed now.
      expect(await runStatus(s), "S stays locked").toBe("locked");
      if (reversalResult.ok) {
        const refused = await settle(approveReversal(s));
        expect(refused.ok, "reversing the source S is refused").toBe(false);
        expect(refused.ok ? 0 : (refused.status ?? 0)).toBeGreaterThanOrEqual(
          400,
        );
        expect(refused.ok ? 0 : (refused.status ?? 0)).toBeLessThan(500);
        expect(await runStatus(s), "S still locked").toBe("locked");
      }
    } else {
      // The reversal request won and T was refused: T paid nothing.
      expect(koreksiOf(slipT), "an unlocked T paid nothing").toBe(0);
    }
    // U (July) must be buildable and lockable; it pays the correction only if
    // T did not.
    const u = await approvedRun(world, U_MONTH);
    const next = await settle(lockRun(u));
    expect(next.ok, `U locks: ${describeFailure(next)}`).toBe(true);
    const slipU = await slipOf(u, subject);
    expect(
      koreksiOf(slipT) + koreksiOf(slipU),
      "the correction is paid exactly once over T and U",
    ).toBe(delta);
    expect(
      tStatus === "locked" ? koreksiOf(slipU) : koreksiOf(slipT),
      "the run that did not pay it pays nothing",
    ).toBe(0);
    expect(
      koreksiOf(slipU) === delta || koreksiOf(slipT) === delta,
      "one run holds the whole delta",
    ).toBe(true);

    // 3. The other tenant is untouched.
    expect(await other.snapshot(), "other tenant unchanged").toBe(otherBefore);
  }, 600_000);
});

describe("legend-xrop2: the audit scan for approve times is bounded by created_at >= min(requestedAt)", () => {
  it("legend-xrop2 an approve audit row older than the request is not used: the chained, cancelled request stays held, nothing is deducted", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A, B_PENDING]);
    const control = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    expect(
      overtimeOf(await slipOf(s, subject)),
      "S pays A only",
    ).toBeGreaterThan(0);
    // The chain decided before S was simulated, the request was settled late
    // (outbox) and cancelled: no certain approve time -> held (brief R3).
    const chainAt = new Date((await simulatedAtOf(s)).getTime() - 30 * 60_000);
    const late = await lateAfter(s);
    await chainApproval(subject.reqs[1]!, chainAt);
    await approveLate(subject.reqs[1]!, late);
    await retimeRequest(subject.reqs[1]!, {
      decidedAt: chainAt,
      updatedAt: late,
    });
    // An approve audit row a year older than the request itself: it cannot
    // be this request's approval and must not be read.
    await approveAudit(subject.reqs[1]!, new Date(chainAt.getTime() - YEAR_MS));
    await cancelLate(subject.reqs[1]!, await lateAfter(s, 60_000));
    await cancelLate(control.reqs[0]!, await lateAfter(s, 60_000));

    const t = await lockedRun(world, T_MONTH);
    const u = await lockedRun(world, U_MONTH);

    expect(potonganOf(await slipOf(t, control)), "control").toBeGreaterThan(0);
    for (const run of [t, u]) {
      const slip = await slipOf(run, subject);
      expect(slip, "the employee is paid").toBeDefined();
      expect(koreksiOf(slip), "no LEMBUR_KOREKSI").toBe(0);
      expect(
        potonganOf(slip),
        "the old audit row did not make S look as if it paid B",
      ).toBe(0);
    }
  }, 900_000);

  it("legend-xrop2 [regression guard, passes before the fix too] an approve after S is still paid once in T when an old audit row of the same request exists", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    // Chained request approved after S was locked; its approve audit row is
    // in the bound. A year-old row of the same request lies outside the bound.
    const late = await lateAfter(s);
    await chainApproval(subject.reqs[1]!, late);
    await approveLate(subject.reqs[1]!, late);
    await approveAudit(subject.reqs[1]!, late);
    await approveAudit(
      subject.reqs[1]!,
      new Date((await simulatedAtOf(s)).getTime() - YEAR_MS),
    );

    const t = await lockedRun(world, T_MONTH);
    const slipT = await slipOf(t, subject);
    expect(koreksiOf(slipT), "approve result stays right").toBe(delta);
    expect(potonganOf(slipT)).toBe(0);
    const u = await lockedRun(world, U_MONTH);
    expect(koreksiOf(await slipOf(u, subject)), "and only once").toBe(0);
  }, 900_000);
});
