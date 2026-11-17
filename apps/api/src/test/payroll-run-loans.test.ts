// Kasbon deduction writer of a payroll run (bead legend-8tfvr; design
// docs/briefs/955-loan-design.md sections 0, 1 and 6; PRD PAYR-01..PAYR-05;
// founder rule "jangan sampai rugi": nobody is deducted more than the loan owes,
// nobody's net pay goes negative, and a reversal gives back exactly what the lock took).
// Fail-first: written before the simulate writer, the lock step and migration 0461.
//
// RULES UNDER TEST (numbers follow brief section 6)
//  1. [simulate-writes]   simulate writes one row and one LOAN line per eligible
//                         loan; amount = min(installment, outstanding); the balance
//                         does not move (PAYR-01).
//  2. [room-cap]          deduction <= floor(netBeforeLoans * bp / 10000), net >= 0;
//                         bp 0 or no policy: no row, no line.
//  3. [cross-run-cap]     a second live run on the same loan only gets what the
//                         first one did not reserve; a fully reserved loan is
//                         skipped, the run is not refused.
//  4. [resimulate-replaces] re-simulating leaves one row per loan; return-to-draft
//                         deletes the rows and frees the reservation.
//  5. [lock-lowers-once]  lock lowers outstanding by exactly the row amount; a
//                         second lock is 409 and moves nothing.
//  6. [last-installment-settles] outstanding < installment: outstanding is
//                         deducted and lock settles the loan.
//  7. [lock-stale-rows]   rows that no longer match the stored LOAN lines (deleted,
//                         changed, extra) make lock 409 PAYROLL_RUN_RESULT_STALE.
//  8. [reversal-after-real-lock] the approved reversal gives the balance back
//                         once, reopens a settled loan, deletes the rows.
//  9. [ledger-db]         the DB refuses (23514 at commit) a loan balance that does
//                         not match the locked runs' deductions.
// 10. [gross-loan-component-refused] a tenant pay component of category
//                         loan_installment is 422 PAYROLL_RUN_SIMULATE_UNSUPPORTED.
// 11. [thr-no-loan]       a THR run deducts no loan.
// 12. [ineligible-loans]  pending/approved loans, a loan whose first deduction
//                         period is after the run, and loans of employees outside
//                         the run are not deducted.
// 13. [concurrent-simulate] two runs simulated in parallel on one loan never
//                         reserve more than the balance and never deadlock.
// 14. [gl-unchanged]      lives in payroll-gl-consumer.test.ts.
//
// ASSUMPTIONS (contract silent; contest if wrong)
//  - The kasbon policy row (max_deduction_of_net_pay_bp) is the only switch: no row
//    or bp 0 means nothing is deducted (design D7).
//  - A second lock of a locked run is any 409 (the exact code is not asserted).
//  - [concurrent-simulate]: a failing run must fail with a 409 (clean, retryable),
//    never with a raw database deadlock (40P01).
//  - Loans seeded "with history" record their earlier installments as rows in one
//    locked run of another legal entity, so principal - outstanding equals the
//    locked deductions (ledger invariant I3).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
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
import {
  openPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
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
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];
const createdLoans: string[] = [];
const createdThrSchedules: string[] = [];

const SALARY = 8_000_020;
const BP = 5000; // kasbon policy: up to 50% of net pay
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};
const DEC = {
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  payDate: "2026-12-28",
};
// January of the next year: a run in another calendar year is not held back by the
// year lock, so two runs can really contend for one loan.
const JAN_NEXT_YEAR = {
  periodStart: "2027-01-01",
  periodEnd: "2027-01-31",
  payDate: "2027-01-28",
};
type Dates = typeof NOV;

const RUNS = "/api/hris/payroll/runs";

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

