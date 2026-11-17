// Overtime correction ("rapel lembur") for frozen periods (bead legend-72nod,
// brief docs/briefs/983-hr-sisa.md, "Rancangan Kartu C"). Fail-first: written
// before the feature exists.
//
// RULES UNDER TEST (real runs: simulate -> approve -> lock -> reversal)
//  1. [late-approval] Overtime approved after the source run S was locked is
//     paid in the next run T as ONE earning line LEMBUR_KOREKSI whose amount
//     is the difference f(approved now) - f(paid in S). Once T is locked the
//     line never shows up again in a later run.
//  2. [repeat] Repeated corrections never pay the same hours twice: after a
//     cancelled request is replaced by an identical approved one nothing more
//     is paid; approve-then-cancel pays back at most what was paid. Total
//     settled over all runs never exceeds the delta.
//  3. [cancel-after-lock] Overtime cancelled after S was locked becomes a
//     deduction line LEMBUR_KOREKSI_POTONGAN in T (never more than the LEMBUR
//     paid on the slip of S), capped by the remaining wage; what does not fit
//     stays outstanding and is deducted in later runs, never ignored, never
//     more than the LEMBUR of the slip of S in total.
//  4. [offboarding-held] An employee with an open / revoked / completed
//     offboarding gets neither LEMBUR_KOREKSI nor LEMBUR_KOREKSI_POTONGAN
//     (held for manual handling).
//  5. [concurrent-drafts] Two draft runs T1, T2 that both carry the same
//     correction: the lock of the second is refused with 409 once the
//     outstanding amount is used up. Nobody is paid twice.
//  6. [reversal] Reversing T gives the outstanding amount back: the next run
//     pays the correction again (and exactly once).
//  7. [salary-basis] A change of the salary base never enters the delta: a
//     retroactive raise without any request change yields no correction line,
//     and a raise taking effect in T does not scale the delta of S.
//  8. [reverse-source-db-trigger] The database itself refuses to mark a run
//     'reversed' while it is the source of a settled correction (trigger 0557).
//  9. [late-settle-cancel-held] A request approved by its chain before S but
//     only settled after S, then cancelled: S did not pay it, so nothing is
//     deducted (the source is held, not guessed).
// 10. [pre-activation-source] Runs locked before the tenant's activation
//     moment (payroll_overtime_correction_activations) are never a source.
// 11. [held-per-source] A held source does not stop the other sources: they
//     are still corrected, and the simulate audit row reports the held source.
//
// ASSUMPTIONS (spec silent; from the brief)
//  - Line identity is the payslip line `componentCode`: "LEMBUR_KOREKSI"
//    (earning, taxable) and "LEMBUR_KOREKSI_POTONGAN" (deduction). The normal
//    overtime line of a slip is the line with category "overtime" whose code
//    is neither of those.
//  - Expected amounts are never hard-coded. They come from an ORACLE employee
//    of the same run S whose requests were approved before S was locked: the
//    delta is oracle LEMBUR minus subject LEMBUR of the same run S (same
//    salary, same formula).
//  - "Approved late" / "cancelled late" are made by SQL on overtime_requests
//    (decided_at / updated_at set explicitly one hour after the S.lockedAt read
//    from the run row), the brief's model: paidSet = approved with
//    updated_at <= S.lockedAt. Timestamps are never the database now(): the
//    service compares them with the Node clock stamps of simulate and lock, and
//    the test database clock is skewed against the host (Colima).
//  - The salary basis for the delta is the one of the period of S.
//  - Run months: S = 2026-05, T = 06, U = 07, V = 08 (all after the published
//    overtime formula and statutory tables).
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
  idr,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollAmount,
} from "../lib/payroll-sealed.ts";
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

const key = () => `ot-983-${randomUUID()}`;
const SALARY = 15_000_000;
const KOREKSI = "LEMBUR_KOREKSI";
const POTONGAN = "LEMBUR_KOREKSI_POTONGAN";
const LAST_DAY = "2026-11-16";
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
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
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
        `OT983 ${roleId.slice(0, 8)}`,
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
type Emp = {
  id: string;
  name: string;
  salaryComponentId: string;
  reqs: string[];
};

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Koreksi Lembur ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/** Attendance 'out' log (accepted) plus the overtime request of the day. */
const HOUR_MS = 3_600_000;

/**
 * Request timestamps are explicit. Seeds exist before S is drafted, so they
 * sit one hour before the test starts (far outside the skew zone around the
 * simulate and lock of S); `at` places a seed after S was locked.
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
      `ot983-${logId}`,
    ],
  );
  const inserted = await conn.query<{ id: string }>(
    `INSERT INTO overtime_requests
       (tenant_id, outlet_id, employee_id, formula_id, date, minutes, day_type, reason,
        status, requested_by, decided_by, decided_at, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, 'workday', 'Koreksi lembur 983', $7::varchar, $8,
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

/**
 * An active pkwtt employee TK/0 with NPWP and bank account on the base salary
 * plus overtime requests (all dated in the period of S = May 2026).
 */
