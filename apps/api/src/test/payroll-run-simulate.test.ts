// Payroll run SIMULATE step + stored-result LOCK (bead legend-c2yca; design
// docs/briefs/sub-payroll-followups-design.md sections 2 and 7 tests 1-5; PRD
// PAYR-01 "simulation is repeatable and side-effect free", PAYR-02 "a locked run
// keeps what was approved"; founder rule "jangan sampai rugi": nobody is paid
// numbers the approvers did not see). Fail-first: written before the code.
//
// RULES UNDER TEST
//  1. [simulate-stores] simulating a run stores one sealed result per employee
//     (payroll_run_results), the run totals equal the sum of the results, no
//     payslip and no domain event is written (PAYR-01), and simulating again
//     replaces the results (still one per employee, new simulation number).
//  2. [results-frozen] once the run is approved, the DB refuses INSERT, DELETE
//     and a value UPDATE on its results (SQLSTATE 23514).
//  3. [lock-reads-stored] the lock seals exactly the stored calculation. A lock
//     route body that carries caller numbers (`employees`) is a 400 and the run
//     stays approved. The service ignores or refuses a caller plan; either way
//     the sealed slip is the stored one.
//  4. [lock-result-deleted] a result row gone after approval: 409
//     PAYROLL_RUN_RESULT_STALE, nothing written.
//  5. [route-guards] simulate and lock: anonymous 401, foreign origin 403,
//     missing permission 403.
//  6. [simulate-empty] / [simulate-input-missing] error states: a run with no
//     eligible employee is 422 PAYROLL_RUN_EMPTY; an employee with no PTKP
//     status is 422 PAYROLL_SIMULATION_INPUT_MISSING and nothing is stored.
//
// ASSUMPTIONS (design silent or OPEN; stated so the engineer can contest them)
//  - Gross of a regular run = the employee's fixed base-salary component
//    (8.000.020), no BPJS (policy programmes []), so net = gross - PPh 21.
//  - Simulate picks the published statutory versions in force on the pay date;
//    the kit publishes all types effective 2003-06-01 (own versions 9401+).
//  - Population = employees of the run's legal entity, employment type in the
//    policy group, employed in the period (design O7).
//  - Payment method = bank_transfer when a bank account is on file (O1).
//  - The approval routes do not exist (O6): approval is written with SQL.
//  - The sealed result opens with binding { tenantId, table:
//    "payroll_run_results", rowId: payslip_id, field: "result" } and holds
//    `calculation` (design section 2).
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import type { ScopedTenantContext } from "@starter/shared/core";
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
const createdThrSchedules: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];

const key = () => `simulate-${randomUUID()}`;
const SALARY = 8_000_020;
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};

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
        `Simulate ${roleId.slice(0, 8)}`,
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
let exporter: Client; // payroll.view + payroll.run + payroll.lock
let exporterUserId: string;
let runOnly: Client; // payroll.view + payroll.run (no lock)
let viewer: Client; // payroll.view only
let hr: Client;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string; name: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Simulasi ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
  return world;
}

async function makeEmployee(
  world: World,
  opts: { ptkp?: string | null; withBank?: boolean } = {},
): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), name: `Simulasi ${++counter}` };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: emp.name,
      ptkpStatus: opts.ptkp,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      createdBy: exporterUserId,
    });
  });
  if (opts.withBank === false) return emp;
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

async function draftRun(world: World): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant(async (conn) => {
    const schedule = await insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...NOV,
    });
    if (schedule) createdThrSchedules.push(schedule);
  });
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      exporterUserId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

/** draft -> simulated (service) -> approved (SQL). */
async function approvedRun(world: World) {
  const runId = await draftRun(world);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return runId;
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

const countOf = async (table: string, runId: string) =>
  Number(
    (
      await scalar(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).n,
  );

const eventCount = async (runId: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    ).rows[0].n,
  );

type StoredCalculation = {
  employeeId: string;
  grossIdr: number;
  netIdr: number;
  pph21Idr: number;
  tax: unknown;
  paymentMethod: string;
};
type StoredResult = {
  employeeId: string;
  payslipId: string;
  simulationNo: number;
  calculation: StoredCalculation;
};

const storedResults = (runId: string) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT employee_id, payslip_id, simulation_no, result_encrypted, pii_key_version
           FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    return rows.map((row): StoredResult => {
      const opened = JSON.parse(
        openPayrollValue(
          row.result_encrypted,
          {
            tenantId: tenant.id,
            table: "payroll_run_results",
            rowId: row.payslip_id,
            field: "result",
          } as never,
          row.pii_key_version,
        ),
      ) as { calculation: StoredCalculation };
      return {
        employeeId: row.employee_id,
        payslipId: row.payslip_id,
        simulationNo: Number(row.simulation_no),
        calculation: opened.calculation,
      };
    });
  });

const sealedSlips = (runId: string) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT id, employee_id, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    return rows.map((row) => ({
      id: row.id as string,
      employeeId: row.employee_id as string,
      calculation: JSON.parse(
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
      ) as StoredCalculation,
    }));
  });

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