/** The same, as the application database role (the API's path). */
async function asAppRole(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type PgFailure = { code?: string; message?: string };
const appRoleFailure = (run: (client: PoolClient) => Promise<void>) =>
  asAppRole(run).then(
    () => null,
    (error: unknown) => error as PgFailure,
  );

async function signedInUser(name: string) {
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
        `Run loans ${roleId.slice(0, 8)}`,
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

let requesterId: string;
let approverId: string;
let maker: Awaited<ReturnType<typeof signedInUser>>;
let counter = 0;

type World = { entityId: string; policyId: string };
type Emp = { id: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Kasbon Run ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, requesterId);
  });
  return world;
}

/** No bank account on file: the payee is paid in cash, no PII call needed. */
async function makeEmployee(world: World, salary = SALARY): Promise<Emp> {
  const emp = { id: randomUUID() };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: `Kasbon Run ${++counter}`,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: salary,
      createdBy: requesterId,
    });
  });
  return emp;
}

async function draftRun(
  world: World,
  dates: Dates = NOV,
  thr = false,
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  const schedule = await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      thr,
      ...dates,
    }),
  );
  if (schedule) createdThrSchedules.push(schedule);
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      requesterId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), requesterId, {
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
      requesterId,
      payrollRunIdSchema.parse(runId),
      "Salah hitung, dibatalkan (uji kasbon run)",
    ),
  );
}

async function decideReversal(runId: string) {
  const { decidePayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      approverId,
      payrollRunIdSchema.parse(runId),
      "approve",
    ),
  );
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

/** simulated -> approved (SQL), the approval routes are not under test here. */
async function approvedRun(world: World, dates: Dates = NOV) {
  const runId = await draftRun(world, dates);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return runId;
}

// ---- Kasbon policy, loans, history ------------------------------------------

/** `bp = null` removes the tenant's kasbon policy row. */
async function setPolicy(bp: number | null) {
  await asTenant(async (conn) => {
    await conn.query("DELETE FROM payroll_loan_policies WHERE tenant_id = $1", [
      tenant.id,
    ]);
    if (bp !== null)
      await conn.query(
        `INSERT INTO payroll_loan_policies
           (tenant_id, max_principal_idr, max_principal_of_base_salary_bp, max_installments,
            max_deduction_of_net_pay_bp, single_open_loan, max_total_open_idr)
         VALUES ($1, 100000000, NULL, 36, $2, false, 1000000000)`,
        [tenant.id, bp],
      );
  });
}

const insertDeductionSql = `INSERT INTO payroll_loan_deductions
  (tenant_id, payroll_run_id, employee_id, loan_id, amount_idr)
  VALUES ($1, $2, $3, $4, $5)`;

let historyRunId: string | null = null;
/**
 * One locked run (own legal entity, no loans of its own) that carries the
 * earlier installments of seeded loans, so that principal - outstanding equals
 * the locked deductions (ledger invariant I3).
 */
async function ensureHistoryRun(): Promise<string> {
  if (historyRunId) return historyRunId;
  const world = await makeWorld();
  await makeEmployee(world);
  const runId = await approvedRun(world);
  await lockRun(runId);
  expect(await runStatus(runId), "history run is locked").toBe("locked");
  historyRunId = runId;
  return runId;
}

type LoanSeed = {
  principal?: number;
  installment?: number;
  /** Earlier installments already deducted by locked runs (raw rows). */
  history?: number;
  status?: "pending" | "approved" | "disbursed";
  firstPeriod?: string;
};

async function seedLoan(employeeId: string, seed: LoanSeed = {}) {
  const principal = seed.principal ?? 1_000_000;
  const installment = seed.installment ?? 100_000;
  const history = seed.history ?? 0;
  const status = seed.status ?? "disbursed";
  const loanId = randomUUID();
  createdLoans.push(loanId);
  const historyRun = history > 0 ? await ensureHistoryRun() : null;
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Kasbon uji run', $9,
               $10, $11, $12)`,
      [
        loanId,
        tenant.id,
        employeeId,
        principal,
        installment,
        Math.ceil(principal / installment),
        principal - history,
        seed.firstPeriod ?? "2026-11-01",
        status,
        status === "pending" ? null : requesterId,
        status === "pending" ? null : new Date().toISOString(),
        status === "disbursed" ? new Date().toISOString() : null,
      ],
    );
    if (historyRun)
      await conn.query(insertDeductionSql, [
        tenant.id,
        historyRun,
        employeeId,
        loanId,
        history,
      ]);
  }, history > 0);
  return loanId;
}

type LoanRow = {
  outstanding: number;
  status: string;
  settledAt: string | null;
};
const loanOf = async (loanId: string): Promise<LoanRow> => {
  const row = await scalar(
    `SELECT outstanding_idr, status, settled_at
       FROM employee_loans WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, loanId],
  );
  return {
    outstanding: Number(row.outstanding_idr),
    status: row.status as string,
    settledAt: row.settled_at as string | null,
  };
};
const outstandingOf = async (loanId: string) =>
  (await loanOf(loanId)).outstanding;

