// Fail-closed guards of the simulate-then-lock payroll run (architect round,
// docs/briefs/sub-payroll-followups.md "Architect round (xhigh) fixes";
// design docs/briefs/sub-payroll-followups-design.md). Founder rule "jangan
// sampai rugi": a run is refused loudly instead of paying numbers that are
// wrong, and nobody is under-taxed. Fail-first: written before the fixes.
//
// RULES UNDER TEST
//  1. [receivable-open] (O2, bead legend-bypw2, founder decision B8) simulate
//     no longer refuses an employee with an open PPh 21 receivable from earlier
//     payslips: it adds a collection line equal to
//     planPph21ReceivableCollection({ openIdr, roomIdr }) where room is the net
//     pay left before the collection. Collected <= open, collected <= room, net
//     never negative, no employee without a receivable is touched, simulating
//     again collects the same amount (no double collection), the lock seals
//     exactly what simulate stored, and the balance after the lock is
//     open - collected. Inconsistent or unreadable earlier payslip data is
//     still refused, nothing stored, run stays draft (fail closed). A run of
//     employees without a receivable simulates as before.
//  2. [lock-year-serialized] a November run and a December run of the same
//     legal entity locked at the same time are serialized by the tax-year
//     lock: exactly one locks; the loser is a 409 and writes nothing (either
//     Dec first: Nov is 409 PAYROLL_PPH21_LATER_PERIOD_LOCKED, or Nov first:
//     Dec is 409 on stale prior). The year's PPh 21 equals the annual tax on
//     all income; a December loser re-simulated on top of November locks.
//  3. [thr-one-month] a THR run whose period is not exactly one calendar month
//     is 422 PAYROLL_RUN_SIMULATE_UNSUPPORTED; a one-month THR run simulates.
//  4. [lock-employee-dates] a join date or end date of an employee changed
//     after approval makes the lock 409 PAYROLL_RUN_RESULT_STALE, nothing
//     written (the stored result keeps the dates it was computed with).
//
// ASSUMPTIONS (design silent; stated so the engineer can contest them)
//  - An open receivable is seeded by tampering with the sealed calculation of
//    one earlier locked payslip (June 2025, a year before the run): its tax
//    carries pph21ReceivableIdr = r and pph21WithheldIdr reduced by r, so
//    the identity pph21Idr = W + borne + receivable holds. No collected line
//    exists, so the open balance is r > 0. The balance is read across years
//    (brief of the receivable card: "lintas tahun").
//  - The collection is the deduction line of category "pph21_receivable"
//    (shared Pph21ReceivableSlip shape) inside the stored `calculation.lines`.
//    Room is read from a control employee of the same run with the same
//    salary and no receivable: his net is the room (no loans, no late
//    deductions in this world). A large receivable (40.000.000) exceeds the
//    room, so the employee nets 0 and the rest stays open (B8: no percentage
//    limit, no negative net).
//  - For the fail-closed cases the exact error code is not fixed by the
//    design, so only "refused (not resolved), run draft, nothing stored" is
//    asserted. Inconsistent data = a pph21_receivable collection line larger
//    than the receivable raised; unreadable = the sealed calculation of the
//    earlier payslip is garbage.
//  - In 2 the loser's code is one of PAYROLL_PPH21_LATER_PERIOD_LOCKED,
//    PAYROLL_PPH21_MONTH_STALE or PAYROLL_RUN_RESULT_STALE (design 2/3 do not
//    fix which stale check fires first). Which run wins is not fixed. The race
//    is repeated ROUNDS times so that a missing year lock shows up.
//  - In 3 periods other than one calendar month: 1 Nov-31 Dec, 15 Nov-14 Dec
//    and 1-15 Nov; one-month control: 1-30 Nov.
//  - In 4 the employee columns are join_date and end_date; the end date is
//    set inside the run period (still employed, still simulated).
//  - Same world as payroll-pph21-december-runs.test.ts: policy programmes [],
//    pkwtt TK/0 employees with a NPWP and bank account, default PPh 21 policy.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
  payrollRunIdSchema,
  pph21ReceivableBalance,
  planPph21ReceivableCollection,
  type Pph21PriorPeriod,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";
import {
  approveSimulatedRun,
  deleteStatutoryTables,
  insertDraftRun,
  insertContract,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
  returnRunToDraft,
} from "./payroll-simulate-kit.ts";

// Pass-through spy on the payroll decrypt, used only by the
// [receivable-latest-balance-only] tests (legend-2fk79) to count which earlier
// payslips a simulate or lock opens. Behavior is the real function.
vi.mock("../lib/payroll-sealed.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/payroll-sealed.ts")>();
  return { ...actual, openPayrollValue: vi.fn(actual.openPayrollValue) };
});

type EngineTax = Pph21PriorPeriod["tax"];

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
const createdThrSchedules: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];

const key = () => `followup-guards-${randomUUID()}`;
const SALARY = 15_000_000;
const ROUNDS = 3;

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
        `Guards ${roleId.slice(0, 8)}`,
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
let hr: Client;
let exporterUserId: string;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Penjaga ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
  return world;
}

/** An active pkwtt employee TK/0 with a NPWP and a bank account, gross scheme. */
async function makeEmployee(world: World): Promise<Emp> {
  const emp: Emp = { id: randomUUID() };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: `Penjaga ${++counter}`,
      joinDate: "2025-03-01",
      ptkpStatus: "TK/0",
      taxScheme: "gross",
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      scheme: "gross",
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

/** Month `m` (1-12) of `year`, paid on `payDay` (default the 28th). */
const monthDates = (m: number, year = 2026, payDay = 28): RunDates => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-${String(payDay).padStart(2, "0")}`,
  };
};

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

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

const countOf = async (table: string, runId: string) =>
  Number(
    (
      await scalar(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).n,
  );

/** draft -> simulated (service) -> approved (SQL). */
async function approvedRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
) {
  const runId = await draftRun(world, dates, runType);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return runId;
}

async function lockedRun(world: World, dates: RunDates) {
  const runId = await approvedRun(world, dates);
  await lockRun(runId);
  expect(await runStatus(runId)).toBe("locked");
  return runId;
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

type Calc = { grossIdr: number; tax: EngineTax };

const openSlip = (row: {
  id: string;
  calculation_encrypted: Buffer;
  pii_key_version: number;
}) =>
  JSON.parse(
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
  ) as Calc;

const slipsOf = (runIds: readonly string[]) =>
  asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT id, payroll_run_id, employee_id, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, runIds],
      )
    ).rows.map((row) => ({
      runId: row.payroll_run_id as string,
      employeeId: row.employee_id as string,
      calc: openSlip(row),
    })),
  );

/** legend-2fk79: new payslip field, the receivable still open after that slip. */
const OPEN_AFTER_FIELD = "pph21ReceivableOpenAfterIdr";

/**
 * Seeds an open PPh 21 receivable for the employee: tampers with the sealed
 * calculation of the employee's payslip in `runId` (replica role: the
 * immutability triggers are off for this test fixture only). Returns r.
 */
async function seedOpenReceivable(
  runId: string,
  emp: Emp,
  /** Larger than the tax: PPh 21 stays withheld in full, identity kept. */
  amount?: number,
): Promise<number> {
  return asTenant(async (conn) => {
    const row = (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows[0];
    const calc = openSlip(row) as FullCalc & {
      deductionsIdr: number;
      pph21Idr: number;
    };
    const withheld = calc.tax.pph21WithheldIdr;
    expect(withheld, "the seed slip withheld tax").toBeGreaterThan(0);
    const receivable = amount ?? Math.min(50_000, withheld);
    // Both variants must still satisfy payslipTotalsIssues (the loader parses
    // the slip with the same schema).
    const tampered =
      amount === undefined
        ? {
            ...calc,
            // Part of the tax was not withheld: pph21 line, deductions and
            // net follow, the owed tax stays the same.
            lines: calc.lines.map((l) =>
              l.category === "pph21"
                ? { ...l, amountIdr: l.amountIdr - receivable }
                : l,
            ),
            deductionsIdr: calc.deductionsIdr - receivable,
            netIdr: calc.netIdr + receivable,
            tax: {
              ...calc.tax,
              pph21WithheldIdr: withheld - receivable,
              pph21ReceivableIdr: receivable,
            },
          }
        : {
            ...calc,
            pph21Idr: calc.pph21Idr + receivable,
            tax: {
              ...calc.tax,
              pph21Idr: calc.tax.pph21Idr + receivable,
              pph21ReceivableIdr: receivable,
            },
          };
    // legend-2fk79: when the slip carries the open-balance field (slips sealed
    // after the field exists), keep it consistent with the raised receivable,
    // since the loader trusts the latest slip's field. Slips without the field
    // (before the field exists, or old slips) are left as they were.
    if (OPEN_AFTER_FIELD in calc)
      (tampered as Record<string, unknown>)[OPEN_AFTER_FIELD] =
        Number((calc as unknown as Record<string, unknown>)[OPEN_AFTER_FIELD]) +
        receivable;
    await conn.query(
      `UPDATE payslips SET calculation_encrypted = $3, pii_key_version = $4
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenant.id,
        row.id,
        sealPayrollValue(JSON.stringify(tampered), {
          tenantId: tenant.id,
          table: "payslips",
          rowId: row.id,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
    return receivable;
  }, true);
}

