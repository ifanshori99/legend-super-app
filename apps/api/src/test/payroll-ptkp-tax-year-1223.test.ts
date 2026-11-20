// PTKP follows the status at the start of the tax year (bead 1223, SO 1221 A
// P2-1, PMK 168/2023). The PTKP of a tax year is the status on 1 January, or on
// the join date when the employee starts during the year; a change in the
// middle of the year (marriage, a child) applies from the next tax year. The
// monthly TER category follows the same status.
//
// Before: simulate read employees.ptkp_status of today, so an employee TK/0
// who married in July was computed K/0 from July (and K/1 moved TER A -> B),
// and December annualised with PTKP 58.5 jt instead of 54 jt (tax short).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
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

async function makeRunner() {
  const client = agent(app);
  await signUp(client, "PTKP runner");
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
        `PTKP ${roleId.slice(0, 8)}`,
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
      [id, tenant.id, `PT PTKP ${label} ${++counter}`],
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

async function makeEmployee(
  entityId: string,
  joinDate: string,
  ptkpStatus: string,
): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: fixtureOutlet.id,
      entityId,
      id,
      name: `PTKP ${++counter}`,
      joinDate,
      ptkpStatus,
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

const JUL = {
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  payDate: "2026-07-28",
};
const DEC = {
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  payDate: "2026-12-28",
};
const JAN_NEXT = {
  periodStart: "2027-01-01",
  periodEnd: "2027-01-31",
  payDate: "2027-01-28",
};

/** HR changes the status (the trigger records it), dated `effectiveFrom`. */
async function changePtkp(
  employeeId: string,
  status: string,
  effectiveFrom: string,
) {
  await asTenant(async (conn) => {
    await conn.query(
      "UPDATE employees SET ptkp_status = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId, status],
    );
    // The trigger dates the change today (Jakarta); pin it for the scenario.
    const moved = await conn.query(
      `UPDATE employee_ptkp_history SET effective_from = $4
        WHERE tenant_id = $1 AND employee_id = $2 AND ptkp_status = $3
          AND effective_from = GREATEST((now() AT TIME ZONE 'Asia/Jakarta')::date,
                                        (SELECT join_date FROM employees WHERE id = $2))`,
      [tenant.id, employeeId, status, effectiveFrom],
    );
    expect(moved.rowCount).toBe(1);
  });
}

type StoredTax = {
  ptkpStatus: string;
  method: string;
  terCategory: string | null;
};

async function simulatedTax(
  runId: string,
  employeeId: string,
): Promise<StoredTax> {
  return asTenant(async (conn) => {
    const row = (
      await conn.query(
        `SELECT payslip_id, result_encrypted, pii_key_version FROM payroll_run_results
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, employeeId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    const parsed = JSON.parse(
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
    ) as { calculation: { tax: StoredTax } };
    return parsed.calculation.tax;
  });
}

async function taxOf(
  entityId: string,
  policyId: string,
  employeeId: string,
  dates: { periodStart: string; periodEnd: string; payDate: string },
) {
  const runId = await draftRun(entityId, policyId, dates);
  await simulateRun(runId);
  return simulatedTax(runId, employeeId);
}

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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ptkp-1223-%'",
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

describe("[1223] PTKP of the tax year: status on 1 January or on the join date", () => {
  it("TK/0 who marries in July (K/0): July-December stay TK/0 (TER A, December annualised on TK/0), the next year is K/0", async () => {
    const entity = await makeEntity("menikah");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await changePtkp(emp, "K/0", "2026-07-15");

    const jul = await taxOf(entity, policy, emp, JUL);
    expect(jul.ptkpStatus).toBe("TK/0");
    expect(jul.method).toBe("ter");
    expect(jul.terCategory).toBe("A");

    const dec = await taxOf(entity, policy, emp, DEC);
    expect(dec.ptkpStatus).toBe("TK/0");
    expect(dec.method).toBe("annual_recalculation");

    const next = await taxOf(entity, policy, emp, JAN_NEXT);
    expect(next.ptkpStatus).toBe("K/0");
    expect(next.terCategory).toBe("A");
  });

  it("TK/0 who becomes K/1 in July keeps TER A (not B) until the next year", async () => {
    const entity = await makeEntity("anak");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await changePtkp(emp, "K/1", "2026-07-15");

    const jul = await taxOf(entity, policy, emp, JUL);
    expect(jul.ptkpStatus).toBe("TK/0");
    expect(jul.terCategory).toBe("A");

    const next = await taxOf(entity, policy, emp, JAN_NEXT);
    expect(next.ptkpStatus).toBe("K/1");
    expect(next.terCategory).toBe("B");
  });

  it("joins in March 2026 as K/1: the status on the join date applies (TER B)", async () => {
    const entity = await makeEntity("masuk");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2026-03-02", "K/1");

    const jul = await taxOf(entity, policy, emp, JUL);
    expect(jul.ptkpStatus).toBe("K/1");
    expect(jul.terCategory).toBe("B");
  });

  it("no history before 1 January: the oldest row applies (a status recorded only in June 2026 counts for 2026)", async () => {
    const entity = await makeEntity("tertua");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "K/1");
    await asTenant((conn) =>
      conn.query(
        `UPDATE employee_ptkp_history SET effective_from = '2026-06-01'
          WHERE tenant_id = $1 AND employee_id = $2`,
        [tenant.id, emp],
      ),
    );

    const jul = await taxOf(entity, policy, emp, JUL);
    expect(jul.ptkpStatus).toBe("K/1");
    expect(jul.terCategory).toBe("B");
  });
});