/** The deduction rows of a run as { loanId: amount }, plus the employee per loan. */
async function rowsOf(runId: string) {
  const rows = await asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT employee_id, loan_id, amount_idr FROM payroll_loan_deductions
          WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY loan_id`,
        [tenant.id, runId],
      )
    ).rows.map((row) => ({
      employeeId: row.employee_id as string,
      loanId: row.loan_id as string,
      amount: Number(row.amount_idr),
    })),
  );
  return {
    rows,
    byLoan: Object.fromEntries(rows.map((row) => [row.loanId, row.amount])),
    sum: rows.reduce((total, row) => total + row.amount, 0),
  };
}

type Line = {
  componentCode: string;
  category: string;
  kind: string;
  amountIdr: number;
  taxable: boolean;
  sourceId: string | null;
};
type Calc = {
  employeeId: string;
  grossIdr: number;
  deductionsIdr: number;
  netIdr: number;
  lines: Line[];
};

/** The stored (decrypted) simulation of every employee of a run. */
const storedResults = (runId: string) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT employee_id, payslip_id, result_encrypted, pii_key_version
           FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    return rows.map((row) => ({
      employeeId: row.employee_id as string,
      calc: (
        JSON.parse(
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
        ) as { calculation: Calc }
      ).calculation,
    }));
  });

/** Every LOAN-category line of a run's stored simulation. */
async function loanLines(runId: string) {
  const results = await storedResults(runId);
  return results.flatMap((result) =>
    result.calc.lines
      .filter((line) => line.category === "loan_installment")
      .map((line) => ({ employeeId: result.employeeId, line })),
  );
}

const loanRepaymentOf = async (runId: string) =>
  Number(
    (
      await scalar(
        "SELECT totals->>'loanRepaymentIdr' AS v FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
        [tenant.id, runId],
      )
    ).v,
  );

// ---- Setup / teardown --------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const requester = await signedInUser("Run loans requester");
  requesterId = requester.userId;
  await grantRole(requesterId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    "payroll.cancel.approve",
  ]);
  const approver = await signedInUser("Run loans approver");
  approverId = approver.userId;
  await grantRole(approverId, ["payroll.view", "payroll.cancel.approve"]);
  maker = await signedInUser("Run loans maker");
  await grantRole(maker.userId, [
    "payroll.view",
    "payroll.run",
    "payroll.approve",
  ]);
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
  await setPolicy(BP);
});

afterAll(async () => {
  await setPolicy(null);
  await asTenant(async (conn) => {
    for (const table of [
      "payroll_loan_deductions",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'run-loans-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM employee_loans WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdLoans],
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- 1. [simulate-writes] ---------------------------------------------------

describe("simulate reserves the installments", () => {
  it("[simulate-writes] one row and one LOAN line per loan, amount = min(installment, outstanding), totals add up, the balance does not move", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const full = await seedLoan(emp.id); // outstanding 1.000.000, installment 100.000
    // outstanding 50.000 < installment 80.000: only the 50.000 is owed.
    const small = await seedLoan(emp.id, {
      principal: 500_000,
      installment: 80_000,
      history: 450_000,
    });
    const runId = await draftRun(world);

    await simulateRun(runId);

    expect(await runStatus(runId)).toBe("simulated");
    const stored = await rowsOf(runId);
    expect(stored.rows).toHaveLength(2);
    expect(stored.byLoan).toEqual({ [full]: 100_000, [small]: 50_000 });
    expect(stored.rows.every((row) => row.employeeId === emp.id)).toBe(true);

    const lines = await loanLines(runId);
    expect(lines).toHaveLength(2);
    for (const { employeeId, line } of lines) {
      expect(employeeId).toBe(emp.id);
      expect(line.componentCode).toBe("LOAN");
      expect(line.category).toBe("loan_installment");
      expect(line.kind).toBe("deduction");
      expect(line.taxable).toBe(false);
      expect(line.sourceId, "the line points at its loan").not.toBeNull();
      expect(line.amountIdr).toBe(stored.byLoan[line.sourceId!]);
    }
    expect(new Set(lines.map(({ line }) => line.sourceId))).toEqual(
      new Set([full, small]),
    );
    expect(await loanRepaymentOf(runId)).toBe(150_000);
    expect(await loanRepaymentOf(runId)).toBe(stored.sum);

    // PAYR-01: simulating has no side effect on money.
    expect(await outstandingOf(full)).toBe(1_000_000);
    expect(await outstandingOf(small)).toBe(50_000);
    expect((await loanOf(full)).status).toBe("disbursed");
  }, 180_000);
});

// ---- 2. [room-cap] ------------------------------------------------------------

describe("deduction never exceeds the room in net pay", () => {
  it("[room-cap] low net pay: deduction <= floor(netBeforeLoans * bp / 10000), net >= 0; bp 0 or no policy deducts nothing", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world, 1_000_000);
    const loan = await seedLoan(emp.id, {
      principal: 2_000_000,
      installment: 500_000,
    });
    const runId = await draftRun(world);

    await setPolicy(3000);
    try {
      await simulateRun(runId);
      const [slip] = await storedResults(runId);
      const deducted = (await rowsOf(runId)).byLoan[loan] ?? 0;
      const netBeforeLoans = slip!.calc.netIdr + deducted;
      const room = Math.floor((netBeforeLoans * 3000) / 10_000);
      expect(room, "the cap binds: room is below the installment").toBeLessThan(
        500_000,
      );
      expect(deducted, "something is deducted").toBeGreaterThan(0);
      expect(deducted).toBeLessThanOrEqual(room);
      expect(deducted).toBe(Math.min(500_000, room));
      expect(slip!.calc.netIdr).toBeGreaterThanOrEqual(0);
      expect(await loanRepaymentOf(runId)).toBe(deducted);

      // bp 0: the policy allows no deduction at all.
      await setPolicy(0);
      await simulateRun(runId);
      expect((await rowsOf(runId)).rows, "bp 0: no row").toHaveLength(0);
      expect(await loanLines(runId), "bp 0: no line").toHaveLength(0);
      expect(await loanRepaymentOf(runId)).toBe(0);

      // No policy row at all: the same.
      await setPolicy(null);
      await simulateRun(runId);
      expect((await rowsOf(runId)).rows, "no policy: no row").toHaveLength(0);
      expect(await loanLines(runId), "no policy: no line").toHaveLength(0);
      expect(await loanRepaymentOf(runId)).toBe(0);
    } finally {
      await setPolicy(BP);
    }
    expect(await outstandingOf(loan)).toBe(2_000_000);
  }, 240_000);
});

// ---- 3-4. reservation across runs -------------------------------------------

describe("a loan is reserved by one live run at a time", () => {
  it("[cross-run-cap] run B only gets outstanding - what run A reserved; a fully reserved loan gets no row and B is not refused", async () => {
    const world = await makeWorld();
    const e1 = await makeEmployee(world);
    const e2 = await makeEmployee(world);
    const partly = await seedLoan(e1.id, { history: 850_000 }); // outstanding 150.000
    const fully = await seedLoan(e2.id, {
      principal: 400_000,
      installment: 100_000,
      history: 300_000, // outstanding 100.000 = one installment
    });
    const runA = await draftRun(world, NOV);
    await simulateRun(runA);
    expect((await rowsOf(runA)).byLoan).toEqual({
      [partly]: 100_000,
      [fully]: 100_000,
    });

    const runB = await draftRun(world, DEC);
    await simulateRun(runB); // must not be refused
    expect(await runStatus(runB)).toBe("simulated");
    const b = await rowsOf(runB);
    expect(b.byLoan[partly], "only the unreserved 50.000 is left").toBe(50_000);
    expect(b.byLoan[fully], "fully reserved: no row").toBeUndefined();
    const linesB = await loanLines(runB);
    expect(linesB.map(({ line }) => line.sourceId)).toEqual([partly]);
    expect(await loanRepaymentOf(runB)).toBe(50_000);

    expect(await outstandingOf(partly)).toBe(150_000);
    expect(await outstandingOf(fully)).toBe(100_000);
  }, 240_000);

  it("[resimulate-replaces] simulating twice leaves one row per loan; return-to-draft deletes the rows and frees the reservation for run B", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id, { history: 850_000 }); // outstanding 150.000
    const runA = await draftRun(world, NOV);
    await simulateRun(runA);
    await simulateRun(runA);
    expect(
      (await rowsOf(runA)).byLoan,
      "one row after two simulations",
    ).toEqual({ [loan]: 100_000 });
    expect(await loanLines(runA)).toHaveLength(1);

    const runB = await draftRun(world, DEC);
    await simulateRun(runB);
    expect((await rowsOf(runB)).byLoan[loan]).toBe(50_000);

    const back = await maker.client
      .post(`${RUNS}/${runA}/return-to-draft`)
      .set(originHeader)
      .send({ reason: "Koreksi", idempotencyKey: `run-loans-${randomUUID()}` });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await runStatus(runA)).toBe("draft");
    expect((await rowsOf(runA)).rows, "rows deleted").toHaveLength(0);

    // The reservation is free again: B simulated once more takes the full installment.
    await simulateRun(runB);
    expect((await rowsOf(runB)).byLoan[loan]).toBe(100_000);
    expect((await rowsOf(runB)).rows).toHaveLength(1);
    expect(await outstandingOf(loan)).toBe(150_000);
  }, 240_000);
});

// ---- 5-6. lock ---------------------------------------------------------------

describe("lock takes the installment out of the balance", () => {
  it("[lock-lowers-once] lock lowers outstanding by exactly the row amount; a second lock is 409 and moves nothing", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id);
    const runId = await approvedRun(world);
    const { sum, byLoan } = await rowsOf(runId);
    expect(byLoan, "simulate reserved the installment").toEqual({
      [loan]: 100_000,
    });
    expect(await outstandingOf(loan), "approval lowers nothing").toBe(
      1_000_000,
    );

    await lockRun(runId);

    expect(await runStatus(runId)).toBe("locked");
    expect(await outstandingOf(loan)).toBe(1_000_000 - sum);
    expect((await loanOf(loan)).status).toBe("disbursed");
    expect((await rowsOf(runId)).byLoan, "rows stay as the record").toEqual(
      byLoan,
    );

    const again = await failureOf(lockRun(runId));
    expect(again, "a second lock must be refused").not.toBeNull();
    expect(again!.status).toBe(409);
    expect(await outstandingOf(loan)).toBe(1_000_000 - sum);
  }, 240_000);

  it("[last-installment-settles] outstanding below the installment: outstanding is deducted, lock settles the loan", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id, { history: 940_000 }); // outstanding 60.000
    const runId = await approvedRun(world);
    expect((await rowsOf(runId)).byLoan).toEqual({ [loan]: 60_000 });

    await lockRun(runId);

    const after = await loanOf(loan);
    expect(after.outstanding).toBe(0);
    expect(after.status).toBe("settled");
    expect(after.settledAt, "settled_at is set").not.toBeNull();
  }, 240_000);

  it.each(["row deleted", "amount changed", "extra loan row"])(
    "[lock-stale-rows] %s after approval: lock is 409 PAYROLL_RUN_RESULT_STALE, the run stays approved, the balance is unchanged",
    async (tamper) => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const loan = await seedLoan(emp.id);
      const runId = await approvedRun(world);
      expect(
        (await rowsOf(runId)).byLoan,
        "precondition: the run holds its row",
      ).toEqual({ [loan]: 100_000 });

      await asTenant(async (conn) => {
        if (tamper === "row deleted")
          await conn.query(
            "DELETE FROM payroll_loan_deductions WHERE tenant_id = $1 AND payroll_run_id = $2",
            [tenant.id, runId],
          );
        else if (tamper === "amount changed")
          await conn.query(
            `UPDATE payroll_loan_deductions SET amount_idr = amount_idr - 1
              WHERE tenant_id = $1 AND payroll_run_id = $2`,
            [tenant.id, runId],
          );
        else {
          const other = randomUUID();
          createdLoans.push(other);
          await conn.query(
            `INSERT INTO employee_loans
               (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
                outstanding_idr, first_deduction_period, reason, status,
                decided_by, decided_at, disbursed_at)
             VALUES ($1, $2, $3, 500000, 50000, 10, 500000, '2026-11-01',
                     'Kasbon uji tambahan', 'disbursed', $4, now(), now())`,
            [other, tenant.id, emp.id, requesterId],
          );
          await conn.query(insertDeductionSql, [
            tenant.id,
            runId,
            emp.id,
            other,
            50_000,
          ]);
        }
      }, true);

      const refused = await failureOf(lockRun(runId));
      expect(
        refused,
        "rows that differ from the lines must be refused",
      ).not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
      expect(await runStatus(runId)).toBe("approved");
      expect(await outstandingOf(loan)).toBe(1_000_000);
    },
    240_000,
  );
});

// ---- 8. reversal -------------------------------------------------------------

describe("reversal gives back what the lock took", () => {
  it("[reversal-after-real-lock] the balance returns to its pre-lock value once, a settled loan is reopened, the rows are gone, a second decide is 409", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const open = await seedLoan(emp.id); // outstanding 1.000.000, -100.000
    const closing = await seedLoan(emp.id, { history: 950_000 }); // 50.000, settles
    const runId = await approvedRun(world);
    expect((await rowsOf(runId)).byLoan).toEqual({
      [open]: 100_000,
      [closing]: 50_000,
    });

    await lockRun(runId);
    expect(await outstandingOf(open)).toBe(900_000);
    expect((await loanOf(closing)).status).toBe("settled");

    await requestReversal(runId);
    await decideReversal(runId);

    expect(await runStatus(runId)).toBe("reversed");
    expect(await outstandingOf(open)).toBe(1_000_000);
    const reopened = await loanOf(closing);
    expect(reopened.outstanding).toBe(50_000);
    expect(reopened.status).toBe("disbursed");
    expect(reopened.settledAt, "settled_at is cleared").toBeNull();
    expect((await rowsOf(runId)).rows, "rows deleted").toHaveLength(0);

    const again = await failureOf(decideReversal(runId));
    expect(again, "a second decide must be refused").not.toBeNull();
    expect(again!.status).toBe(409);
    expect(await outstandingOf(open)).toBe(1_000_000);
    expect((await loanOf(closing)).outstanding).toBe(50_000);
  }, 240_000);
});

// ---- 9. [ledger-db] ----------------------------------------------------------

describe("the database keeps the loan ledger", () => {
  it("[ledger-db] lowering outstanding with no locked deduction behind it is 23514 at commit", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id);

    const failure = await appRoleFailure(async (conn) => {
      await conn.query(
        `UPDATE employee_loans SET outstanding_idr = outstanding_idr - 1
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
    });

    expect(
      failure,
      "a balance without a ledger entry must be refused",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(failure!.message).toMatch(/balance does not match/);
    expect(await outstandingOf(loan)).toBe(1_000_000);
  }, 120_000);

  it("[ledger-db] deleting the rows of a locked run (reversal pending) without restoring the balance, then marking it reversed, is 23514 at commit", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id);
    const runId = await approvedRun(world);
    await lockRun(runId);
    await requestReversal(runId);
    expect(await outstandingOf(loan)).toBe(900_000);
    expect(
      (await rowsOf(runId)).rows,
      "precondition: the locked run holds its row",
    ).toHaveLength(1);

    const failure = await appRoleFailure(async (conn) => {
      await conn.query(
        "DELETE FROM payroll_loan_deductions WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      );
      await conn.query(
        `UPDATE payroll_runs
            SET status = 'reversed',
                reversal = jsonb_set(reversal, '{status}', '"approved"')
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, runId],
      );
    });

    expect(
      failure,
      "rows removed without a restore must be refused",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(failure!.message).toMatch(/balance does not match/);
    expect(await runStatus(runId)).toBe("locked");
    expect(await outstandingOf(loan)).toBe(900_000);
    expect((await rowsOf(runId)).rows).toHaveLength(1);
  }, 240_000);

  it("[ledger-db] a loan INSERTed as disbursed with outstanding below principal is 23514 at commit; outstanding = principal is accepted", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const insertLoan = (loanId: string, outstanding: number) =>
      appRoleFailure(async (conn) => {
        await conn.query(
          `INSERT INTO employee_loans
             (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
              outstanding_idr, first_deduction_period, reason, status,
              decided_by, decided_at, disbursed_at)
           VALUES ($1, $2, $3, 1000000, 100000, 10, $4, '2026-11-01', 'Kasbon uji ledger',
                   'disbursed', $5, now(), now())`,
          [loanId, tenant.id, emp.id, outstanding, requesterId],
        );
      });

    // Positive control: a fresh disbursed loan owes its whole principal.
    const okLoan = randomUUID();
    createdLoans.push(okLoan);
    expect(
      await insertLoan(okLoan, 1_000_000),
      "outstanding = principal is a valid new loan",
    ).toBeNull();
    expect(await outstandingOf(okLoan)).toBe(1_000_000);

    const badLoan = randomUUID();
    createdLoans.push(badLoan);
    const failure = await insertLoan(badLoan, 999_999);

    expect(
      failure,
      "a new loan that already owes less than its principal must be refused",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    const stored = await asTenant((conn) =>
      conn.query(
        "SELECT 1 FROM employee_loans WHERE tenant_id = $1 AND id = $2",
        [tenant.id, badLoan],
      ),
    );
    expect(stored.rows, "the refused loan was not stored").toHaveLength(0);
  }, 120_000);
});

// ---- 10. [gross-loan-component-refused] --------------------------------------

describe("only the writer may produce loan lines", () => {
  it("[gross-loan-component-refused] a pay component of category loan_installment is 422 PAYROLL_RUN_SIMULATE_UNSUPPORTED, nothing stored", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const componentId = randomUUID();
    const rowId = randomUUID();
    await asTenant(async (conn) => {
      await conn.query(
        `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
           recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
         VALUES ($1, $2, $3, 'Cicilan manual uji', 'loan_installment', 'deduction',
           'fixed', false, 'gross', false, false, false)`,
        [
          componentId,
          tenant.id,
          `SM_${componentId.replaceAll("-", "").slice(0, 10).toUpperCase()}`,
        ],
      );
      await conn.query(
        `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
           amount_encrypted, pii_key_version, effective_from, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, '2025-01-01', $7)`,
        [
          rowId,
          tenant.id,
          emp.id,
          componentId,
          sealPayrollAmount(idr(50_000), {
            tenantId: tenant.id,
            table: "employee_pay_components",
            rowId,
            field: "amount",
          }),
          PAYROLL_SEAL_KEY_VERSION,
          requesterId,
        ],
      );
    });
    const runId = await draftRun(world);

    const refused = await failureOf(simulateRun(runId));

    expect(refused, "a tenant loan component must be refused").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_RUN_SIMULATE_UNSUPPORTED");
    expect(await runStatus(runId)).toBe("draft");
    expect((await rowsOf(runId)).rows).toHaveLength(0);
  }, 180_000);
});

// ---- 11-12. who is deducted ---------------------------------------------------

describe("only eligible loans of regular runs are deducted", () => {
  it("[thr-no-loan] a THR run deducts no loan, while the regular run of the same employee does", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id, { firstPeriod: "2026-11-01" });

    // Positive control: the regular November run reserves the installment.
    const regular = await draftRun(world, NOV);
    await simulateRun(regular);
    expect((await rowsOf(regular)).byLoan).toEqual({ [loan]: 100_000 });

    const thr = await draftRun(world, DEC, true);
    await simulateRun(thr);
    expect(await runStatus(thr)).toBe("simulated");
    expect((await rowsOf(thr)).rows, "THR: no row").toHaveLength(0);
    expect(await loanLines(thr), "THR: no line").toHaveLength(0);
    expect(await loanRepaymentOf(thr)).toBe(0);
    expect(await outstandingOf(loan)).toBe(1_000_000);
  }, 240_000);

  it("[ineligible-loans] pending, approved, not-yet-due and out-of-run loans are not deducted; each eligible loan is deducted from its own employee", async () => {
    const world = await makeWorld();
    const e1 = await makeEmployee(world);
    const e2 = await makeEmployee(world);
    const eligible1 = await seedLoan(e1.id);
    const eligible2 = await seedLoan(e2.id, {
      principal: 600_000,
      installment: 60_000,
    });
    const pending = await seedLoan(e1.id, { status: "pending" });
    const approved = await seedLoan(e1.id, { status: "approved" });
    // First deduction in December: not due in a run that ends on 30 November.
    const notDue = await seedLoan(e1.id, { firstPeriod: "2026-12-01" });
    // An employee of another legal entity is not in this run.
    const otherWorld = await makeWorld();
    const stranger = await makeEmployee(otherWorld);
    const outOfRun = await seedLoan(stranger.id);
    const runId = await draftRun(world);

    await simulateRun(runId);

    const stored = await rowsOf(runId);
    expect(stored.byLoan).toEqual({
      [eligible1]: 100_000,
      [eligible2]: 60_000,
    });
    expect(
      Object.fromEntries(
        stored.rows.map((row) => [row.loanId, row.employeeId]),
      ),
    ).toEqual({ [eligible1]: e1.id, [eligible2]: e2.id });
    const lines = await loanLines(runId);
    expect(
      lines.map(({ employeeId, line }) => [employeeId, line.sourceId]).sort(),
    ).toEqual(
      [
        [e1.id, eligible1],
        [e2.id, eligible2],
      ].sort(),
    );
    for (const skipped of [pending, approved, notDue, outOfRun])
      expect(
        stored.byLoan[skipped],
        `loan ${skipped} is not deducted`,
      ).toBeUndefined();
    expect(await loanRepaymentOf(runId)).toBe(160_000);
  }, 240_000);
});

// ---- 13. [concurrent-simulate] ----------------------------------------------

describe("two runs reserving one loan together", () => {
  it("[concurrent-simulate] runs of two months (December and January of the next year, outside the year lock) simulated in parallel reserve at most the balance and never deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const loan = await seedLoan(emp.id, { history: 850_000 }); // outstanding 150.000
      const runA = await draftRun(world, DEC);
      const runB = await draftRun(world, JAN_NEXT_YEAR);

      const outcomes = await Promise.all([
        failureOf(simulateRun(runA)),
        failureOf(simulateRun(runB)),
      ]);

      for (const outcome of outcomes.filter((o) => o !== null)) {
        expect(outcome!.status, `round ${round}: a clean retryable error`).toBe(
          409,
        );
      }
      const a = await rowsOf(runA);
      const b = await rowsOf(runB);
      const reserved = (a.byLoan[loan] ?? 0) + (b.byLoan[loan] ?? 0);
      expect(
        reserved,
        `round ${round}: never above the balance`,
      ).toBeLessThanOrEqual(150_000);
      if (outcomes.every((o) => o === null))
        expect(reserved, `round ${round}: both simulated, nothing lost`).toBe(
          150_000,
        );
      expect(await outstandingOf(loan)).toBe(150_000);
    }
  }, 600_000);
});