/** Rewrites the sealed calculation of one earlier payslip (fixture only). */
async function tamperEarlierSlip(
  runId: string,
  emp: Emp,
  change: (calc: FullCalc) => unknown,
) {
  await asTenant(async (conn) => {
    const row = (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows[0];
    const next = change(openSlip(row) as FullCalc);
    await conn.query(
      `UPDATE payslips SET calculation_encrypted = $3, pii_key_version = $4
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenant.id,
        row.id,
        sealPayrollValue(JSON.stringify(next), {
          tenantId: tenant.id,
          table: "payslips",
          rowId: row.id,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
  }, true);
}

const sumPph21 = (taxes: readonly EngineTax[]) =>
  taxes.reduce((total, tax) => total + tax.pph21Idr, 0);

/**
 * The invariant: per employee, PPh 21 over the history runs plus the December
 * runs equals the annual tax of ONE engine call on the December income, with
 * the history as prior (same oracle as payroll-pph21-december-runs.test.ts).
 */
async function expectYearEqualsAnnualTax(
  emp: Emp,
  historyRunIds: readonly string[],
  decemberRunIds: readonly string[],
) {
  const history = (await slipsOf(historyRunIds)).filter(
    (s) => s.employeeId === emp.id,
  );
  const december = (await slipsOf(decemberRunIds)).filter(
    (s) => s.employeeId === emp.id,
  );
  expect(december.length, "one slip per December run").toBe(
    decemberRunIds.length,
  );
  for (const slip of december)
    expect(slip.calc.tax.method).toBe("annual_recalculation");
  const merged = computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    earnings: [
      {
        amountIdr: december.reduce(
          (total, s) => total + s.calc.tax.taxableGrossIdr,
          0,
        ),
        taxable: true,
        taxScheme: "gross",
      },
    ],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: buildPph21Prior(
      history.map((s) => ({ tax: s.calc.tax, employeeDeductibleIdr: 0 })),
    ),
  });
  const year = sumPph21([
    ...history.map((s) => s.calc.tax),
    ...december.map((s) => s.calc.tax),
  ]);
  expect(year, "year PPh 21 = annual tax on all income").toBe(
    merged.result.annual!.annualTaxIdr,
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("Guards locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("Guards HR");
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
    // Raw (replica role): append-only tables reference payslips and runs.
    for (const table of [
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
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'followup-guards-%'",
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

// ---- 1. [receivable-open] ----------------------------------------------------------

type CollectLine = { category: string; amountIdr: number };
type FullCalc = Calc & { netIdr: number; lines: CollectLine[] };

const collectedOf = (calc: FullCalc) =>
  calc.lines
    .filter((l) => l.category === "pph21_receivable")
    .reduce((total, l) => total + l.amountIdr, 0);
const collectionLines = (calc: FullCalc) =>
  calc.lines.filter((l) => l.category === "pph21_receivable");

const storedResults = (runId: string) =>
  asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT employee_id, payslip_id, result_encrypted, pii_key_version
           FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows.map((row) => ({
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
        ) as { calculation: FullCalc }
      ).calculation,
    })),
  );

describe("[receivable-open] an open PPh 21 receivable is collected by simulate", () => {
  for (const open of [50_000, 40_000_000]) {
    const label =
      open === 50_000
        ? "room covers it: collected in full"
        : "receivable above the room: collects the room, net 0, rest stays open";
    it(`${label}; simulate = what the lock seals`, async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const control = await makeEmployee(world);
      const earlier = await lockedRun(world, monthDates(6, 2025));
      expect(await seedOpenReceivable(earlier, emp, open)).toBe(open);

      const run = await draftRun(world, monthDates(11));
      const simulated = await simulateRun(run);
      expect(simulated.status).toBe("simulated");
      const results = await storedResults(run);
      expect(results).toHaveLength(2);
      const mine = results.find((r) => r.employeeId === emp.id)!.calc;
      const other = results.find((r) => r.employeeId === control.id)!.calc;

      // The control employee owes nothing: untouched.
      expect(collectionLines(other)).toHaveLength(0);
      const room = other.netIdr;
      expect(room).toBeGreaterThan(0);

      // Same collection as the shared B8 planner; one line only.
      const plan = planPph21ReceivableCollection({
        openIdr: open,
        roomIdr: room,
      });
      expect(collectionLines(mine)).toHaveLength(1);
      expect(collectedOf(mine)).toBe(plan.collectedIdr);
      // Money invariants: never more than owed, never more than the room,
      // never a negative net, the rest of the pay is unchanged.
      expect(collectedOf(mine)).toBeLessThanOrEqual(open);
      expect(collectedOf(mine)).toBeLessThanOrEqual(room);
      expect(mine.netIdr).toBeGreaterThanOrEqual(0);
      expect(mine.netIdr).toBe(room - collectedOf(mine));
      if (open <= room) expect(collectedOf(mine)).toBe(open);
      else expect(mine.netIdr).toBe(0);
      // Run totals follow the results (bank transfer = what is paid out).
      expect(Number(simulated.totals?.netIdr)).toBe(mine.netIdr + other.netIdr);

      // Simulating again collects the same, not twice.
      await simulateRun(run);
      const again = await storedResults(run);
      expect(
        collectedOf(again.find((r) => r.employeeId === emp.id)!.calc),
      ).toBe(plan.collectedIdr);

      // The lock seals exactly the simulated numbers.
      await asTenant((conn) => approveSimulatedRun(conn, run));
      await lockRun(run);
      expect(await runStatus(run)).toBe("locked");
      const slips = (await slipsOf([earlier, run])) as unknown as {
        runId: string;
        employeeId: string;
        calc: FullCalc;
      }[];
      const sealedMine = slips.find(
        (s) => s.runId === run && s.employeeId === emp.id,
      )!.calc;
      const sealedOther = slips.find(
        (s) => s.runId === run && s.employeeId === control.id,
      )!.calc;
      expect(collectedOf(sealedMine)).toBe(plan.collectedIdr);
      expect(sealedMine.netIdr).toBe(mine.netIdr);
      expect(sealedOther.netIdr).toBe(other.netIdr);
      expect(collectedOf(sealedOther)).toBe(0);

      // Open balance after the lock = open - collected (never negative).
      const balance = pph21ReceivableBalance(
        slips.filter((s) => s.employeeId === emp.id).map((s) => s.calc),
      );
      expect(balance).toBe(open - plan.collectedIdr);
    }, 600_000);
  }

  it("inconsistent history (collected more than raised): refused, nothing stored, run stays draft", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    await tamperEarlierSlip(earlier, emp, (calc) => ({
      ...calc,
      lines: [
        ...calc.lines,
        {
          category: "pph21_receivable",
          componentCode: "PPH21_RECEIVABLE",
          kind: "deduction",
          amountIdr: 10_000,
        },
      ],
    }));

    const run = await draftRun(world, monthDates(11));
    const refused = await failureOf(simulateRun(run));
    expect(refused, "simulate must refuse inconsistent history").not.toBeNull();
    expect(await runStatus(run)).toBe("draft");
    expect(await countOf("payroll_run_results", run)).toBe(0);
    expect(await countOf("payslips", run)).toBe(0);
  }, 300_000);

  it("unreadable earlier payslip: refused, nothing stored, run stays draft", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    await asTenant(
      (conn) =>
        conn.query(
          `UPDATE payslips SET calculation_encrypted = $3
            WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $4`,
          [tenant.id, earlier, Buffer.from("not a sealed value"), emp.id],
        ),
      true,
    );

    const run = await draftRun(world, monthDates(11));
    const refused = await failureOf(simulateRun(run));
    expect(refused, "simulate must refuse unreadable history").not.toBeNull();
    expect(await runStatus(run)).toBe("draft");
    expect(await countOf("payroll_run_results", run)).toBe(0);
    expect(await countOf("payslips", run)).toBe(0);
  }, 300_000);

  it("the same run without a receivable simulates and stores one result", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    await lockedRun(world, monthDates(6, 2025));

    const run = await draftRun(world, monthDates(11));
    await simulateRun(run);
    expect(await runStatus(run)).toBe("simulated");
    expect(await countOf("payroll_run_results", run)).toBe(1);
    const [only] = await storedResults(run);
    expect(collectionLines(only!.calc)).toHaveLength(0);
  }, 300_000);
});

// ---- 2. [lock-year-serialized] -----------------------------------------------------

describe("[lock-year-serialized] November and December locked at the same time", () => {
  it(`exactly one locks, the loser is a 409 with nothing written, the year keeps the annual tax (${ROUNDS} rounds)`, async () => {
    const allowed = new Set([
      "PAYROLL_PPH21_LATER_PERIOD_LOCKED",
      "PAYROLL_PPH21_MONTH_STALE",
      "PAYROLL_RUN_RESULT_STALE",
    ]);
    for (let round = 0; round < ROUNDS; round++) {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      // Both simulated and approved before either locks: neither sees the other.
      const nov = await approvedRun(world, monthDates(11));
      const dec = await approvedRun(world, monthDates(12, 2026, 25));

      const outcomes = await Promise.all([
        failureOf(lockRun(nov)),
        failureOf(lockRun(dec)),
      ]);
      const failed = outcomes.filter((o) => o !== null);
      expect(
        failed,
        `round ${round}: exactly one lock must lose (a missing year lock lets both through)`,
      ).toHaveLength(1);
      expect(failed[0]!.status).toBe(409);
      expect(allowed.has(failed[0]!.code ?? "")).toBe(true);

      const [winner, loser] = outcomes[0] === null ? [nov, dec] : [dec, nov];
      expect(await runStatus(winner)).toBe("locked");
      expect(await runStatus(loser)).toBe("approved");
      expect(await countOf("payslips", loser)).toBe(0);
      expect(await countOf("payroll_run_month_priors", loser)).toBe(0);

      if (winner === nov) {
        // December lost: re-simulate on top of November, approve, lock.
        await asTenant((conn) => returnRunToDraft(conn, dec));
        await simulateRun(dec);
        await asTenant((conn) => approveSimulatedRun(conn, dec));
        await lockRun(dec);
        expect(await runStatus(dec)).toBe("locked");
        await expectYearEqualsAnnualTax(emp, [nov], [dec]);
      } else {
        // November lost to a locked December: only December is in the books.
        await expectYearEqualsAnnualTax(emp, [], [dec]);
      }
    }
  }, 600_000);
});

// ---- 3. [thr-one-month] ------------------------------------------------------------

describe("[thr-one-month] a THR run must cover exactly one calendar month", () => {
  const notOneMonth: [string, RunDates][] = [
    [
      "1 Nov - 31 Dec",
      {
        periodStart: "2026-11-01",
        periodEnd: "2026-12-31",
        payDate: "2026-12-28",
      },
    ],
    [
      "15 Nov - 14 Dec",
      {
        periodStart: "2026-11-15",
        periodEnd: "2026-12-14",
        payDate: "2026-12-14",
      },
    ],
    [
      "1 - 15 Nov",
      {
        periodStart: "2026-11-01",
        periodEnd: "2026-11-15",
        payDate: "2026-11-15",
      },
    ],
  ];
  for (const [label, dates] of notOneMonth)
    it(`${label}: 422 PAYROLL_RUN_SIMULATE_UNSUPPORTED, nothing stored`, async () => {
      const world = await makeWorld();
      await makeEmployee(world);
      const run = await draftRun(world, dates, "thr");
      const refused = await failureOf(simulateRun(run));
      expect(refused, "simulate must refuse this THR period").not.toBeNull();
      expect(refused!.status).toBe(422);
      expect(refused!.code).toBe("PAYROLL_RUN_SIMULATE_UNSUPPORTED");
      expect(await runStatus(run)).toBe("draft");
      expect(await countOf("payroll_run_results", run)).toBe(0);
    }, 300_000);

  it("1 - 30 Nov (one calendar month) simulates", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const run = await draftRun(world, monthDates(11), "thr");
    await simulateRun(run);
    expect(await runStatus(run)).toBe("simulated");
    expect(await countOf("payroll_run_results", run)).toBe(1);
  }, 300_000);
});

// ---- 4. [lock-employee-dates] ------------------------------------------------------

describe("[lock-employee-dates] employee dates changed after approval", () => {
  const changes: [string, string, string][] = [
    ["end date set", "end_date", "2026-11-20"],
    ["join date moved", "join_date", "2025-04-01"],
  ];
  for (const [label, column, value] of changes)
    it(`${label}: lock is 409 PAYROLL_RUN_RESULT_STALE and nothing is written`, async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const run = await approvedRun(world, monthDates(11));

      await asTenant((conn) =>
        conn.query(
          `UPDATE employees SET ${column} = $3 WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, emp.id, value],
        ),
      );

      const refused = await failureOf(lockRun(run));
      expect(refused, "the lock must refuse a changed employee").not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
      expect(await runStatus(run)).toBe("approved");
      expect(await countOf("payslips", run)).toBe(0);
    }, 300_000);

  it("an employee left untouched after approval locks", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const run = await approvedRun(world, monthDates(11));
    await lockRun(run);
    expect(await runStatus(run)).toBe("locked");
    expect(await countOf("payslips", run)).toBe(1);
  }, 300_000);
});

