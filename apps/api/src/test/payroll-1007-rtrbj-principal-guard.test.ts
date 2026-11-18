// Kasbon principal guard (bead legend-rtrbj, finding of second opinion 955/971;
// design brief 1007 "rtrbj"; founder rule "jangan sampai rugi": nobody may raise
// or lower what a loan was granted for after it was handed out, because the ledger
// invariant "principal - outstanding = locked deductions" would be rewritten
// instead of enforced).
// Fail-first: written before migration 0622_payroll_loan_principal_ledger_guard.sql.
//
// RULES UNDER TEST (all as the application database role `legend_app`, not a superuser)
//  1. [principal-locked]   a disbursed loan with a locked deduction behind it: an UPDATE
//                          of principal_idr alone (up or down) is refused (23514);
//                          principal, balance, run rows and run status are untouched.
//  2. [principal-paired]   principal and outstanding moved together (the ledger
//                          difference stays equal) is refused as well: only a guard on
//                          principal itself catches this.
//  3. [principal-fresh]    a disbursed loan with no deduction at all: any change of
//                          principal is refused; an UPDATE that writes the same value is
//                          accepted (no real change).
//  4. [principal-pending]  a pending loan may still have its principal edited
//                          (principal and outstanding together, as the request flow does);
//                          an approved loan may not.
//  5. [principal-settled]  a loan the last locked installment settled keeps its principal.
//  6. [ledger-trigger-watches-principal] the deferred ledger trigger itself also
//                          watches principal_idr: with the immediate guard switched off for
//                          one transaction (table owner, rolled back by the commit failure),
//                          the principal-only UPDATE still fails at COMMIT with 23514.
//  7. [tenant-isolation]   every test keeps a disbursed loan of another tenant: it is
//                          never changed, and an UPDATE aimed at it from this tenant's
//                          session matches no row.
//  8. [status-roundtrip]   (migration 0471) a disbursed loan with a locked deduction cannot
//                          leave the paid-out states: in ONE transaction, step 1 (back to
//                          pending, disbursed_at NULL, outstanding = principal) is refused
//                          with 23514, so the re-size of step 2 and the re-disbursal of
//                          step 3 are never reached; loan and other tenant untouched.
//  9. [status-settle-ok]   the legitimate disbursed -> settled move (the last installment
//                          locked by the normal run lock) is not blocked by that guard.
//
// ASSUMPTIONS (contract silent; contest if wrong)
//  - Only the error code 23514 is asserted for the immediate guard (its text is not
//    fixed by the brief); the deferred ledger check keeps its "balance does not match"
//    text (migration 0461), asserted in rule 6.
//  - An `approved` loan (decided, not yet paid out) is already protected: the brief says
//    "status <> 'pending'".
//  - Rule 8: the guard is BEFORE UPDATE OF status and refuses OLD.status IN
//    ('disbursed','settled') AND NEW.status NOT IN ('disbursed','settled'); only 23514
//    is asserted. The step that raised is recorded to prove it was step 1.
//  - Rule 9: the normal path is the run lock (lockPayrollRunInTransaction) that already
//    settles a loan in the [principal-settled] precondition; a bare
//    UPDATE status='settled' is not used (the ledger check owns that).
//  - Rule 6 finds the immediate guard by reading pg_trigger (any non-constraint BEFORE
//    UPDATE trigger on employee_loans that mentions principal_idr) and disables it with
//    ALTER TABLE ... DISABLE TRIGGER inside the test transaction.
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

// Tenant B: owns one disbursed loan that no test may touch.
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const otherEmployee = randomUUID();
const otherLoan = randomUUID();
const OTHER_PRINCIPAL = 500_000;

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function inTenant<T>(
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
  inTenant(tenant.id, run, raw);

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
        `Principal guard ${roleId.slice(0, 8)}`,
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
      [world.entityId, tenant.id, `PT Principal Guard ${++counter}`],
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
      name: `Principal Guard ${++counter}`,
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
      thr: false,
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

type LoanSeed = {
  principal?: number;
  installment?: number;
  status?: "pending" | "approved" | "disbursed";
};

async function seedLoan(employeeId: string, seed: LoanSeed = {}) {
  const principal = seed.principal ?? 1_000_000;
  const installment = seed.installment ?? 100_000;
  const status = seed.status ?? "disbursed";
  const loanId = randomUUID();
  createdLoans.push(loanId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $4, '2026-11-01', 'Kasbon uji principal guard', $7,
               $8, $9, $10)`,
      [
        loanId,
        tenant.id,
        employeeId,
        principal,
        installment,
        Math.ceil(principal / installment),
        status,
        status === "pending" ? null : requesterId,
        status === "pending" ? null : new Date().toISOString(),
        status === "disbursed" ? new Date().toISOString() : null,
      ],
    );
  });
  return loanId;
}

type LoanRow = { principal: number; outstanding: number; status: string };
const loanOf = async (loanId: string): Promise<LoanRow> => {
  const row = await scalar(
    `SELECT principal_idr, outstanding_idr, status
       FROM employee_loans WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, loanId],
  );
  return {
    principal: Number(row.principal_idr),
    outstanding: Number(row.outstanding_idr),
    status: row.status as string,
  };
};

