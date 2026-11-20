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
import { backfillPtkpHistoryForTenant } from "../services/payroll-ptkp-backfill.ts";
import { loadTaxYearPtkpStatuses } from "../services/payroll-ptkp-tax-year.ts";
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
  returnRunToDraft,
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
        JSON.stringify([
          "payroll.view",
          "payroll.run",
          "payroll.lock",
          "hr.employee.manage",
        ]),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, '2025-01-01', $2)`,
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

const JAN = {
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payDate: "2026-01-28",
};
const MAY = {
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
  payDate: "2026-05-28",
};
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

/** HR changes the status (the trigger records it), in force from `effectiveFrom`. */
async function changePtkp(
  employeeId: string,
  status: string,
  effectiveFrom: string,
) {
  await asTenant(async (conn) => {
    await conn.query("SELECT set_config('app.ptkp_effective_from', $1, true)", [
      effectiveFrom,
    ]);
    await conn.query(
      "UPDATE employees SET ptkp_status = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId, status],
    );
  });
}

const historyOf = (employeeId: string) =>
  asTenant(
    async (conn) =>
      (
        await conn.query<{ effective_from: string; ptkp_status: string }>(
          `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, ptkp_status
           FROM employee_ptkp_history WHERE tenant_id = $1 AND employee_id = $2
          ORDER BY effective_from`,
          [tenant.id, employeeId],
        )
      ).rows,
  );

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), runnerId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

async function lockedRun(
  entityId: string,
  policyId: string,
  dates: { periodStart: string; periodEnd: string; payDate: string },
) {
  const runId = await draftRun(entityId, policyId, dates);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  await lockRun(runId);
  return runId;
}

const key = () => `ptkp-1223-${randomUUID()}`;

async function correct(
  employeeId: string,
  body: { ptkpStatus: string; effectiveFrom: string; reason?: string },
  now: Date,
  actorId = runnerId,
) {
  const { correctEmployeePtkp } =
    await import("../services/hris-employee-ptkp.service.ts");
  return correctEmployeePtkp(
    tenantScope(),
    actorId,
    employeeId,
    {
      reason: "Salah input saat data karyawan dibuat",
      ...body,
      idempotencyKey: key(),
    },
    now,
  );
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

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

describe("[1223 r2] backfill of the running year from the first locked payslip", () => {
  it("TK/0 payslip in January, K/0 since July before the deploy: after the backfill December is TK/0, next year K/0; idempotent", async () => {
    const entity = await makeEntity("backfill");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await lockedRun(entity, policy, JAN);
    // What 0515 left: today's status (K/0) from the join date, no trace of TK/0.
    await asTenant(async (conn) => {
      await conn.query(
        "UPDATE employees SET ptkp_status = 'K/0' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, emp],
      );
      await conn.query(
        "UPDATE employee_ptkp_history SET ptkp_status = 'K/0' WHERE tenant_id = $1 AND employee_id = $2",
        [tenant.id, emp],
      );
    }, true);
    const before = await withTenant(db, tenantScope(), (tx) =>
      loadTaxYearPtkpStatuses(tx, tenant.id, 2026, [
        { id: emp, joinDate: "2025-03-01" },
      ]),
    );
    expect(before.get(emp)).toBe("K/0");

    const backfill = () =>
      asTenant((conn) =>
        // force: the test database may already hold HR corrections of other
        // tests (the refusal itself is tested below).
        backfillPtkpHistoryForTenant(conn, tenant.id, 2026, "2026-11-20", true),
      );
    await backfill();
    const once = await historyOf(emp);
    expect(once).toEqual([
      { effective_from: "2025-03-01", ptkp_status: "K/0" },
      { effective_from: "2026-01-01", ptkp_status: "TK/0" },
      { effective_from: "2026-11-20", ptkp_status: "K/0" },
    ]);
    await backfill();
    expect(await historyOf(emp)).toEqual(once);

    const dec = await taxOf(entity, policy, emp, DEC);
    expect(dec.ptkpStatus).toBe("TK/0");
    expect(dec.method).toBe("annual_recalculation");
    const next = await taxOf(entity, policy, emp, JAN_NEXT);
    expect(next.ptkpStatus).toBe("K/0");
  });
});

describe("[1223 r2] HR correction of the running year (hr.employee.manage + payroll.run)", () => {
  const AUG = new Date("2026-08-03T03:00:00Z"); // 2026-08-03 Jakarta

  it("a wrong entry is corrected from 1 January (December uses it), an audit row is written; any other day is 422", async () => {
    const entity = await makeEntity("koreksi");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    const odd = await failureOf(
      correct(emp, { ptkpStatus: "K/1", effectiveFrom: "2026-03-05" }, AUG),
    );
    expect(odd?.status).toBe(422);
    expect(odd?.code).toBe("PTKP_EFFECTIVE_DATE_INVALID");

    const updated = await correct(
      emp,
      { ptkpStatus: "K/1", effectiveFrom: "2026-01-01" },
      AUG,
    );
    expect(updated.employee.ptkpStatus).toBe("K/1");
    expect(updated.taxYearPtkpStatus).toBe("K/1");
    expect(updated.next).toBeNull();
    expect(await historyOf(emp)).toContainEqual({
      effective_from: "2026-01-01",
      ptkp_status: "K/1",
    });
    const audits = await asTenant(async (conn) =>
      Number(
        (
          await conn.query<{ n: string }>(
            "SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'hris.employee_ptkp.corrected'",
            [tenant.id, emp],
          )
        ).rows[0]?.n,
      ),
    );
    expect(audits).toBe(1);
    const jul = await taxOf(entity, policy, emp, JUL);
    expect(jul.ptkpStatus).toBe("K/1");
    expect(jul.terCategory).toBe("B");
  });

  it("refused (409) once the year's December payslip is locked; a change from today still goes to the next year", async () => {
    const entity = await makeEntity("tutup");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await lockedRun(entity, policy, DEC);
    const DEC_30 = new Date("2026-12-30T03:00:00Z");
    const closed = await failureOf(
      correct(emp, { ptkpStatus: "K/0", effectiveFrom: "2026-01-01" }, DEC_30),
    );
    expect(closed?.status).toBe(409);
    expect(closed?.code).toBe("PTKP_TAX_YEAR_CLOSED");
    await correct(
      emp,
      { ptkpStatus: "K/0", effectiveFrom: "2026-12-30" },
      DEC_30,
    );
    expect(await historyOf(emp)).toEqual([
      { effective_from: "2025-03-01", ptkp_status: "TK/0" },
      { effective_from: "2026-12-30", ptkp_status: "K/0" },
    ]);
  });

  it("refused (403) without payroll.run", async () => {
    const entity = await makeEntity("izin");
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    const client = agent(app);
    await signUp(client, "PTKP HR only");
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    createdUsers.push(userId);
    const roleId = randomUUID();
    createdRoles.push(roleId);
    await asTenant(async (conn) => {
      await conn.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, $3, false, $4, $5)`,
        [
          roleId,
          tenant.id,
          `PTKP HR ${roleId.slice(0, 8)}`,
          JSON.stringify(["hr.employee.manage"]),
          JSON.stringify(["tenant"]),
        ],
      );
      await conn.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', NULL, '2025-01-01', $2)`,
        [tenant.id, userId, roleId],
      );
    });
    const denied = await failureOf(
      correct(
        emp,
        { ptkpStatus: "K/0", effectiveFrom: "2026-01-01" },
        AUG,
        userId,
      ),
    );
    expect(denied?.status).toBe(403);
  });
});