const simulatePath = (runId: string) =>
  `/api/hris/payroll/runs/${runId}/simulate`;
const lockPath = (runId: string) => `/api/hris/payroll/runs/${runId}/lock`;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("Simulate locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const run = await signedInClient("Simulate run-only");
  await grantRole(run.userId, ["payroll.view", "payroll.run"]);
  runOnly = run.client;
  const view = await signedInClient("Simulate viewer");
  await grantRole(view.userId, ["payroll.view"]);
  viewer = view.client;
  const hrUser = await signedInClient("Simulate HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  // The default PPh 21 policy (half up) applies: no tenant policy version.
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
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
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'simulate-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM thr_schedules WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdThrSchedules],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    // Only this file's own components: other test files' kit components share
    // the `SM_` code prefix and must survive.
    const ownComponentIds = (
      await conn.query<{ component_id: string }>(
        "SELECT DISTINCT component_id FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
        [tenant.id, createdEmployees],
      )
    ).rows.map((row) => row.component_id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, ownComponentIds],
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

// ---- 1. [simulate-stores] -----------------------------------------------------

describe("[simulate-stores] simulating a run", () => {
  it("stores one sealed result per employee, totals = sum of the results, no payslip and no event; again replaces the results", async () => {
    const world = await makeWorld();
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const runId = await draftRun(world);

    const run = await simulateRun(runId);
    expect(run.status).toBe("simulated");
    expect(run.simulationCount).toBe(1);

    const results = await storedResults(runId);
    expect(results.map((r) => r.employeeId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    for (const result of results) {
      expect(result.simulationNo).toBe(1);
      expect(result.calculation.grossIdr).toBe(SALARY);
      // Nobody nets more than gross.
      expect(result.calculation.netIdr).toBeLessThanOrEqual(SALARY);
      expect(result.calculation.paymentMethod).toBe("bank_transfer");
    }
    const sum = (pick: (c: StoredCalculation) => number) =>
      results.reduce((total, r) => total + pick(r.calculation), 0);
    expect(run.totals?.employeeCount).toBe(2);
    expect(Number(run.totals?.grossIdr)).toBe(sum((c) => c.grossIdr));
    expect(Number(run.totals?.netIdr)).toBe(sum((c) => c.netIdr));
    expect(Number(run.totals?.pph21Idr)).toBe(sum((c) => c.pph21Idr));
    expect(Number(run.totals?.bankTransferIdr)).toBe(sum((c) => c.netIdr));

    // PAYR-01: side-effect free.
    expect(await countOf("payslips", runId)).toBe(0);
    expect(await eventCount(runId)).toBe(0);

    const again = await simulateRun(runId);
    expect(again.simulationCount).toBe(2);
    const replaced = await storedResults(runId);
    expect(replaced).toHaveLength(2);
    expect(replaced.every((r) => r.simulationNo === 2)).toBe(true);
    expect(await countOf("payslips", runId)).toBe(0);
  }, 90_000);
});

// ---- 2. [results-frozen] -------------------------------------------------------

describe("[results-frozen] stored results after approval", () => {
  it("the DB refuses INSERT, DELETE and a value UPDATE (SQLSTATE 23514)", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const runId = await approvedRun(world);
    const [stored] = await storedResults(runId);
    expect(stored, "a result exists").toBeDefined();

    const code = async (sqlText: string, params: unknown[]) =>
      (
        (await asTenant((conn) => conn.query(sqlText, params)).then(
          () => null,
          (error: unknown) => error,
        )) as { code?: string } | null
      )?.code;

    expect(
      await code(
        `INSERT INTO payroll_run_results
           (tenant_id, payroll_run_id, employee_id, payslip_id, simulation_no,
            payment_method, result_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 1, 'cash', $5, 1)`,
        [tenant.id, runId, emp.id, randomUUID(), Buffer.from("x")],
      ),
    ).toBe("23514");
    expect(
      await code(
        "DELETE FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      ),
    ).toBe("23514");
    expect(
      await code(
        `UPDATE payroll_run_results SET payment_method = 'cash'
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      ),
    ).toBe("23514");
    expect(await storedResults(runId)).toHaveLength(1);
  }, 90_000);
});

// ---- 3. [lock-reads-stored] ---------------------------------------------------

describe("[lock-reads-stored] the lock uses the stored simulation", () => {
  it("a lock body carrying caller numbers is 422 VALIDATION_ERROR and the run stays approved; the plain lock seals the stored calculation", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const runId = await approvedRun(world);
    const [stored] = await storedResults(runId);

    const forged = await exporter
      .post(lockPath(runId))
      .set(originHeader)
      .send({
        idempotencyKey: key(),
        employees: [
          {
            calculation: { ...stored!.calculation, grossIdr: SALARY * 2 },
          },
        ],
      });
    // Project convention: an unknown key fails strict validation as 422.
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(forged.body.error.code).toBe("VALIDATION_ERROR");
    expect(await runStatus(runId)).toBe("approved");
    expect(await countOf("payslips", runId)).toBe(0);

    const locked = await exporter
      .post(lockPath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.data.status).toBe("locked");

    const slips = await sealedSlips(runId);
    expect(slips).toHaveLength(1);
    expect(slips[0]!.id).toBe(stored!.payslipId);
    expect(isDeepStrictEqual(slips[0]!.calculation, stored!.calculation)).toBe(
      true,
    );
  }, 90_000);

  it("the service never seals caller numbers: an extra plan is refused or ignored, the sealed slip is the stored one", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const runId = await approvedRun(world);
    const [stored] = await storedResults(runId);
    const { lockPayrollRunInTransaction } =
      await import("../services/payroll-run-lock.service.ts");

    const outcome = await failureOf(
      withTenant(db, tenantScope(), (tx) =>
        lockPayrollRunInTransaction(tx, tenantScope(), exporterUserId, {
          payrollRunId: payrollRunIdSchema.parse(runId),
          employees: [
            { calculation: { ...stored!.calculation, grossIdr: SALARY * 2 } },
          ],
        } as never),
      ),
    );
    if (outcome) {
      // Refused: nothing written.
      expect(await runStatus(runId)).toBe("approved");
      expect(await countOf("payslips", runId)).toBe(0);
    } else {
      const slips = await sealedSlips(runId);
      expect(slips).toHaveLength(1);
      expect(
        isDeepStrictEqual(slips[0]!.calculation, stored!.calculation),
      ).toBe(true);
    }
  }, 90_000);
});

// ---- 4. [lock-result-deleted] -------------------------------------------------

describe("[lock-result-deleted] a stored result is missing at lock", () => {
  it("409 PAYROLL_RUN_RESULT_STALE and nothing is written", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    await makeEmployee(world);
    const runId = await approvedRun(world);
    // Raw role: the guard trigger protects the rows after approval.
    await asTenant(
      (conn) =>
        conn.query(
          `DELETE FROM payroll_run_results
            WHERE tenant_id = $1 AND payroll_run_id = $2
              AND employee_id = (SELECT employee_id FROM payroll_run_results
                                  WHERE tenant_id = $1 AND payroll_run_id = $2 LIMIT 1)`,
          [tenant.id, runId],
        ),
      true,
    );
    expect(await storedResults(runId)).toHaveLength(1);

    const refused = await exporter
      .post(lockPath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await countOf("payslips", runId)).toBe(0);
    expect(await countOf("payslip_bank_snapshots", runId)).toBe(0);
    expect(await countOf("payroll_run_month_priors", runId)).toBe(0);
  }, 90_000);
});

// ---- 5. [route-guards] --------------------------------------------------------

describe("[route-guards] simulate and lock routes", () => {
  it("anonymous 401, foreign origin 403, missing permission 403; the permitted user simulates (200)", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const runId = await draftRun(world);
    const anonymous = agent(app);

    for (const path of [simulatePath(runId), lockPath(runId)]) {
      const noSession = await anonymous
        .post(path)
        .set(originHeader)
        .send({ idempotencyKey: key() });
      expect(noSession.status, path).toBe(401);

      const badOrigin = await exporter
        .post(path)
        .set("Origin", "https://evil.example")
        .send({ idempotencyKey: key() });
      expect(badOrigin.status, path).toBe(403);
    }

    const noRun = await viewer
      .post(simulatePath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(noRun.status, JSON.stringify(noRun.body)).toBe(403);
    const noLock = await runOnly
      .post(lockPath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(noLock.status, JSON.stringify(noLock.body)).toBe(403);
    expect(await countOf("payroll_run_results", runId)).toBe(0);

    const ok = await runOnly
      .post(simulatePath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe("simulated");
    expect(await countOf("payroll_run_results", runId)).toBe(1);
  }, 90_000);
});

// ---- 6. error and empty states -------------------------------------------------

describe("simulate error states", () => {
  it("[simulate-empty] a run with no eligible employee is 422 PAYROLL_RUN_EMPTY and stays draft", async () => {
    const world = await makeWorld();
    const runId = await draftRun(world);
    const response = await exporter
      .post(simulatePath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("PAYROLL_RUN_EMPTY");
    expect(await runStatus(runId)).toBe("draft");
    expect(await countOf("payroll_run_results", runId)).toBe(0);
  }, 90_000);

  it("[simulate-input-missing] an employee without a PTKP status is 422 PAYROLL_SIMULATION_INPUT_MISSING; nothing is stored", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const noPtkp = await makeEmployee(world, { ptkp: null });
    const runId = await draftRun(world);
    const response = await exporter
      .post(simulatePath(runId))
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("PAYROLL_SIMULATION_INPUT_MISSING");
    // Employee ids only, never other personal data.
    expect(JSON.stringify(response.body)).toContain(noPtkp.id);
    expect(await runStatus(runId)).toBe("draft");
    expect(await countOf("payroll_run_results", runId)).toBe(0);
    expect(await countOf("payslips", runId)).toBe(0);
  }, 90_000);
});