const deductionSumOf = async (runId: string, loanId: string) =>
  Number(
    (
      await scalar(
        `SELECT COALESCE(SUM(amount_idr), 0) AS v FROM payroll_loan_deductions
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND loan_id = $3`,
        [tenant.id, runId, loanId],
      )
    ).v,
  );

/** The other tenant's loan: untouched, and invisible from this tenant's session. */
async function expectOtherTenantUntouched() {
  const row = (
    await inTenant(otherTenant, (conn) =>
      conn.query(
        `SELECT principal_idr, outstanding_idr, status FROM employee_loans
          WHERE tenant_id = $1 AND id = $2`,
        [otherTenant, otherLoan],
      ),
    )
  ).rows[0];
  expect(row, "the other tenant's loan still exists").toBeDefined();
  expect(Number(row.principal_idr)).toBe(OTHER_PRINCIPAL);
  expect(Number(row.outstanding_idr)).toBe(OTHER_PRINCIPAL);
  expect(row.status).toBe("disbursed");
}

/** A locked run holding 100.000 of a fresh 1.000.000 loan. */
async function lockedLoan(seed: LoanSeed = {}) {
  const world = await makeWorld();
  const emp = await makeEmployee(world);
  const loan = await seedLoan(emp.id, seed);
  const runId = await approvedRun(world);
  await lockRun(runId);
  expect(await runStatus(runId), "precondition: run is locked").toBe("locked");
  return { loan, runId, emp };
}

// ---- Setup / teardown --------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const requester = await signedInUser("Principal guard requester");
  requesterId = requester.userId;
  await grantRole(requesterId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    "payroll.cancel.approve",
  ]);
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
  await setPolicy(BP);

  // Tenant B with one disbursed loan.
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Principal guard tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `principal-guard-${otherTenant.slice(0, 8)}`, tenant.id],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [otherBrand, otherTenant],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Principal Guard B', false)",
    [otherEntity, otherTenant],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PG B', 'Jl. PG', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      otherOutlet,
      otherTenant,
      otherBrand,
      otherEntity,
      `PGB-${otherTenant.slice(0, 6)}`.toUpperCase(),
    ],
  );
  await inTenant(otherTenant, async (conn) => {
    await insertEmployee(conn, {
      tenantId: otherTenant,
      outletId: otherOutlet,
      entityId: otherEntity,
      id: otherEmployee,
      name: "Principal Guard B employee",
      taxScheme: null,
    });
    await conn.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status,
          decided_by, decided_at, disbursed_at)
       VALUES ($1, $2, $3, $4, 100000, 5, $4, '2026-11-01', 'Kasbon tenant B', 'disbursed',
               $5, now(), now())`,
      [otherLoan, otherTenant, otherEmployee, OTHER_PRINCIPAL, requesterId],
    );
  });
});

afterAll(async () => {
  await setPolicy(null);
  await inTenant(
    otherTenant,
    async (conn) => {
      await conn.query("DELETE FROM employee_loans WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await conn.query(
        "DELETE FROM employment_contracts WHERE tenant_id = $1",
        [otherTenant],
      );
      await conn.query("DELETE FROM employees WHERE tenant_id = $1", [
        otherTenant,
      ]);
    },
    true,
  ).catch(() => undefined);
  for (const sqlText of [
    "DELETE FROM outlets WHERE tenant_id = $1",
    "DELETE FROM legal_entities WHERE tenant_id = $1",
    "DELETE FROM brands WHERE tenant_id = $1",
    "DELETE FROM tenants WHERE id = $1",
  ])
    await owner.query(sqlText, [otherTenant]).catch(() => undefined);
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

const setPrincipalSql = `UPDATE employee_loans SET principal_idr = $3
                          WHERE tenant_id = $1 AND id = $2`;

// ---- 1-2. loan with a locked deduction ---------------------------------------

describe("a loan that is paid out keeps its principal", () => {
  it("[principal-locked] raising or lowering principal alone is 23514; nothing moves", async () => {
    const { loan, runId } = await lockedLoan();
    const before = await loanOf(loan);
    expect(before, "precondition: one installment was taken").toEqual({
      principal: 1_000_000,
      outstanding: 900_000,
      status: "disbursed",
    });

    for (const principal of [1_100_000, 900_000]) {
      const failure = await appRoleFailure(async (conn) => {
        await conn.query(setPrincipalSql, [tenant.id, loan, principal]);
      });
      expect(
        failure,
        `principal ${principal} on a paid-out loan must be refused`,
      ).not.toBeNull();
      expect(failure!.code).toBe("23514");
    }

    expect(await loanOf(loan)).toEqual(before);
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    expect(await runStatus(runId)).toBe("locked");
    await expectOtherTenantUntouched();
  }, 240_000);

  it("[principal-paired] principal and outstanding moved together (ledger difference unchanged) is 23514", async () => {
    const { loan, runId } = await lockedLoan();

    const failure = await appRoleFailure(async (conn) => {
      await conn.query(
        `UPDATE employee_loans
            SET principal_idr = principal_idr + 500000,
                outstanding_idr = outstanding_idr + 500000
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
    });

    expect(
      failure,
      "inflating the loan keeping the difference must be refused",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(await loanOf(loan)).toEqual({
      principal: 1_000_000,
      outstanding: 900_000,
      status: "disbursed",
    });
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    await expectOtherTenantUntouched();
  }, 240_000);
});