// ---- 5. [receivable-no-double-collection] (architect round 1, findings 1-3) --------
//
// RULES UNDER TEST (founder rule "jangan sampai rugi": nobody is collected
// more than once, a receivable of entity A is never collected by entity B, a
// run whose receivable was already collected cannot be reversed)
//  5a. Two runs of one legal entity are both simulated while receivable X is
//      open, so both collect X. Whichever locks second is refused 409
//      PAYROLL_RUN_RESULT_STALE (its stored collection is out of date) and
//      writes nothing. Total collected over the locked runs never exceeds X,
//      and pph21ReceivableBalance does not throw afterwards. Dec 2025 + Jan
//      2026 (different tax years, so the tax-year prior check cannot see
//      each other), both lock orders.
//  5b. Mar 2026 locked, then Feb 2026 (same entity, both collecting X): the
//      second lock is refused 409 (code not fixed: the existing "later period
//      locked" guard or the new stale check). May already pass today.
//  5c. Receivable raised under legal entity A is NOT collected by a run of
//      legal entity B (employee transferred to B): no collection line, and
//      A's balance stays open after B's run locks.
//  5d. A run that raised a receivable cannot be reversed once another live run
//      collected it: 409 PAYROLL_RUN_REVERSAL_BLOCKED (at the request or at
//      the approval; both are accepted). Control: with nobody collecting, the
//      same run reverses.
//
// ASSUMPTIONS
//  - X = 50.000 on the June 2025 payslip (seedOpenReceivable default variant,
//    which keeps payslipTotalsIssues valid).
//  - Reversal = request by the locker, decision by a second user with
//    payroll.cancel.approve (service functions, like lockRun above).
//  - Moving an employee between legal entities is a plain update of
//    employees.legal_entity_id.
describe("[receivable-no-double-collection] one receivable is collected once, by its own legal entity", () => {
  const X = 50_000;

  const collectedTotal = async (runIds: readonly string[], emp: Emp) =>
    (
      (await slipsOf(runIds)) as unknown as {
        employeeId: string;
        calc: FullCalc;
      }[]
    )
      .filter((s) => s.employeeId === emp.id)
      .reduce((total, s) => total + collectedOf(s.calc), 0);

  const lockedWithCollection = async (runIds: readonly string[], emp: Emp) =>
    (
      (await slipsOf(runIds)) as unknown as {
        employeeId: string;
        calc: FullCalc;
      }[]
    ).filter((s) => s.employeeId === emp.id && collectedOf(s.calc) > 0).length;

  /** Both runs simulated while X is open: both collect X (precondition). */
  async function twoCollectingRuns(a: RunDates, b: RunDates) {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(earlier, emp)).toBe(X);
    const first = await draftRun(world, a);
    const second = await draftRun(world, b);
    await simulateRun(first);
    await simulateRun(second);
    for (const run of [first, second]) {
      const mine = (await storedResults(run)).find(
        (r) => r.employeeId === emp.id,
      )!.calc;
      expect(collectedOf(mine), "simulate collects the open X").toBe(X);
      await asTenant((conn) => approveSimulatedRun(conn, run));
    }
    return { emp, earlier, first, second };
  }

  for (const order of ["december first", "january first"] as const)
    it(`5a. Dec 2025 + Jan 2026 both simulated, ${order}: the second lock is 409 PAYROLL_RUN_RESULT_STALE, X collected once`, async () => {
      const {
        emp,
        earlier,
        first: dec,
        second: jan,
      } = await twoCollectingRuns(monthDates(12, 2025), monthDates(1, 2026));
      const [winner, loser] =
        order === "december first" ? [dec, jan] : [jan, dec];

      await lockRun(winner);
      expect(await runStatus(winner)).toBe("locked");
      const refused = await failureOf(lockRun(loser));
      expect(
        refused,
        "the second run would collect the same receivable again",
      ).not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
      expect(await runStatus(loser)).toBe("approved");
      expect(await countOf("payslips", loser)).toBe(0);

      // Never collected twice; the balance is still computable (no throw).
      expect(await collectedTotal([earlier, winner, loser], emp)).toBe(X);
      const slips = (await slipsOf([earlier, winner, loser])) as unknown as {
        employeeId: string;
        calc: FullCalc;
      }[];
      expect(
        pph21ReceivableBalance(
          slips.filter((s) => s.employeeId === emp.id).map((s) => s.calc),
        ),
      ).toBe(0);
    }, 600_000);

  it("5a'. the loser, simulated again, locks and collects nothing more", async () => {
    const {
      emp,
      earlier,
      first: dec,
      second: jan,
    } = await twoCollectingRuns(monthDates(12, 2025), monthDates(1, 2026));
    await lockRun(dec);
    expect((await failureOf(lockRun(jan)))?.code).toBe(
      "PAYROLL_RUN_RESULT_STALE",
    );
    await asTenant((conn) => returnRunToDraft(conn, jan));
    await simulateRun(jan);
    await asTenant((conn) => approveSimulatedRun(conn, jan));
    await lockRun(jan);
    expect(await runStatus(jan)).toBe("locked");
    expect(await lockedWithCollection([earlier, dec, jan], emp)).toBe(1);
    expect(await collectedTotal([earlier, dec, jan], emp)).toBe(X);
  }, 600_000);

  it("5b. Mar 2026 locked, then Feb 2026 (both collecting X): Feb is refused 409, X collected once", async () => {
    const {
      emp,
      earlier,
      first: mar,
      second: feb,
    } = await twoCollectingRuns(monthDates(3, 2026), monthDates(2, 2026));
    await lockRun(mar);
    const refused = await failureOf(lockRun(feb));
    expect(refused, "Feb would collect X a second time").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(await runStatus(feb)).toBe("approved");
    expect(await collectedTotal([earlier, mar, feb], emp)).toBe(X);
  }, 600_000);

  it("5c. a receivable raised under entity A is not collected by a run of entity B", async () => {
    const worldA = await makeWorld();
    const worldB = await makeWorld();
    const emp = await makeEmployee(worldA);
    const earlier = await lockedRun(worldA, monthDates(6, 2025));
    expect(await seedOpenReceivable(earlier, emp)).toBe(X);
    await asTenant((conn) =>
      conn.query(
        `UPDATE employees SET legal_entity_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, emp.id, worldB.entityId],
      ),
    );

    const run = await draftRun(worldB, monthDates(11));
    await simulateRun(run);
    expect(await runStatus(run)).toBe("simulated");
    const mine = (await storedResults(run)).find(
      (r) => r.employeeId === emp.id,
    )!.calc;
    expect(
      collectionLines(mine),
      "entity B must not collect entity A's receivable",
    ).toHaveLength(0);

    await asTenant((conn) => approveSimulatedRun(conn, run));
    await lockRun(run);
    expect(await runStatus(run)).toBe("locked");
    const slips = (await slipsOf([earlier, run])) as unknown as {
      employeeId: string;
      calc: FullCalc;
    }[];
    expect(
      pph21ReceivableBalance(
        slips.filter((s) => s.employeeId === emp.id).map((s) => s.calc),
      ),
    ).toBe(X);
  }, 600_000);

  describe("5d. reversal of the run that raised the receivable", () => {
    let approverUserId: string;
    beforeAll(async () => {
      const approver = await signedInClient("Guards reversal approver");
      await grantRole(approver.userId, [
        "payroll.view",
        "payroll.cancel.approve",
      ]);
      approverUserId = approver.userId;
    });

    async function reverse(runId: string) {
      const {
        requestPayrollRunReversalInTransaction,
        decidePayrollRunReversalInTransaction,
      } = await import("../services/payroll-run-reversal.service.ts");
      const id = payrollRunIdSchema.parse(runId);
      await withTenant(db, tenantScope(), (tx) =>
        requestPayrollRunReversalInTransaction(
          tx,
          tenantScope(),
          exporterUserId,
          id,
          "Salah hitung, dibatalkan",
        ),
      );
      await withTenant(db, tenantScope(), (tx) =>
        decidePayrollRunReversalInTransaction(
          tx,
          tenantScope(),
          approverUserId,
          id,
          "approve",
        ),
      );
    }

    it("control: nobody collected the receivable, the run reverses", async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const earlier = await lockedRun(world, monthDates(6, 2025));
      expect(await seedOpenReceivable(earlier, emp)).toBe(X);
      await reverse(earlier);
      expect(await runStatus(earlier)).toBe("reversed");
    }, 600_000);

    it("a later run (other month, other year) collected X: the reversal is 409 PAYROLL_RUN_REVERSAL_BLOCKED and the run stays locked", async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const earlier = await lockedRun(world, monthDates(6, 2025));
      expect(await seedOpenReceivable(earlier, emp)).toBe(X);
      const later = await draftRun(world, monthDates(11));
      await simulateRun(later);
      await asTenant((conn) => approveSimulatedRun(conn, later));
      await lockRun(later);
      expect(await collectedTotal([later], emp)).toBe(X);

      const refused = await failureOf(reverse(earlier));
      expect(
        refused,
        "reversing would leave a collection without its receivable",
      ).not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
      expect(await runStatus(earlier)).toBe("locked");
    }, 600_000);
  });
});

// ---- 6. [receivable-no-backward-collection] ------------------------------------------
// CTO decision (brief 644, round 3): a run only collects a PPh 21 receivable
// raised by a run whose pay_date is <= its own pay_date (equal is allowed).
// The rest stays open for later runs. Assumptions:
//  - X = 50.000, raised on a locked run's payslip via seedOpenReceivable.
//  - "Feb off-cycle" is a regular run with a February period and pay date;
//    the fixture has no separate off-cycle run type.
//  - Case 3 cannot be reached by simulate once the rule exists (Feb never
//    sees a receivable raised by a later-paid run), so the fixture moves the
//    raising run's pay_date to March after Feb was simulated: it is the same
//    state as "a Mar run raised X and Feb's stored result collects it".
describe("[receivable-no-backward-collection] a run never collects a receivable raised by a later-paid run", () => {
  const X = 50_000;
  type SlipCalc = { employeeId: string; calc: FullCalc };

  const slipsFor = async (runIds: readonly string[], emp: Emp) =>
    ((await slipsOf(runIds)) as unknown as SlipCalc[]).filter(
      (s) => s.employeeId === emp.id,
    );
  const myResult = async (runId: string, emp: Emp) =>
    (await storedResults(runId)).find((r) => r.employeeId === emp.id)!.calc;

  it("1. Mar raises X and is locked; Feb (pay date Feb) simulates with no collection and X stays open", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const mar = await lockedRun(world, monthDates(3, 2026));
    expect(await seedOpenReceivable(mar, emp)).toBe(X);

    const feb = await draftRun(world, monthDates(2, 2026));
    await simulateRun(feb);
    expect(await runStatus(feb)).toBe("simulated");
    expect(
      collectionLines(await myResult(feb, emp)),
      "Feb (paid before Mar) must not collect a receivable raised by Mar",
    ).toHaveLength(0);
    expect(
      pph21ReceivableBalance((await slipsFor([mar], emp)).map((s) => s.calc)),
      "X is still open on the Mar run",
    ).toBe(X);
  }, 600_000);

  it("2. Jan raises X, Mar collects it (locked); Feb then collects nothing (no double collection)", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await seedOpenReceivable(jan, emp)).toBe(X);
    const mar = await draftRun(world, monthDates(3, 2026));
    await simulateRun(mar);
    expect(collectedOf(await myResult(mar, emp)), "Mar collects X").toBe(X);
    await asTenant((conn) => approveSimulatedRun(conn, mar));
    await lockRun(mar);
    expect(await runStatus(mar)).toBe("locked");

    const feb = await draftRun(world, monthDates(2, 2026));
    await simulateRun(feb);
    expect(
      collectionLines(await myResult(feb, emp)),
      "X was already collected by Mar: Feb must not collect it again",
    ).toHaveLength(0);
    expect(
      pph21ReceivableBalance(
        (await slipsFor([jan, mar], emp)).map((s) => s.calc),
      ),
    ).toBe(0);
  }, 600_000);

  it("3. Feb collected X at simulate, but the run that raised X is paid after Feb: lock Feb is 409 PAYROLL_RUN_RESULT_STALE", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const raiser = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(raiser, emp)).toBe(X);
    const feb = await draftRun(world, monthDates(2, 2026));
    await simulateRun(feb);
    expect(collectedOf(await myResult(feb, emp)), "Feb collects X").toBe(X);
    await asTenant((conn) => approveSimulatedRun(conn, feb));

    // The raising run is now one paid in March 2026 (after Feb's pay date).
    await asTenant(
      (conn) =>
        conn.query(
          `UPDATE payroll_runs SET pay_date = $3 WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, raiser, "2026-03-28"],
        ),
      true,
    );

    const refused = await failureOf(lockRun(feb));
    expect(
      refused,
      "Feb would collect a receivable raised by a later-paid run",
    ).not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(feb)).toBe("approved");
    expect(await countOf("payslips", feb)).toBe(0);
  }, 600_000);

  it("4. control: Jan raises X, Feb (later pay date) collects it as usual; same pay date collects too", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await seedOpenReceivable(jan, emp)).toBe(X);
    const feb = await draftRun(world, monthDates(2, 2026));
    await simulateRun(feb);
    expect(collectedOf(await myResult(feb, emp))).toBe(X);
    await asTenant((conn) => approveSimulatedRun(conn, feb));
    await lockRun(feb);
    expect(await runStatus(feb)).toBe("locked");

    // Same pay date (2026-04-10): the raising run and the collecting run.
    const world2 = await makeWorld();
    const emp2 = await makeEmployee(world2);
    const sameDay = "2026-04-10";
    const raiser = await lockedRun(world2, {
      ...monthDates(3, 2026),
      payDate: sameDay,
    });
    expect(await seedOpenReceivable(raiser, emp2)).toBe(X);
    const collector = await draftRun(world2, {
      ...monthDates(4, 2026),
      payDate: sameDay,
    });
    await simulateRun(collector);
    expect(
      collectedOf(await myResult(collector, emp2)),
      "equal pay date may collect",
    ).toBe(X);
  }, 600_000);
});

