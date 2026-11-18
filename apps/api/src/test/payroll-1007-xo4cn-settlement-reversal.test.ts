// Bead legend-xo4cn (P1, second-opinion 971 finding, brief 1007). A payroll run reversal
// must not reopen a kasbon balance that a COMPLETED offboarding already froze in its
// settlement snapshot (the snapshot would then bill too little). Money rule "jangan sampai
// rugi": refusing the reversal is safer than silently opening a difference; reopening the
// settlement is a separate, explicit decision.
//
// RULES UNDER TEST (CTO decision, brief 1007)
//  1. [xo4cn-request-refused] request of a reversal of a locked run, where one employee with
//     a loan deduction in that run has a completed offboarding (frozen snapshot), is 409
//     PAYROLL_REVERSAL_LOAN_SETTLED. Nothing moves: run stays locked, deduction rows stay,
//     loan balance stays, snapshot stays byte-for-byte.
//  2. [xo4cn-decide-refused] the same refusal at the APPROVE step (request was made before the
//     offboarding completed): approve is 409 PAYROLL_REVERSAL_LOAN_SETTLED, nothing moves.
//  3. [xo4cn-before-completion] a reversal approved BEFORE the offboarding completes still
//     works; the balance is restored and the completion afterwards bills the restored balance.
//  4. [xo4cn-mixed-run] one run with a leaver (completed offboarding) and a stayer (no
//     offboarding): the WHOLE run reversal is refused; the stayer's loan is untouched too.
//  5. [xo4cn-unrelated-exit] a completed offboarding of an employee who is NOT in the run (and
//     whose loan is not in the run) does not block the reversal.
//  6. [xo4cn-other-tenant] a loan of another tenant is never touched.
//
// ASSUMPTIONS (contract/brief silent; contest if wrong)
//  - HttpError exposes `status` and `code` (the same shape payroll-run-loans.test.ts reads).
//  - A locked run that only awaits a reversal decision does not count as a "pending payroll
//    deduction" for the offboarding completion guard (PAYROLL_DEDUCTION_PENDING looks at
//    draft..approved runs), so completing the exit between request and approve is possible
//    (rule 2). If completion is refused there, rule 2 cannot be set up and needs a rethink.
//  - A refused request leaves the run `locked` (no reversal-requested state is stored).
//  - The leaver is revoked BEFORE the run is simulated (revoking access ends the employment,
//    which would otherwise make the lock stale), and completed AFTER the lock. Same pattern as
//    payroll-run-loans.test.ts [offboarding-guard-locked].
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
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
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

const SALARY = 8_000_020;
const BP = 5000; // kasbon policy: up to 50% of net pay
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};
type Dates = typeof NOV;

const SETTLED_CODE = "PAYROLL_REVERSAL_LOAN_SETTLED";
const GUARD_LAST_DAY = "2026-11-16";

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asTenantOf<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  raw = false,
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
const asTenant = <T>(run: (client: PoolClient) => Promise<T>, raw = false) =>
  asTenantOf(tenant.id, run, raw);

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
        `Settle reversal ${roleId.slice(0, 8)}`,
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
let hr: Awaited<ReturnType<typeof signedInUser>>;
let counter = 0;
let isolated: IsolatedTenant;
let isolatedEmployee: string;
let isolatedLoan: string;

type World = { entityId: string; policyId: string };
type Emp = { id: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Settle Reversal ${++counter}`],
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
      name: `Settle Reversal ${++counter}`,
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
      "Salah hitung, dibatalkan (uji reversal vs settlement)",
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

async function lockedRun(world: World) {
  const runId = await approvedRun(world, NOV);
  await lockRun(runId);
  expect(await runStatus(runId), "run is locked").toBe("locked");
  return runId;
}

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

/** A disbursed loan, principal 1.000.000, installment 100.000, no earlier history. */
async function seedLoan(employeeId: string) {
  const loanId = randomUUID();
  createdLoans.push(loanId);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, 1000000, 100000, 10, 1000000, '2026-11-01',
               'Kasbon uji reversal settlement', 'disbursed', $4, now(), now())`,
      [loanId, tenant.id, employeeId, requesterId],
    ),
  );
  return loanId;
}

const outstandingOf = async (loanId: string) =>
  Number(
    (
      await scalar(
        "SELECT outstanding_idr FROM employee_loans WHERE tenant_id = $1 AND id = $2",
        [tenant.id, loanId],
      )
    ).outstanding_idr,
  );

