// Kasbon limits (bead legend-fij0l) and the case-insensitive unique receipt
// index (bead legend-8399r), both from migration 0169. Runs the real Express
// app, Better Auth, the RBAC resolver and PostgreSQL.
//
// Tenant: a throwaway tenant (createIsolatedTenant), NOT the seeded Cafe Legend
// tenant, so the one-row-per-tenant policy never races with
// payroll-loans-api.test.ts. The HTTP tenant is chosen by the Host header, as
// the tenant B checks in payroll-loans-api.test.ts do.
//
// Assumptions where the brief is ambiguous:
// - "Joint ceiling is not a rule": with single_open_loan false, parallel
//   requests may all succeed; the parallel tests only pin the open-loan rule
//   (and that the lock is per employee, not global).
// - A refusal is HTTP 422 with error.code PAYROLL_LOAN_LIMIT_EXCEEDED.
// - Total open cap (legend-hjaot): a pending or approved loan counts its
//   principal, a disbursed one its unpaid outstanding; the sum of the
//   employee's OTHER open loans plus the new principal must stay <= the cap.
//   Pending loans count as open on approve too, so approving one of two
//   pending loans never changes what the other sees: parallel approvals are
//   deterministic (both pass or both fail), not "exactly one 200".
// - On approve the loan itself is not counted as open, but any other pending,
//   approved or disbursed loan of the employee is.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant as asAppTenant,
  tenantAId,
} from "./tenant-isolation-harness.ts";
import { insertPolicy } from "./payroll-simulate-kit.ts";

const app = createApp();
const ME = "/api/hris/me/loans";
const HR = "/api/hris/payroll/loans";
const COMPONENTS = "/api/hris/payroll/components";
const employeeComponents = (employeeId: string) =>
  `/api/hris/payroll/employees/${employeeId}/components`;
const LIMIT_CODE = "PAYROLL_LOAN_LIMIT_EXCEEDED";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdEmployees: string[] = [];
const createdComponents: string[] = [];
const createdCategories: string[] = [];
let ledgerRunId: string | undefined;
let ledgerPolicyId: string | undefined;
const key = () => `loan-caps-${randomUUID()}`;
const label = randomUUID().slice(0, 8);

let tenantB: IsolatedTenant;
let tenantC: IsolatedTenant | undefined;
let host: string;

async function asTenantOf<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const asTenantB = <T>(run: (client: PoolClient) => Promise<T>): Promise<T> =>
  asTenantOf(tenantB.tenantId, run);

/**
 * Repay a disbursed loan through the ledger (migration 0443, invariant I3):
 * outstanding_idr / status only move together with the deduction row of a
 * locked payroll run, and the deferred trigger checks it at COMMIT. One locked
 * run (own policy, written in replica role like the history run of
 * payroll-run-loans.test.ts) carries a row per loan; `patchLoanSql` is then
 * applied with triggers on, so the real ledger trigger judges the new balance.
 */
async function repayThroughLedger(
  loanId: string,
  paidIdr: number,
  patchLoanSql: string,
) {
  await asTenantB(async (db) => {
    await db.query("SET LOCAL session_replication_role = replica");
    if (!ledgerRunId) {
      ledgerRunId = randomUUID();
      ledgerPolicyId = randomUUID();
      await insertPolicy(
        db,
        tenantB.tenantId,
        tenantB.legalEntityId,
        ledgerPolicyId,
      );
      await db.query(
        `INSERT INTO payroll_runs
           (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start,
            period_end, pay_date, status, totals, config_snapshot, approved_by_hr,
            approved_by_hr_at, approved_by_finance, approved_by_finance_at, locked_by,
            locked_at, created_by)
         VALUES ($1, $2, $3, $4, 'regular', '2024-10-01', '2024-10-31', '2024-10-28',
                 'locked', '{}', '{}', 'loan-caps-hr', now(), 'loan-caps-fin', now(),
                 'loan-caps-lock', now(), 'loan-caps-hr')`,
        [ledgerRunId, tenantB.tenantId, tenantB.legalEntityId, ledgerPolicyId],
      );
    }
    await db.query(
      `INSERT INTO payroll_loan_deductions
         (tenant_id, payroll_run_id, employee_id, loan_id, amount_idr)
       SELECT tenant_id, $2, employee_id, id, $3
         FROM employee_loans WHERE tenant_id = $1 AND id = $4`,
      [tenantB.tenantId, ledgerRunId, paidIdr, loanId],
    );
    // Triggers back on: the loan write below is what the ledger must accept.
    await db.query("SET LOCAL session_replication_role = origin");
    await db.query(
      `UPDATE employee_loans SET ${patchLoanSql} WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, loanId],
    );
  });
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
  await asTenantB(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenantB.tenantId,
        `Loan caps ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantB.tenantId, userId, roleId],
    );
  });
}

