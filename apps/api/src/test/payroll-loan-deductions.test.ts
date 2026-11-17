// Loan deductions per payroll run (bead legend-xo0xx, WS-10; brief
// docs/briefs/949-context.md section xo0xx; founder rule "jangan sampai rugi":
// nobody is paid more, and a loan is never deducted above what it can owe).
// Fail-first: written before the table and the reversal restore exist.
//
// RULES UNDER TEST
//  1. [table-rls] payroll_loan_deductions exists with RLS enabled + forced and a
//     restrictive tenant_isolation policy (docs/plan/contracts.md).
//  2. [unique-per-run-loan] one row per (run, loan): a second deduction of the
//     same loan in the same run is refused (23505). No double deduction.
//  3. [amount-positive] amount_idr must be > 0 (23514); a deduction above the
//     loan principal is refused (a loan can never owe more than its principal).
//  4. [insert-window] rows are written while the run is draft/simulated; once
//     the run is approved (frozen) the DB refuses the insert.
//  5. [reversal-restores] approving the reversal of a locked run that carries
//     deduction rows restores each loan's outstanding by exactly the recorded
//     amount, once; unrelated loans are untouched; deciding again changes
//     nothing and the restored loan never exceeds its principal.
//  6. [reversal-refuses-unrecorded] totals.loanRepaymentIdr > 0 with NO
//     deduction rows stays refused (409, run stays locked, loans untouched).
//
// ASSUMPTIONS (contract silent; contest if wrong)
//  - Insert after approval is refused with any DB error (guard like
//    payroll_run_results, SQLSTATE 23514 expected but not asserted).
//  - A deduction above the loan principal is refused with any DB error.
//  - The reversal "marks or removes" the deduction rows (brief); the test does
//    not assert which, only the loan balance and the idempotence.
//  - A locked run carrying loans is seeded with raw SQL on top of a real
//    simulate and lock (replica role): totals.loanRepaymentIdr + deduction rows.
//    The simulate/lock writer of legend-8tfvr is covered in
//    payroll-run-loans.test.ts; this file keeps the raw fixtures of the reversal.
//  - Ledger invariant I3 (legend-8tfvr, migration 0443): for a disbursed loan,
//    principal - outstanding = the deductions of its locked or paid runs. Every
//    loan the reversal touches is seeded that way (see expectLedgerHolds); only
//    [reversal-refuses-unrecorded] seeds the broken state on purpose, and the
//    refused reversal never writes the loan.
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
const createdLoans: string[] = [];

const SALARY = 8_000_020;
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};
const PRINCIPAL = 1_000_000;
const DEDUCTED = 100_000;

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
  return userId;
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
        `Loan deduction ${roleId.slice(0, 8)}`,
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
      [world.entityId, tenant.id, `PT Potongan Kasbon ${++counter}`],
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
      name: `Kasbon ${++counter}`,
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

async function draftRun(world: World): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...NOV,
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
      "Salah hitung, dibatalkan (uji kasbon)",
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

const dbCode = (sqlText: string, params: unknown[], raw = false) =>
  asTenant((conn) => conn.query(sqlText, params), raw).then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "unknown",
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

const outstandingOf = async (loanId: string) =>
  Number(
    (
      await scalar(
        "SELECT outstanding_idr FROM employee_loans WHERE tenant_id = $1 AND id = $2",
        [tenant.id, loanId],
      )
    ).outstanding_idr,
  );

/**
 * A disbursed loan. Ledger trigger 0443 also runs on INSERT (deferred, I3:
 * principal - outstanding = SUM of deductions of locked/paid runs), so a
 * fresh loan with no locked run must be seeded with outstanding = principal.
 * Installments already deducted are created by `lockedRunWithDeductions`,
 * which records the rows and lowers outstanding together.
 */