async function rowsOf(runId: string) {
  const rows = await asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT loan_id, amount_idr FROM payroll_loan_deductions
          WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY loan_id`,
        [tenant.id, runId],
      )
    ).rows.map((row) => ({
      loanId: row.loan_id as string,
      amount: Number(row.amount_idr),
    })),
  );
  return Object.fromEntries(rows.map((row) => [row.loanId, row.amount]));
}

// ---- Offboarding helpers (same HTTP path as payroll-run-loans.test.ts) -------

const postAs = (path: string, body: object = {}) =>
  hr.client.post(path).set(originHeader).send(body);

/** Create, move the last day into the past, revoke access: status `revoked`. */
async function revokedExit(employeeId: string): Promise<string> {
  const created = await postAs(
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "resignation",
      reason: "Akhir hubungan kerja uji reversal settlement.",
      lastWorkingDate: "2034-09-30",
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  await asTenant((conn) =>
    conn.query(
      "UPDATE hris_offboardings SET last_working_date = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, id, GUARD_LAST_DAY],
    ),
  );
  const revoked = await postAs(`/api/hris/offboardings/${id}/revoke-access`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(revoked.body.data.status).toBe("revoked");
  return id;
}

/** Waive every open checklist task (HR may), then complete: freezes the snapshot. */
async function completeExit(offboardingId: string, employeeId: string) {
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
        reason: "Uji reversal vs settlement",
      },
    );
    expect(waived.status, JSON.stringify(waived.body)).toBeLessThan(300);
  }
  const done = await postAs(`/api/hris/offboardings/${offboardingId}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.data.status).toBe("completed");
}

async function exitRow(offboardingId: string) {
  const row = await scalar(
    `SELECT status, completed_at, settlement_snapshot
       FROM hris_offboardings WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, offboardingId],
  );
  return {
    status: row.status as string,
    completedAt: row.completed_at as string | null,
    snapshot: row.settlement_snapshot as unknown,
  };
}

// ---- Setup / teardown --------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const requester = await signedInUser("Settle reversal requester");
  requesterId = requester.userId;
  await grantRole(requesterId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    "payroll.cancel.approve",
  ]);
  const approver = await signedInUser("Settle reversal approver");
  approverId = approver.userId;
  await grantRole(approverId, ["payroll.view", "payroll.cancel.approve"]);
  hr = await signedInUser("Settle reversal HR");
  await grantRole(hr.userId, ["hr.employee.manage", "payroll.view"]);
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
  await setPolicy(BP);

  // Another tenant with a disbursed loan that must never be touched.
  isolated = await createIsolatedTenant(`xo4cn-${randomUUID().slice(0, 6)}`);
  isolatedEmployee = randomUUID();
  isolatedLoan = randomUUID();
  await asTenantOf(isolated.tenantId, async (conn) => {
    await conn.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        isolatedEmployee,
        isolated.tenantId,
        `XB-${isolatedEmployee.slice(0, 8).toUpperCase()}`,
        isolated.outletId,
      ],
    );
    await conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, 1000000, 100000, 10, 1000000, '2026-11-01',
               'Kasbon tenant B', 'disbursed', $4, now(), now())`,
      [isolatedLoan, isolated.tenantId, isolatedEmployee, requesterId],
    );
  });
});

