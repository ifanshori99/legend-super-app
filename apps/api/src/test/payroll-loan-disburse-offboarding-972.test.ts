// Kasbon disbursement after offboarding + simulate-vs-complete race
// (bead legend-bckn9, brief docs/briefs/972-payroll-sisa.md; follow-up of 955
// commits 67d26efc7 "guard offboarding" and 15344ad49 "skip loans at simulate").
// Founder rule "jangan sampai rugi": no loan money goes out to an employee whose
// offboarding is completed; no installment is deducted twice or missed.
// Fail-first: written before the disbursement guard exists.
//
// RULES UNDER TEST
//  1. [disburse-offboarding-completed] POST /api/hris/payroll/loans/:id/disburse
//                         of an `approved` loan whose employee has a `completed`
//                         offboarding is 409 PAYROLL_LOAN_OFFBOARDING_COMPLETED. The loan
//                         stays `approved`, disbursed_at stays null (no money out).
//  2. [disburse-offboarding-open] an offboarding that is not completed (created, then
//                         access revoked) does not block the disbursement (200); an
//                         employee with no offboarding disburses normally (200).
//  3. [race-simulate-vs-complete] one transaction simulates the run while another
//                         completes the offboarding (POST .../complete). Allowed outcomes:
//                         a) complete 200 -> the run has NO deduction row for the leaver;
//                         b) complete 409 PAYROLL_DEDUCTION_PENDING -> the run holds the row
//                            (100.000), the offboarding stays revoked, and completing again
//                            after the run is locked gives 200.
//                         In every outcome the final loan balance (after the run is locked)
//                         equals outstandingLoans.amountIdr of the frozen settlement
//                         snapshot, and pendingPayrollDeductions.count is 0 (no double
//                         deduction, no bill that is too low).
//
// ASSUMPTIONS (contract silent; contest if wrong)
//  - The 409 error code is `PAYROLL_LOAN_OFFBOARDING_COMPLETED` (brief: "409 kode jelas";
//    the exact code is not named in the brief or the shared validators). Rename here if
//    the engineer picks another one; the status 409 is the hard rule.
//  - Only a `completed` offboarding blocks disbursement (brief). `revoked` does not.
//  - The disbursement guard is asked at disburse time. To not depend on how the
//    completion treats an approved loan, the loan is seeded AFTER the offboarding is
//    completed (a loan approved late), not before.
//  - A simulate that loses the race may fail with a clean 409 (retryable); it must
//    never fail with a raw database error. Then no row exists and the balance is untouched.
//  - Race tests assert invariants that hold for either interleaving, so they are
//    deterministic; the sleep in [race-open-simulate] only gives the competing request a
//    chance to reach the database, it is never asserted on.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { finalSettlementSummarySchema } from "@starter/shared/hris";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
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
  max: 6,
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
type Dates = typeof NOV;
const LAST_DAY = "2026-11-16";
const GUARD_CODE = "PAYROLL_DEDUCTION_PENDING";
const DISBURSE_CODE = "PAYROLL_LOAN_OFFBOARDING_COMPLETED";
const LOANS = "/api/hris/payroll/loans";

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
        `Disburse 972 ${roleId.slice(0, 8)}`,
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
let hr: Awaited<ReturnType<typeof signedInUser>>;
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
      [world.entityId, tenant.id, `PT Kasbon 972 ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, requesterId);
  });
  return world;
}

/** No bank account on file: the payee is paid in cash, no PII call needed. */
async function makeEmployee(world: World): Promise<Emp> {
  const emp = { id: randomUUID() };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: `Kasbon 972 ${++counter}`,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      createdBy: requesterId,
    });
  });
  return emp;
}

async function draftRun(world: World, dates: Dates = NOV): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  const schedule = await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      thr: false,
      ...dates,
    }),
  );
  if (schedule) createdThrSchedules.push(schedule);
  return runId;
}

/**
 * Simulate in its own transaction. `hold` (optional) runs after the rows are
 * written but BEFORE the transaction commits, so a competing request can be
 * fired while the simulate is still open.
 */
async function simulateRun(runId: string, hold?: () => Promise<void>) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), async (tx) => {
    const result = await simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      requesterId,
      payrollRunIdSchema.parse(runId),
    );
    if (hold) await hold();
    return result;
  });
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

type Failure = { status?: number; code?: string; message?: string };
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

async function seedLoan(
  employeeId: string,
  status: "approved" | "disbursed" = "disbursed",
) {
  const loanId = randomUUID();
  createdLoans.push(loanId);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, 1000000, 100000, 10, 1000000, '2026-11-01',
               'Kasbon uji 972', $4, $5, now(), $6)`,
      [
        loanId,
        tenant.id,
        employeeId,
        status,
        requesterId,
        status === "disbursed" ? new Date().toISOString() : null,
      ],
    ),
  );
  return loanId;
}

