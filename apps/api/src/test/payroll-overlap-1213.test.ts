// Payroll double-pay guards (bead legend-1213, SO 1208 P1 x2, brief
// docs/briefs/1210-1213-fix-so1208.md). Founder rule "jangan sampai rugi":
// nobody is paid twice for the same days.
//
// DECIDED RULES UNDER TEST
//  (a) A policy cannot be created, or reactivated, when its employment types
//      intersect another ACTIVE policy of the same legal entity: 409
//      PAYROLL_POLICY_EMPLOYMENT_OVERLAP. Other entities, inactive policies
//      and disjoint types are fine.
//  (b) Simulate and lock (under the entity lock) refuse an employee who already
//      holds a payslip in ANOTHER live (not reversed) regular run whose period
//      overlaps: 409 PAYROLL_EMPLOYEE_PERIOD_OVERLAP. Only regular runs are
//      compared; a THR run is never blocked by it.
//  (c) A cycle change is refused when the next period the new cycle would open
//      (the day after the latest live regular run of the policy) starts on or
//      before that run's end: 409 PAYROLL_POLICY_CYCLE_OVERLAPS_RUN. A change
//      that keeps the period boundaries (only the pay day) stays allowed.
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
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, signUp } from "./helpers.ts";
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
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];
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
const createdThr: string[] = [];

const SALARY = 8_000_020;
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};
const OCT = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  payDate: "2026-10-28",
};
const DEC = {
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  payDate: "2026-12-28",
};
const POLICY_OVERLAP = "PAYROLL_POLICY_EMPLOYMENT_OVERLAP";
const RUN_OVERLAP = "PAYROLL_EMPLOYEE_PERIOD_OVERLAP";
const CYCLE_OVERLAP = "PAYROLL_POLICY_CYCLE_OVERLAPS_RUN";

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

let runnerId: string;
let counter = 0;
const key = () => `overlap-1213-${randomUUID()}`;