// ---- 3-4. other loan states --------------------------------------------------

describe("which loans may change their principal", () => {
  it("[principal-fresh] a disbursed loan with no deduction: a change is 23514, writing the same value is accepted, another tenant's loan matches no row", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const loan = await seedLoan(emp.id);

    const failure = await appRoleFailure(async (conn) => {
      await conn.query(
        `UPDATE employee_loans
            SET principal_idr = 400000, outstanding_idr = 400000
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
    });
    expect(failure, "lowering a fresh loan must be refused").not.toBeNull();
    expect(failure!.code).toBe("23514");

    const same = await appRoleFailure(async (conn) => {
      await conn.query(setPrincipalSql, [tenant.id, loan, 1_000_000]);
    });
    expect(
      same,
      "an UPDATE that keeps the same principal is not a change",
    ).toBeNull();

    let matched = -1;
    await appRoleFailure(async (conn) => {
      matched =
        (await conn.query(setPrincipalSql, [otherTenant, otherLoan, 1]))
          .rowCount ?? -1;
    });
    expect(matched, "RLS hides the other tenant's loan").toBe(0);

    expect(await loanOf(loan)).toEqual({
      principal: 1_000_000,
      outstanding: 1_000_000,
      status: "disbursed",
    });
    await expectOtherTenantUntouched();
  }, 120_000);

  it("[principal-pending] a pending loan may be edited (principal with outstanding); an approved loan may not", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const pending = await seedLoan(emp.id, { status: "pending" });
    const approved = await seedLoan(emp.id, { status: "approved" });

    const edit = await appRoleFailure(async (conn) => {
      await conn.query(
        `UPDATE employee_loans
            SET principal_idr = 900000, outstanding_idr = 900000
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, pending],
      );
    });
    expect(edit, "a pending loan keeps being editable").toBeNull();
    expect(await loanOf(pending)).toEqual({
      principal: 900_000,
      outstanding: 900_000,
      status: "pending",
    });

    const refused = await appRoleFailure(async (conn) => {
      await conn.query(
        `UPDATE employee_loans
            SET principal_idr = 900000, outstanding_idr = 900000
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, approved],
      );
    });
    expect(refused, "an approved loan is past editing").not.toBeNull();
    expect(refused!.code).toBe("23514");
    expect(await loanOf(approved)).toEqual({
      principal: 1_000_000,
      outstanding: 1_000_000,
      status: "approved",
    });
    await expectOtherTenantUntouched();
  }, 120_000);
});

// ---- 5. settled loan ---------------------------------------------------------

describe("a settled loan keeps its principal", () => {
  it("[principal-settled] after the last installment is locked, changing principal is 23514", async () => {
    const { loan, runId } = await lockedLoan({
      principal: 100_000,
      installment: 100_000,
    });
    const before = await loanOf(loan);
    expect(before, "precondition: the lock settled the loan").toEqual({
      principal: 100_000,
      outstanding: 0,
      status: "settled",
    });

    const failure = await appRoleFailure(async (conn) => {
      await conn.query(setPrincipalSql, [tenant.id, loan, 200_000]);
    });

    expect(failure, "a settled loan cannot be re-sized").not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(await loanOf(loan)).toEqual(before);
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    await expectOtherTenantUntouched();
  }, 240_000);
});

// ---- 8-9. status round trip --------------------------------------------------

describe("a paid-out loan cannot be sent back through its status", () => {
  it("[status-roundtrip] pending -> re-size -> disbursed in one transaction is 23514 at step 1; nothing moves", async () => {
    const { loan, runId } = await lockedLoan();
    const before = await loanOf(loan);
    expect(before, "precondition: one installment was taken").toEqual({
      principal: 1_000_000,
      outstanding: 900_000,
      status: "disbursed",
    });

    const resized = 999_999; // valid against the amounts CHECK
    let step = 0;
    const failure = await appRoleFailure(async (conn) => {
      step = 1;
      await conn.query(
        `UPDATE employee_loans
            SET status = 'pending', disbursed_at = NULL,
                outstanding_idr = principal_idr
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
      step = 2;
      await conn.query(
        `UPDATE employee_loans
            SET principal_idr = ${resized}, outstanding_idr = ${resized}
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
      step = 3;
      await conn.query(
        `UPDATE employee_loans
            SET status = 'disbursed', disbursed_at = now(),
                outstanding_idr = ${resized - 100_000}
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, loan],
      );
    });

    expect(
      failure,
      "sending a paid-out loan back to pending must be refused",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(step, "the guard must stop the very first step").toBe(1);
    expect(await loanOf(loan)).toEqual(before);
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    expect(await runStatus(runId)).toBe("locked");
    await expectOtherTenantUntouched();
  }, 240_000);

  it("[status-settle-ok] the last locked installment still moves disbursed -> settled through the run lock", async () => {
    const { loan, runId } = await lockedLoan({
      principal: 100_000,
      installment: 100_000,
    });

    expect(
      await loanOf(loan),
      "the normal path is not blocked by the status guard",
    ).toEqual({ principal: 100_000, outstanding: 0, status: "settled" });
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    expect(await runStatus(runId)).toBe("locked");
    await expectOtherTenantUntouched();
  }, 240_000);
});

