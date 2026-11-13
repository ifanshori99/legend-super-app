// Fail-closed guards of the simulate-then-lock payroll run (architect round,
// docs/briefs/sub-payroll-followups.md "Architect round (xhigh) fixes";
// design docs/briefs/sub-payroll-followups-design.md). Founder rule "jangan
// sampai rugi": a run is refused loudly instead of paying numbers that are
// wrong, and nobody is under-taxed. Fail-first: written before the fixes.
//
// RULES UNDER TEST
//  1. [receivable-open] simulate refuses a run when an employee still owes an
//     open PPh 21 receivable from earlier payslips (collecting it is follow-up
//     O2): 422 PAYROLL_RUN_SIMULATE_UNSUPPORTED, nothing stored, run stays
//     draft. A run of employees without a receivable simulates as before.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
  payrollRunIdSchema,
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
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
  returnRunToDraft,
} from "./payroll-simulate-kit.ts";

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

/**
 * Seeds an open PPh 21 receivable for the employee: tampers with the sealed
 * calculation of the employee's payslip in `runId` (replica role: the
 * immutability triggers are off for this test fixture only). Returns r.
 */
async function seedOpenReceivable(runId: string, emp: Emp): Promise<number> {
  return asTenant(async (conn) => {
    const row = (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows[0];
    const calc = openSlip(row);
    const withheld = calc.tax.pph21WithheldIdr;
    expect(withheld, "the seed slip withheld tax").toBeGreaterThan(0);
    const receivable = Math.min(50_000, withheld);
    const tampered = {
      ...calc,
      tax: {
        ...calc.tax,
        pph21WithheldIdr: withheld - receivable,
        pph21ReceivableIdr: receivable,
      },
    };
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

describe("[receivable-open] an open PPh 21 receivable blocks simulate", () => {
  it("422 PAYROLL_RUN_SIMULATE_UNSUPPORTED, nothing stored, run stays draft", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const earlier = await lockedRun(world, monthDates(6, 2025));
    const receivable = await seedOpenReceivable(earlier, emp);
    expect(receivable).toBeGreaterThan(0);

    const run = await draftRun(world, monthDates(11));
    const refused = await failureOf(simulateRun(run));
    expect(refused, "simulate must refuse an open receivable").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_RUN_SIMULATE_UNSUPPORTED");
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
