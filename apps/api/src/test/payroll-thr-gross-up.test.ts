// THR of a gross_up employee: the company bears the PPh 21 on the THR (bead
// legend-x7jas; founder decision Q9, 13 Nov 2026; money + tax = tingkat K).
// Founder rule "jangan sampai rugi": nobody is paid more than the rules give and
// the outlet never carries the tax of an employee who is not on gross_up.
//
// Decision Q9: an employee whose tax scheme is `gross_up` gets the PPh 21 on the
// THR as a tax allowance (tunjangan pajak), exactly like the monthly salary: the
// allowance is a line of the slip, part of the gross income, and the employee's
// net THR equals the gross THR. An employee on the plain `gross` scheme keeps
// having the tax withheld from the THR. R1 (TER of the base salary in a THR
// month follows the earlier slip) is NOT touched here: every month below holds
// one run only (or the December pair, whose invariant is the year's annual tax).
// Fail-first: today the THR tax is withheld from the THR of every employee, so
// the gross_up employee nets less than the THR and no allowance line exists.
//
// RULES UNDER TEST
//  1. [thr-gross-up-net] a THR run's slip of a gross_up employee: net = THR
//     gross; a `tax_allowance` line equals tax.taxAllowanceIdr and the PPh 21
//     deduction (both > 0); gross = THR + allowance; the taxable gross holds the
//     allowance (as for a gross_up salary); every tax number equals the shared
//     engine's gross_up result for the same THR.
//  2. [thr-gross-withheld] the same run for a `gross` employee: no allowance, the
//     tax is withheld, net = THR - tax < THR, tax numbers equal the engine's
//     `gross` result. The employer bears nothing.
//  3. [thr-gross-up-run-totals] one THR run with both employees, approved and
//     locked: run totals = sum of the locked slips; the gross_up slip nets the
//     THR; the bank file total = the run's bank transfer total = the sum of the
//     slips' net pay (no rupiah more or less than the slips say); the allowance
//     is the gross_up employee's only (company cost = THR + allowance, nothing
//     for the gross employee).
//  4. [thr-gross-up-december] Jan-Nov TER runs, December regular run, then THR
//     run (last tax period): the gross_up THR slip nets the THR with allowance =
//     withheld; the gross THR slip is taxed; and per employee the year's PPh 21
//     equals the annual tax on all income (one engine call on the merged
//     December income).
//  5. [thr-net-withheld] the same run for a `net` contract: the tax is still
//     withheld from the THR (only gross_up is borne by the company): no
//     allowance, net = THR - tax < THR, tax numbers equal the engine's `gross`
//     result (withholding on the plain THR).
//  6. [thr-component-gross-up-contract-gross] a `gross` contract whose tenant
//     THR component is typed `gross_up`: no allowance, the tax is withheld, net
//     < THR, tax numbers equal the engine's `gross` result.
//  7. [thr-scheme-mismatch] CTO decision (13 Nov 2026): a THR run simulation fails
//     closed (HttpError 422, code PAYROLL_TAX_SCHEME_MISMATCH) when the
//     employee's CONTRACT scheme differs from the scheme of a taxable earning
//     component with thrBase = true (the salary). The Indonesian message names
//     the employee id (not the name) and how to align (contract scheme or
//     salary component scheme). No result or slip is stored. The tenant's own
//     THR component scheme is not checked (rule 6 stays valid).
//
// ASSUMPTIONS (the spec is silent or ambiguous; stated so they can be contested)
//  - Test data now keeps the salary component's scheme equal to the contract's
//    (the mismatch tests are the only exception).
//  - The employee's scheme is the one on the active contract (what simulate
//    reads), mirrored on the salary component. The THR line follows the
//    employee's scheme (Q9), not a scheme of the THR component itself.
//  - "Skema potong (net/gross biasa)" in the brief: tested for `gross` and for
//    `net`. Founder decision: only `gross_up` is borne by the company; a `net`
//    contract still has the PPh 21 withheld from the THR (rule 5).
//  - The THR line follows the employee's contract scheme, never the tax scheme of
//    the tenant's THR pay component: a `gross` contract with a `gross_up` THR
//    component is still withheld (rule 6).
//  - The THR amount is read from the slip's `thr` line (never hard-coded). The
//    employee (TK/0, NPWP, joined 2025-03-01, one fixed salary of 15.000.000, no
//    BPJS) is employed for 12 months or more at the THR date, so the THR is > 0.
//  - A THR run alone in its month is taxed by TER on that month's gross; the
//    oracle is `computePayslipTax` with the THR as the only earning.
//  - Bank file amount = payslip net (generic_csv, as in payroll-bank-export).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEFAULT_PPH21_POLICY,
  bankTransferFileSchema,
  buildPph21Prior,
  computePayslipTax,
  payrollRunIdSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { createBankTransferFile } from "../services/payroll-export.service.ts";