// ---- 6. [thr-receivable-open] (bead legend-30dhj) ----------------------------------
//
// RULES UNDER TEST (founder rule "jangan sampai rugi": a THR run that also
// collects an open PPh 21 receivable never pays anyone more than the THR the
// rules give, and never collects more than is owed or more than the room)
//  6a. A THR run (one calendar month) simulates an employee with an open
//      receivable from an earlier locked payslip: one collection line equal to
//      planPph21ReceivableCollection({ openIdr, roomIdr }) where room is the
//      net THR of a control employee with the same THR and no receivable.
//      collected <= open, collected <= room, net >= 0, net + collected = room,
//      the control is untouched, the receivable above the room keeps the rest
//      open, and the lock seals exactly what simulate stored.
//  6b. The contract/component scheme mismatch is still refused (422
//      PAYROLL_TAX_SCHEME_MISMATCH, ids only) when the same employee has an
//      open receivable: nothing stored, run stays draft, receivable untouched.
// The exact rupiah values come from the control employee (the engine's own
// THR result) and the shared planner, not from numbers typed here.

describe("[thr-receivable-open] a THR run collects an open PPh 21 receivable", () => {
  for (const open of [50_000, 40_000_000]) {
    const label =
      open === 50_000
        ? "room covers it: collected in full, nothing stays open"
        : "receivable above the room: collects the room, net 0, rest stays open";
    it(`${label}; simulate = what the lock seals`, async () => {
      const world = await makeWorld();
      const emp = await makeEmployee(world);
      const control = await makeEmployee(world);
      const earlier = await lockedRun(world, monthDates(6, 2025));
      expect(await seedOpenReceivable(earlier, emp, open)).toBe(open);

      const run = await draftRun(world, monthDates(11), "thr");
      const simulated = await simulateRun(run);
      expect(simulated.status).toBe("simulated");
      const results = await storedResults(run);
      expect(results).toHaveLength(2);
      const mine = results.find((r) => r.employeeId === emp.id)!.calc;
      const other = results.find((r) => r.employeeId === control.id)!.calc;

      // Same THR for both; the control owes nothing, so his net is the room.
      const thrOf = (calc: FullCalc) =>
        calc.lines
          .filter((l) => l.category === "thr")
          .reduce((total, l) => total + l.amountIdr, 0);
      expect(thrOf(mine)).toBeGreaterThan(0);
      expect(thrOf(mine)).toBe(thrOf(other));
      expect(collectionLines(other)).toHaveLength(0);
      const room = other.netIdr;
      expect(room).toBeGreaterThan(0);
      expect(room).toBeLessThan(thrOf(other));
      // A THR run pays only THR: gross equals the THR lines (no salary on top).
      expect(other.grossIdr).toBe(thrOf(other));
      expect(mine.grossIdr).toBe(thrOf(mine));
      // The case label is true: the small receivable fits the room, the big
      // one does not.
      expect(open <= room).toBe(open === 50_000);

      const plan = planPph21ReceivableCollection({
        openIdr: open,
        roomIdr: room,
      });
      expect(collectionLines(mine)).toHaveLength(1);
      expect(collectedOf(mine)).toBe(plan.collectedIdr);
      // Money invariants: never more than owed, never more than the room,
      // never a negative net, never paid more than the control (no one is
      // paid more than the THR rules give).
      expect(collectedOf(mine)).toBeLessThanOrEqual(open);
      expect(collectedOf(mine)).toBeLessThanOrEqual(room);
      expect(mine.netIdr).toBeGreaterThanOrEqual(0);
      expect(mine.netIdr).toBe(room - collectedOf(mine));
      expect(mine.netIdr).toBeLessThanOrEqual(other.netIdr);
      if (open <= room) {
        expect(collectedOf(mine)).toBe(open);
        expect(plan.openAfterIdr).toBe(0);
      } else {
        expect(collectedOf(mine)).toBe(room);
        expect(mine.netIdr).toBe(0);
        expect(plan.openAfterIdr).toBe(open - room);
        expect(plan.openAfterIdr).toBeGreaterThan(0);
      }
      // Run totals follow the results: what is paid out + what is collected
      // = what the two THR slips are worth after tax, nothing more.
      expect(Number(simulated.totals?.netIdr)).toBe(mine.netIdr + other.netIdr);
      expect(Number(simulated.totals?.netIdr) + collectedOf(mine)).toBe(
        2 * room,
      );

      // The lock seals exactly the simulated numbers; the balance after the
      // lock is open - collected (never negative, never collected twice).
      await asTenant((conn) => approveSimulatedRun(conn, run));
      await lockRun(run);
      expect(await runStatus(run)).toBe("locked");
      const slips = (await slipsOf([earlier, run])) as unknown as {
        runId: string;
        employeeId: string;
        calc: FullCalc;
      }[];
      const sealedMine = slips.find(
        (s) => s.runId === run && s.employeeId === emp.id,
      )!.calc;
      const sealedOther = slips.find(
        (s) => s.runId === run && s.employeeId === control.id,
      )!.calc;
      expect(collectedOf(sealedMine)).toBe(plan.collectedIdr);
      expect(sealedMine.netIdr).toBe(mine.netIdr);
      expect(sealedOther.netIdr).toBe(other.netIdr);
      expect(collectedOf(sealedOther)).toBe(0);
      expect(
        pph21ReceivableBalance(
          slips.filter((s) => s.employeeId === emp.id).map((s) => s.calc),
        ),
      ).toBe(plan.openAfterIdr);
    }, 600_000);
  }

  it("scheme mismatch is still refused with an open receivable: 422, ids only, nothing stored, run stays draft", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const control = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(earlier, emp, 50_000)).toBe(50_000);
    // From 2026 the contract is gross_up while the salary component stays
    // gross: the THR tax would be borne for the THR but not for the salary.
    await asTenant((conn) =>
      insertContract(conn, {
        tenantId: tenant.id,
        employeeId: emp.id,
        taxScheme: "gross_up",
        startDate: "2026-01-01",
      }),
    );

    const run = await draftRun(world, monthDates(11), "thr");
    const refused = await failureOf(simulateRun(run));
    expect(refused, "simulate must refuse the scheme mismatch").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_TAX_SCHEME_MISMATCH");
    expect((refused as unknown as Error).message).toContain(emp.id);
    expect((refused as unknown as Error).message).not.toContain(control.id);
    expect(await runStatus(run)).toBe("draft");
    expect(await countOf("payroll_run_results", run)).toBe(0);
    expect(await countOf("payslips", run)).toBe(0);
    // The receivable is untouched: nothing was collected.
    expect(
      pph21ReceivableBalance(
        (await slipsOf([earlier]))
          .filter((s) => s.employeeId === emp.id)
          .map((s) => s.calc as unknown as FullCalc),
      ),
    ).toBe(50_000);
  }, 600_000);
});