const loanOf = async (loanId: string) => {
  const row = await scalar(
    `SELECT outstanding_idr, status, disbursed_at
       FROM employee_loans WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, loanId],
  );
  return {
    outstanding: Number(row.outstanding_idr),
    status: row.status as string,
    disbursedAt: row.disbursed_at as string | null,
  };
};

/** The deduction rows of a run as { loanId: amount }. */
async function rowsOf(runId: string) {
  const rows = await asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT loan_id, amount_idr FROM payroll_loan_deductions
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows.map((row) => ({
      loanId: row.loan_id as string,
      amount: Number(row.amount_idr),
    })),
  );
  return Object.fromEntries(rows.map((row) => [row.loanId, row.amount]));
}

// ---- Offboarding helpers (HTTP, like the 955 guard tests) ----------------------

const postAs = (path: string, body: object = {}) =>
  hr.client.post(path).set(originHeader).send(body);

/** Create, move the last day into the past, revoke access: status `revoked`. */
async function revokedExit(employeeId: string): Promise<string> {
  const created = await postAs(
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "resignation",
      reason: "Akhir hubungan kerja uji 972.",
      lastWorkingDate: "2034-09-30",
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
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

/** Waive every open checklist task (HR may). */
async function waiveAll(employeeId: string) {
  const listed = await hr.client.get(
    `/api/hris/employees/${employeeId}/checklist-tasks?limit=100`,
  );
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  for (const task of listed.body.data as { id: string; status: string }[]) {
    if (task.status === "done" || task.status === "waived") continue;
    const waived = await postAs(
      `/api/hris/checklist-tasks/${task.id}/actions`,
      {
        action: "waive",
        reason: "Uji kasbon 972",
      },
    );
    expect(waived.status, JSON.stringify(waived.body)).toBeLessThan(300);
  }
}

const completeExit = (offboardingId: string) =>
  postAs(`/api/hris/offboardings/${offboardingId}/complete`);

async function exitRow(offboardingId: string) {
  const row = await scalar(
    `SELECT status, settlement_snapshot
       FROM hris_offboardings WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, offboardingId],
  );
  return {
    status: row.status as string,
    snapshot: row.settlement_snapshot as unknown,
  };
}

const disburse = (loanId: string) =>
  hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: `disb-972-${randomUUID()}` });

// ---- Setup / teardown ----------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const requester = await signedInUser("Disburse 972 requester");
  requesterId = requester.userId;
  await grantRole(requesterId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    "payroll.cancel.approve",
  ]);
  // HR: completes offboardings and disburses loans. Not the borrower of any loan.
  hr = await signedInUser("Disburse 972 HR");
  await grantRole(hr.userId, [
    "hr.employee.manage",
    "hr.loan.approve",
    "payroll.view",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'disb-972-%'",
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

// ---- 1-2. [disburse-offboarding-*] ---------------------------------------------

describe("disbursing a kasbon after the employee's offboarding", () => {
  it("[disburse-offboarding-completed] 409 PAYROLL_LOAN_OFFBOARDING_COMPLETED; the loan stays approved and no money is released", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const exitId = await revokedExit(emp.id);
    await waiveAll(emp.id);
    const done = await completeExit(exitId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await exitRow(exitId)).status).toBe("completed");

    // A loan approved late (after the exit was completed).
    const loan = await seedLoan(emp.id, "approved");
    const refused = await disburse(loan);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe(DISBURSE_CODE);

    const after = await loanOf(loan);
    expect(after.status, "still approved").toBe("approved");
    expect(after.disbursedAt, "no disbursement time").toBeNull();

    // Same answer on a retry with a fresh idempotency key: still refused.
    const again = await disburse(loan);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(DISBURSE_CODE);
    expect((await loanOf(loan)).status).toBe("approved");
  }, 300_000);

  it("[disburse-offboarding-open] an offboarding that is only revoked, or no offboarding at all, does not block the disbursement", async () => {
    const world = await makeWorld();
    const leaving = await makeEmployee(world);
    await revokedExit(leaving.id); // revoked, NOT completed
    const loanLeaving = await seedLoan(leaving.id, "approved");
    const paidLeaving = await disburse(loanLeaving);
    expect(paidLeaving.status, JSON.stringify(paidLeaving.body)).toBe(200);
    expect((await loanOf(loanLeaving)).status).toBe("disbursed");

    const staying = await makeEmployee(world);
    const loanStaying = await seedLoan(staying.id, "approved");
    const paidStaying = await disburse(loanStaying);
    expect(paidStaying.status, JSON.stringify(paidStaying.body)).toBe(200);
    expect((await loanOf(loanStaying)).status).toBe("disbursed");
  }, 300_000);
});