import { createLogger } from "../lib/logger.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";
import {
  approveSimulatedRun,
  deleteStatutoryTables,
  insertDraftRun,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
} from "./payroll-simulate-kit.ts";

// ---- App, DB pool -----------------------------------------------------------

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const storageRuntime: StorageRuntime = {
  storage: new FakeObjectStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => null,
  hrisDocumentSigner: async () => null,
};
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime,
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

const key = () => `thr-gu-${randomUUID()}`;
// Default monthly salary of the test employees. The December case also runs
// at 8 jt (DECEMBER_LOW_SALARY): there the year's biaya jabatan stays below the
// 6 jt cap and a gross_up employee still owes tax at the December settlement.
const SALARY = 15_000_000;
const DECEMBER_LOW_SALARY = 8_000_000;

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
        `THR gross-up ${roleId.slice(0, 8)}`,
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
let exporterUserId: string;
let hr: Client;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

// ---- Fixtures -----------------------------------------------------------------

type Scheme = "gross" | "gross_up" | "net";
type World = { entityId: string; policyId: string };
type Emp = { id: string; scheme: Scheme; name: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT THR Gross-up ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
  return world;
}

/**
 * Active pkwtt employee TK/0 with NPWP and a bank account, paid by `scheme` on
 * the contract. The salary component (thrBase = true) carries `componentScheme`,
 * by default the same scheme: simulate of a THR run refuses an employee whose
 * contract scheme differs from the scheme of a THR-base salary component.
 */
async function makeEmployee(
  world: World,
  scheme: Scheme,
  componentScheme: Scheme = scheme,
  salary: number = SALARY,
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    scheme,
    name: `THR ${scheme}/${componentScheme} ${++counter}`,
  };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: emp.name,
      joinDate: "2025-03-01",
      ptkpStatus: "TK/0",
      taxScheme: scheme,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: salary,
      // The scheme lives on the contract (what simulate reads) and is
      // mirrored on the salary component (data that matches); a different
      // `componentScheme` builds the mismatch fixture.
      scheme: componentScheme,
      createdBy: exporterUserId,
    });
  });
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

type RunDates = { periodStart: string; periodEnd: string; payDate: string };
const monthDates = (m: number, payDay = 28): RunDates => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  return {
    periodStart: `2026-${mm}-01`,
    periodEnd: `2026-${mm}-${last}`,
    payDate: `2026-${mm}-${String(payDay).padStart(2, "0")}`,
  };
};
const NOV_THR = monthDates(11);
const DEC_A = monthDates(12, 25);
const DEC_B = monthDates(12, 28);

async function draftRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant(async (conn) => {
    const schedule = await insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      thr: runType === "thr",
      ...dates,
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

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), exporterUserId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

/** draft -> simulated (service) -> approved (SQL). */
async function approvedRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
) {
  const runId = await draftRun(world, dates, runType);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  return runId;
}

async function lockedRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
) {
  const runId = await approvedRun(world, dates, runType);
  await lockRun(runId);
  return runId;
}

// ---- Readers ------------------------------------------------------------------

type Line = { category: string; kind: string; amountIdr: number };
type Tax = {
  method: string;
  terRateBp: number | null;
  taxableGrossIdr: number;
  pph21Idr: number;
  pph21WithheldIdr: number;
  taxAllowanceIdr: number;
  pph21EmployerBorneIdr: number;
  pph21RefundIdr: number;
  pph21EmployerRefundIdr: number;
};
type Calc = {
  employeeId: string;
  grossIdr: number;
  deductionsIdr: number;
  netIdr: number;
  pph21Idr: number;
  lines: Line[];
  tax: Tax;
};

/** Stored simulation results (sealed) of a simulated run. */
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