// ---- 6. the deferred ledger trigger watches principal ------------------------

describe("the ledger check watches principal too", () => {
  it("[ledger-trigger-watches-principal] with the immediate guard off for one transaction, a principal-only UPDATE is 23514 at commit", async () => {
    const { loan, runId } = await lockedLoan();

    const client = await owner.connect();
    let failure: PgFailure | null = null;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      const guards = await client.query<{ name: string }>(
        `SELECT quote_ident(tgname) AS name FROM pg_trigger
          WHERE tgrelid = 'public.employee_loans'::regclass
            AND NOT tgisinternal AND tgconstraint = 0
            AND (tgtype & 2) = 2 AND (tgtype & 16) = 16
            AND pg_get_triggerdef(oid) ~ 'principal_idr'`,
      );
      for (const guard of guards.rows)
        await client.query(
          `ALTER TABLE public.employee_loans DISABLE TRIGGER ${guard.name}`,
        );
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(setPrincipalSql, [tenant.id, loan, 999_999]);
      await client.query("COMMIT");
    } catch (error) {
      failure = error as PgFailure;
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      client.release();
    }

    expect(
      failure,
      "the deferred ledger check must refuse a principal that no longer matches the locked deductions",
    ).not.toBeNull();
    expect(failure!.code).toBe("23514");
    expect(failure!.message).toMatch(/balance does not match/);
    expect(await loanOf(loan)).toEqual({
      principal: 1_000_000,
      outstanding: 900_000,
      status: "disbursed",
    });
    expect(await deductionSumOf(runId, loan)).toBe(100_000);
    await expectOtherTenantUntouched();
  }, 240_000);
});