async function seedLoan(
  employeeId: string,
  outstanding: number,
  principal = PRINCIPAL,
): Promise<string> {
  const loanId = randomUUID();
  createdLoans.push(loanId);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, $4, $5, 10, $6, '2026-11-01', 'Kasbon uji potongan',
               'disbursed', $7, now(), now())`,
      [
        loanId,
        tenant.id,
        employeeId,
        principal,
        DEDUCTED,
        outstanding,
        requesterId,
      ],
    ),
  );
  return loanId;
}

/**
 * Ledger invariant I3 as a fixture check: principal - outstanding equals the
 * rows recorded by locked/paid runs. A seed that breaks it would make the
 * deferred ledger trigger refuse the restore commit with 23514.
 */
async function expectLedgerHolds(loanIds: string[]) {
  for (const loanId of loanIds) {
    const row = await scalar(
      `SELECT l.principal_idr - l.outstanding_idr AS owed_paid,
              COALESCE((SELECT SUM(d.amount_idr)
                          FROM payroll_loan_deductions d
                          JOIN payroll_runs r ON r.tenant_id = d.tenant_id AND r.id = d.payroll_run_id
                         WHERE d.tenant_id = l.tenant_id AND d.loan_id = l.id
                           AND r.status IN ('locked', 'paid')), 0) AS recorded
         FROM employee_loans l WHERE l.tenant_id = $1 AND l.id = $2`,
      [tenant.id, loanId],
    );
    expect(
      Number(row.owed_paid),
      `fixture loan ${loanId} satisfies the ledger invariant I3`,
    ).toBe(Number(row.recorded));
  }
}

const insertDeductionSql = `INSERT INTO payroll_loan_deductions
  (tenant_id, payroll_run_id, employee_id, loan_id, amount_idr)
  VALUES ($1, $2, $3, $4, $5)`;

/** Locked run (cash payee) with a recorded deduction, seeded with raw SQL. */
async function lockedRunWithDeductions(
  world: World,
  emp: Emp,
  deductions: { loanId: string; amount: number }[],
  recordRows = true,
) {
  const runId = await draftRun(world);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  await lockRun(runId);
  expect(await runStatus(runId), "seeded run is locked").toBe("locked");
  const total = deductions.reduce((sum, d) => sum + d.amount, 0);
  await asTenant(async (conn) => {
    await conn.query(
      // Keep the totals identities valid: deductions = ... + loans, net =
      // bank + cash (the payee is cash). The loan cap config mirrors the lock
      // test's tamperTotals helper.
      `UPDATE payroll_runs
          SET totals = totals || jsonb_build_object(
                'loanRepaymentIdr', $2::bigint,
                'deductionsIdr', (totals->>'deductionsIdr')::bigint + $2::bigint,
                'netIdr', (totals->>'netIdr')::bigint - $2::bigint,
                'cashIdr', (totals->>'cashIdr')::bigint - $2::bigint),
              config_snapshot = config_snapshot || '{"loanMaxDeductionOfNetPayBp":5000}'::jsonb
        WHERE id = $1`,
      [runId, total],
    );
    // Rows and the matching outstanding decrease share this transaction so
    // the deferred ledger invariant (I3) holds at COMMIT.
    if (recordRows)
      for (const d of deductions) {
        await conn.query(insertDeductionSql, [
          tenant.id,
          runId,
          emp.id,
          d.loanId,
          d.amount,
        ]);
        await conn.query(
          `UPDATE employee_loans SET outstanding_idr = outstanding_idr - $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, d.loanId, d.amount],
        );
      }
  }, true);
  return runId;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requesterId = await signedInUser("Loan deduction requester");
  await grantRole(requesterId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    "payroll.cancel.approve",
  ]);
  approverId = await signedInUser("Loan deduction approver");
  await grantRole(approverId, ["payroll.view", "payroll.cancel.approve"]);
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
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

// ---- 1. [table-rls] ----------------------------------------------------------