/** Sealed payslips (locked runs) of the given runs. */
const slipsOf = (runIds: readonly string[]) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT id, payroll_run_id, employee_id, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, runIds],
      )
    ).rows;
    return rows.map((row) => ({
      runId: row.payroll_run_id as string,
      employeeId: row.employee_id as string,
      calc: JSON.parse(
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
      ) as Calc,
    }));
  });

const runTotals = async (runId: string) =>
  (
    await asTenant(
      async (conn) =>
        (
          await conn.query(
            "SELECT totals FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
            [tenant.id, runId],
          )
        ).rows[0],
    )
  ).totals as { netIdr: number; bankTransferIdr: number };

const thrOf = (calc: Calc) => {
  const lines = calc.lines.filter((l) => l.category === "thr");
  expect(lines, "one THR line on the slip").toHaveLength(1);
  expect(lines[0]!.amountIdr, "THR is paid").toBeGreaterThan(0);
  return lines[0]!.amountIdr;
};
const sumLines = (calc: Calc, category: string) =>
  calc.lines
    .filter((l) => l.category === category)
    .reduce((total, l) => total + l.amountIdr, 0);

/** The shared engine's TER result for one month whose only earning is `amount`. */
const oracleTerMonth = (scheme: Scheme, amount: number) =>
  computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: false,
    monthsWorked: 12,
    earnings: [{ amountIdr: amount, taxable: true, taxScheme: scheme }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: buildPph21Prior([]),
  }).tax;

// ---- Setup / teardown ---------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("THR gross-up locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("THR gross-up HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  // No tenant PPh 21 policy version: the default policy (half up) applies.
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
      "bank_transfer_files",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'thr-gu-%'",
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
    // Only the components of this file's own employees: a tenant-wide
    // `SM_%` sweep would delete salary components another file still uses.
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

// ---- 1. [thr-gross-up-net] ------------------------------------------------------

describe("[thr-gross-up-net] THR slip of a gross_up employee", () => {
  it("nets the full THR: the tax is a tax allowance line, part of the gross income, as for a gross_up salary", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world, "gross_up");
    const runId = await draftRun(world, NOV_THR, "thr");
    await simulateRun(runId);

    const results = await storedResults(runId);
    expect(results).toHaveLength(1);
    const calc = results[0]!.calc;
    const thr = thrOf(calc);
    const oracle = oracleTerMonth("gross_up", thr);
    expect(
      oracle.taxAllowanceIdr,
      "oracle: a gross_up THR has a tax allowance",
    ).toBeGreaterThan(0);

    // The allowance is a recorded earning line and equals the tax numbers.
    expect(calc.tax.taxAllowanceIdr).toBe(oracle.taxAllowanceIdr);
    expect(sumLines(calc, "tax_allowance")).toBe(calc.tax.taxAllowanceIdr);
    // The tax is still deducted from the slip (and is the allowance).
    expect(calc.tax.pph21WithheldIdr).toBe(oracle.pph21WithheldIdr);
    expect(sumLines(calc, "pph21")).toBe(calc.tax.pph21WithheldIdr);
    expect(calc.tax.pph21WithheldIdr).toBe(calc.tax.taxAllowanceIdr);
    expect(calc.pph21Idr).toBe(oracle.pph21Idr);
    // Gross income = THR + allowance (like a gross_up month), taxed once.
    expect(calc.grossIdr).toBe(thr + calc.tax.taxAllowanceIdr);
    expect(calc.tax.taxableGrossIdr).toBe(oracle.taxableGrossIdr);
    expect(calc.tax.taxableGrossIdr).toBe(thr + calc.tax.taxAllowanceIdr);
    // The employee nets exactly the THR: the company bears the tax.
    expect(calc.deductionsIdr).toBe(calc.tax.pph21WithheldIdr);
    expect(calc.netIdr).toBe(thr);
    expect(emp.scheme).toBe("gross_up");
  }, 120_000);
});

// ---- 2. [thr-gross-withheld] ---------------------------------------------------