// ---- 3. [race-simulate-vs-complete] --------------------------------------------

/**
 * Whatever the interleaving, after the run is locked and the exit is completed:
 * balance == frozen snapshot, nothing pending, and the leaver is deducted at most
 * once (only when the deduction was already committed before the exit completed
 * and therefore held the completion back).
 */
async function settleAndCheck(input: {
  exitId: string;
  loan: string;
  runId: string;
  simulate: Failure | null;
  complete: { status: number; body: { error?: { code?: string } } };
}) {
  const { exitId, loan, runId, simulate, complete } = input;
  const label = `simulate=${simulate?.status ?? "ok"} complete=${complete.status}`;

  if (simulate)
    expect(simulate.status, `${label}: a lost simulate is a clean 409`).toBe(
      409,
    );
  expect([200, 409], `${label}: complete is 200 or 409`).toContain(
    complete.status,
  );

  const rows = await rowsOf(runId);
  if (complete.status === 200) {
    expect(
      rows[loan],
      `${label}: a completed leaver has no deduction row`,
    ).toBeUndefined();
    expect((await exitRow(exitId)).status).toBe("completed");
  } else {
    expect(complete.body.error?.code, label).toBe(GUARD_CODE);
    expect(rows[loan], `${label}: refusal only because the row exists`).toBe(
      100_000,
    );
    expect((await exitRow(exitId)).status, label).toBe("revoked");
    expect((await exitRow(exitId)).snapshot, label).toBeNull();
  }

  // Lock whatever the simulate produced, then finish the exit if it is still open.
  if (!simulate) {
    await asTenant((conn) => approveSimulatedRun(conn, runId));
    await lockRun(runId);
    expect(await runStatus(runId), label).toBe("locked");
  }
  if (complete.status === 409) {
    const retry = await completeExit(exitId);
    expect(retry.status, `${label}: ${JSON.stringify(retry.body)}`).toBe(200);
  }

  const snapshot = finalSettlementSummarySchema.parse(
    (await exitRow(exitId)).snapshot,
  );
  const balance = (await loanOf(loan)).outstanding;
  expect(
    balance,
    `${label}: loan balance equals the frozen settlement bill`,
  ).toBe(snapshot.outstandingLoans.amountIdr);
  expect(snapshot.pendingPayrollDeductions.count, label).toBe(0);
  expect([1_000_000, 900_000], `${label}: deducted once at most`).toContain(
    balance,
  );
}

async function raceOnce() {
  const world = await makeWorld();
  const emp = await makeEmployee(world);
  const loan = await seedLoan(emp.id);
  const exitId = await revokedExit(emp.id);
  await waiveAll(emp.id);
  const runId = await draftRun(world);

  const [simulate, complete] = await Promise.all([
    failureOf(simulateRun(runId)),
    completeExit(exitId),
  ]);
  await settleAndCheck({ exitId, loan, runId, simulate, complete });
}

describe("simulating a payroll run while the leaver's offboarding completes", () => {
  it("[race-simulate-vs-complete] six free-running races end with no double deduction and a bill equal to the balance", async () => {
    for (let round = 0; round < 6; round += 1) await raceOnce();
  }, 600_000);

  it("[race-open-simulate] complete fired while the simulate transaction is open and uncommitted: either it waits and is refused, or the simulate skips the leaver; never both", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id);
    const exitId = await revokedExit(emp.id);
    await waiveAll(emp.id);
    const runId = await draftRun(world);

    const fired: { promise?: ReturnType<typeof completeExit> } = {};
    const simulate = await failureOf(
      simulateRun(runId, async () => {
        // The simulate has written its rows but not committed yet.
        fired.promise = completeExit(exitId);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }),
    );
    const complete = await fired.promise!;
    await settleAndCheck({ exitId, loan, runId, simulate, complete });
  }, 300_000);
});
