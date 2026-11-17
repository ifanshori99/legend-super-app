// Held overtime corrections reported by the payroll simulate (bead legend-oayhe,
// follow-up of legend-72nod / 983). Fail-first: written before the feature.
//
// CONTRACT UNDER TEST (CTO decision on the card)
//  The simulate response (`payrollRunSchema`, shared contract) carries an
//  OPTIONAL field `heldOvertimeCorrections`: one item per held correction, so
//  an admin sees before the lock which employees are NOT corrected and why.
//
// RULES UNDER TEST
//  1. [held-listed-not-paid] An employee whose correction is held (open
//     offboarding) is listed by the simulate of T and gets no correction line
//     when T is locked; a normal employee is paid and is not listed.
//  2. [held-window-source] A source run S with a request decided between its
//     simulate and its lock is held: the simulate of T lists the employee and
//     the source S, and nothing is paid or deducted for it; a plain
//     cancellation after the lock is still deducted and not listed.
//  3. [simulate-equals-lock] What the simulate reports as held is what the lock
//     leaves unpaid; non-held lines equal the simulation; simulating twice
//     reports the same held list; totals before and after the lock are equal.
//  4. [no-held-empty] A run with nothing held reports an empty list or no
//     field at all, and still pays the correction.
//  5. [schema-optional] `payrollRunSchema` accepts the field and still accepts
//     a response without it (old responses); a field of the wrong type is
//     refused.
//  6. [tenant-isolation] Held items only name employees and source runs of the
//     run's own scope; held items of another legal entity of the same tenant
//     never show up, and every named employee belongs to this tenant.
//
// ASSUMPTIONS (spec silent on the item shape; the card only names the field)
//  - Item shape: { employeeId: uuid, sourceRunId: uuid, reason: string
//    (non-empty) }, mirroring the audit row
//    `payroll.run.overtime_correction_held` ('employee|source|reason|...').
//    Only these three keys are read; extra keys (outstanding amount, employee
//    name, ...) are allowed. If the engineer names them differently, adapt
//    `HeldItem` below, nothing else.
//  - "No held" is reported as an absent field or an empty array.
//  - The simulate is read through the HTTP endpoint
//    POST /api/hris/payroll/runs/:id/simulate ({ data: payrollRun }).
//  - Tenant isolation is tested inside the one tenant the test host provides
//    (the HTTP tenant is fixed): a second legal entity of the same tenant with
//    its own held employee must never leak; a full second-tenant payroll world
//    (outlet, brand, formula) is out of proportion for this card.
//  - Same fixtures and timing model as payroll-overtime-correction-983.test.ts:
//    late approvals/cancellations are made by SQL with explicit timestamps
//    after S.lockedAt (never the database now()). Amounts come from an oracle
//    employee of the same run, never hard-coded.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payrollRunIdSchema,
  payrollRunSchema,
} from "@starter/shared/hris/payroll";
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

const key = () => `ot-oayhe-${randomUUID()}`;
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

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
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
        `OTH ${roleId.slice(0, 8)}`,
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
let locker: Client;
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
      [world.entityId, tenant.id, `PT Held Simulate ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

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
      `oth-${logId}`,
    ],
  );
  const inserted = await conn.query<{ id: string }>(
    `INSERT INTO overtime_requests
       (tenant_id, outlet_id, employee_id, formula_id, date, minutes, day_type, reason,
        status, requested_by, decided_by, decided_at, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, 'workday', 'Lembur held simulate', $7::varchar, $8,
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

async function makeEmployee(
  world: World,
  reqs: readonly OtSpec[] = [],
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: `Karyawan Held ${++counter}`,
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

async function draftRun(world: World, month: number): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...monthDates(month),
    }),
  );
  return runId;
}