describe("[thr-gross-withheld] THR slip of a gross employee", () => {
  it("still has the tax withheld from the THR: no allowance, nothing borne by the employer", async () => {
    const world = await makeWorld();
    await makeEmployee(world, "gross");
    const runId = await draftRun(world, NOV_THR, "thr");
    await simulateRun(runId);

    const results = await storedResults(runId);
    expect(results).toHaveLength(1);
    const calc = results[0]!.calc;
    const thr = thrOf(calc);
    const oracle = oracleTerMonth("gross", thr);
    expect(oracle.pph21WithheldIdr).toBeGreaterThan(0);

    expect(calc.tax.taxAllowanceIdr).toBe(0);
    expect(sumLines(calc, "tax_allowance")).toBe(0);
    expect(calc.tax.pph21EmployerBorneIdr).toBe(0);
    expect(calc.tax.pph21WithheldIdr).toBe(oracle.pph21WithheldIdr);
    expect(sumLines(calc, "pph21")).toBe(oracle.pph21WithheldIdr);
    expect(calc.pph21Idr).toBe(oracle.pph21Idr);
    expect(calc.grossIdr).toBe(thr);
    expect(calc.netIdr).toBe(thr - oracle.pph21WithheldIdr);
    expect(calc.netIdr).toBeLessThan(thr);
  }, 120_000);
});

// ---- 5. [thr-net-withheld] ------------------------------------------------------

describe("[thr-net-withheld] THR slip of a net employee", () => {
  it("still has the tax withheld from the THR: only gross_up is borne by the company", async () => {
    const world = await makeWorld();
    await makeEmployee(world, "net");
    const runId = await draftRun(world, NOV_THR, "thr");
    await simulateRun(runId);

    const results = await storedResults(runId);
    expect(results).toHaveLength(1);
    const calc = results[0]!.calc;
    const thr = thrOf(calc);
    // Withholding on the plain THR: the oracle of the `gross` scheme.
    const oracle = oracleTerMonth("gross", thr);
    expect(oracle.pph21WithheldIdr).toBeGreaterThan(0);

    expect(calc.tax.taxAllowanceIdr).toBe(0);
    expect(sumLines(calc, "tax_allowance")).toBe(0);
    expect(calc.tax.pph21WithheldIdr).toBe(oracle.pph21WithheldIdr);
    expect(sumLines(calc, "pph21")).toBe(oracle.pph21WithheldIdr);
    expect(calc.pph21Idr).toBe(oracle.pph21Idr);
    expect(calc.grossIdr).toBe(thr);
    expect(calc.netIdr).toBe(thr - oracle.pph21WithheldIdr);
    expect(calc.netIdr).toBeLessThan(thr);
  }, 120_000);
});

// ---- 6. [thr-component-gross-up-contract-gross] ------------------------------------

describe("[thr-component-gross-up-contract-gross] gross contract, gross_up THR component", () => {
  it("follows the contract: the tax is withheld, no allowance", async () => {
    const world = await makeWorld();
    // Contract gross + salary component gross (match); only the tenant THR
    // component is gross_up, which is not checked. Removed again in `finally`.
    await makeEmployee(world, "gross", "gross");
    const componentId = randomUUID();
    await asTenant((conn) =>
      conn.query(
        `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
           recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
         VALUES ($1, $2, $3, 'THR komponen gross-up uji', 'thr', 'earning',
           'fixed', true, 'gross_up', false, false, false)`,
        [
          componentId,
          tenant.id,
          `SM_THR_${componentId.replaceAll("-", "").slice(0, 10).toUpperCase()}`,
        ],
      ),
    );
    try {
      const runId = await draftRun(world, NOV_THR, "thr");
      await simulateRun(runId);

      const results = await storedResults(runId);
      expect(results).toHaveLength(1);
      const calc = results[0]!.calc;
      const thr = thrOf(calc);
      const oracle = oracleTerMonth("gross", thr);
      expect(oracle.pph21WithheldIdr).toBeGreaterThan(0);

      expect(calc.tax.taxAllowanceIdr).toBe(0);
      expect(sumLines(calc, "tax_allowance")).toBe(0);
      expect(calc.tax.pph21EmployerBorneIdr).toBe(0);
      expect(calc.tax.pph21WithheldIdr).toBe(oracle.pph21WithheldIdr);
      expect(calc.pph21Idr).toBe(oracle.pph21Idr);
      expect(calc.grossIdr).toBe(thr);
      expect(calc.netIdr).toBe(thr - oracle.pph21WithheldIdr);
      expect(calc.netIdr).toBeLessThan(thr);
    } finally {
      await asTenant((conn) =>
        conn.query("DELETE FROM pay_components WHERE id = $1", [componentId]),
      );
    }
  }, 120_000);
});

// ---- 3. [thr-gross-up-run-totals] -----------------------------------------------