describe("payroll_loan_deductions table", () => {
  it("[table-rls] exists with RLS enabled and forced and a restrictive tenant_isolation policy", async () => {
    const exists = await owner.query(
      "SELECT to_regclass('public.payroll_loan_deductions') AS t",
    );
    expect(exists.rows[0].t, "table must exist").not.toBeNull();
    const rls = await owner.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'public.payroll_loan_deductions'::regclass`,
    );
    expect(rls.rows[0]).toEqual({ rls: true, forced: true });
    const policies = await owner.query<{
      policyname: string;
      permissive: string;
    }>(
      `SELECT policyname, permissive FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'payroll_loan_deductions'`,
    );
    expect(policies.rows).toContainEqual({
      policyname: "tenant_isolation",
      permissive: "RESTRICTIVE",
    });
  });
});

// ---- 2-4. constraints --------------------------------------------------------

describe("payroll_loan_deductions guards", () => {
  it("[unique-per-run-loan] a draft run takes one deduction per loan; a second for the same loan is 23505", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loanId = await seedLoan(emp.id, PRINCIPAL);
    const runId = await draftRun(world);

    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runId,
        emp.id,
        loanId,
        DEDUCTED,
      ]),
    ).toBeNull();
    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runId,
        emp.id,
        loanId,
        DEDUCTED,
      ]),
    ).toBe("23505");
    const rows = await scalar(
      `SELECT count(*)::int AS n FROM payroll_loan_deductions
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [tenant.id, runId],
    );
    expect(rows.n).toBe(1);
  }, 90_000);

  it("[amount-positive] zero and negative amounts are 23514; an amount above the loan principal is refused", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loanId = await seedLoan(emp.id, PRINCIPAL);
    const runId = await draftRun(world);

    for (const amount of [0, -1])
      expect(
        await dbCode(insertDeductionSql, [
          tenant.id,
          runId,
          emp.id,
          loanId,
          amount,
        ]),
        `amount ${amount}`,
      ).toBe("23514");
    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runId,
        emp.id,
        loanId,
        PRINCIPAL + 1,
      ]),
      "deduction above principal",
    ).not.toBeNull();
    const rows = await scalar(
      `SELECT count(*)::int AS n FROM payroll_loan_deductions
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [tenant.id, runId],
    );
    expect(rows.n).toBe(0);
  }, 90_000);

  it("[combined-cap] two live runs cannot deduct the same loan above its outstanding together", async () => {
    const world = await makeWorld();
    const otherWorld = await makeWorld();
    const emp = await makeEmployee(world);
    const loanId = await seedLoan(emp.id, 150_000, 150_000);
    const runA = await draftRun(world);
    const runB = await draftRun(otherWorld);

    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runA,
        emp.id,
        loanId,
        DEDUCTED,
      ]),
    ).toBeNull();
    // 100_000 + 100_000 > 150_000 outstanding: refused although each alone fits.
    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runB,
        emp.id,
        loanId,
        DEDUCTED,
      ]),
      "combined deductions above outstanding",
    ).toBe("23514");
    // The remaining 50_000 still fits.
    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runB,
        emp.id,
        loanId,
        50_000,
      ]),
    ).toBeNull();
  }, 90_000);

  it("[insert-window] once the run is approved the DB refuses a new deduction row", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loanId = await seedLoan(emp.id, PRINCIPAL);
    const runId = await draftRun(world);
    await simulateRun(runId);
    await asTenant((conn) => approveSimulatedRun(conn, runId));
    expect(await runStatus(runId)).toBe("approved");

    expect(
      await dbCode(insertDeductionSql, [
        tenant.id,
        runId,
        emp.id,
        loanId,
        DEDUCTED,
      ]),
      "insert into an approved run must be refused",
    ).not.toBeNull();
    const rows = await scalar(
      `SELECT count(*)::int AS n FROM payroll_loan_deductions
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [tenant.id, runId],
    );
    expect(rows.n).toBe(0);
  }, 90_000);
});

// ---- 5-6. reversal -----------------------------------------------------------

describe("reversal restores loan deductions", () => {
  it("[reversal-restores] each deducted loan is restored by exactly the recorded amount, once; an unrelated loan is untouched", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const first = await seedLoan(emp.id, PRINCIPAL);
    const second = await seedLoan(emp.id, 400_000, 400_000);
    const runId = await lockedRunWithDeductions(world, emp, [
      { loanId: first, amount: DEDUCTED },
      { loanId: second, amount: 50_000 },
    ]);
    // The unrelated loan paid 300_000 in ANOTHER locked run (I3 holds for it too).
    const otherWorld = await makeWorld();
    const otherEmp = await makeEmployee(otherWorld);
    const unrelated = await seedLoan(otherEmp.id, PRINCIPAL, PRINCIPAL);
    await lockedRunWithDeductions(otherWorld, otherEmp, [
      { loanId: unrelated, amount: 300_000 },
    ]);
    await expectLedgerHolds([first, second, unrelated]);

    await requestReversal(runId);
    await decideReversal(runId);
    expect(await runStatus(runId)).toBe("reversed");

    expect(await outstandingOf(first)).toBe(PRINCIPAL);
    expect(await outstandingOf(second)).toBe(400_000);
    expect(await outstandingOf(unrelated)).toBe(700_000);
    await expectLedgerHolds([first, second, unrelated]);

    // Deciding again must not restore a second time.
    const again = await failureOf(decideReversal(runId));
    expect(
      again,
      "a second approve on a reversed run must be refused",
    ).not.toBeNull();
    expect(await outstandingOf(first)).toBe(PRINCIPAL);
    expect(await outstandingOf(second)).toBe(400_000);
    expect(await outstandingOf(unrelated)).toBe(700_000);
  }, 180_000);

  it("[reversal-refuses-unrecorded] loan repayment in totals without deduction rows stays refused (409); run stays locked, loans untouched", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    // No deduction rows are recorded, so I3 requires outstanding = principal.
    const loanId = await seedLoan(emp.id, PRINCIPAL);
    const runId = await lockedRunWithDeductions(
      world,
      emp,
      [{ loanId, amount: DEDUCTED }],
      false,
    );

    const refused = await failureOf(
      (async () => {
        await requestReversal(runId);
        await decideReversal(runId);
      })(),
    );
    expect(refused, "no rows to restore from: must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(await runStatus(runId)).toBe("locked");
    expect(await outstandingOf(loanId)).toBe(PRINCIPAL);
  }, 120_000);
});