async function seedEmployee(userId: string | null) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenantB((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Batas Kasbon', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenantB.tenantId,
        userId,
        `LC-${id.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let approver: Client;
let payrollAdmin: Client;

/** A signed-in staff account with its own employee row in tenant B. */
async function newStaff() {
  const staff = await signedInClient("Loan caps staff");
  await grantRole(staff.userId, ["self.loan.request"]);
  const employeeId = await seedEmployee(staff.userId);
  return { client: staff.client, employeeId };
}

const post = (client: Client, url: string, body: object) =>
  client.post(url).set(originHeader).set("Host", host).send(body);

const requestLoan = (client: Client, principalIdr: number, extra = {}) =>
  post(client, ME, {
    principalIdr,
    installmentCount: 3,
    reason: "Biaya uji batas kasbon",
    idempotencyKey: key(),
    ...extra,
  });

const decide = (id: string, action: "approve" | "reject" | "cancel") =>
  post(approver, `${HR}/${id}/decision`, { action, idempotencyKey: key() });

async function created(client: Client, principalIdr: number, extra = {}) {
  const response = await requestLoan(client, principalIdr, extra);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

function expectRefused(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(422);
  expect((response.body as { error: { code: string } }).error.code).toBe(
    LIMIT_CODE,
  );
}

type PolicyInput = {
  maxPrincipalIdr?: number | null;
  baseSalaryBp?: number | null;
  maxInstallments?: number;
  singleOpenLoan?: boolean;
  maxTotalOpenIdr?: number;
};

/** Writes tenant B's policy as the owner (lenient defaults, one-off overrides). */
async function setPolicy(input: PolicyInput = {}) {
  const values = [
    tenantB.tenantId,
    // The per-loan ceiling may not exceed the total cap (table CHECK), so the
    // lenient default shrinks to a small total.
    input.maxPrincipalIdr === undefined
      ? Math.min(100_000_000, input.maxTotalOpenIdr ?? 100_000_000)
      : input.maxPrincipalIdr,
    input.baseSalaryBp ?? null,
    input.maxInstallments ?? 36,
    5000,
    input.singleOpenLoan ?? false,
    input.maxTotalOpenIdr ?? 1_000_000_000,
  ];
  await asTenantB((db) =>
    db.query(
      `INSERT INTO payroll_loan_policies
         (tenant_id, max_principal_idr, max_principal_of_base_salary_bp, max_installments,
          max_deduction_of_net_pay_bp, single_open_loan, max_total_open_idr)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         max_principal_idr = EXCLUDED.max_principal_idr,
         max_principal_of_base_salary_bp = EXCLUDED.max_principal_of_base_salary_bp,
         max_installments = EXCLUDED.max_installments,
         max_deduction_of_net_pay_bp = EXCLUDED.max_deduction_of_net_pay_bp,
         single_open_loan = EXCLUDED.single_open_loan,
         max_total_open_idr = EXCLUDED.max_total_open_idr`,
      values,
    ),
  );
}

const clearPolicy = () =>
  asTenantB((db) =>
    db.query("DELETE FROM payroll_loan_policies WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]),
  );

const statusOf = async (loanId: string) =>
  (
    await asTenantB((db) =>
      db.query<{ status: string }>(
        "SELECT status FROM employee_loans WHERE id = $1",
        [loanId],
      ),
    )
  ).rows[0]?.status;

let baseSalaryComponent: string;
let allowanceComponent: string;

async function createComponent(category: string) {
  const response = await post(payrollAdmin, COMPONENTS, {
    code: `LC${label}${category.slice(0, 3)}`.toUpperCase(),
    name: `Komponen ${category} uji kasbon`,
    category,
    recurrence: "fixed",
    taxable: true,
    taxScheme: "gross",
    bpjsBase: true,
    overtimeBase: false,
    thrBase: true,
    displayOrder: 5,
    idempotencyKey: key(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  createdComponents.push(response.body.data.id);
  return response.body.data.id as string;
}

async function setComponent(
  employeeId: string,
  componentId: string,
  amountIdr: number,
) {
  const response = await payrollAdmin
    .put(employeeComponents(employeeId))
    .set(originHeader)
    .set("Host", host)
    .send({
      componentId,
      amountIdr,
      effectiveFrom: "2025-03-01",
      idempotencyKey: key(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.id as string;
}

beforeAll(async () => {
  tenantB = await createIsolatedTenant(`lcap-${randomUUID().slice(0, 6)}`);
  host = tenantB.hostname;
  const hr = await signedInClient("Loan caps approver");
  await grantRole(hr.userId, ["hr.loan.approve", "payroll.view"]);
  approver = hr.client;
  const admin = await signedInClient("Loan caps payroll admin");
  await grantRole(admin.userId, ["payroll.view", "payroll.run"]);
  payrollAdmin = admin.client;
  baseSalaryComponent = await createComponent("base_salary");
  allowanceComponent = await createComponent("fixed_allowance");
});

afterAll(async () => {
  await asTenantB(async (db) => {
    // The locked ledger run is frozen: delete its rows in replica role.
    await db.query("SET LOCAL session_replication_role = replica");
    for (const sql of [
      "DELETE FROM payroll_loan_deductions WHERE tenant_id = $1",
      "DELETE FROM payroll_runs WHERE tenant_id = $1",
      "DELETE FROM payroll_policies WHERE tenant_id = $1",
    ])
      await db.query(sql, [tenantB.tenantId]);
    await db.query("SET LOCAL session_replication_role = origin");
    for (const sql of [
      "DELETE FROM payroll_loan_policies WHERE tenant_id = $1",
      "DELETE FROM hris_idempotency WHERE tenant_id = $1",
      "DELETE FROM reimbursements WHERE tenant_id = $1",
      "DELETE FROM employee_loans WHERE tenant_id = $1",
      "DELETE FROM employee_pay_components WHERE tenant_id = $1",
    ])
      await db.query(sql, [tenantB.tenantId]);
    await db.query(
      "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantB.tenantId, createdCategories],
    );
    await db.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantB.tenantId, createdComponents],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantB.tenantId, createdEmployees],
    );
  });
  if (tenantC) {
    await asTenantOf(tenantC.tenantId, async (db) => {
      await db.query("DELETE FROM employee_loans WHERE tenant_id = $1", [
        tenantC!.tenantId,
      ]);
      await db.query("DELETE FROM employees WHERE tenant_id = $1", [
        tenantC!.tenantId,
      ]);
    });
    await dropIsolatedTenant(tenantC);
  }
  await dropIsolatedTenant(tenantB);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await appPool.end();
  await owner.end();
});

describe("kasbon limits: policy required", () => {
  it("[loan-limits-no-policy] refuses a request while the tenant has no policy", async () => {
    await clearPolicy();
    const staff = await newStaff();
    expectRefused(await requestLoan(staff.client, 100_000));
  });
});

describe("kasbon limits: absolute ceiling and installments", () => {
  it("[loan-limits-max-principal] accepts the ceiling and refuses one rupiah above", async () => {
    await setPolicy({ maxPrincipalIdr: 1_000_000 });
    const staff = await newStaff();
    expect((await requestLoan(staff.client, 1_000_000)).status).toBe(201);
    expectRefused(await requestLoan(staff.client, 1_000_001));
  });

  it("[loan-limits-max-installments] refuses more installments than the policy allows", async () => {
    await setPolicy({ maxInstallments: 6 });
    const staff = await newStaff();
    expect(
      (await requestLoan(staff.client, 600_000, { installmentCount: 6 }))
        .status,
    ).toBe(201);
    expectRefused(
      await requestLoan(staff.client, 600_000, { installmentCount: 7 }),
    );
  });
});

describe("kasbon limits: multiple of base salary", () => {
  it("[loan-limits-salary-multiple] allows up to 2x base salary and refuses above", async () => {
    await setPolicy({ maxPrincipalIdr: null, baseSalaryBp: 20000 });
    const staff = await newStaff();
    await setComponent(staff.employeeId, baseSalaryComponent, 3_000_000);
    expect((await requestLoan(staff.client, 6_000_000)).status).toBe(201);
    expectRefused(await requestLoan(staff.client, 6_000_001));
  });

  it("[loan-limits-salary-missing] refuses an employee with no base salary, even with other components", async () => {
    await setPolicy({ maxPrincipalIdr: null, baseSalaryBp: 20000 });
    const none = await newStaff();
    expectRefused(await requestLoan(none.client, 1_000));
    // Only a base_salary component counts as salary: an allowance does not.
    const allowanceOnly = await newStaff();
    await setComponent(allowanceOnly.employeeId, allowanceComponent, 9_000_000);
    expectRefused(await requestLoan(allowanceOnly.client, 1_000));
  });

  it("[loan-limits-salary-expired] ignores a base salary that ended yesterday", async () => {
    await setPolicy({ maxPrincipalIdr: null, baseSalaryBp: 20000 });
    const staff = await newStaff();
    const rowId = await setComponent(
      staff.employeeId,
      baseSalaryComponent,
      3_000_000,
    );
    expect((await requestLoan(staff.client, 1_000_000)).status).toBe(201);
    const yesterday = businessDateOf(
      new Date(Date.now() - 86_400_000),
      DEFAULT_BUSINESS_DAY_CLOCK,
    );
    await asTenantB((db) =>
      db.query(
        "UPDATE employee_pay_components SET effective_to = $2 WHERE id = $1",
        [rowId, yesterday],
      ),
    );
    expectRefused(await requestLoan(staff.client, 1_000_000));
  });

  it("[loan-limits-both-ceilings] applies the stricter of the absolute and salary ceilings", async () => {
    await setPolicy({ maxPrincipalIdr: 5_000_000, baseSalaryBp: 5000 });
    const staff = await newStaff();
    await setComponent(staff.employeeId, baseSalaryComponent, 2_000_000);
    // 50 percent of 2,000,000 = 1,000,000 binds, not the 5,000,000 ceiling.
    expect((await requestLoan(staff.client, 1_000_000)).status).toBe(201);
    expectRefused(await requestLoan(staff.client, 1_000_001));
  });
});

describe("kasbon limits: single open loan", () => {
  it("[loan-limits-single-open] blocks a second request until the first is rejected or cancelled", async () => {
    await setPolicy({ singleOpenLoan: true });
    const staff = await newStaff();
    const first = await created(staff.client, 500_000);
    expectRefused(await requestLoan(staff.client, 500_000));

    expect((await decide(first, "reject")).status).toBe(200);
    const second = await created(staff.client, 500_000);

    expect((await decide(second, "cancel")).status).toBe(200);
    const third = await created(staff.client, 500_000);

    // An approved loan is still open.
    expect((await decide(third, "approve")).status).toBe(200);
    expectRefused(await requestLoan(staff.client, 500_000));
  });

  it("[loan-limits-open-statuses] a disbursed loan still blocks, a settled one does not", async () => {
    await setPolicy({ singleOpenLoan: true });
    const staff = await newStaff();
    const first = await created(staff.client, 500_000);
    expect((await decide(first, "approve")).status).toBe(200);
    const disbursed = await post(approver, `${HR}/${first}/disburse`, {
      idempotencyKey: key(),
    });
    expect(disbursed.status, JSON.stringify(disbursed.body)).toBe(200);
    expectRefused(await requestLoan(staff.client, 500_000));

    await repayThroughLedger(
      first,
      500_000,
      "status = 'settled', settled_at = now(), outstanding_idr = 0",
    );
    await created(staff.client, 500_000);
  });

  it("[loan-limits-approve-not-pending] approving a decided loan is an invalid transition, not a limit error", async () => {
    await setPolicy({ singleOpenLoan: true });
    const staff = await newStaff();
    const loan = await created(staff.client, 500_000);
    expect((await decide(loan, "reject")).status).toBe(200);
    // A policy that would refuse it must not change the answer.
    await setPolicy({ maxPrincipalIdr: 100_000 });
    const again = await decide(loan, "approve");
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");
  });

  it("[loan-limits-single-open-off] allows several open loans when the rule is off", async () => {
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    await created(staff.client, 500_000);
    await created(staff.client, 500_000);
  });
});

describe("kasbon limits: concurrent requests", () => {
  it("[loan-limits-parallel-requests] lets exactly one of three parallel requests through", async () => {
    await setPolicy({ singleOpenLoan: true });
    const staff = await newStaff();
    const responses = await Promise.all(
      [1, 2, 3].map(() => requestLoan(staff.client, 500_000)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 422, 422]);
    for (const refused of responses.filter((r) => r.status === 422))
      expectRefused(refused);
    const open = await asTenantB((db) =>
      db.query(
        "SELECT id FROM employee_loans WHERE employee_id = $1 AND status IN ('pending','approved','disbursed')",
        [staff.employeeId],
      ),
    );
    expect(open.rowCount).toBe(1);
  });

  it("[loan-limits-parallel-employees] does not block different employees against each other", async () => {
    await setPolicy({ singleOpenLoan: true });
    const [one, two] = await Promise.all([newStaff(), newStaff()]);
    const responses = await Promise.all([
      requestLoan(one.client, 500_000),
      requestLoan(two.client, 500_000),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
  });

  it("[loan-limits-parallel-rule-off] accepts parallel requests when the open-loan rule is off", async () => {
    // Per-request ceilings only; there is no joint ceiling (see assumptions).
    await setPolicy({ maxPrincipalIdr: 1_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    const responses = await Promise.all(
      [1, 2, 3].map(() => requestLoan(staff.client, 1_000_000)),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
  });
});

describe("kasbon limits: approval re-checks the policy of today", () => {
  it("[loan-limits-approve-recheck] refuses approval after the ceiling dropped and allows it once raised", async () => {
    await setPolicy();
    const staff = await newStaff();
    const loan = await created(staff.client, 900_000);
    await setPolicy({ maxPrincipalIdr: 500_000 });
    expectRefused(await decide(loan, "approve"));
    expect(await statusOf(loan)).toBe("pending");
    await setPolicy({ maxPrincipalIdr: 100_000_000 });
    const approved = await decide(loan, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await statusOf(loan)).toBe("approved");
  });

  it("[loan-limits-approve-other-open] refuses approval while another open loan exists once the rule is on", async () => {
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const first = await created(staff.client, 400_000);
    await created(staff.client, 400_000);
    await setPolicy({ singleOpenLoan: true });
    expectRefused(await decide(first, "approve"));
    expect(await statusOf(first)).toBe("pending");
  });

  it("[loan-limits-parallel-approvals] never approves two pending loans of one employee in parallel", async () => {
    // Assumption: each loan counts the other (pending) as open, so under the
    // rule neither may be approved; the contract tested is "at most one 200,
    // every refusal is a limit error, never two approved loans".
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const first = await created(staff.client, 400_000);
    const second = await created(staff.client, 400_000);
    await setPolicy({ singleOpenLoan: true });
    const responses = await Promise.all([
      decide(first, "approve"),
      decide(second, "approve"),
    ]);
    const approvedCount = responses.filter((r) => r.status === 200).length;
    expect(approvedCount).toBeLessThanOrEqual(1);
    for (const refused of responses.filter((r) => r.status !== 200))
      expectRefused(refused);
    const approved = await asTenantB((db) =>
      db.query(
        "SELECT id FROM employee_loans WHERE employee_id = $1 AND status = 'approved'",
        [staff.employeeId],
      ),
    );
    expect(approved.rowCount).toBe(approvedCount);
  });
});

const OPEN = "('pending','approved','disbursed')";

/** Sum of outstanding_idr of the employee's open loans, read straight from SQL. */
async function openSum(employeeId: string): Promise<number> {
  const rows = await asTenantB((db) =>
    db.query<{ total: string }>(
      `SELECT COALESCE(sum(outstanding_idr), 0)::text AS total
         FROM employee_loans WHERE employee_id = $1 AND status IN ${OPEN}`,
      [employeeId],
    ),
  );
  return Number(rows.rows[0]!.total);
}

const disburse = (id: string) =>
  post(approver, `${HR}/${id}/disburse`, { idempotencyKey: key() });

async function approved(id: string) {
  const response = await decide(id, "approve");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function disbursed(id: string) {
  await approved(id);
  const response = await disburse(id);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe("kasbon limits: total open cap", () => {
  it("[loan-total-boundary] accepts a request that fills the total exactly and refuses one rupiah more", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    await created(staff.client, 1_200_000);
    const fits = await requestLoan(staff.client, 800_000);
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expectRefused(await requestLoan(staff.client, 1));
    expect(await openSum(staff.employeeId)).toBe(2_000_000);
  });

  it("[loan-total-first-request-over] refuses a single request above the total on its own", async () => {
    // Only the salary multiple (10x of 3,000,000) sits above the total, so the
    // total is the rule that refuses: the per-loan rupiah ceiling cannot be
    // lower than it.
    await setPolicy({
      maxPrincipalIdr: null,
      baseSalaryBp: 100_000,
      maxTotalOpenIdr: 2_000_000,
      singleOpenLoan: false,
    });
    const staff = await newStaff();
    await setComponent(staff.employeeId, baseSalaryComponent, 3_000_000);
    expectRefused(await requestLoan(staff.client, 2_000_001));
    expect((await requestLoan(staff.client, 2_000_000)).status).toBe(201);
  });

  it("[loan-total-statuses-count] pending, approved and disbursed loans all count", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    const loan = await created(staff.client, 1_200_000);
    // Room is 800,000 in every open status.
    expectRefused(await requestLoan(staff.client, 800_001));
    await approved(loan);
    expectRefused(await requestLoan(staff.client, 800_001));
    expect((await disburse(loan)).status).toBe(200);
    expect(await statusOf(loan)).toBe("disbursed");
    expectRefused(await requestLoan(staff.client, 800_001));
  });

  it("[loan-total-disbursed-outstanding] a disbursed loan counts its unpaid outstanding, not its principal", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    const loan = await created(staff.client, 1_200_000);
    await disbursed(loan);
    // Part of the loan was repaid: 300,000 is still owed of 1,200,000.
    await repayThroughLedger(loan, 900_000, "outstanding_idr = 300000");
    // Room = 2,000,000 - 300,000 = 1,700,000 (it would be 800,000 on principal).
    expectRefused(await requestLoan(staff.client, 1_700_001));
    const fits = await requestLoan(staff.client, 1_700_000);
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expectRefused(await requestLoan(staff.client, 1));
  });

  it("[loan-total-closed-statuses] settled, rejected and cancelled loans do not count", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    // Each loan is 1,500,000: it could not be requested next to another open one.
    const rejected = await created(staff.client, 1_500_000);
    expect((await decide(rejected, "reject")).status).toBe(200);
    const cancelled = await created(staff.client, 1_500_000);
    expect((await decide(cancelled, "cancel")).status).toBe(200);
    const settled = await created(staff.client, 1_500_000);
    await disbursed(settled);
    await repayThroughLedger(
      settled,
      1_500_000,
      "status = 'settled', settled_at = now(), outstanding_idr = 0",
    );
    // None of the three counts, so the whole total is free.
    const full = await requestLoan(staff.client, 2_000_000);
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expectRefused(await requestLoan(staff.client, 1));
  });

  it("[loan-total-other-employee] another employee's open loans never count", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const first = await newStaff();
    const second = await newStaff();
    await created(first.client, 1_900_000);
    const mine = await requestLoan(second.client, 1_900_000);
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
  });

  it("[loan-total-other-tenant] another tenant's open loans never count", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    tenantC ??= await createIsolatedTenant(`lcap-${randomUUID().slice(0, 6)}`);
    const other = tenantC;
    const otherEmployee = randomUUID();
    await asTenantOf(other.tenantId, async (db) => {
      await db.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, 'Karyawan Tenant Lain', $4, 'pkwtt', '2025-03-01', 'active')`,
        [
          otherEmployee,
          other.tenantId,
          `LC-${otherEmployee.slice(0, 8).toUpperCase()}`,
          other.outletId,
        ],
      );
      await db.query(
        `INSERT INTO employee_loans
           (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
            outstanding_idr, first_deduction_period, reason)
         VALUES ($1, $2, $3, 1900000, 950000, 2, 1900000, '2026-02-01', 'Kasbon tenant lain')`,
        [randomUUID(), other.tenantId, otherEmployee],
      );
    });
    const staff = await newStaff();
    const mine = await requestLoan(staff.client, 1_900_000);
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
  });

  it("[loan-total-approve-recheck] approval is refused once the total dropped below the open loans, and it stays pending", async () => {
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const first = await created(staff.client, 1_200_000);
    const second = await created(staff.client, 1_200_000);
    // The pair (2,400,000) no longer fits.
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    expectRefused(await decide(first, "approve"));
    expect(await statusOf(first)).toBe("pending");
    expectRefused(await decide(second, "approve"));
    expect(await statusOf(second)).toBe("pending");
    // Room again: both fit.
    await setPolicy({ maxTotalOpenIdr: 2_400_000, singleOpenLoan: false });
    await approved(first);
    await approved(second);
    expect(await statusOf(first)).toBe("approved");
  });

  it("[loan-total-approve-excludes-self] approving a lone loan within the total is allowed", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    const loan = await created(staff.client, 2_000_000);
    const response = await decide(loan, "approve");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await statusOf(loan)).toBe("approved");
  });

  it("[loan-total-approve-counts-others] approval counts another open loan's outstanding, not its principal", async () => {
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const paid = await created(staff.client, 1_200_000);
    await disbursed(paid);
    await repayThroughLedger(paid, 900_000, "outstanding_idr = 300000");
    const next = await created(staff.client, 1_700_000);
    // 300,000 owed + 1,700,000 = 2,000,000.
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    expect((await decide(next, "approve")).status).toBe(200);
    // One rupiah less room: a fresh pair must be refused.
    const other = await newStaff();
    const a = await created(other.client, 1_000_000);
    await created(other.client, 1_000_000);
    await setPolicy({ maxTotalOpenIdr: 1_999_999, singleOpenLoan: false });
    expectRefused(await decide(a, "approve"));
  });

  it("[loan-total-parallel-requests] lets exactly two of three parallel 800,000 requests through", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const staff = await newStaff();
    const responses = await Promise.all(
      [1, 2, 3].map(() => requestLoan(staff.client, 800_000)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 422]);
    for (const refused of responses.filter((r) => r.status === 422))
      expectRefused(refused);
    expect(await openSum(staff.employeeId)).toBe(1_600_000);
  });

  it("[loan-total-parallel-employees] does not make different employees compete for the total", async () => {
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const [one, two] = await Promise.all([newStaff(), newStaff()]);
    const responses = await Promise.all([
      requestLoan(one.client, 2_000_000),
      requestLoan(two.client, 2_000_000),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
  });

  it("[loan-total-parallel-approvals] parallel approvals of two pending loans both pass or both fail", async () => {
    // Assumption (differs from a literal reading of the brief): a pending loan
    // already counts as open, so each approval sees the other loan whether it
    // is pending or approved. The outcome therefore does not depend on order.
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const first = await created(staff.client, 1_200_000);
    const second = await created(staff.client, 1_200_000);

    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const refused = await Promise.all([
      decide(first, "approve"),
      decide(second, "approve"),
    ]);
    for (const response of refused) expectRefused(response);
    expect(await statusOf(first)).toBe("pending");
    expect(await statusOf(second)).toBe("pending");

    await setPolicy({ maxTotalOpenIdr: 2_400_000, singleOpenLoan: false });
    const both = await Promise.all([
      decide(first, "approve"),
      decide(second, "approve"),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await openSum(staff.employeeId)).toBe(2_400_000);
  });

  it("[loan-total-parallel-approve-and-request] an approval and a request racing never push the open sum over the total", async () => {
    await setPolicy({ singleOpenLoan: false });
    const staff = await newStaff();
    const loan = await created(staff.client, 1_200_000);
    await setPolicy({ maxTotalOpenIdr: 2_000_000, singleOpenLoan: false });
    const [approval, request] = await Promise.all([
      decide(loan, "approve"),
      requestLoan(staff.client, 800_001),
    ]);
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    expectRefused(request);
    expect(await openSum(staff.employeeId)).toBe(1_200_000);
  });

  it("[loan-total-per-loan-max-wins] the per-loan maximum still refuses while the total has room", async () => {
    await setPolicy({
      maxPrincipalIdr: 1_000_000,
      maxTotalOpenIdr: 5_000_000,
      singleOpenLoan: false,
    });
    const staff = await newStaff();
    expectRefused(await requestLoan(staff.client, 1_000_001));
    expect((await requestLoan(staff.client, 1_000_000)).status).toBe(201);
  });

  it("[loan-total-salary-multiple-wins] the salary multiple still refuses while the total has room", async () => {
    await setPolicy({
      maxPrincipalIdr: null,
      baseSalaryBp: 10000,
      maxTotalOpenIdr: 5_000_000,
      singleOpenLoan: false,
    });
    const staff = await newStaff();
    await setComponent(staff.employeeId, baseSalaryComponent, 1_000_000);
    expectRefused(await requestLoan(staff.client, 1_000_001));
    expect((await requestLoan(staff.client, 1_000_000)).status).toBe(201);
  });
});

describe("kasbon policy table (database)", () => {
  const insert = (values: {
    maxPrincipalIdr?: number | null;
    bp?: number | null;
    installments?: number;
    deduction?: number;
    total?: number | null;
  }) =>
    asTenantB((db) =>
      db.query(
        `INSERT INTO payroll_loan_policies
           (tenant_id, max_principal_idr, max_principal_of_base_salary_bp, max_installments,
            max_deduction_of_net_pay_bp, max_total_open_idr)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantB.tenantId,
          values.maxPrincipalIdr === undefined
            ? 1_000_000
            : values.maxPrincipalIdr,
          values.bp ?? null,
          values.installments ?? 12,
          values.deduction ?? 5000,
          values.total === undefined ? 1_000_000_000 : values.total,
        ],
      ),
    );

  it("[loan-policy-check-constraints] rejects invalid policy values", async () => {
    await clearPolicy();
    const invalid = [
      { maxPrincipalIdr: null, bp: null },
      { installments: 0 },
      { installments: 37 },
      { maxPrincipalIdr: null, bp: 120_001 },
      { deduction: 10_001 },
      { deduction: -1 },
      { maxPrincipalIdr: 0 },
      { total: 0 },
      { total: -1 },
      // The total cap may not be below the per-loan ceiling.
      { maxPrincipalIdr: 2_000_000, total: 1_999_999 },
    ];
    for (const values of invalid)
      await expect(
        insert(values),
        JSON.stringify(values),
      ).rejects.toMatchObject({ code: "23514" });
    // The total open cap is required: NULL is a not-null violation.
    await expect(insert({ total: null })).rejects.toMatchObject({
      code: "23502",
    });
    // Boundaries are valid.
    await insert({
      maxPrincipalIdr: 1,
      installments: 36,
      deduction: 10_000,
      total: 1,
    });
    await clearPolicy();
    await insert({ maxPrincipalIdr: 2_000_000, total: 2_000_000 });
    await clearPolicy();
    await insert({
      maxPrincipalIdr: null,
      bp: 120_000,
      installments: 1,
      deduction: 0,
    });
  });

  it("[loan-policy-one-row-per-tenant] refuses a second policy row for the tenant", async () => {
    await clearPolicy();
    await insert({});
    await expect(insert({})).rejects.toMatchObject({ code: "23505" });
  });

  it("[loan-policy-rls] hides the policy from another tenant", async () => {
    await clearPolicy();
    await insert({});
    const asOwnTenant = await asAppTenant(appPool, tenantB.tenantId, (db) =>
      db.query("SELECT tenant_id FROM payroll_loan_policies"),
    );
    expect(asOwnTenant.rows).toHaveLength(1);
    await asAppTenant(appPool, tenantAId, async (db) => {
      const seen = await db.query(
        "SELECT tenant_id FROM payroll_loan_policies WHERE tenant_id = $1",
        [tenantB.tenantId],
      );
      expect(seen.rowCount).toBe(0);
      const updated = await db.query(
        "UPDATE payroll_loan_policies SET single_open_loan = false WHERE tenant_id = $1",
        [tenantB.tenantId],
      );
      expect(updated.rowCount).toBe(0);
      // DELETE is revoked from the app role (policies are edited, not removed).
    });
  });
});

describe("reimbursement receipt reference index (database)", () => {
  async function seedClaimBase() {
    const categoryId = randomUUID();
    createdCategories.push(categoryId);
    await asTenantB((db) =>
      db.query(
        `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
         VALUES ($1, $2, $3, false, $4)`,
        [
          categoryId,
          tenantB.tenantId,
          `Transport uji ${randomUUID().slice(0, 8)}`,
          JSON.stringify([
            {
              positionId: null,
              perClaimLimitIdr: 500_000,
              perMonthLimitIdr: null,
            },
          ]),
        ],
      ),
    );
    return { categoryId, employeeId: await seedEmployee(null) };
  }

  const insertClaim = (
    base: { categoryId: string; employeeId: string },
    receiptRef: string | null,
  ) =>
    asTenantB((db) =>
      db.query(
        `INSERT INTO reimbursements
           (id, tenant_id, employee_id, category_id, expense_date, amount_idr, description,
            receipt_upload_ref, payout)
         VALUES ($1, $2, $3, $4, '2026-01-15', 10000, 'Klaim uji indeks', $5, 'payroll')`,
        [
          randomUUID(),
          tenantB.tenantId,
          base.employeeId,
          base.categoryId,
          receiptRef,
        ],
      ),
    );

  it("[reimbursement-receipt-unique] refuses the same receipt reference in another letter case", async () => {
    const base = await seedClaimBase();
    const ref = `Receipt-${label}`;
    await insertClaim(base, ref);
    await expect(insertClaim(base, ref.toLowerCase())).rejects.toMatchObject({
      code: "23505",
      constraint: "reimbursements_receipt_upload_ref_key",
    });
    await expect(insertClaim(base, ref.toUpperCase())).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("[reimbursement-receipt-null] allows many claims without a receipt reference", async () => {
    const base = await seedClaimBase();
    await insertClaim(base, null);
    await insertClaim(base, null);
    await insertClaim(base, null);
  });
});