describe("[thr-gross-up-run-totals] a THR run with a gross_up and a gross employee", () => {
  it("locks with run totals = the slips, the bank file total = the transfers, and the allowance only on the gross_up slip", async () => {
    const world = await makeWorld();
    const gu = await makeEmployee(world, "gross_up");
    const gr = await makeEmployee(world, "gross");
    const runId = await lockedRun(world, NOV_THR, "thr");

    const slips = await slipsOf([runId]);
    expect(slips).toHaveLength(2);
    const guSlip = slips.find((s) => s.employeeId === gu.id)!.calc;
    const grSlip = slips.find((s) => s.employeeId === gr.id)!.calc;
    const guThr = thrOf(guSlip);
    const grThr = thrOf(grSlip);

    // gross_up: THR in full; the company carries the allowance.
    expect(guSlip.netIdr).toBe(guThr);
    expect(guSlip.tax.taxAllowanceIdr).toBeGreaterThan(0);
    // gross: tax comes out of the THR, the outlet carries nothing for it.
    expect(grSlip.tax.taxAllowanceIdr).toBe(0);
    expect(grSlip.tax.pph21EmployerBorneIdr).toBe(0);
    expect(grSlip.netIdr).toBe(grThr - grSlip.tax.pph21WithheldIdr);
    expect(grSlip.netIdr).toBeLessThan(grThr);

    // Run totals and the money that leaves the bank: the slips, no rupiah more.
    const netTotal = guSlip.netIdr + grSlip.netIdr;
    const totals = await runTotals(runId);
    expect(totals.netIdr).toBe(netTotal);
    expect(totals.bankTransferIdr).toBe(netTotal);
    // Everything paid out is THR + the gross_up allowance - the employee's tax.
    expect(netTotal).toBe(guThr + (grThr - grSlip.tax.pph21WithheldIdr));

    // The legacy POST route is closed (legend-yjbjb: 409
    // LEGACY_BANK_EXPORT_DISABLED); the file builder is exercised directly.
    const file = bankTransferFileSchema.parse(
      await createBankTransferFile(
        tenantScope(),
        exporterUserId,
        payrollRunIdSchema.parse(runId),
        { format: "generic_csv", idempotencyKey: key() },
        storageRuntime,
      ),
    );
    expect(file.rowCount).toBe(2);
    expect(file.totalIdr).toBe(netTotal);
    expect(file.totalIdr).toBe(totals.bankTransferIdr);
  }, 180_000);
});

// ---- 4. [thr-gross-up-december] -------------------------------------------------

async function decemberCase(salary: number) {
  const world = await makeWorld();
  const gu = await makeEmployee(world, "gross_up", "gross_up", salary);
  const gr = await makeEmployee(world, "gross", "gross", salary);
  const history: string[] = [];
  for (let m = 1; m <= 11; m++)
    history.push(await lockedRun(world, monthDates(m)));
  const a = await lockedRun(world, DEC_A);
  const b = await lockedRun(world, DEC_B, "thr");

  const slips = await slipsOf([...history, a, b]);
  const slipOf = (emp: Emp, runId: string) =>
    slips.find((s) => s.employeeId === emp.id && s.runId === runId)!.calc;

  // gross_up: the THR nets in full, the company bears the December tax on it.
  const guB = slipOf(gu, b);
  const guThr = thrOf(guB);
  expect(guB.tax.method).toBe("annual_recalculation");
  expect(guB.tax.taxAllowanceIdr).toBeGreaterThan(0);
  expect(guB.tax.taxAllowanceIdr).toBe(guB.tax.pph21WithheldIdr);
  expect(sumLines(guB, "tax_allowance")).toBe(guB.tax.taxAllowanceIdr);
  expect(guB.netIdr).toBe(guThr);

  // gross: the tax is taken from the THR, no allowance.
  const grB = slipOf(gr, b);
  const grThr = thrOf(grB);
  expect(grB.tax.taxAllowanceIdr).toBe(0);
  expect(grB.tax.pph21EmployerBorneIdr).toBe(0);
  expect(grB.tax.pph21WithheldIdr).toBeGreaterThan(0);
  expect(grB.netIdr).toBeLessThan(grThr);

  // The year per employee: sum of PPh 21 = annual tax on all income, once.
  for (const emp of [gu, gr]) {
    const own = (ids: readonly string[]) => ids.map((id) => slipOf(emp, id));
    const hist = own(history);
    const december = own([a, b]);
    const merged = computePayslipTax({
      tables: REFERENCE_TABLES,
      policy: DEFAULT_PPH21_POLICY,
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: true,
      monthsWorked: 12,
      // The stored taxable gross also holds the company-paid tax (gross_up
      // allowance or net borne tax). Feeding it back under the employee's own
      // scheme would let the engine add that tax a second time (the history is
      // already settled by the allowance, so it reads it as a company balance
      // and grosses it up again: +203.000 PKP, +10.150 tax at 8 jt). The
      // oracle therefore takes the December income WITHOUT the covered tax and
      // lets the engine gross it up once, under the employee's scheme. The
      // biaya jabatan (5%, max 6 jt a year) is computed once on the year's
      // gross in December (PMK 168/2023 Pasal 21), never per run.
      earnings: [
        {
          amountIdr: december.reduce(
            (total, s) =>
              total +
              s.tax.taxableGrossIdr -
              s.tax.taxAllowanceIdr -
              s.tax.pph21EmployerBorneIdr,
            0,
          ),
          taxable: true,
          taxScheme: emp.scheme,
        },
      ],
      employerBenefitIdr: 0,
      employeeDeductibleIdr: 0,
      prior: buildPph21Prior(
        hist.map((s) => ({
          tax: s.tax as never,
          employeeDeductibleIdr: 0,
        })),
      ),
    });
    const year = [...hist, ...december].reduce(
      (total, s) => total + s.tax.pph21Idr,
      0,
    );
    expect(year, `${emp.scheme}: year PPh 21 = annual tax`).toBe(
      merged.result.annual!.annualTaxIdr,
    );
  }
}