/** The simulate as the payroll screen gets it: the HTTP endpoint. */
async function simulateHttp(runId: string): Promise<Record<string, unknown>> {
  const res = await locker
    .post(`/api/hris/payroll/runs/${runId}/simulate`)
    .set(originHeader)
    .send({ idempotencyKey: key() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Record<string, unknown>;
}

/** Totals stored on the run row (there is no GET-one route). */
async function storedTotals(runId: string): Promise<Record<string, unknown>> {
  const { rows } = await asTenant((conn) =>
    conn.query<{ totals: Record<string, unknown> }>(
      "SELECT totals FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    ),
  );
  return rows[0]!.totals;
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

const runStatus = async (runId: string) =>
  (
    await asTenant(
      async (conn) =>
        (
          await conn.query(
            "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
            [tenant.id, runId],
          )
        ).rows[0],
    )
  ).status as string;

/** approved -> locked for a run that was already simulated. */
async function approveAndLock(runId: string) {
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  await lockRun(runId);
  expect(await runStatus(runId)).toBe("locked");
}

/** draft -> simulate (HTTP) -> approved -> locked; returns the simulate body. */
async function lockedRun(world: World, month: number) {
  const runId = await draftRun(world, month);
  const simulated = await simulateHttp(runId);
  await approveAndLock(runId);
  return { runId, simulated };
}

// ---- request changes after S was locked -----------------------------------

async function stampsOf(runId: string) {
  const { rows } = await asTenant((conn) =>
    conn.query<{ simulated_at: Date; locked_at: Date | null }>(
      "SELECT last_simulated_at AS simulated_at, locked_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    ),
  );
  return { simulatedAt: rows[0]!.simulated_at, lockedAt: rows[0]!.locked_at };
}

async function lateAt(runId: string, afterMs = 0): Promise<Date> {
  const { lockedAt } = await stampsOf(runId);
  if (lockedAt === null) throw new Error("S is not locked yet");
  return new Date(lockedAt.getTime() + HOUR_MS + afterMs);
}

const approveAt = (requestId: string, when: Date) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests
            SET status = 'approved', decided_by = $3, decided_at = $4::timestamptz, updated_at = $4::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, approverUserId, when],
      ),
    true,
  );

const cancelAt = (requestId: string, when: Date) =>
  asTenant(
    (conn) =>
      conn.query(
        `UPDATE overtime_requests SET status = 'cancelled', updated_at = $3::timestamptz
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, requestId, when],
      ),
    true,
  );

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

/** Delta that request B adds once approved: oracle LEMBUR minus subject LEMBUR of S. */
async function deltaOfS(sourceRun: string, subject: Emp, oracle: Emp) {
  const subjectPaid = overtimeOf(await slipOf(sourceRun, subject));
  expect(subjectPaid, "S pays the approved request").toBeGreaterThan(0);
  const delta = overtimeOf(await slipOf(sourceRun, oracle)) - subjectPaid;
  expect(delta, "the late request adds overtime pay").toBeGreaterThan(0);
  return delta;
}

// ---- held items as the simulate reports them -------------------------------

type HeldItem = {
  employeeId: string;
  sourceRunId: string;
  reason: string;
  outstandingIdr?: number | null;
};

const heldOf = (run: Record<string, unknown>): HeldItem[] =>
  (run.heldOvertimeCorrections as HeldItem[] | undefined) ?? [];
const heldIds = (run: Record<string, unknown>) =>
  heldOf(run)
    .map((h) => h.employeeId)
    .sort();
const sortedIds = (...emps: Emp[]) => emps.map((e) => e.id).sort();

function expectWellFormed(held: readonly HeldItem[]) {
  for (const item of held) {
    expect(typeof item.employeeId, "names the employee").toBe("string");
    expect(typeof item.sourceRunId, "names the source run").toBe("string");
    expect(typeof item.reason, "says why").toBe("string");
    expect(item.reason.trim().length, "reason is not empty").toBeGreaterThan(0);
  }
}

// ---- offboarding (HTTP, like the 983 test) ---------------------------------

const postAs = (path: string, body: object = {}) =>
  hr.post(path).set(originHeader).send(body);

async function openExit(employeeId: string): Promise<void> {
  const created = await postAs(
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "resignation",
      reason: "Akhir hubungan kerja uji held simulate.",
      lastWorkingDate: "2034-09-30",
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
}

// ---- lifecycle ---------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OTH locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  locker = lock.client;
  const approver = await signedInClient("OTH approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OTH HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
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
               'Held simulate fixture', now(), $5, $5)`,
      [
        formulaId,
        tenant.id,
        2_000_000_000 + Math.floor(Math.random() * 100_000_000),
        JSON.stringify(OT_PARAMETERS),
        lockerUserId,
      ],
    ),
  );
});