async function makeRunner() {
  const client = agent(app);
  await signUp(client, "Overlap runner");
  const session = await client.get("/api/auth/get-session");
  runnerId = session.body.user.id as string;
  createdUsers.push(runnerId);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Overlap ${roleId.slice(0, 8)}`,
        JSON.stringify(["payroll.view", "payroll.run", "payroll.lock"]),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, runnerId, roleId],
    );
  });
}

async function makeEntity(label: string): Promise<string> {
  const id = randomUUID();
  createdEntities.push(id);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [id, tenant.id, `PT Irisan ${label} ${++counter}`],
    ),
  );
  return id;
}

/** A raw policy (pkwtt group, monthly calendar cycle) the validator never saw. */
async function rawPolicy(entityId: string): Promise<string> {
  const id = randomUUID();
  createdPolicies.push(id);
  await asTenant((conn) => insertPolicy(conn, tenant.id, entityId, id));
  return id;
}

async function makeEmployee(entityId: string): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: fixtureOutlet.id,
      entityId,
      id,
      name: `Irisan ${++counter}`,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: id,
      amount: SALARY,
      createdBy: runnerId,
    });
  });
  return id;
}

async function draftRun(
  entityId: string,
  policyId: string,
  dates: { periodStart: string; periodEnd: string; payDate: string },
  thr = false,
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  const schedule = await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId,
      policyId,
      thr,
      ...dates,
    }),
  );
  if (schedule) createdThr.push(schedule);
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      runnerId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), runnerId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

async function approvedRun(
  entityId: string,
  policyId: string,
  dates: { periodStart: string; periodEnd: string; payDate: string },
): Promise<string> {
  const runId = await draftRun(entityId, policyId, dates);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  return runId;
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

const monthly = (payDay: number | null, payMonthOffset: 0 | 1 = 0) =>
  ({
    frequency: "monthly",
    cutoffDay: null,
    payDay,
    payMonthOffset,
  }) as const;

async function createPolicy(
  entityId: string,
  code: string,
  employmentTypes: ("pkwtt" | "pkwt" | "daily" | "intern")[],
) {
  const { createPayrollPolicy } =
    await import("../services/payroll-policy.service.ts");
  const created = await createPayrollPolicy(tenantScope(), runnerId, {
    legalEntityId: entityId as never,
    name: `Irisan ${code}`,
    employeeGroup: { code, name: `Grup ${code}`, employmentTypes },
    cycle: monthly(null),
    payDateAdjustment: "none",
    jkkRiskClass: "low",
    bpjsProgrammes: [],
    idempotencyKey: key() as never,
  });
  createdPolicies.push(created.id);
  return created;
}

async function patchPolicy(
  policyId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const { updatePayrollPolicy } =
    await import("../services/payroll-policy.service.ts");
  return updatePayrollPolicy(tenantScope(), runnerId, policyId, {
    ...patch,
    idempotencyKey: key(),
  } as never);
}

const slipCount = (runId: string) =>
  asTenant(async (conn) =>
    Number(
      (
        await conn.query<{ n: string }>(
          "SELECT count(*) AS n FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenant.id, runId],
        )
      ).rows[0]?.n,
    ),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await makeRunner();
  await asTenant(async (conn) => {
    await conn.query(
      "DELETE FROM payroll_pph21_policies WHERE tenant_id = $1",
      [tenant.id],
    );
    await publishStatutoryTables(conn, tenant.id, runnerId);
  });
});

afterAll(async () => {
  await asTenant(async (conn) => {
    await conn.query(
      "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    for (const table of ["payroll_run_results", "payroll_run_month_priors"])
      await conn.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, createdRuns],
      );
    await conn.query("DELETE FROM payslips WHERE payroll_run_id = ANY($1)", [
      createdRuns,
    ]);
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'overlap-1213-%'",
      [tenant.id],
    );
    await conn.query("DELETE FROM payroll_runs WHERE id = ANY($1)", [
      createdRuns,
    ]);
    await conn.query("DELETE FROM thr_schedules WHERE id = ANY($1)", [
      createdThr,
    ]);
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
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

// ---- (a) policies with overlapping employment types -------------------------

describe("[1213a] policy employment types never overlap in one legal entity", () => {
  it("refuses a second active policy that shares an employment type (STAFF [pkwtt,pkwt] + MANAJER [pkwtt])", async () => {
    const entity = await makeEntity("a1");
    await createPolicy(entity, "STAFF", ["pkwtt", "pkwt"]);
    const failure = await failureOf(createPolicy(entity, "MANAJER", ["pkwtt"]));
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe(POLICY_OVERLAP);
  });

  it("allows disjoint types, the same types in another entity, and the same types once the first is inactive", async () => {
    const entity = await makeEntity("a2");
    const other = await makeEntity("a2b");
    const staff = await createPolicy(entity, "STAFF", ["pkwtt", "pkwt"]);
    await createPolicy(entity, "HARIAN", ["daily"]);
    await createPolicy(other, "STAFF", ["pkwtt", "pkwt"]);
    await patchPolicy(staff.id, { isActive: false });
    await createPolicy(entity, "MANAJER", ["pkwtt"]);
  });

  it("refuses to reactivate a policy whose types now overlap an active one", async () => {
    const entity = await makeEntity("a3");
    const staff = await createPolicy(entity, "STAFF", ["pkwtt", "pkwt"]);
    await patchPolicy(staff.id, { isActive: false });
    await createPolicy(entity, "MANAJER", ["pkwtt"]);
    const failure = await failureOf(patchPolicy(staff.id, { isActive: true }));
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe(POLICY_OVERLAP);
  });
});

// ---- (b) one employee, two regular runs, same days ---------------------------

describe("[1213b] an employee is paid once per period across regular runs", () => {
  it("simulate refuses an employee who already has a slip in another live regular run of the same period", async () => {
    const entity = await makeEntity("b1");
    const staff = await rawPolicy(entity);
    const manajer = await rawPolicy(entity);
    const employee = await makeEmployee(entity);
    const first = await approvedRun(entity, staff, NOV);
    await lockRun(first);
    expect(await slipCount(first)).toBe(1);
    const second = await draftRun(entity, manajer, NOV);
    const failure = await failureOf(simulateRun(second));
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe(RUN_OVERLAP);
    expect(employee).toBeTruthy();
  });

  it("lock refuses the second of two approved runs for the same employee and period", async () => {
    const entity = await makeEntity("b2");
    const staff = await rawPolicy(entity);
    const manajer = await rawPolicy(entity);
    await makeEmployee(entity);
    const first = await approvedRun(entity, staff, NOV);
    const second = await approvedRun(entity, manajer, NOV);
    await lockRun(first);
    const failure = await failureOf(lockRun(second));
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe(RUN_OVERLAP);
    expect(await slipCount(second)).toBe(0);
  });

  it("a partly overlapping period (26 Oct-25 Nov after 1-31 Oct) is refused too", async () => {
    const entity = await makeEntity("b3");
    const staff = await rawPolicy(entity);
    const manajer = await rawPolicy(entity);
    await makeEmployee(entity);
    const first = await approvedRun(entity, staff, OCT);
    await lockRun(first);
    const second = await draftRun(entity, manajer, {
      periodStart: "2026-10-26",
      periodEnd: "2026-11-25",
      payDate: "2026-11-28",
    });
    const failure = await failureOf(simulateRun(second));
    expect(failure?.code).toBe(RUN_OVERLAP);
  });

  it("a consecutive period, and a THR run in the same period, are not blocked", async () => {
    const entity = await makeEntity("b4");
    const staff = await rawPolicy(entity);
    const thrPolicy = await rawPolicy(entity);
    await makeEmployee(entity);
    const first = await approvedRun(entity, staff, NOV);
    await lockRun(first);
    const december = await draftRun(entity, staff, DEC);
    await simulateRun(december);
    const thr = await draftRun(entity, thrPolicy, NOV, true);
    const failure = await failureOf(simulateRun(thr));
    // THR may be empty for this employee, but never refused as an overlap.
    expect(failure?.code).not.toBe(RUN_OVERLAP);
  });

  it("re-simulating and locking the run that owns the slip is not an overlap with itself", async () => {
    const entity = await makeEntity("b5");
    const staff = await rawPolicy(entity);
    await makeEmployee(entity);
    const first = await approvedRun(entity, staff, NOV);
    await lockRun(first);
    expect(await slipCount(first)).toBe(1);
  });
});

// ---- (c) cycle change over a live run -----------------------------------------

describe("[1213c] a cycle change cannot reopen days a live run already covers", () => {
  it("refuses cutoff 25 after a live 1-31 Oct run (26 Oct-25 Nov would pay 26-31 Oct twice)", async () => {
    const entity = await makeEntity("c1");
    const policy = await rawPolicy(entity);
    await draftRun(entity, policy, OCT);
    const failure = await failureOf(
      patchPolicy(policy, {
        cycle: {
          frequency: "monthly",
          cutoffDay: 25,
          payDay: 28,
          payMonthOffset: 0,
        },
      }),
    );
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe(CYCLE_OVERLAP);
  });

  it("allows a change that keeps the period boundaries (pay day only), and any change with no live run", async () => {
    const entity = await makeEntity("c2");
    const policy = await rawPolicy(entity);
    await draftRun(entity, policy, OCT);
    await patchPolicy(policy, { cycle: monthly(10, 1) });
    const free = await rawPolicy(await makeEntity("c2b"));
    await patchPolicy(free, {
      cycle: {
        frequency: "monthly",
        cutoffDay: 25,
        payDay: 28,
        payMonthOffset: 0,
      },
    });
  });
});