async function makeEmployee(
  world: World,
  reqs: readonly OtSpec[] = [],
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: `Karyawan Koreksi ${++counter}`,
    salaryComponentId: "",
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
    emp.salaryComponentId = await insertSalary(conn, {
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

/** A new salary row of the employee's base-salary component from a date. */
async function setSalaryFrom(emp: Emp, amount: number, effectiveFrom: string) {
  const rowId = randomUUID();
  await asTenant(async (conn) => {
    // One open pay window per component: close the current one the day before.
    await conn.query(
      `UPDATE employee_pay_components SET effective_to = $4::date - 1
        WHERE tenant_id = $1 AND employee_id = $2 AND component_id = $3
          AND effective_to IS NULL`,
      [tenant.id, emp.id, emp.salaryComponentId, effectiveFrom],
    );
    await conn.query(
      `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
         amount_encrypted, pii_key_version, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        rowId,
        tenant.id,
        emp.id,
        emp.salaryComponentId,
        sealPayrollAmount(idr(amount), {
          tenantId: tenant.id,
          table: "employee_pay_components",
          rowId,
          field: "amount",
        }),
        PAYROLL_SEAL_KEY_VERSION,
        effectiveFrom,
        lockerUserId,
      ],
    );
  });
}

// ---- overtime request changes after the source run was locked --------------

/** simulate and lock stamps of the latest source run (period of S_MONTH). */
async function sourceTimes(): Promise<{
  simulatedAt: Date;
  lockedAt: Date | null;
}> {
  const { rows } = await asTenant((conn) =>
    conn.query<{ simulated_at: Date; locked_at: Date | null }>(
      `SELECT last_simulated_at AS simulated_at, locked_at
         FROM payroll_runs
        WHERE tenant_id = $1 AND period_start = $2::date
        ORDER BY created_at DESC LIMIT 1`,
      [tenant.id, monthDates(S_MONTH).periodStart],
    ),
  );
  return { simulatedAt: rows[0]!.simulated_at, lockedAt: rows[0]!.locked_at };
}

/** One hour (plus `afterMs`) after S was locked, read from the run row. */
async function lateAt(afterMs = 0): Promise<Date> {
  const { lockedAt } = await sourceTimes();
  if (lockedAt === null) throw new Error("S is not locked yet");
  return new Date(lockedAt.getTime() + HOUR_MS + afterMs);
}

/** Pending -> approved one hour after S.lockedAt (or at `at`). */
const approveLate = async (requestId: string, at?: Date) => {
  const when = at ?? (await lateAt());
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

/** approved/pending -> cancelled (terminal), one hour and a minute after S.lockedAt. */
const cancelLate = async (requestId: string, at?: Date) => {
  const when = at ?? (await lateAt(60_000));
  return asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests SET status = 'cancelled', updated_at = $3::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, when],
      ),
    true,
  );
};

/** A fresh approved request (filed and decided after S.lockedAt): "approved again". */
const approveAgain = async (empId: string, spec: Omit<OtSpec, "status">) => {
  const when = await lateAt();
  return asTenant((conn) =>
    seedOvertime(conn, empId, { ...spec, status: "approved" }, when),
  );
};

/** Moves the decision and update time of requests into the window of S. */
const retimeRequests = (
  requestIds: readonly string[],
  times: { decidedAt?: Date; updatedAt: Date },
) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests
            SET decided_at = COALESCE($3::timestamptz, decided_at), updated_at = $4::timestamptz
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.id, requestIds, times.decidedAt ?? null, times.updatedAt],
      ),
    true,
  );

/** locked_at of any run, read from the run row. */
async function lockedAtOf(runId: string): Promise<Date> {
  const row = await scalar(
    "SELECT locked_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
    [tenant.id, runId],
  );
  if (!row.locked_at) throw new Error("run is not locked yet");
  return row.locked_at as Date;
}

/**
 * The chain (approval_requests) of an overtime request that the approver
 * decided at `chainAt`; the request itself is settled later. ASSUMPTION: the
 * module/action/object names below are the ones the overtime chain uses (free
 * text columns); they are only the link request id -> chain row.
 */
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
               'user', 1, 1, '[]', 'approved', 'Lembur 983 chain', $6, $7::timestamptz,
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
  // Link the request to its chain row: without approval_chain_id the request
  // is not "chained" at all and the source would not be held.
  await asTenant((conn) =>
    conn.query(
      "UPDATE overtime_requests SET approval_chain_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, requestId, id],
    ),
  );
}

/**
 * Runs `body` with the tenant's activation moment set to `activatedAt` (the
 * explicit timestamp, never now()); the row is removed afterwards.
 */
async function withActivation<T>(
  activatedAt: Date,
  body: () => Promise<T>,
): Promise<T> {
  const clear = () =>
    asTenant(
      (conn) =>
        conn.query(
          "DELETE FROM payroll_overtime_correction_activations WHERE tenant_id = $1",
          [tenant.id],
        ),
      true,
    );
  await clear();
  await asTenant(
    (conn) =>
      conn.query(
        `INSERT INTO payroll_overtime_correction_activations (tenant_id, activated_at)
         VALUES ($1, $2::timestamptz)`,
        [tenant.id, activatedAt],
      ),
    true,
  );
  try {
    return await body();
  } finally {
    await clear();
  }
}

const C_JUNE: OtSpec = { date: "2026-06-05", minutes: 60, status: "approved" };

// ---- runs ---------------------------------------------------------------

type RunDates = { periodStart: string; periodEnd: string; payDate: string };

/** Month `m` (1-12) of `year`, paid on the 28th. */
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

async function reverseRun(runId: string) {
  const {
    requestPayrollRunReversalInTransaction,
    decidePayrollRunReversalInTransaction,
  } = await import("../services/payroll-run-reversal.service.ts");
  const id = payrollRunIdSchema.parse(runId);
  await withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      id,
      "Salah hitung, dibatalkan",
    ),
  );
  await withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      approverUserId,
      id,
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

/** draft -> simulated -> approved (not yet locked). */
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

// ---- payslip oracle -----------------------------------------------------

type Line = {
  componentCode: string;
  category: string;
  kind: string;
  amountIdr: number;
  taxable: boolean;
};
type Calc = { netIdr: number; lines: Line[] };

const openSlip = (row: {
  id: string;
  calculation_encrypted: Buffer;
  pii_key_version: number;
}) =>
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
  ) as Calc;

/** The sealed calculation of the employee's slip in a run, if there is one. */
async function slipOf(runId: string, emp: Emp): Promise<Calc | undefined> {
  const rows = await asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version
           FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows.map(openSlip),
  );
  return rows[0];
}

const codeSum = (calc: Calc | undefined, code: string) =>
  (calc?.lines ?? [])
    .filter((l) => l.componentCode === code)
    .reduce((total, l) => total + l.amountIdr, 0);
const koreksiOf = (calc: Calc | undefined) => codeSum(calc, KOREKSI);
const potonganOf = (calc: Calc | undefined) => codeSum(calc, POTONGAN);
/** The normal LEMBUR of a slip (not a correction line). */
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
 * Employee E (A approved, B pending) and oracle O (A and B approved) of the
 * same run S: delta = LEMBUR(O) - LEMBUR(E) is what B adds once approved.
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
  return { delta, paidInS: overtimeOf(subjectSlip) };
}

// ---- offboarding helpers (HTTP, like payroll-loan-disburse-offboarding-972) --

const postAs = (path: string, body: object = {}) =>
  hr.post(path).set(originHeader).send(body);

async function openExit(employeeId: string): Promise<string> {
  const created = await postAs(
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "resignation",
      reason: "Akhir hubungan kerja uji 983.",
      lastWorkingDate: "2034-09-30",
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

async function revokedExit(employeeId: string): Promise<string> {
  const id = await openExit(employeeId);
  await asTenant((conn) =>
    conn.query(
      "UPDATE hris_offboardings SET last_working_date = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, id, LAST_DAY],
    ),
  );
  const revoked = await postAs(`/api/hris/offboardings/${id}/revoke-access`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  return id;
}

async function completedExit(employeeId: string): Promise<string> {
  const id = await revokedExit(employeeId);
  const listed = await hr.get(
    `/api/hris/employees/${employeeId}/checklist-tasks?limit=100`,
  );
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  for (const task of listed.body.data as { id: string; status: string }[]) {
    if (task.status === "done" || task.status === "waived") continue;
    const waived = await postAs(
      `/api/hris/checklist-tasks/${task.id}/actions`,
      { action: "waive", reason: "Uji koreksi lembur 983" },
    );
    expect(waived.status, JSON.stringify(waived.body)).toBeLessThan(300);
  }
  const done = await postAs(`/api/hris/offboardings/${id}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OT983 locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("OT983 approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OT983 HR");
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
               'Koreksi lembur 983 fixture', now(), $5, $5)`,
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
  // The ledger of the feature (name from the brief); absent before the feature.
  try {
    await asTenant(async (conn) => {
      if (
        (
          await conn.query("SELECT to_regclass($1) AS t", [
            "public.payroll_overtime_corrections",
          ])
        ).rows[0].t !== null
      )
        await conn.query(
          "DELETE FROM payroll_overtime_corrections WHERE tenant_id = $1",
          [tenant.id],
        );
      if (
        (
          await conn.query("SELECT to_regclass($1) AS t", [
            "public.payroll_overtime_correction_activations",
          ])
        ).rows[0].t !== null
      )
        await conn.query(
          "DELETE FROM payroll_overtime_correction_activations WHERE tenant_id = $1",
          [tenant.id],
        );
    }, true);
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ot-983-%'",
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
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[]) AND request_reason = 'Lembur 983 chain'",
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
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-72nod: overtime correction for frozen periods", () => {
  it("[late-approval] overtime approved after S was locked is paid once in T as LEMBUR_KOREKSI and never again", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);

    const t = await lockedRun(world, T_MONTH);

    const slipT = await slipOf(t, subject);
    expect(slipT, "subject has a slip in T").toBeDefined();
    expect(koreksiOf(slipT)).toBe(delta);
    const line = slipT!.lines.find((l) => l.componentCode === KOREKSI)!;
    expect(line).toMatchObject({ kind: "earning", taxable: true });
    expect(potonganOf(slipT)).toBe(0);
    // The oracle was paid in S already: nothing to correct.
    expect(koreksiOf(await slipOf(t, oracle))).toBe(0);
    expect(potonganOf(await slipOf(t, oracle))).toBe(0);

    // After T is locked the correction is settled: not in the next runs.
    const u = await lockedRun(world, U_MONTH);
    expect(koreksiOf(await slipOf(u, subject))).toBe(0);
    expect(potonganOf(await slipOf(u, subject))).toBe(0);
  }, 600_000);

  it("[repeat-replaced] a cancelled request replaced by an identical approved one pays the hours only once", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    // The approved request is cancelled and the same day is approved again.
    await cancelLate(subject.reqs[1]!);
    await approveAgain(subject.id, { date: B_PENDING.date, minutes: 60 });

    const u = await lockedRun(world, U_MONTH);
    const v = await lockedRun(world, V_MONTH);
    for (const run of [u, v]) {
      const slip = await slipOf(run, subject);
      expect(koreksiOf(slip), "no second payment of the same hours").toBe(0);
      expect(potonganOf(slip), "and nothing taken back either").toBe(0);
    }
  }, 600_000);

  it("[repeat-cancelled] approve then cancel takes back exactly what the correction paid; the net over all runs is zero", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    await cancelLate(subject.reqs[1]!);
    const u = await lockedRun(world, U_MONTH);
    const v = await lockedRun(world, V_MONTH);
    const slipU = await slipOf(u, subject);
    const slipV = await slipOf(v, subject);
    expect(koreksiOf(slipU) + koreksiOf(slipV)).toBe(0);
    // The hours of B were paid by the correction in T (delta), not by the
    // LEMBUR of S. The take-back is bounded by LEMBUR of S plus what the
    // correction paid, so it is exactly delta: the net is zero, not "at most
    // what S paid" (that bound would be wrong whenever the two differ).
    expect(potonganOf(slipU), "the cancellation is deducted").toBe(delta);
    expect(potonganOf(slipV), "and only once").toBe(0);
    expect(delta - (potonganOf(slipU) + potonganOf(slipV))).toBe(0);
  }, 600_000);

  it("[paid-positive-cancelled] LEMBUR of S is 0, the correction paid it, then the request is cancelled: the amount is taken back, not lost", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [B_PENDING]);
    const oracle = await makeEmployee(world, [B_APPROVED]);
    const s = await lockedRun(world, S_MONTH);
    expect(overtimeOf(await slipOf(s, subject)), "S paid no overtime").toBe(0);
    const delta = overtimeOf(await slipOf(s, oracle));
    expect(delta).toBeGreaterThan(0);
    await approveLate(subject.reqs[0]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    await cancelLate(subject.reqs[0]!);
    const u = await lockedRun(world, U_MONTH);
    const v = await lockedRun(world, V_MONTH);
    const slipU = await slipOf(u, subject);
    const slipV = await slipOf(v, subject);
    // ASSUMPTION: the wage is large enough to absorb the whole amount, so
    // the whole correction paid in T is recovered (the take-back cap counts
    // positive corrections already paid). What could not be recovered would
    // be held, never silently dropped; here nothing is left.
    expect(koreksiOf(slipU) + koreksiOf(slipV)).toBe(0);
    expect(potonganOf(slipU) + potonganOf(slipV)).toBe(delta);
  }, 600_000);

  it("[cancel-after-lock] overtime cancelled after S was locked is deducted in T, once, as LEMBUR_KOREKSI_POTONGAN", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    const paidInS = overtimeOf(await slipOf(s, subject));
    expect(paidInS).toBeGreaterThan(0);
    await cancelLate(subject.reqs[0]!);

    const t = await lockedRun(world, T_MONTH);

    const slipT = await slipOf(t, subject);
    expect(slipT).toBeDefined();
    expect(potonganOf(slipT)).toBe(paidInS);
    const line = slipT!.lines.find((l) => l.componentCode === POTONGAN)!;
    expect(line.kind).toBe("deduction");
    expect(koreksiOf(slipT)).toBe(0);

    const u = await lockedRun(world, U_MONTH);
    expect(potonganOf(await slipOf(u, subject))).toBe(0);
    expect(koreksiOf(await slipOf(u, subject))).toBe(0);
  }, 600_000);

  it("[cancel-capped] the deduction is limited by the remaining wage; the rest stays outstanding and is deducted later, never above LEMBUR of S", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    const paidInS = overtimeOf(await slipOf(s, subject));
    expect(paidInS).toBeGreaterThan(0);
    await cancelLate(subject.reqs[0]!);
    // Wage of June is far below the amount to take back; July is normal again.
    const tiny = 100_000;
    expect(tiny).toBeLessThan(paidInS);
    await setSalaryFrom(subject, tiny, monthDates(T_MONTH).periodStart);
    await setSalaryFrom(subject, SALARY, monthDates(U_MONTH).periodStart);

    const t = await lockedRun(world, T_MONTH);
    const slipT = await slipOf(t, subject);
    const firstCut = potonganOf(slipT);
    expect(firstCut, "something is deducted, not ignored").toBeGreaterThan(0);
    expect(firstCut, "but not more than the wage allows").toBeLessThan(paidInS);
    expect(firstCut).toBeLessThanOrEqual(tiny);
    expect(slipT!.netIdr, "net pay never negative").toBeGreaterThanOrEqual(0);

    const u = await lockedRun(world, U_MONTH);
    const secondCut = potonganOf(await slipOf(u, subject));
    expect(secondCut, "the rest follows in the next run").toBe(
      paidInS - firstCut,
    );

    const v = await lockedRun(world, V_MONTH);
    expect(potonganOf(await slipOf(v, subject))).toBe(0);
    expect(firstCut + secondCut).toBeLessThanOrEqual(paidInS);
  }, 600_000);

  it("[offboarding-held] open, revoked and completed offboarding employees get no correction line; a normal employee does", async () => {
    const world = await makeWorld();
    const oracle = await makeEmployee(world, [A, B_APPROVED]);
    const control = await makeEmployee(world, [A, B_PENDING]);
    const open = await makeEmployee(world, [A, B_PENDING]);
    const revoked = await makeEmployee(world, [A, B_PENDING]);
    const completed = await makeEmployee(world, [A, B_PENDING]);
    const openCancel = await makeEmployee(world, [A]);
    const plainCancel = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, control, oracle);

    await openExit(open.id);
    await revokedExit(revoked.id);
    await completedExit(completed.id);
    await openExit(openCancel.id);
    for (const e of [control, open, revoked, completed])
      await approveLate(e.reqs[1]!);
    await cancelLate(openCancel.reqs[0]!);
    await cancelLate(plainCancel.reqs[0]!);

    const t = await lockedRun(world, T_MONTH);

    // Positive controls: the feature works for a normal employee.
    expect(koreksiOf(await slipOf(t, control))).toBe(delta);
    expect(potonganOf(await slipOf(t, plainCancel))).toBeGreaterThan(0);
    // Held: no automatic line of any kind.
    for (const held of [open, revoked, completed, openCancel]) {
      const slip = await slipOf(t, held);
      expect(koreksiOf(slip), `${held.name} no LEMBUR_KOREKSI`).toBe(0);
      expect(potonganOf(slip), `${held.name} no POTONGAN`).toBe(0);
    }
    // Still held in the next run (manual handling only).
    const u = await lockedRun(world, U_MONTH);
    for (const held of [open, revoked, completed, openCancel]) {
      const slip = await slipOf(u, held);
      expect(koreksiOf(slip)).toBe(0);
      expect(potonganOf(slip)).toBe(0);
    }
  }, 900_000);

  it("[concurrent-drafts] two draft runs with the same correction: the second lock is refused with 409, nobody is paid twice", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);

    // Both drafts are simulated before either is locked: both carry the line.
    const t1 = await approvedRun(world, T_MONTH);
    const t2 = await approvedRun(world, U_MONTH);

    await lockRun(t1);
    expect(await runStatus(t1)).toBe("locked");
    expect(koreksiOf(await slipOf(t1, subject))).toBe(delta);

    const refused = await failure(lockRun(t2));
    expect(refused.status, refused.message).toBe(409);
    expect(await runStatus(t2), "the run is not locked").not.toBe("locked");
  }, 600_000);

  it("[reversal] reversing T gives the outstanding amount back; the next run pays it again, once", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    await reverseRun(t);
    expect(await runStatus(t)).toBe("reversed");

    const u = await lockedRun(world, U_MONTH);
    expect(koreksiOf(await slipOf(u, subject))).toBe(delta);
    const v = await lockedRun(world, V_MONTH);
    expect(koreksiOf(await slipOf(v, subject)), "and only once").toBe(0);
  }, 600_000);

  it("[window-held] approve or cancel between simulate and lock of S never creates a deduction for hours S did not pay: S is held", async () => {
    const world = await makeWorld();
    // Approved inside the window, cancelled after the lock: S never paid B.
    const approvedInWindow = await makeEmployee(world, [A, B_PENDING]);
    // Approved inside the window, never cancelled.
    const approvedOnly = await makeEmployee(world, [A, B_PENDING]);
    // Paid by S (approved before simulate), cancelled inside the window.
    const cancelledInWindow = await makeEmployee(world, [A, B_APPROVED]);
    // Positive control: a plain cancellation after the lock is deducted.
    const control = await makeEmployee(world, [A]);

    const sRun = await draftRun(world, monthDates(S_MONTH));
    await simulateRun(sRun);
    // The changes are made now (status only); their times are placed in the
    // window once S is locked and both of its stamps are known.
    const simulatedAt = (await sourceTimes()).simulatedAt;
    await approveLate(approvedInWindow.reqs[1]!, simulatedAt);
    await approveLate(approvedOnly.reqs[1]!, simulatedAt);
    await cancelLate(cancelledInWindow.reqs[1]!, simulatedAt);
    await asTenant((conn) => approveSimulatedRun(conn, sRun));
    await lockRun(sRun);
    expect(await runStatus(sRun)).toBe("locked");
    const stamps = await sourceTimes();
    const middle = new Date(
      stamps.simulatedAt.getTime() +
        (stamps.lockedAt!.getTime() - stamps.simulatedAt.getTime()) / 2,
    );
    await retimeRequests([approvedInWindow.reqs[1]!, approvedOnly.reqs[1]!], {
      decidedAt: middle,
      updatedAt: middle,
    });
    await retimeRequests([cancelledInWindow.reqs[1]!], { updatedAt: middle });

    await cancelLate(approvedInWindow.reqs[1]!);
    await cancelLate(control.reqs[0]!);

    const t = await lockedRun(world, T_MONTH);
    expect(potonganOf(await slipOf(t, control)), "control").toBeGreaterThan(0);
    // ASSUMPTION (brief, P0-2): a source run with a request decided between
    // its simulation and its lock is held: no automatic line of any kind.
    const u = await lockedRun(world, U_MONTH);
    for (const held of [approvedInWindow, approvedOnly, cancelledInWindow]) {
      for (const run of [t, u]) {
        const slip = await slipOf(run, held);
        expect(koreksiOf(slip), `${held.name} no LEMBUR_KOREKSI`).toBe(0);
        expect(potonganOf(slip), `${held.name} no POTONGAN`).toBe(0);
      }
    }
  }, 900_000);

  it("[reverse-source] a run that is the source of a settled correction cannot be reversed; after T is reversed it can", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    // ASSUMPTION: refused with a 4xx (HttpError); the brief only says "tolak".
    const refused = await failure(reverseRun(s));
    expect(refused.status ?? 0, refused.message).toBeGreaterThanOrEqual(400);
    expect(refused.status ?? 0, refused.message).toBeLessThan(500);
    expect(await runStatus(s), "S stays locked").toBe("locked");
    expect(await runStatus(t), "T stays locked").toBe("locked");
  }, 600_000);

  it("[reverse-source-order] reversing T first lets S be reversed afterwards", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    await reverseRun(t);
    expect(await runStatus(t)).toBe("reversed");
    await reverseRun(s);
    expect(await runStatus(s)).toBe("reversed");
  }, 600_000);

  it("[salary-basis] a salary change never enters the delta: a retroactive raise alone gives no line, a raise in T does not scale the delta", async () => {
    const world = await makeWorld();
    const oracle = await makeEmployee(world, [A, B_APPROVED]);
    const control = await makeEmployee(world, [A, B_PENDING]);
    const raisedLater = await makeEmployee(world, [A, B_PENDING]);
    const raisedRetro = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, control, oracle);

    await approveLate(control.reqs[1]!);
    await approveLate(raisedLater.reqs[1]!);
    // Retroactive raise (effective inside S) without any request change.
    await setSalaryFrom(raisedRetro, SALARY * 2, "2026-05-01");
    // Raise effective from T: S is still computed on its own basis.
    await setSalaryFrom(
      raisedLater,
      SALARY * 2,
      monthDates(T_MONTH).periodStart,
    );

    const t = await lockedRun(world, T_MONTH);

    expect(koreksiOf(await slipOf(t, control)), "positive control").toBe(delta);
    expect(koreksiOf(await slipOf(t, raisedLater))).toBe(delta);
    const retro = await slipOf(t, raisedRetro);
    expect(retro, "the raised employee is paid in T").toBeDefined();
    expect(koreksiOf(retro)).toBe(0);
    expect(potonganOf(retro)).toBe(0);
  }, 600_000);

  it("[deduction-exceeds-paid] a deduction larger than what S paid is held, never partly taken and never dropped", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    const paidInS = overtimeOf(await slipOf(s, subject));
    expect(paidInS).toBeGreaterThan(0);
    // A retroactive raise makes the hours worth three times what S paid, so
    // the cancellation would take back more than S ever paid for them.
    await setSalaryFrom(subject, SALARY * 3, "2026-05-01");
    await cancelLate(subject.reqs[0]!);

    const t = await lockedRun(world, T_MONTH);
    const u = await lockedRun(world, U_MONTH);
    const slipT = await slipOf(t, subject);
    const slipU = await slipOf(u, subject);
    expect(slipT, "the employee is paid in T").toBeDefined();
    // Held: nothing automatic, so nothing above what S paid is deducted.
    expect(koreksiOf(slipT) + koreksiOf(slipU)).toBe(0);
    expect(potonganOf(slipT) + potonganOf(slipU)).toBe(0);
  }, 600_000);

  it("[reverse-source-db-trigger] the database refuses status 'reversed' on a source run of a settled correction, straight in SQL", async () => {
    const { world, subject, oracle } = await lateApprovalWorld();
    const s = await lockedRun(world, S_MONTH);
    const { delta } = await deltaOfS(s, subject, oracle);
    await approveLate(subject.reqs[1]!);
    const t = await lockedRun(world, T_MONTH);
    expect(koreksiOf(await slipOf(t, subject))).toBe(delta);

    // Triggers stay on (no replica role): this goes around the service.
    const markReversed = (runId: string) =>
      asTenant((conn) =>
        conn.query(
          `UPDATE payroll_runs SET status = 'reversed', reversal = '{"status":"approved"}'::jsonb
            WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, runId],
        ),
      );
    const refused = await failure(markReversed(s));
    expect(refused.message).toBeTruthy();
    expect(await runStatus(s), "S stays locked").toBe("locked");

    // Control (rules out any other trigger as the reason): once T is reversed
    // the same statement goes through.
    await reverseRun(t);
    expect(await runStatus(t)).toBe("reversed");
    await markReversed(s);
    expect(await runStatus(s)).toBe("reversed");
  }, 600_000);

  it("[late-settle-cancel-held] approved by the chain before S, settled after S, then cancelled: S never paid it, so nothing is deducted", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A, B_PENDING]);
    const control = await makeEmployee(world, [A]);
    const s = await lockedRun(world, S_MONTH);
    expect(
      overtimeOf(await slipOf(s, subject)),
      "S pays A only",
    ).toBeGreaterThan(0);
    // The chain decided before S was simulated, but the request stayed
    // pending (outbox settle is late): S paid nothing for it.
    const stamps = await sourceTimes();
    const chainAt = new Date(stamps.simulatedAt.getTime() - 30 * 60_000);
    const late = await lateAt();
    await chainApproval(subject.reqs[1]!, chainAt);
    await approveLate(subject.reqs[1]!, late);
    await retimeRequests([subject.reqs[1]!], {
      decidedAt: chainAt,
      updatedAt: late,
    });
    await cancelLate(subject.reqs[1]!);
    await cancelLate(control.reqs[0]!);

    const t = await lockedRun(world, T_MONTH);
    const u = await lockedRun(world, U_MONTH);

    expect(potonganOf(await slipOf(t, control)), "control").toBeGreaterThan(0);
    // ASSUMPTION (brief R3): no certain approval time for a chained, cancelled
    // request -> the source is held: no automatic line of any kind.
    for (const run of [t, u]) {
      const slip = await slipOf(run, subject);
      expect(slip, "the employee is paid").toBeDefined();
      expect(koreksiOf(slip), "no LEMBUR_KOREKSI").toBe(0);
      expect(potonganOf(slip), "no deduction for hours S never paid").toBe(0);
    }
  }, 900_000);

  it("[pre-activation-source] a run locked before the activation moment is never a source: its old cancellation is not deducted, a later source still is", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A, C_JUNE]);
    const s = await lockedRun(world, S_MONTH);
    const t = await lockedRun(world, T_MONTH);
    const paidInS = overtimeOf(await slipOf(s, subject));
    const paidInT = overtimeOf(await slipOf(t, subject));
    expect(paidInS, "S (May) paid A").toBeGreaterThan(0);
    expect(paidInT, "T (June) paid C").toBeGreaterThan(0);
    const sLocked = await lockedAtOf(s);
    const tLocked = await lockedAtOf(t);
    expect(tLocked.getTime()).toBeGreaterThan(sLocked.getTime());
    // Both requests are cancelled after both runs were locked (explicit times).
    await cancelLate(subject.reqs[0]!, new Date(tLocked.getTime() + HOUR_MS));
    await cancelLate(
      subject.reqs[1]!,
      new Date(tLocked.getTime() + HOUR_MS + 60_000),
    );
    // Activation between the two locks: S is old history, T is a source.
    const activatedAt = new Date((sLocked.getTime() + tLocked.getTime()) / 2);

    const u = await withActivation(activatedAt, () =>
      lockedRun(world, U_MONTH),
    );

    const slipU = await slipOf(u, subject);
    expect(slipU, "the employee is paid").toBeDefined();
    expect(koreksiOf(slipU)).toBe(0);
    expect(
      potonganOf(slipU),
      "only the post-activation source is deducted",
    ).toBe(paidInT);
  }, 900_000);

  it("[held-per-source] a held source does not hold the others: the other source is still deducted, and the simulate audit reports the held one", async () => {
    const world = await makeWorld();
    const subject = await makeEmployee(world, [A, C_JUNE]);
    // S (May): A is paid by S, then cancelled between simulate and lock -> S is held.
    const sRun = await draftRun(world, monthDates(S_MONTH));
    await simulateRun(sRun);
    const simulatedAt = (await sourceTimes()).simulatedAt;
    await cancelLate(subject.reqs[0]!, simulatedAt);
    await asTenant((conn) => approveSimulatedRun(conn, sRun));
    await lockRun(sRun);
    expect(await runStatus(sRun)).toBe("locked");
    const stamps = await sourceTimes();
    const middle = new Date(
      stamps.simulatedAt.getTime() +
        (stamps.lockedAt!.getTime() - stamps.simulatedAt.getTime()) / 2,
    );
    await retimeRequests([subject.reqs[0]!], { updatedAt: middle });
    // T (June): clean source; C is paid by T and cancelled after T was locked.
    const t = await lockedRun(world, T_MONTH);
    const paidInT = overtimeOf(await slipOf(t, subject));
    expect(paidInT, "T paid C").toBeGreaterThan(0);
    await cancelLate(
      subject.reqs[1]!,
      new Date((await lockedAtOf(t)).getTime() + HOUR_MS),
    );

    const uRun = await draftRun(world, monthDates(U_MONTH));
    await simulateRun(uRun);
    await asTenant((conn) => approveSimulatedRun(conn, uRun));
    await lockRun(uRun);
    expect(await runStatus(uRun)).toBe("locked");

    const slipU = await slipOf(uRun, subject);
    expect(slipU, "the employee is paid").toBeDefined();
    expect(koreksiOf(slipU)).toBe(0);
    expect(
      potonganOf(slipU),
      "T is deducted although S is held; S itself is not",
    ).toBe(paidInT);
    // Reported, not silent. The run contract is unchanged; the held source is
    // reported by the audit row `payroll.run.overtime_correction_held` of the
    // simulate (heldItems: 'employee|source|reason|outstanding').
    const heldRows = (
      await asTenant((conn) =>
        conn.query(
          `SELECT event->'maskedChanges'->'after'->'heldItems' AS items
             FROM audit_logs
            WHERE tenant_id = $1
              AND event->>'action' = 'payroll.run.overtime_correction_held'
              AND event->>'objectId' = $2`,
          [tenant.id, uRun],
        ),
      )
    ).rows;
    expect(heldRows.length, "one held audit row for the simulate").toBe(1);
    const heldItems = heldRows[0]!.items as string[];
    expect(heldItems, "only S is held, T is not").toHaveLength(1);
    const [heldEmployee, heldSource] = heldItems[0]!.split("|");
    expect(heldEmployee, "names the held employee").toBe(subject.id);
    expect(heldSource, "names the held source run").toBe(sRun);
  }, 900_000);
});