afterAll(async () => {
  try {
    await asTenant(async (conn) => {
      for (const table of [
        "payroll_overtime_corrections",
        "payroll_overtime_correction_activations",
      ])
        if (
          (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
            .rows[0].t !== null
        )
          await conn.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            tenant.id,
          ]);
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ot-oayhe-%'",
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

/**
 * Shared world of the "held" tests: oracle (A+B approved), control (A, B
 * pending), open-offboarding employee (A, B pending) and a plain employee
 * without any overtime change. S (May) is locked; B is approved late for
 * control and held employee.
 */
async function offboardingWorld() {
  const world = await makeWorld();
  const oracle = await makeEmployee(world, [A, B_APPROVED]);
  const control = await makeEmployee(world, [A, B_PENDING]);
  const held = await makeEmployee(world, [A, B_PENDING]);
  const plain = await makeEmployee(world, []);
  const s = await lockedRun(world, S_MONTH);
  const delta = await deltaOfS(s.runId, control, oracle);
  await openExit(held.id);
  const when = await lateAt(s.runId);
  await approveAt(control.reqs[1]!, when);
  await approveAt(held.reqs[1]!, when);
  return { world, oracle, control, held, plain, s: s.runId, delta };
}

// A run with nothing held (memoised: used by two tests, built once).
let cleanRun: Promise<{
  simulated: Record<string, unknown>;
  runId: string;
  subject: Emp;
  delta: number;
}> | null = null;
const getCleanRun = () => {
  cleanRun ??= (async () => {
    const world = await makeWorld();
    const oracle = await makeEmployee(world, [A, B_APPROVED]);
    const subject = await makeEmployee(world, [A, B_PENDING]);
    const s = await lockedRun(world, S_MONTH);
    const delta = await deltaOfS(s.runId, subject, oracle);
    await approveAt(subject.reqs[1]!, await lateAt(s.runId));
    const runId = await draftRun(world, T_MONTH);
    const simulated = await simulateHttp(runId);
    await approveAndLock(runId);
    expect(koreksiOf(await slipOf(runId, subject))).toBe(delta);
    return { simulated, runId, subject, delta };
  })();
  return cleanRun;
};

describe("legend-oayhe: held overtime corrections in the payroll simulate", () => {
  it("[held-listed-not-paid] the simulate lists the held employee with source and reason; the lock pays nothing for it, and pays the normal employee", async () => {
    const { world, control, held, plain, s, delta } = await offboardingWorld();

    const tRun = await draftRun(world, T_MONTH);
    const simulated = await simulateHttp(tRun);

    // The reported list: exactly the held employee, with the source run S.
    expect(heldIds(simulated), "held employees of the simulate").toEqual([
      held.id,
    ]);
    expectWellFormed(heldOf(simulated));
    expect(heldOf(simulated)[0]!.sourceRunId).toBe(s);
    expect(heldIds(simulated)).not.toContain(control.id);
    expect(heldIds(simulated)).not.toContain(plain.id);
    // The response is still a valid payroll run for the shared contract.
    expect(() => payrollRunSchema.parse(simulated)).not.toThrow();

    // Jangan sampai rugi: the held correction is not paid.
    await approveAndLock(tRun);
    const heldSlip = await slipOf(tRun, held);
    expect(
      heldSlip,
      "the held employee is still paid the normal wage",
    ).toBeDefined();
    expect(koreksiOf(heldSlip), "no LEMBUR_KOREKSI for the held").toBe(0);
    expect(potonganOf(heldSlip), "no POTONGAN for the held").toBe(0);
    // Positive control: the normal employee gets the correction.
    expect(koreksiOf(await slipOf(tRun, control))).toBe(delta);
  }, 900_000);

  it("[held-window-source] a source run with a request decided between its simulate and lock is held: listed with that source, nothing paid; a plain cancellation is deducted and not listed", async () => {
    const world = await makeWorld();
    const inWindow = await makeEmployee(world, [A, B_PENDING]);
    const control = await makeEmployee(world, [A]);

    const sRun = await draftRun(world, S_MONTH);
    await simulateHttp(sRun);
    const simulatedAt = (await stampsOf(sRun)).simulatedAt;
    // Approved inside the window (status now, time placed once S is locked).
    await approveAt(inWindow.reqs[1]!, simulatedAt);
    await approveAndLock(sRun);
    const stamps = await stampsOf(sRun);
    const middle = new Date(
      stamps.simulatedAt.getTime() +
        (stamps.lockedAt!.getTime() - stamps.simulatedAt.getTime()) / 2,
    );
    await retimeRequests([inWindow.reqs[1]!], {
      decidedAt: middle,
      updatedAt: middle,
    });
    // After the lock: the window request is cancelled, the control is cancelled.
    await cancelAt(inWindow.reqs[1]!, await lateAt(sRun, 60_000));
    await cancelAt(control.reqs[0]!, await lateAt(sRun, 60_000));

    const tRun = await draftRun(world, T_MONTH);
    const simulated = await simulateHttp(tRun);

    expect(heldIds(simulated)).toEqual([inWindow.id]);
    expectWellFormed(heldOf(simulated));
    expect(heldOf(simulated)[0]!.sourceRunId).toBe(sRun);
    expect(
      heldIds(simulated),
      "the plain cancellation is not held",
    ).not.toContain(control.id);

    await approveAndLock(tRun);
    const heldSlip = await slipOf(tRun, inWindow);
    expect(koreksiOf(heldSlip)).toBe(0);
    expect(potonganOf(heldSlip)).toBe(0);
    expect(
      potonganOf(await slipOf(tRun, control)),
      "the control is deducted",
    ).toBeGreaterThan(0);
  }, 900_000);

  it("[simulate-equals-lock] held in the simulate is unpaid at the lock; a second simulate reports the same list; the totals do not change at the lock", async () => {
    const { world, control, held, delta } = await offboardingWorld();

    const tRun = await draftRun(world, T_MONTH);
    const first = await simulateHttp(tRun);
    const second = await simulateHttp(tRun);
    expect(heldIds(first), "the simulate reports the held employee").toEqual([
      held.id,
    ]);
    expect(heldOf(second), "repeatable: same list, same order").toEqual(
      heldOf(first),
    );

    await approveAndLock(tRun);

    // Held in the simulate = no automatic line at the lock.
    for (const id of heldIds(first)) {
      const slip = await slipOf(tRun, { id } as Emp);
      expect(koreksiOf(slip), `lock pays nothing for held ${id}`).toBe(0);
      expect(potonganOf(slip), `lock deducts nothing for held ${id}`).toBe(0);
    }
    // Not held in the simulate = paid at the lock, exactly the delta.
    expect(koreksiOf(await slipOf(tRun, control))).toBe(delta);
    // The numbers the admin approved are the numbers that were locked.
    const simulatedTotals = second.totals as Record<string, unknown>;
    const lockedTotals = await storedTotals(tRun);
    for (const field of [
      "employeeCount",
      "grossIdr",
      "deductionsIdr",
      "netIdr",
    ] as const)
      expect(lockedTotals[field], `totals.${field} at the lock`).toEqual(
        simulatedTotals[field],
      );
  }, 900_000);

  it("[no-held-empty] a run with nothing held reports no held corrections and still pays the correction", async () => {
    const { simulated, runId, subject } = await getCleanRun();
    // Absent or empty, never a list with items.
    expect(heldOf(simulated), "nothing is held").toEqual([]);
    // The correction itself was paid (checked while building the run).
    expect(koreksiOf(await slipOf(runId, subject))).toBeGreaterThan(0);
  }, 900_000);

  it("[schema-optional] payrollRunSchema accepts the optional field, still accepts a response without it, and refuses a field of the wrong type", async () => {
    const { simulated } = await getCleanRun();
    const withoutField = { ...simulated };
    delete withoutField.heldOvertimeCorrections;
    // An old response (before the field existed) stays valid.
    expect(() => payrollRunSchema.parse(withoutField)).not.toThrow();
    // The field is accepted (empty, and with an item of the assumed shape).
    expect(() =>
      payrollRunSchema.parse({ ...withoutField, heldOvertimeCorrections: [] }),
    ).not.toThrow();
    const item: HeldItem = {
      employeeId: randomUUID(),
      sourceRunId: randomUUID(),
      reason: "offboarding",
      outstandingIdr: 1000,
    };
    const parsed = payrollRunSchema.parse({
      ...withoutField,
      heldOvertimeCorrections: [item],
    }) as unknown as Record<string, unknown>;
    expect(heldOf(parsed), "the field survives parsing").toHaveLength(1);
    expect(heldOf(parsed)[0]!.employeeId).toBe(item.employeeId);
    // outstandingIdr is nullable.
    expect(() =>
      payrollRunSchema.parse({
        ...withoutField,
        heldOvertimeCorrections: [{ ...item, outstandingIdr: null }],
      }),
    ).not.toThrow();
    // A reason outside the known set is refused.
    expect(() =>
      payrollRunSchema.parse({
        ...withoutField,
        heldOvertimeCorrections: [{ ...item, reason: "alasan lain" }],
      }),
    ).toThrow();
    // A field of the wrong type is refused.
    expect(() =>
      payrollRunSchema.parse({
        ...withoutField,
        heldOvertimeCorrections: "tidak ada",
      }),
    ).toThrow();
  }, 900_000);

  it("[tenant-isolation] held items only name this run's own employees and sources; another legal entity's held employee never shows up", async () => {
    const one = await offboardingWorld();
    const two = await offboardingWorld();

    const tOne = await draftRun(one.world, T_MONTH);
    const simOne = await simulateHttp(tOne);
    const tTwo = await draftRun(two.world, T_MONTH);
    const simTwo = await simulateHttp(tTwo);

    expect(heldIds(simOne)).toEqual(sortedIds(one.held));
    expect(heldIds(simTwo)).toEqual(sortedIds(two.held));
    expect(heldOf(simOne).map((h) => h.sourceRunId)).toEqual([one.s]);
    expect(heldOf(simTwo).map((h) => h.sourceRunId)).toEqual([two.s]);

    // Everything named belongs to this tenant (read as the database owner,
    // without the row-level filter, so a foreign id cannot hide).
    const ids = [...heldOf(simOne), ...heldOf(simTwo)].map((h) => h.employeeId);
    const employees = await owner.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM employees WHERE id = ANY($1::uuid[])",
      [ids],
    );
    expect(employees.rows).toHaveLength(ids.length);
    for (const row of employees.rows) expect(row.tenant_id).toBe(tenant.id);
    const runs = await owner.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM payroll_runs WHERE id = ANY($1::uuid[])",
      [[...heldOf(simOne), ...heldOf(simTwo)].map((h) => h.sourceRunId)],
    );
    expect(runs.rows).toHaveLength(ids.length);
    for (const row of runs.rows) expect(row.tenant_id).toBe(tenant.id);

    // And the other entity's employee is not paid by this run either.
    await approveAndLock(tOne);
    expect(await slipOf(tOne, two.held)).toBeUndefined();
    expect(koreksiOf(await slipOf(tOne, one.held))).toBe(0);
  }, 1_800_000);
});