describe("[1223 r2] history trigger and table access", () => {
  it("insert records the join date; two corrections on one day keep the last; a day before the join date is refused", async () => {
    const entity = await makeEntity("pemicu");
    const emp = await makeEmployee(entity, "2026-03-02", "TK/0");
    expect(await historyOf(emp)).toEqual([
      { effective_from: "2026-03-02", ptkp_status: "TK/0" },
    ]);
    await changePtkp(emp, "K/0", "2026-03-02");
    await changePtkp(emp, "K/1", "2026-03-02");
    expect(await historyOf(emp)).toEqual([
      { effective_from: "2026-03-02", ptkp_status: "K/1" },
    ]);
    const early = await failureOf(changePtkp(emp, "K/2", "2026-03-01"));
    expect((early as { code?: string } | null)?.code).toBe("23514");
    expect(await historyOf(emp)).toEqual([
      { effective_from: "2026-03-02", ptkp_status: "K/1" },
    ]);
  });

  it("legend_app reads only its tenant's rows and cannot write the history", async () => {
    const entity = await makeEntity("rls");
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL SESSION AUTHORIZATION legend_app");
      const countFor = async (tenantId: string) => {
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
        return Number(
          (
            await client.query<{ n: string }>(
              "SELECT count(*) AS n FROM employee_ptkp_history WHERE employee_id = $1",
              [emp],
            )
          ).rows[0]?.n,
        );
      };
      expect(await countFor(randomUUID())).toBe(0);
      expect(await countFor(tenant.id)).toBe(1);
      await client.query("SAVEPOINT w");
      const denied = await client
        .query(
          "UPDATE employee_ptkp_history SET ptkp_status = 'K/3' WHERE employee_id = $1",
          [emp],
        )
        .then(
          () => null,
          (error: { code?: string }) => error.code,
        );
      expect(denied).toBe("42501");
      await client.query("ROLLBACK TO SAVEPOINT w");
      const insert = await client
        .query(
          `INSERT INTO employee_ptkp_history (tenant_id, employee_id, effective_from, ptkp_status)
           VALUES ($1, $2, '2026-06-01', 'K/3')`,
          [tenant.id, emp],
        )
        .then(
          () => null,
          (error: { code?: string }) => error.code,
        );
      expect(insert).toBe("42501");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("[1223 r3] lock, profile, leaver, backfill guard", () => {
  const AUG = new Date("2026-08-03T03:00:00Z");

  it("a correction after the December simulation makes the lock stale (409); simulated again it locks with the new PTKP", async () => {
    const entity = await makeEntity("lock");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    const runId = await draftRun(entity, policy, DEC);
    await simulateRun(runId);
    await asTenant((conn) => approveSimulatedRun(conn, runId));
    await correct(emp, { ptkpStatus: "K/0", effectiveFrom: "2026-01-01" }, AUG);
    const stale = await failureOf(lockRun(runId));
    expect(stale?.status).toBe(409);
    expect(stale?.code).toBe("PAYROLL_RUN_RESULT_STALE");
    await asTenant((conn) => returnRunToDraft(conn, runId));
    await simulateRun(runId);
    await asTenant((conn) => approveSimulatedRun(conn, runId));
    await lockRun(runId);
    expect((await simulatedTax(runId, emp)).ptkpStatus).toBe("K/0");
  });

  it("a correction from 1 January keeps the profile on the later status (next year's): answer names both", async () => {
    const entity = await makeEntity("profil");
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await changePtkp(emp, "K/0", "2026-07-15");
    const result = await correct(
      emp,
      { ptkpStatus: "TK/1", effectiveFrom: "2026-01-01" },
      AUG,
    );
    expect(result.employee.ptkpStatus).toBe("K/0");
    expect(result.taxYearPtkpStatus).toBe("TK/1");
    expect(result.next).toEqual({
      ptkpStatus: "K/0",
      effectiveFrom: "2026-07-15",
    });
    expect(await historyOf(emp)).toEqual([
      { effective_from: "2025-03-01", ptkp_status: "TK/0" },
      { effective_from: "2026-01-01", ptkp_status: "TK/1" },
      { effective_from: "2026-07-15", ptkp_status: "K/0" },
    ]);
  });

  it("a leaver whose last-period payslip (May) is locked: the correction of the year is 409", async () => {
    const entity = await makeEntity("keluar");
    const policy = await rawPolicy(entity);
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await asTenant((conn) =>
      conn.query(
        "UPDATE employees SET end_date = '2026-05-20' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, emp],
      ),
    );
    const runId = await lockedRun(entity, policy, MAY);
    expect((await simulatedTax(runId, emp)).method).toBe(
      "annual_recalculation",
    );
    const closed = await failureOf(
      correct(emp, { ptkpStatus: "K/0", effectiveFrom: "2026-01-01" }, AUG),
    );
    expect(closed?.status).toBe(409);
    expect(closed?.code).toBe("PTKP_TAX_YEAR_CLOSED");
  });

  it("the backfill refuses a tenant with an audited HR correction unless forced", async () => {
    const entity = await makeEntity("guard");
    const emp = await makeEmployee(entity, "2025-03-01", "TK/0");
    await correct(emp, { ptkpStatus: "K/0", effectiveFrom: "2026-01-01" }, AUG);
    await expect(
      asTenant((conn) =>
        backfillPtkpHistoryForTenant(conn, tenant.id, 2026, "2026-11-20"),
      ),
    ).rejects.toThrow(/koreksi PTKP/);
    await asTenant((conn) =>
      backfillPtkpHistoryForTenant(conn, tenant.id, 2026, "2026-11-20", true),
    );
  });
});