// ---- 7. [receivable-latest-balance-only] (legend-2fk79) -------------------------------
// The open-receivable loader used by simulate and lock must not decrypt every
// earlier payslip of every year: only the latest balance per employee. The
// RESULT stays identical (same collection, same fail-closed behavior, which
// the [receivable-open] tests above keep covering).
//
// Assumptions (the card says "latest balance per employee" without fixing how
// the balance is carried; no migration is allowed): the observable contract is
// the number of earlier payslip decrypts (the payroll decrypt function, spied
// above). Per employee at most ONE earlier payslip may be opened by simulate,
// and at most one by the lock re-check, and it must be the payslip of the most
// recent earlier locked run (Aug 2025). The fixture raises X on that latest
// payslip (seedOpenReceivable), so the stored history stays the oracle of the
// result; how the engineer carries the balance is free. If the engineer adds a
// carried-balance field that the tampering seed does not set, the fixture must
// be updated in the same card, not the assertions.
describe("[receivable-latest-balance-only] open receivable reads the latest balance per employee", () => {
  const X = 50_000;
  type SealContext = { table: string; rowId: string };

  /** Earlier-payslip decrypts since the last reset, per employee. */
  const opened = (slipOwner: ReadonlyMap<string, string>) => {
    const perEmployee = new Map<string, string[]>();
    for (const call of vi.mocked(openPayrollValue).mock.calls) {
      const context = call[1] as unknown as SealContext;
      const employeeId = slipOwner.get(context.rowId);
      if (context.table !== "payslips" || employeeId === undefined) continue;
      perEmployee.set(employeeId, [
        ...(perEmployee.get(employeeId) ?? []),
        context.rowId,
      ]);
    }
    return perEmployee;
  };

  it("three earlier runs, two employees: simulate and lock open at most the latest payslip of each, result identical", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const clean = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    const jul = await lockedRun(world, monthDates(7, 2025));
    const aug = await lockedRun(world, monthDates(8, 2025));
    expect(await seedOpenReceivable(aug, owes, X)).toBe(X);

    // Which payslip belongs to whom, and which is the latest (Aug) one.
    const slipRows = await asTenant(async (conn) =>
      (
        await conn.query(
          `SELECT id, payroll_run_id, employee_id FROM payslips
            WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
          [tenant.id, [jun, jul, aug]],
        )
      ).rows.map((row) => ({
        id: row.id as string,
        runId: row.payroll_run_id as string,
        employeeId: row.employee_id as string,
      })),
    );
    expect(slipRows).toHaveLength(6);
    const slipOwner = new Map(slipRows.map((row) => [row.id, row.employeeId]));
    const latestSlips = new Set(
      slipRows.filter((row) => row.runId === aug).map((row) => row.id),
    );

    const run = await draftRun(world, monthDates(11));
    vi.mocked(openPayrollValue).mockClear();
    const simulated = await simulateRun(run);
    expect(simulated.status).toBe("simulated");
    const simulateOpens = opened(slipOwner);
    for (const [employeeId, slipIds] of simulateOpens) {
      expect(
        slipIds.length,
        `simulate opens at most one earlier payslip of employee ${employeeId}`,
      ).toBeLessThanOrEqual(1);
      for (const id of slipIds)
        expect(
          latestSlips.has(id),
          "the payslip opened is the latest balance (Aug 2025)",
        ).toBe(true);
    }

    // Result identical to reading every payslip: X collected once, in full
    // (the room covers it), the clean employee untouched.
    const results = await storedResults(run);
    expect(results).toHaveLength(2);
    const mine = results.find((r) => r.employeeId === owes.id)!.calc;
    const other = results.find((r) => r.employeeId === clean.id)!.calc;
    expect(collectionLines(other)).toHaveLength(0);
    expect(collectionLines(mine)).toHaveLength(1);
    expect(collectedOf(mine)).toBe(X);
    expect(mine.netIdr).toBe(other.netIdr - X);

    await asTenant((conn) => approveSimulatedRun(conn, run));
    vi.mocked(openPayrollValue).mockClear();
    await lockRun(run);
    expect(await runStatus(run)).toBe("locked");
    for (const [employeeId, slipIds] of opened(slipOwner))
      expect(
        slipIds.length,
        `lock opens at most one earlier payslip of employee ${employeeId}`,
      ).toBeLessThanOrEqual(1);

    const slips = (await slipsOf([jun, jul, aug, run])) as unknown as {
      runId: string;
      employeeId: string;
      calc: FullCalc;
    }[];
    const sealedMine = slips.find(
      (s) => s.runId === run && s.employeeId === owes.id,
    )!.calc;
    expect(collectedOf(sealedMine)).toBe(X);
    expect(
      pph21ReceivableBalance(
        slips.filter((s) => s.employeeId === owes.id).map((s) => s.calc),
      ),
      "the receivable is paid off exactly once",
    ).toBe(0);
  }, 900_000);

  it("an open receivable above the room keeps flowing: latest balance only, rest stays open", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    const jul = await lockedRun(world, monthDates(7, 2025));
    const open = 40_000_000;
    expect(await seedOpenReceivable(jul, owes, open)).toBe(open);

    const run = await draftRun(world, monthDates(11));
    await simulateRun(run);
    const [result] = await storedResults(run);
    const plan = planPph21ReceivableCollection({
      openIdr: open,
      roomIdr: result!.calc.netIdr + collectedOf(result!.calc),
    });
    expect(collectedOf(result!.calc)).toBe(plan.collectedIdr);
    expect(result!.calc.netIdr).toBe(0);
    await asTenant((conn) => approveSimulatedRun(conn, run));
    await lockRun(run);
    const slips = (await slipsOf([jun, jul, run])) as unknown as {
      employeeId: string;
      calc: FullCalc;
    }[];
    expect(
      pph21ReceivableBalance(
        slips.filter((s) => s.employeeId === owes.id).map((s) => s.calc),
      ),
    ).toBe(open - plan.collectedIdr);
  }, 900_000);
});

// ---- 8. [receivable-open-after-field] (legend-2fk79) ----------------------------------
// New optional payslip field pph21ReceivableOpenAfterIdr: the receivable still
// open after that slip. The loader reads the latest slip per employee when the
// field is there, and falls back to reading the full history for slips without
// it (old slips, no migration). The RESULT must be identical either way.
//
// Assumptions (SPEC does not fix them, CTO brief 2 does):
//  - The field is carried by slips sealed from now on: after a lock, the new
//    slip carries the receivable still open for that employee (0 when fully
//    collected). Tests stamp or strip the field on earlier slips by rewriting
//    the sealed slip (replica role, fixture only), like seedOpenReceivable.
//  - "Journal" and "invoice (tagihan)" of the card are the sealed slip: the
//    collection line (category pph21_receivable), net, deductions, withheld
//    PPh 21 and the remaining balance. The payroll journal is built from the
//    sealed slip, so identical slips give identical journals.
//  - Field value for a seeded receivable r on the latest slip is r; earlier
//    slips carry 0 (nothing open after them).
describe("[receivable-open-after-field] same receivable with and without the open-balance field", () => {
  const X = 50_000;
  type Mode = "with" | "without";
  type Wide = FullCalc & {
    deductionsIdr: number;
    pph21Idr: number;
    tax: EngineTax & { pph21ReceivableIdr?: number };
  };
  type SlipCalc = { runId: string; employeeId: string; calc: Wide };

  const withField = (calc: FullCalc, value: number | null) => {
    const next = { ...(calc as unknown as Record<string, unknown>) };
    if (value === null) delete next[OPEN_AFTER_FIELD];
    else next[OPEN_AFTER_FIELD] = value;
    return next;
  };
  const stamp = (runId: string, emp: Emp, value: number | null) =>
    tamperEarlierSlip(runId, emp, (calc) => withField(calc, value));
  const openAfterOf = (calc: unknown) =>
    (calc as Record<string, unknown>)[OPEN_AFTER_FIELD];
  const slipsFor = async (runIds: readonly string[], emp: Emp) =>
    ((await slipsOf(runIds)) as unknown as SlipCalc[]).filter(
      (s) => s.employeeId === emp.id,
    );
  const myResult = async (runId: string, emp: Emp) =>
    (await storedResults(runId)).find((r) => r.employeeId === emp.id)!.calc;
  /** What a user sees and the journal is built from: no field, no ids. */
  const normalized = (calc: Wide) => ({
    net: calc.netIdr,
    deductions: calc.deductionsIdr,
    pph21: calc.pph21Idr,
    withheld: calc.tax.pph21WithheldIdr,
    receivableRaised: calc.tax.pph21ReceivableIdr ?? 0,
    lines: calc.lines.map((l) => [l.category, l.amountIdr]),
  });

  /**
   * Jun, Jul, Aug 2025 locked; `owed` raised on Aug for the first employee;
   * the history is stamped per `modes` (Jun, Jul, Aug); Nov 2026 is simulated,
   * approved and locked. Returns what the sealed Nov slip says.
   */
  async function scenario(modes: readonly [Mode, Mode, Mode], owed?: number) {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const clean = await makeEmployee(world);
    const history = [
      await lockedRun(world, monthDates(6, 2025)),
      await lockedRun(world, monthDates(7, 2025)),
      await lockedRun(world, monthDates(8, 2025)),
    ];
    const open = await seedOpenReceivable(history[2]!, owes, owed);
    for (const [i, runId] of history.entries()) {
      const mode = modes[i]!;
      await stamp(runId, owes, mode === "with" ? (i === 2 ? open : 0) : null);
      await stamp(runId, clean, mode === "with" ? 0 : null);
    }
    const run = await draftRun(world, monthDates(11));
    await simulateRun(run);
    expect(await runStatus(run)).toBe("simulated");
    const simulated = await myResult(run, owes);
    const otherSimulated = await myResult(run, clean);
    expect(collectionLines(otherSimulated)).toHaveLength(0);
    await asTenant((conn) => approveSimulatedRun(conn, run));
    await lockRun(run);
    expect(await runStatus(run)).toBe("locked");
    const sealed = (await slipsFor([run], owes))[0]!.calc;
    const balance = pph21ReceivableBalance(
      (await slipsFor([...history, run], owes)).map((s) => s.calc),
    );
    return {
      open,
      simulated: normalized(simulated as Wide),
      sealed: normalized(sealed),
      sealedOpenAfter: openAfterOf(sealed),
      balance,
      otherNet: otherSimulated.netIdr,
    };
  }

  it("slips with the field, without it, and a mix of old and new give the identical collection, slip and balance", async () => {
    const baseline = await scenario(["without", "without", "without"]);
    // Anchor: the baseline itself is the correct collection (full read).
    expect(baseline.open).toBe(X);
    const baselineLines = baseline.sealed.lines.filter(
      ([category]) => category === "pph21_receivable",
    );
    expect(baselineLines, "X is collected once").toEqual([
      ["pph21_receivable", X],
    ]);
    expect(baseline.sealed.net).toBe(baseline.otherNet - X);
    expect(baseline.balance, "paid off exactly once").toBe(0);

    const variants: [string, readonly [Mode, Mode, Mode]][] = [
      ["every slip has the field", ["with", "with", "with"]],
      [
        "old slip first, newer slips with the field",
        ["without", "with", "with"],
      ],
      [
        "latest slip is old (no field): full-read fallback",
        ["with", "with", "without"],
      ],
    ];
    for (const [label, modes] of variants) {
      const got = await scenario(modes);
      expect(got.simulated, `${label}: simulate result`).toEqual(
        baseline.simulated,
      );
      expect(got.sealed, `${label}: sealed slip`).toEqual(baseline.sealed);
      expect(got.balance, `${label}: balance`).toBe(baseline.balance);
    }
  }, 1_800_000);

  it("a receivable above the room: same partial collection with and without the field, rest stays open, never more than owed", async () => {
    const open = 40_000_000;
    const without = await scenario(["without", "without", "without"], open);
    const withIt = await scenario(["with", "with", "with"], open);
    const plan = planPph21ReceivableCollection({
      openIdr: open,
      roomIdr:
        without.simulated.net +
        without.simulated.lines
          .filter(([c]) => c === "pph21_receivable")
          .reduce((t, [, amount]) => t + Number(amount), 0),
    });
    expect(plan.collectedIdr).toBeGreaterThan(0);
    expect(plan.collectedIdr).toBeLessThan(open);
    expect(withIt.simulated).toEqual(without.simulated);
    expect(withIt.sealed).toEqual(without.sealed);
    expect(withIt.sealed.net, "net never below zero").toBe(0);
    expect(withIt.balance, "the rest stays open").toBe(
      open - plan.collectedIdr,
    );
    expect(without.balance).toBe(open - plan.collectedIdr);
    // The new slip carries the receivable still open after it, in both cases
    // (the field is written from now on, even over an old history).
    expect(withIt.sealedOpenAfter).toBe(open - plan.collectedIdr);
    expect(without.sealedOpenAfter).toBe(open - plan.collectedIdr);
  }, 1_800_000);

  it("the field written by one run feeds the next: two runs together collect exactly what was owed, no more", async () => {
    const open = 40_000_000;
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(jun, owes, open)).toBe(open);
    await stamp(jun, owes, null); // old slip without the field
    const history = [jun];
    let collectedTotal = 0;
    for (const month of [9, 10, 11]) {
      const run = await draftRun(world, monthDates(month, 2026));
      await simulateRun(run);
      const collected = collectedOf(await myResult(run, owes));
      expect(collected).toBeGreaterThanOrEqual(0);
      await asTenant((conn) => approveSimulatedRun(conn, run));
      await lockRun(run);
      history.push(run);
      collectedTotal += collected;
      const sealed = (await slipsFor([run], owes))[0]!.calc;
      expect(openAfterOf(sealed), `run month ${month}: field`).toBe(
        open - collectedTotal,
      );
      expect(
        pph21ReceivableBalance(
          (await slipsFor(history, owes)).map((s) => s.calc),
        ),
      ).toBe(open - collectedTotal);
      expect(
        collectedTotal,
        "never collects more than owed",
      ).toBeLessThanOrEqual(open);
    }
    expect(collectedTotal).toBeGreaterThan(0);
  }, 1_800_000);

  it("one run, two employees: one with the field, one with old slips only, both collect their own receivable", async () => {
    const world = await makeWorld();
    const fresh = await makeEmployee(world);
    const old = await makeEmployee(world);
    const jul = await lockedRun(world, monthDates(7, 2025));
    const aug = await lockedRun(world, monthDates(8, 2025));
    expect(await seedOpenReceivable(aug, fresh, X)).toBe(X);
    expect(await seedOpenReceivable(aug, old, 30_000_000)).toBe(30_000_000);
    await stamp(jul, fresh, 0);
    await stamp(aug, fresh, X);
    await stamp(jul, old, null);
    await stamp(aug, old, null);

    const run = await draftRun(world, monthDates(11));
    await simulateRun(run);
    const freshCalc = await myResult(run, fresh);
    const oldCalc = await myResult(run, old);
    expect(collectedOf(freshCalc)).toBe(X);
    const oldPlan = planPph21ReceivableCollection({
      openIdr: 30_000_000,
      roomIdr: oldCalc.netIdr + collectedOf(oldCalc),
    });
    expect(collectedOf(oldCalc)).toBe(oldPlan.collectedIdr);
    expect(collectedOf(oldCalc)).toBeLessThanOrEqual(30_000_000);
    await asTenant((conn) => approveSimulatedRun(conn, run));
    await lockRun(run);
    expect(await runStatus(run)).toBe("locked");
    const slips = (await slipsOf([jul, aug, run])) as unknown as SlipCalc[];
    const balanceOf = (emp: Emp) =>
      pph21ReceivableBalance(
        slips.filter((s) => s.employeeId === emp.id).map((s) => s.calc),
      );
    expect(balanceOf(fresh)).toBe(0);
    expect(balanceOf(old)).toBe(30_000_000 - oldPlan.collectedIdr);
  }, 1_800_000);

  for (const mode of ["with", "without"] as const) {
    describe(`no collection backward in time, history ${mode} the field`, () => {
      const stampAll = async (runId: string, emp: Emp, value: number) =>
        stamp(runId, emp, mode === "with" ? value : null);

      it("Mar raises X, Feb (pay date Feb) collects nothing and X stays open", async () => {
        const world = await makeWorld();
        const emp = await makeEmployee(world);
        const jan = await lockedRun(world, monthDates(1, 2026));
        const mar = await lockedRun(world, monthDates(3, 2026));
        expect(await seedOpenReceivable(mar, emp)).toBe(X);
        await stampAll(jan, emp, 0);
        await stampAll(mar, emp, X);
        const feb = await draftRun(world, monthDates(2, 2026));
        await simulateRun(feb);
        expect(
          collectionLines(await myResult(feb, emp)),
          "Feb is paid before Mar: no collection of X",
        ).toHaveLength(0);
        expect(
          pph21ReceivableBalance(
            (await slipsFor([jan, mar], emp)).map((s) => s.calc),
          ),
        ).toBe(X);
      }, 1_200_000);

      it("Jan raises X, Mar collects it; Feb collects nothing (no double collection)", async () => {
        const world = await makeWorld();
        const emp = await makeEmployee(world);
        const jan = await lockedRun(world, monthDates(1, 2026));
        expect(await seedOpenReceivable(jan, emp)).toBe(X);
        await stampAll(jan, emp, X);
        const mar = await draftRun(world, monthDates(3, 2026));
        await simulateRun(mar);
        expect(collectedOf(await myResult(mar, emp))).toBe(X);
        await asTenant((conn) => approveSimulatedRun(conn, mar));
        await lockRun(mar);
        const feb = await draftRun(world, monthDates(2, 2026));
        await simulateRun(feb);
        expect(collectionLines(await myResult(feb, emp))).toHaveLength(0);
        expect(
          pph21ReceivableBalance(
            (await slipsFor([jan, mar], emp)).map((s) => s.calc),
          ),
        ).toBe(0);
      }, 1_200_000);

      it("Feb collected X at simulate, then the raising run is paid after Feb: lock Feb is 409 PAYROLL_RUN_RESULT_STALE", async () => {
        const world = await makeWorld();
        const emp = await makeEmployee(world);
        const raiser = await lockedRun(world, monthDates(6, 2025));
        expect(await seedOpenReceivable(raiser, emp)).toBe(X);
        await stampAll(raiser, emp, X);
        const feb = await draftRun(world, monthDates(2, 2026));
        await simulateRun(feb);
        expect(collectedOf(await myResult(feb, emp))).toBe(X);
        await asTenant((conn) => approveSimulatedRun(conn, feb));
        await asTenant(
          (conn) =>
            conn.query(
              `UPDATE payroll_runs SET pay_date = $3 WHERE tenant_id = $1 AND id = $2`,
              [tenant.id, raiser, "2026-03-28"],
            ),
          true,
        );
        const refused = await failureOf(lockRun(feb));
        expect(refused).not.toBeNull();
        expect(refused!.status).toBe(409);
        expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
        expect(await runStatus(feb)).toBe("approved");
        expect(await countOf("payslips", feb)).toBe(0);
      }, 1_200_000);
    });
  }
});

// ---- 9. [lock-order] (legend-2fk79, brief 3 T3) -----------------------------------------
// The lock timestamp is the order the latest-balance fast path trusts. It is
// taken AFTER the receivable lock: lockedAt = max(now, max(locked_at of the
// OTHER runs of the SAME legal entity) + 1 ms), and the very same value is
// written to the run and to the payroll.locked event. A lock whose clock is
// behind (two locks almost at once, clocks apart) still sorts after the run
// that locked before it, so nobody reads a stale balance (double or missed
// collection). Reversal looks only at runs of the legal entity being reversed.
//
// Assumptions (brief 3 T3 fixes the formula, not the clock):
//  - "now" is the JS clock: the test moves `Date` (fake timers, Date only)
//    around ONE lockRun call and restores it. The DB clock is not moved.
//  - Exact values: now older/equal than the latest locked_at gives
//    latest + 1 ms; now later than it stays now (no needless push forward).
//  - Only the run row and the payroll.locked event carry lockedAt in a form
//    the test can read without implementation knowledge; the audit row is not
//    asserted (its table layout is not in the contract).
//  - The reversal case: entity B has its own receivable, collected by a run of
//    B locked AFTER the run of entity A being reversed. A's reversal must not
//    be blocked by B (nothing of A was collected). It may already pass today;
//    it guards the scoping of `others`.
describe("[lock-order] lockedAt sorts after the earlier locked runs of the same legal entity", () => {
  const lockedAtOf = async (runId: string) =>
    (
      await scalar(
        "SELECT locked_at FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
        [tenant.id, runId],
      )
    ).locked_at as Date;

  /** Locks `runId` while the JS clock reads `at`, then restores the real one. */
  async function lockRunAt(runId: string, at: Date) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    try {
      return await lockRun(runId);
    } finally {
      vi.useRealTimers();
    }
  }

  /** The lockedAt carried by the payroll.locked event of this run. */
  async function eventLockedAt(runId: string) {
    const rows = (
      await owner.query(
        `SELECT event::text AS text FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'payroll.locked'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    ).rows;
    expect(rows, "one payroll.locked event for the run").toHaveLength(1);
    const found = /"lockedAt":\s*"([^"]+)"/.exec(rows[0].text as string);
    expect(found, "the event carries lockedAt").not.toBeNull();
    return new Date(found![1]!);
  }

  it("a clock behind, equal or ahead of the earlier lock: later runs always sort after, the event carries the same value", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const jul = await approvedRun(world, monthDates(7, 2025));
    await lockRun(jul);
    const julAt = (await lockedAtOf(jul)).getTime();

    // Clock 1 ms behind the earlier lock.
    const aug = await approvedRun(world, monthDates(8, 2025));
    await lockRunAt(aug, new Date(julAt - 1));
    expect(await runStatus(aug)).toBe("locked");
    const augAt = (await lockedAtOf(aug)).getTime();
    expect(augAt, "behind: pushed to the earlier lock + 1 ms").toBe(julAt + 1);
    expect(
      (await eventLockedAt(aug)).getTime(),
      "event carries the stored lockedAt",
    ).toBe(augAt);

    // Clock exactly equal to the latest lock.
    const sep = await approvedRun(world, monthDates(9, 2025));
    await lockRunAt(sep, new Date(augAt));
    const sepAt = (await lockedAtOf(sep)).getTime();
    expect(sepAt, "equal: strictly after").toBe(augAt + 1);
    expect((await eventLockedAt(sep)).getTime()).toBe(sepAt);

    // Clock ahead: stays the clock, not pushed further.
    const oct = await approvedRun(world, monthDates(10, 2025));
    await lockRunAt(oct, new Date(sepAt + 60_000));
    expect(
      (await lockedAtOf(oct)).getTime(),
      "ahead: the clock value is kept",
    ).toBe(sepAt + 60_000);
  }, 1_200_000);

  it("a run of another legal entity does not push lockedAt", async () => {
    const worldA = await makeWorld();
    const worldB = await makeWorld();
    await makeEmployee(worldA);
    await makeEmployee(worldB);
    const a = await approvedRun(worldA, monthDates(7, 2025));
    const b = await approvedRun(worldB, monthDates(7, 2025));
    await lockRun(a);
    const aAt = (await lockedAtOf(a)).getTime();
    await lockRunAt(b, new Date(aAt - 5_000));
    expect(
      (await lockedAtOf(b)).getTime(),
      "entity B keeps its own clock, A is not its earlier lock",
    ).toBe(aAt - 5_000);
  }, 900_000);

  it("receivable: the second lock with a clock behind is refused 409, X collected exactly once, re-simulated it locks after the first and collects nothing", async () => {
    const X = 50_000;
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(earlier, emp)).toBe(X);
    const dec = await draftRun(world, monthDates(12, 2025));
    const jan = await draftRun(world, monthDates(1, 2026));
    await simulateRun(dec);
    await simulateRun(jan);
    for (const run of [dec, jan]) {
      expect(
        collectedOf(
          (await storedResults(run)).find((r) => r.employeeId === emp.id)!.calc,
        ),
        "simulate collects the open X",
      ).toBe(X);
      await asTenant((conn) => approveSimulatedRun(conn, run));
    }
    await lockRun(dec);
    const decAt = (await lockedAtOf(dec)).getTime();

    const refused = await failureOf(lockRunAt(jan, new Date(decAt - 1)));
    expect(refused, "jan would collect X again").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(jan)).toBe("approved");
    expect(await countOf("payslips", jan)).toBe(0);

    await asTenant((conn) => returnRunToDraft(conn, jan));
    await simulateRun(jan);
    await asTenant((conn) => approveSimulatedRun(conn, jan));
    await lockRunAt(jan, new Date(decAt - 1));
    expect(await runStatus(jan)).toBe("locked");
    expect(
      (await lockedAtOf(jan)).getTime(),
      "sorts after dec despite the clock behind",
    ).toBe(decAt + 1);

    const slips = (await slipsOf([earlier, dec, jan])) as unknown as {
      runId: string;
      employeeId: string;
      calc: FullCalc;
    }[];
    const mine = slips.filter((s) => s.employeeId === emp.id);
    expect(
      mine.filter((s) => s.runId !== earlier && collectedOf(s.calc) > 0),
      "only dec collected",
    ).toHaveLength(1);
    expect(
      mine.reduce((total, s) => total + collectedOf(s.calc), 0),
      "X collected exactly once",
    ).toBe(X);
    expect(pph21ReceivableBalance(mine.map((s) => s.calc))).toBe(0);
  }, 1_200_000);

  it("receivable, two locks at the same time: exactly one locks, the other is 409, X collected once", async () => {
    const X = 50_000;
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    expect(await seedOpenReceivable(earlier, emp)).toBe(X);
    const dec = await draftRun(world, monthDates(12, 2025));
    const jan = await draftRun(world, monthDates(1, 2026));
    await simulateRun(dec);
    await simulateRun(jan);
    for (const run of [dec, jan])
      await asTenant((conn) => approveSimulatedRun(conn, run));

    const outcomes = await Promise.all(
      [dec, jan].map((run) => failureOf(lockRun(run))),
    );
    const refused = outcomes.filter((o) => o !== null);
    expect(refused, "exactly one lock is refused").toHaveLength(1);
    expect(refused[0]!.status).toBe(409);
    expect(refused[0]!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    const statuses = [await runStatus(dec), await runStatus(jan)].sort();
    expect(statuses).toEqual(["approved", "locked"]);
    const slips = (await slipsOf([earlier, dec, jan])) as unknown as {
      employeeId: string;
      calc: FullCalc;
    }[];
    const mine = slips.filter((s) => s.employeeId === emp.id);
    expect(mine.reduce((total, s) => total + collectedOf(s.calc), 0)).toBe(X);
    expect(pph21ReceivableBalance(mine.map((s) => s.calc))).toBe(0);
  }, 1_200_000);

  describe("reversal looks only at its own legal entity", () => {
    let approverUserId: string;
    beforeAll(async () => {
      const approver = await signedInClient("Guards lock-order approver");
      await grantRole(approver.userId, [
        "payroll.view",
        "payroll.cancel.approve",
      ]);
      approverUserId = approver.userId;
    });

    it("entity B collects its own receivable after entity A locked: A's run still reverses", async () => {
      const X = 50_000;
      const worldA = await makeWorld();
      const worldB = await makeWorld();
      const empA = await makeEmployee(worldA);
      const empB = await makeEmployee(worldB);
      const runA = await lockedRun(worldA, monthDates(6, 2025));
      expect(await seedOpenReceivable(runA, empA)).toBe(X);
      const earlierB = await lockedRun(worldB, monthDates(6, 2025));
      expect(await seedOpenReceivable(earlierB, empB)).toBe(X);
      const laterB = await draftRun(worldB, monthDates(11));
      await simulateRun(laterB);
      await asTenant((conn) => approveSimulatedRun(conn, laterB));
      await lockRun(laterB);
      const collected = (
        (await slipsOf([laterB])) as unknown as {
          employeeId: string;
          calc: FullCalc;
        }[]
      ).filter((s) => s.employeeId === empB.id);
      expect(
        collected.reduce((total, s) => total + collectedOf(s.calc), 0),
        "B collected its own X after A locked",
      ).toBe(X);

      const {
        requestPayrollRunReversalInTransaction,
        decidePayrollRunReversalInTransaction,
      } = await import("../services/payroll-run-reversal.service.ts");
      const id = payrollRunIdSchema.parse(runA);
      await withTenant(db, tenantScope(), (tx) =>
        requestPayrollRunReversalInTransaction(
          tx,
          tenantScope(),
          exporterUserId,
          id,
          "Salah hitung, dibatalkan",
        ),
      );
      await withTenant(db, tenantScope(), (tx) =>
        decidePayrollRunReversalInTransaction(
          tx,
          tenantScope(),
          approverUserId,
          id,
          "approve",
        ),
      );
      expect(await runStatus(runA)).toBe("reversed");
    }, 1_200_000);
  });
});