describe("[thr-gross-up-december] THR run in the last tax period", () => {
  const title =
    "Jan-Nov TER, December regular run, then THR: the gross_up THR nets in full, the gross THR is taxed, and the year's PPh 21 equals the annual tax";
  it(`${title} (salary 15.000.000)`, () => decemberCase(SALARY), 900_000);
  it(
    `${title} (salary 8.000.000)`,
    () => decemberCase(DECEMBER_LOW_SALARY),
    900_000,
  );
});

// ---- 7. [thr-scheme-mismatch] ---------------------------------------------------

const storedCount = (runId: string) =>
  asTenant(async (conn) => {
    const count = async (table: string) =>
      Number(
        (
          await conn.query(
            `SELECT count(*)::int AS n FROM ${table}
              WHERE tenant_id = $1 AND payroll_run_id = $2`,
            [tenant.id, runId],
          )
        ).rows[0].n,
      );
    return {
      results: await count("payroll_run_results"),
      slips: await count("payslips"),
    };
  });

describe("[thr-scheme-mismatch] contract scheme differs from the salary component scheme", () => {
  const cases: ReadonlyArray<[Scheme, Scheme]> = [
    ["gross_up", "gross"],
    ["gross", "gross_up"],
    ["net", "gross"],
  ];
  for (const [contract, component] of cases)
    it(`fails closed (422) for a ${contract} contract with a ${component} salary component, naming the employee id`, async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world, contract, component);
      const runId = await draftRun(world, NOV_THR, "thr");

      await expect(simulateRun(runId)).rejects.toMatchObject({
        status: 422,
        code: "PAYROLL_TAX_SCHEME_MISMATCH",
        message: expect.stringContaining(emp.id),
      });
      // The message names the id, never the employee's name.
      const error = await simulateRun(runId).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(emp.name);
      expect(await storedCount(runId)).toEqual({ results: 0, slips: 0 });
    }, 120_000);

  it("with two employees, names only the one whose schemes differ", async () => {
    const world = await makeWorld();
    const matching = await makeEmployee(world, "gross_up", "gross_up");
    const mismatched = await makeEmployee(world, "gross", "gross_up");
    const runId = await draftRun(world, NOV_THR, "thr");

    await expect(simulateRun(runId)).rejects.toMatchObject({
      status: 422,
      code: "PAYROLL_TAX_SCHEME_MISMATCH",
      message: expect.stringContaining(mismatched.id),
    });
    const error = (await simulateRun(runId).catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(matching.id);
    expect(await storedCount(runId)).toEqual({ results: 0, slips: 0 });
  }, 120_000);
});