afterAll(async () => {
  await asTenantOf(
    isolated.tenantId,
    async (conn) => {
      await conn.query("DELETE FROM employee_loans WHERE tenant_id = $1", [
        isolated.tenantId,
      ]);
      await conn.query("DELETE FROM employees WHERE tenant_id = $1", [
        isolated.tenantId,
      ]);
    },
    true,
  );
  await dropIsolatedTenant(isolated);
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
      "DELETE FROM employee_loans WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdLoans],
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
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
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

const otherTenantLoanOutstanding = async () =>
  Number(
    (
      await asTenantOf(isolated.tenantId, (conn) =>
        conn.query(
          "SELECT outstanding_idr FROM employee_loans WHERE tenant_id = $1 AND id = $2",
          [isolated.tenantId, isolatedLoan],
        ),
      )
    ).rows[0].outstanding_idr,
  );

// ---- Tests -------------------------------------------------------------------

describe("reversal of a payroll run vs a completed offboarding settlement", () => {
  it("[xo4cn-request-refused] requesting the reversal is 409 PAYROLL_REVERSAL_LOAN_SETTLED once the leaver's offboarding is completed; run, rows, balance and the frozen snapshot do not change", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world);
    const loan = await seedLoan(leaver.id);
    const exitId = await revokedExit(leaver.id);
    const runId = await lockedRun(world);
    expect(await outstandingOf(loan), "lock took one installment").toBe(
      900_000,
    );
    await completeExit(exitId, leaver.id);
    const before = await exitRow(exitId);
    expect(before.status).toBe("completed");
    const frozen = finalSettlementSummarySchema.parse(before.snapshot);
    expect(frozen.outstandingLoans.amountIdr).toBe(900_000);

    const refused = await failureOf(requestReversal(runId));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe(SETTLED_CODE);
    expect(await runStatus(runId), "run stays locked").toBe("locked");
    expect(await rowsOf(runId), "deduction rows stay").toEqual({
      [loan]: 100_000,
    });
    expect(await outstandingOf(loan), "balance does not move").toBe(900_000);
    expect(await exitRow(exitId), "snapshot is untouched").toEqual(before);
    expect(
      await otherTenantLoanOutstanding(),
      "another tenant is untouched",
    ).toBe(1_000_000);
  }, 300_000);

  it("[xo4cn-decide-refused] approving a reversal requested before the completion is refused with the same 409; nothing moves", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world);
    const loan = await seedLoan(leaver.id);
    const exitId = await revokedExit(leaver.id);
    const runId = await lockedRun(world);
    // Request first: the exit is not completed yet, so the request is accepted.
    await requestReversal(runId);
    const requestedStatus = await runStatus(runId);
    await completeExit(exitId, leaver.id);
    const before = await exitRow(exitId);

    const refused = await failureOf(decideReversal(runId));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe(SETTLED_CODE);
    expect(await runStatus(runId), "run is not reversed").toBe(requestedStatus);
    expect(await runStatus(runId)).not.toBe("reversed");
    expect(await rowsOf(runId), "deduction rows stay").toEqual({
      [loan]: 100_000,
    });
    expect(await outstandingOf(loan), "balance does not move").toBe(900_000);
    expect(await exitRow(exitId), "snapshot is untouched").toEqual(before);
  }, 300_000);

  it("[xo4cn-before-completion] a reversal approved before the offboarding completes still works and the completion then bills the restored balance", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world);
    const loan = await seedLoan(leaver.id);
    const exitId = await revokedExit(leaver.id);
    const runId = await lockedRun(world);

    await requestReversal(runId);
    await decideReversal(runId);

    expect(await runStatus(runId)).toBe("reversed");
    expect(await rowsOf(runId), "reversal deleted the rows").toEqual({});
    expect(await outstandingOf(loan), "balance restored").toBe(1_000_000);

    await completeExit(exitId, leaver.id);
    const snapshot = finalSettlementSummarySchema.parse(
      (await exitRow(exitId)).snapshot,
    );
    expect(snapshot.frozen).toBe(true);
    expect(snapshot.outstandingLoans).toEqual({
      count: 1,
      amountIdr: 1_000_000,
      loanIds: [loan],
    });
    expect(await outstandingOf(loan), "balance = snapshot").toBe(1_000_000);
  }, 300_000);

  it("[xo4cn-mixed-run] one completed leaver in the run refuses the reversal of the WHOLE run; the stayer's loan is not restored either", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world);
    const stayer = await makeEmployee(world);
    const leaverLoan = await seedLoan(leaver.id);
    const stayerLoan = await seedLoan(stayer.id);
    const exitId = await revokedExit(leaver.id);
    const runId = await lockedRun(world);
    expect(await rowsOf(runId)).toEqual({
      [leaverLoan]: 100_000,
      [stayerLoan]: 100_000,
    });
    await completeExit(exitId, leaver.id);
    const before = await exitRow(exitId);

    const refused = await failureOf(requestReversal(runId));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe(SETTLED_CODE);
    expect(await runStatus(runId), "run stays locked").toBe("locked");
    expect(await rowsOf(runId), "both rows stay").toEqual({
      [leaverLoan]: 100_000,
      [stayerLoan]: 100_000,
    });
    expect(await outstandingOf(leaverLoan)).toBe(900_000);
    expect(await outstandingOf(stayerLoan), "stayer loan not restored").toBe(
      900_000,
    );
    expect(await exitRow(exitId)).toEqual(before);
    expect(await otherTenantLoanOutstanding()).toBe(1_000_000);
  }, 300_000);

  it("[xo4cn-unrelated-exit] a completed offboarding of an employee who is not in the run does not block its reversal", async () => {
    // The leaver lives in another legal entity, so its loan is in no run of this world.
    const otherWorld = await makeWorld();
    const leaver = await makeEmployee(otherWorld);
    const leaverLoan = await seedLoan(leaver.id);
    const exitId = await revokedExit(leaver.id);
    await completeExit(exitId, leaver.id);
    const frozen = await exitRow(exitId);

    const world = await makeWorld();
    const stayer = await makeEmployee(world);
    const stayerLoan = await seedLoan(stayer.id);
    const runId = await lockedRun(world);
    expect(await outstandingOf(stayerLoan)).toBe(900_000);

    await requestReversal(runId);
    await decideReversal(runId);

    expect(await runStatus(runId)).toBe("reversed");
    expect(await outstandingOf(stayerLoan), "stayer balance restored").toBe(
      1_000_000,
    );
    expect(await outstandingOf(leaverLoan), "leaver loan untouched").toBe(
      1_000_000,
    );
    expect(await exitRow(exitId), "frozen snapshot untouched").toEqual(frozen);
  }, 300_000);

  it("[xo4cn-other-tenant] the other tenant's loan was never touched by any of the above", async () => {
    expect(await otherTenantLoanOutstanding()).toBe(1_000_000);
  });
});
