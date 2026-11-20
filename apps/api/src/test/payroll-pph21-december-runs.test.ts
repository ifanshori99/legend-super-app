// PPh 21 across TWO runs in the last tax period (December): a regular run A,
// then a THR run B in the same pay month (bead legend-q5dx4; design
// docs/briefs/sub-payroll-followups-design.md section 3 and section 7 cases
// 6-9, plus the round-2 additions: lebih potong refund inside the fold and the
// out-of-order lock). PRD PAYR-03 (annual recalculation in the last period),
// PAYR-02 (a locked run keeps what was approved), founder rule "jangan sampai
// rugi": the sum of PPh 21 withheld over the year must equal the annual tax on
// ALL income, to the rupiah, whatever the number of December runs.
//
// RULES UNDER TEST
//  6. [fold-pure] shared `buildPph21PriorWithLastPeriod` (no DB):
//     a. the year's sum of pph21Idr (TER months + A + B) equals the annual tax
//        of one engine call with A and B earnings merged, for the gross,
//        gross_up and net schemes (and for A, B, C in a chain, in any order of
//        the earlier annual slips);
//     b. an earlier annual slip with a lebih potong refund (negative pph21Idr,
//        employee refund or employer refund) folds without error, nothing goes
//        below 0, and the identity of (a) still holds;
//     c. refused with RangeError: a TER slip in `lastPeriodEarlier`, a stored
//        tax whose pph21Idr does not add up, and an annual slip among the
//        plain `periods` (an earlier-MONTH annual slip).
//  7. [december-two-runs] Jan-Nov locked TER runs, December regular A locked,
//     then THR B: B locks (it was 409 before) and the year's sum of pph21Idr
//     per employee equals the annual tax of one engine call on A + B merged,
//     for the gross, gross_up and net schemes. B records A as a same-month
//     prior (edge).
//  8. [december-concurrent] A and B approved, then locked at the same time: one
//     locks, the other gets 409 PAYROLL_PPH21_MONTH_STALE and nothing is
//     written for it. Return to draft, simulate again, lock: the invariant of 7
//     holds.
//  9. [december-reversal] reversing November after B locked is 409
//     PAYROLL_RUN_REVERSAL_BLOCKED (year edge), the run stays locked.
// 10. [out-of-order] Nov run approved, Dec A locked, then locking Nov is 409
//     PAYROLL_PPH21_LATER_PERIOD_LOCKED (fail closed), nothing written; a Nov
//     run drafted after Dec A is locked cannot be simulated and locked either.
//
// ASSUMPTIONS (design silent; stated so the engineer can contest them)
//  - Same world as payroll-run-simulate.test.ts: policy programmes [] (no BPJS,
//    so the employee deductible is 0), employees pkwtt TK/0 joined 2025-03-01
//    with a NPWP, default PPh 21 policy, reference tables (kit).
//  - The expected values are an ORACLE built from the engine itself
//    (`computePayslipTax` with the merged earnings of A and B and the prior of
//    the stored Jan-Nov slips); the design states the proof: year sum =
//    annualTaxIdr of that call. Earnings are the stored `grossIdr` of each
//    slip, all taxable, one tax scheme per employee (set on the employee's contract, which simulate
//    reads, and mirrored on the salary component).
//  - A THR run's gross is the employee's THR (>0) for a person employed over a
//    year; its amount is read from the stored payslip, never hard-coded.
//  - Lock of the loser in 8 is PAYROLL_PPH21_MONTH_STALE (design 2 step 6 and
//    3: "prior ids changed"). Which of A and B wins is not fixed.
//  - In 10 the guard also fires at simulate (design 3: loadTaxYearPriors
//    runs there too); the test accepts the 409 at either step for the second
//    case and requires it at LOCK for the first.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { idr } from "@starter/shared/core";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  buildPph21PriorWithLastPeriod,
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
  returnRunToDraft,
} from "./payroll-simulate-kit.ts";

type Scheme = "gross" | "gross_up" | "net";
const SCHEMES: readonly Scheme[] = ["gross", "gross_up", "net"];

// ======================================================================================
// 6. Pure fold (no database)
// ======================================================================================

type EngineTax = Pph21PriorPeriod["tax"];

const termMonth = (scheme: Scheme, amountIdr: number): Pph21PriorPeriod => {
  const { tax } = computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: false,
    monthsWorked: 12,
    earnings: [{ amountIdr, taxable: true, taxScheme: scheme }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: buildPph21Prior([]),
  });
  return { tax, employeeDeductibleIdr: 0 };
};

const lastPeriodSlip = (
  scheme: Scheme,
  amountIdr: number,
  prior: Parameters<typeof computePayslipTax>[0]["prior"],
  monthsWorked = 12,
) =>
  computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked,
    earnings: [{ amountIdr, taxable: true, taxScheme: scheme }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior,
  });

const sumPph21 = (taxes: readonly EngineTax[]) =>
  taxes.reduce((total, tax) => total + tax.pph21Idr, 0);

describe("[fold-pure] buildPph21PriorWithLastPeriod", () => {
  for (const scheme of SCHEMES) {
    it(`the year's PPh 21 over TER months + A + B + C equals the annual tax on all income (${scheme})`, () => {
      const months = Array.from({ length: 11 }, () =>
        termMonth(scheme, 15_000_000),
      );
      const terPrior = buildPph21Prior(months);
      const a = lastPeriodSlip(scheme, 15_000_000, terPrior);
      expect(a.tax.method).toBe("annual_recalculation");
      const aPeriod: Pph21PriorPeriod = {
        tax: a.tax,
        employeeDeductibleIdr: 0,
      };
      const b = lastPeriodSlip(
        scheme,
        12_000_000,
        buildPph21PriorWithLastPeriod(months, [aPeriod]),
      );
      const bPeriod: Pph21PriorPeriod = {
        tax: b.tax,
        employeeDeductibleIdr: 0,
      };
      const c = lastPeriodSlip(
        scheme,
        3_000_000,
        buildPph21PriorWithLastPeriod(months, [aPeriod, bPeriod]),
      );
      const merged = lastPeriodSlip(
        scheme,
        15_000_000 + 12_000_000 + 3_000_000,
        terPrior,
      );

      const year = sumPph21([...months.map((m) => m.tax), a.tax, b.tax, c.tax]);
      expect(year).toBe(merged.result.annual!.annualTaxIdr);
      // Two runs only: the same identity.
      const twoRuns = lastPeriodSlip(scheme, 15_000_000 + 12_000_000, terPrior);
      expect(sumPph21([...months.map((m) => m.tax), a.tax, b.tax])).toBe(
        twoRuns.result.annual!.annualTaxIdr,
      );
      // The order of the earlier annual slips does not change the prior.
      expect(buildPph21PriorWithLastPeriod(months, [bPeriod, aPeriod])).toEqual(
        buildPph21PriorWithLastPeriod(months, [aPeriod, bPeriod]),
      );
    });
  }

  it("a lebih potong refund in the earlier annual slip folds without error and the year still ends at the annual tax (employee refund, gross)", () => {
    // 15 jt x 5 months by TER, then the last period (June) pays only 1 jt:
    // the year's tax is below what TER withheld.
    const months = Array.from({ length: 5 }, () =>
      termMonth("gross", 15_000_000),
    );
    const terPrior = buildPph21Prior(months);
    const a = lastPeriodSlip("gross", 1_000_000, terPrior, 6);
    expect(a.tax.pph21Idr, "precondition: June is lebih potong").toBeLessThan(
      0,
    );
    expect(a.tax.pph21RefundIdr).toBeGreaterThan(0);
    const aPeriod: Pph21PriorPeriod = { tax: a.tax, employeeDeductibleIdr: 0 };

    const folded = buildPph21PriorWithLastPeriod(months, [aPeriod]);
    for (const value of Object.values(folded)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    const b = lastPeriodSlip("gross", 500_000, folded, 6);
    const merged = lastPeriodSlip("gross", 1_500_000, terPrior, 6);
    expect(sumPph21([...months.map((m) => m.tax), a.tax, b.tax])).toBe(
      merged.result.annual!.annualTaxIdr,
    );
  });

  it("a lebih potong refund in the earlier annual slip folds without error and the year still ends at the annual tax (employer refund, gross_up)", () => {
    // Gross-up 15 jt x 5 months, leaves in June with 1 jt: every rupiah the
    // company paid in tax allowance comes back to the company, not the employee.
    const months = Array.from({ length: 5 }, () =>
      termMonth("gross_up", 15_000_000),
    );
    const terPrior = buildPph21Prior(months);
    const a = lastPeriodSlip("gross_up", 1_000_000, terPrior, 6);
    expect(a.tax.pph21Idr, "precondition: June is lebih potong").toBeLessThan(
      0,
    );
    expect(a.tax.pph21EmployerRefundIdr).toBeGreaterThan(0);
    const aPeriod: Pph21PriorPeriod = { tax: a.tax, employeeDeductibleIdr: 0 };

    const folded = buildPph21PriorWithLastPeriod(months, [aPeriod]);
    for (const value of Object.values(folded)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(folded.taxAllowanceIdr).toBeLessThanOrEqual(folded.pph21WithheldIdr);
    const b = lastPeriodSlip("gross_up", 500_000, folded, 6);
    const annualB = b.result.annual!;
    // A already returned the old allowance, so B pays a new one on its 500k, and
    // that allowance is taxable income: the year ends at the annual tax on
    // everything actually paid (TER months + A + B, B's allowance included).
    expect(annualB.grossIdr).toBe(
      terPrior.taxableGrossIdr + a.tax.taxableGrossIdr + b.tax.taxableGrossIdr,
    );
    expect(sumPph21([...months.map((m) => m.tax), a.tax, b.tax])).toBe(
      annualB.annualTaxIdr,
    );
    const merged = lastPeriodSlip("gross_up", 1_500_000, terPrior, 6);
    expect(merged.tax.pph21EmployerRefundIdr).toBeGreaterThan(0);
    expect(annualB.grossIdr - merged.result.annual!.grossIdr).toBe(
      b.tax.taxableGrossIdr - 500_000,
    );
  });

  it("refuses with RangeError: a TER slip as an earlier last-period slip, a stored tax that does not add up, and an annual slip among the plain periods", () => {
    const months = Array.from({ length: 11 }, () =>
      termMonth("gross", 15_000_000),
    );
    const a = lastPeriodSlip("gross", 15_000_000, buildPph21Prior(months));
    const aPeriod: Pph21PriorPeriod = { tax: a.tax, employeeDeductibleIdr: 0 };

    // A TER slip is not an earlier annual slip of the last period.
    expect(() => buildPph21PriorWithLastPeriod(months, [months[0]!])).toThrow(
      RangeError,
    );

    // pph21Idr that does not equal withheld + borne + receivable - refunds.
    const tampered: Pph21PriorPeriod = {
      tax: { ...a.tax, pph21Idr: idr(a.tax.pph21Idr + 1) } as EngineTax,
      employeeDeductibleIdr: 0,
    };
    expect(() => buildPph21PriorWithLastPeriod(months, [tampered])).toThrow(
      RangeError,
    );

    // An earlier-MONTH annual slip (a leaver's last period in an earlier
    // month) must not be treated as a TER month.
    expect(() => buildPph21Prior([...months, aPeriod])).toThrow(RangeError);
  });
});

// ======================================================================================
// 7-10. Database: December across runs
// ======================================================================================

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

const key = () => `dec-runs-${randomUUID()}`;
const SALARY = 15_000_000;

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
        `December ${roleId.slice(0, 8)}`,
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
let approverUserId: string;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string; scheme: Scheme };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Desember ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
  return world;
}

/** An active pkwtt employee TK/0 with a NPWP and a bank account, paid by `scheme`. */
async function makeEmployee(world: World, scheme: Scheme): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), scheme };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: `Desember ${scheme} ${++counter}`,
      joinDate: "2025-03-01",
      ptkpStatus: "TK/0",
      // The employee's gross / gross_up / net comes from the contract
      // (simulate reads employment_contracts.tax_scheme), not the component.
      taxScheme: scheme,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      scheme,
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

/** Month `m` (1-12) of 2026, paid on the 28th unless `payDay` is given. */
const monthDates = (m: number, payDay = 28): RunDates => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  return {
    periodStart: `2026-${mm}-01`,
    periodEnd: `2026-${mm}-${last}`,
    payDate: `2026-${mm}-${String(payDay).padStart(2, "0")}`,
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

async function requestReversal(runId: string, actor: string) {
  const { requestPayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      actor,
      payrollRunIdSchema.parse(runId),
      "Salah hitung, dibatalkan (uji)",
    ),
  );
}

async function decideReversal(
  runId: string,
  actor: string,
  decision: "approve" | "reject",
) {
  const { decidePayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      actor,
      payrollRunIdSchema.parse(runId),
      decision,
    ),
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
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return runId;
}

async function lockedRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
) {
  const runId = await approvedRun(world, dates, runType);
  await lockRun(runId);
  expect(await runStatus(runId)).toBe("locked");
  return runId;
}

/** Locked TER runs for the given months of 2026, in order. */
async function lockHistory(world: World, months: readonly number[]) {
  const runIds: string[] = [];
  for (const m of months) runIds.push(await lockedRun(world, monthDates(m)));
  return runIds;
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

const payslipCount = async (runId: string) =>
  Number(
    (
      await scalar(
        "SELECT count(*)::int AS n FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      )
    ).n,
  );

const priorsOf = (runId: string) =>
  asTenant(async (conn) =>
    (
      await conn.query(
        "SELECT prior_payroll_run_id FROM payroll_run_month_priors WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      )
    ).rows.map((row) => row.prior_payroll_run_id as string),
  );

type Calc = { grossIdr: number; tax: EngineTax };
type Slip = { runId: string; employeeId: string; calc: Calc };

const slipsOf = (runIds: readonly string[]) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT id, payroll_run_id, employee_id, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, runIds],
      )
    ).rows;
    return rows.map((row): Slip => ({
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

/**
 * The invariant of the card: per employee, PPh 21 over the history runs and the
 * December runs equals the annual tax of ONE engine call on the merged December
 * earnings, with the history as prior.
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
  expect(december.length, `${emp.scheme}: one slip per December run`).toBe(
    decemberRunIds.length,
  );
  for (const slip of december) {
    expect(slip.calc.tax.method).toBe("annual_recalculation");
    expect(slip.calc.grossIdr).toBeGreaterThan(0);
  }
  const merged = computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    // The December taxable income as stored, taxed once under the gross scheme:
    // `taxableGrossIdr` already holds any gross-up allowance (re-grossing it
    // would tax the allowance twice) and leaves out a lebih potong refund paid
    // on the slip (in `grossIdr`, but not income). Each line's own scheme (a
    // THR run follows the employee's contract scheme: gross_up = borne by the
    // company; otherwise withheld) was applied when the slip was sealed; the annual tax depends only on the total.
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
  expect(year, `${emp.scheme}: year PPh 21 = annual tax on all income`).toBe(
    merged.result.annual!.annualTaxIdr,
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("December locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("December HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const decider = await signedInClient("December reversal approver");
  await grantRole(decider.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = decider.userId;
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'dec-runs-%'",
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

const DEC_A = monthDates(12, 25);
const DEC_B = monthDates(12, 28);

// ---- 7. [december-two-runs] --------------------------------------------------------

describe("[december-two-runs] regular run then THR run in December", () => {
  it("Jan-Nov TER runs, December regular A, then THR B: B locks and the year's PPh 21 equals the annual tax on all income, for gross, gross_up and net", async () => {
    const world = await makeWorld();
    const emps = await Promise.all(SCHEMES.map((s) => makeEmployee(world, s)));
    const history = await lockHistory(
      world,
      Array.from({ length: 11 }, (_, i) => i + 1),
    );

    const a = await lockedRun(world, DEC_A);
    const b = await lockedRun(world, DEC_B, "thr");

    expect(await payslipCount(a)).toBe(3);
    expect(await payslipCount(b)).toBe(3);
    // B was priced on top of A (same-month prior edge).
    expect(await priorsOf(b)).toContain(a);
    for (const emp of emps)
      await expectYearEqualsAnnualTax(emp, history, [a, b]);
  }, 600_000);
});

// ---- 8. [december-concurrent] ------------------------------------------------------

describe("[december-concurrent] two December runs locked at the same time", () => {
  it("one locks, the other is 409 PAYROLL_PPH21_MONTH_STALE with nothing written; re-simulate and lock keeps the year at the annual tax", async () => {
    const world = await makeWorld();
    const emps = await Promise.all(SCHEMES.map((s) => makeEmployee(world, s)));
    const history = await lockHistory(world, [10, 11]);

    // Both are simulated and approved before either locks: neither sees the other.
    const a = await approvedRun(world, DEC_A);
    const b = await approvedRun(world, DEC_B, "thr");

    const outcomes = await Promise.all([
      failureOf(lockRun(a)),
      failureOf(lockRun(b)),
    ]);
    const failed = outcomes.filter((o) => o !== null);
    expect(failed, "exactly one lock must lose").toHaveLength(1);
    expect(failed[0]!.status).toBe(409);
    expect(failed[0]!.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    const [winner, loser] = outcomes[0] === null ? [a, b] : [b, a];
    expect(await runStatus(winner)).toBe("locked");
    expect(await runStatus(loser)).toBe("approved");
    expect(await payslipCount(loser)).toBe(0);
    expect(await priorsOf(loser)).toEqual([]);

    // Return to draft, simulate on top of the winner, approve, lock.
    await asTenant((conn) => returnRunToDraft(conn, loser));
    await simulateRun(loser);
    await asTenant((conn) => approveSimulatedRun(conn, loser));
    await lockRun(loser);
    expect(await runStatus(loser)).toBe("locked");
    expect(await priorsOf(loser)).toContain(winner);
    for (const emp of emps)
      await expectYearEqualsAnnualTax(emp, history, [winner, loser]);
  }, 600_000);
});

// ---- 9. [december-reversal] --------------------------------------------------------

describe("[december-reversal] reversal after December runs locked", () => {
  it("reversing November is 409 PAYROLL_RUN_REVERSAL_BLOCKED after A and B locked; the run stays locked", async () => {
    const world = await makeWorld();
    await makeEmployee(world, "gross");
    const [, november] = await lockHistory(world, [10, 11]);
    await lockedRun(world, DEC_A);
    await lockedRun(world, DEC_B, "thr");

    const blocked = await failureOf(
      (async () => {
        await requestReversal(november!, exporterUserId);
        await decideReversal(november!, approverUserId, "approve");
      })(),
    );
    expect(blocked, "reversing November must be refused").not.toBeNull();
    expect(blocked!.status).toBe(409);
    expect(blocked!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
    expect(await runStatus(november!)).toBe("locked");
  }, 600_000);
});

// ---- 10. [out-of-order] ------------------------------------------------------------

describe("[out-of-order] an earlier month locked after December", () => {
  it("November approved, December A locked, then locking November is 409 PAYROLL_PPH21_LATER_PERIOD_LOCKED and nothing is written", async () => {
    const world = await makeWorld();
    await makeEmployee(world, "gross");
    await lockHistory(world, [10]);
    const november = await approvedRun(world, monthDates(11));
    await lockedRun(world, DEC_A);

    const refused = await failureOf(lockRun(november));
    expect(refused, "the out-of-order lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_LATER_PERIOD_LOCKED");
    expect(await runStatus(november)).toBe("approved");
    expect(await payslipCount(november)).toBe(0);
    expect(await priorsOf(november)).toEqual([]);
  }, 300_000);

  it("a November run drafted after December A is locked cannot be simulated and locked either (409 PAYROLL_PPH21_LATER_PERIOD_LOCKED)", async () => {
    const world = await makeWorld();
    await makeEmployee(world, "gross");
    await lockHistory(world, [10]);
    await lockedRun(world, DEC_A);

    const november = await draftRun(world, monthDates(11));
    const refused = await failureOf(
      (async () => {
        await simulateRun(november);
        await asTenant((conn) => approveSimulatedRun(conn, november));
        await lockRun(november);
      })(),
    );
    expect(refused, "November after December must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_LATER_PERIOD_LOCKED");
    expect(await runStatus(november)).not.toBe("locked");
    expect(await payslipCount(november)).toBe(0);
  }, 300_000);
});

// ---- 11. [leaver-1220] employees who leave (cutoff 25) -----------------------------

const setEndDate = (employeeId: string, endDate: string) =>
  asTenant(
    (conn) =>
      conn.query(
        "UPDATE employees SET end_date = $3 WHERE tenant_id = $1 AND id = $2",
        [tenant.id, employeeId, endDate],
      ),
    true,
  );

const resultEmployeeIds = async (runId: string) =>
  (
    await asTenant((conn) =>
      conn.query<{ employee_id: string }>(
        "SELECT employee_id FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      ),
    )
  ).rows.map((row) => row.employee_id);

/** The `payroll.run.former_employee_excluded` audit events of a run, as JSON text. */
const excludedAudit = async (runId: string) =>
  (
    await asTenant((conn) =>
      conn.query<{ event: string }>(
        `SELECT event::text AS event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'payroll.run.former_employee_excluded'`,
        [tenant.id, runId],
      ),
    )
  ).rows.map((row) => row.event);

describe("[leaver-1220] employee who leaves under a cutoff before month end", () => {
  it("cutoff 25, leaves 30 Nov: Nov run locks, then the Dec run locks (no 422)", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    const stayer = await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-11-30");

    const nov = await lockedRun(world, {
      periodStart: "2026-10-26",
      periodEnd: "2026-11-25",
      payDate: "2026-11-28",
    });
    const dec = await lockedRun(world, {
      periodStart: "2026-11-26",
      periodEnd: "2026-12-25",
      payDate: "2026-12-28",
    });
    expect((await resultEmployeeIds(nov)).sort()).toEqual(
      [leaver.id, stayer.id].sort(),
    );
    expect(await payslipCount(dec)).toBe(2);
  }, 600_000);

  it("THR in March, leaves 28 March: the regular March run, the THR run and the April run all lock (no 422)", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-03-28");

    const march = await lockedRun(world, {
      periodStart: "2026-02-26",
      periodEnd: "2026-03-25",
      payDate: "2026-03-28",
    });
    const thr = await lockedRun(
      world,
      monthDates(3, 28), // period 1-31 March holds the end date
      "thr",
    );
    const april = await lockedRun(world, {
      periodStart: "2026-03-26",
      periodEnd: "2026-04-25",
      payDate: "2026-04-28",
    });
    expect(await resultEmployeeIds(thr)).toContain(leaver.id);
    expect(await payslipCount(march)).toBe(2);
    expect(await payslipCount(april)).toBe(2);
    // The April run holds the end date: it is the leaver's annual period.
    const aprilLeaver = (await slipsOf([april])).find(
      (slip) => slip.employeeId === leaver.id,
    );
    expect(aprilLeaver?.calc.tax.method).toBe("annual_recalculation");
  }, 600_000);

  it("a January run with someone who left 31 Dec: the others are still paid and the leaver is listed by name", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    const stayer = await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-12-31");

    const runId = await draftRun(world, {
      periodStart: "2026-12-26",
      periodEnd: "2027-01-25",
      payDate: "2027-01-28",
    });
    const simulated = await simulateRun(runId);

    expect(await resultEmployeeIds(runId)).toEqual([stayer.id]);
    expect(simulated.excludedFormerEmployees).toHaveLength(1);
    const listed = simulated.excludedFormerEmployees![0]!;
    expect(listed.employeeId).toBe(leaver.id);
    expect(listed.message).toContain("Desember gross");
    const audit = await excludedAudit(runId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain(leaver.id);
    expect(audit[0]).not.toContain("Desember gross");
  }, 300_000);

  it("no cutoff, leaves 28 March: the March run is annual, a THR paid 5 April leaves the leaver out and reports them (no TER on top)", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    const stayer = await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-03-28");

    const march = await lockedRun(world, monthDates(3, 28));
    const marchLeaver = (await slipsOf([march])).find(
      (slip) => slip.employeeId === leaver.id,
    );
    expect(marchLeaver?.calc.tax.method).toBe("annual_recalculation");

    const thr = await draftRun(
      world,
      {
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        payDate: "2026-04-05",
      },
      "thr",
    );
    const simulated = await simulateRun(thr);
    expect(await resultEmployeeIds(thr)).toEqual([stayer.id]);
    expect(simulated.excludedFormerEmployees?.map((e) => e.employeeId)).toEqual(
      [leaver.id],
    );
    expect(simulated.excludedFormerEmployees![0]!.message).toContain(
      "sudah dihitung tahunan",
    );
    const audit = await excludedAudit(thr);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain(leaver.id);
  }, 600_000);

  const THR_APRIL = {
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    payDate: "2026-04-05",
  };

  it("[r4 P1] March approved, THR (5 April) simulated with TER, then March locks annual: locking the THR is 409 PAYROLL_PPH21_MONTH_STALE", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-03-28");

    const march = await approvedRun(world, monthDates(3, 28));
    const thr = await approvedRun(world, THR_APRIL, "thr");
    await lockRun(march);
    const refused = await failureOf(lockRun(thr));
    expect(refused, "the THR lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    expect(await payslipCount(thr)).toBe(0);
  }, 600_000);

  it("[r4 P2] THR (5 April) locked with TER first: locking the leaver's annual March run is 409 PAYROLL_PPH21_LATER_PERIOD_LOCKED", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-03-28");

    const march = await approvedRun(world, monthDates(3, 28));
    await lockedRun(world, THR_APRIL, "thr");
    const refused = await failureOf(lockRun(march));
    expect(refused, "the March lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_LATER_PERIOD_LOCKED");
    expect(await payslipCount(march)).toBe(0);
  }, 600_000);

  it("[r4 P3] December THR for a leaver with an annual November slip: the leaver is left out and reported, the others are paid", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    const stayer = await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-11-28");

    await lockedRun(world, monthDates(11, 28));
    const thr = await draftRun(
      world,
      {
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
        payDate: "2026-12-05",
      },
      "thr",
    );
    const simulated = await simulateRun(thr);
    expect(await resultEmployeeIds(thr)).toEqual([stayer.id]);
    expect(simulated.excludedFormerEmployees?.map((e) => e.employeeId)).toEqual(
      [leaver.id],
    );
  }, 600_000);

  it("[r4 P4] a THR where everyone is left out is PAYROLL_RUN_EMPTY naming the leaver", async () => {
    const world = await makeWorld();
    const leaver = await makeEmployee(world, "gross");
    await setEndDate(leaver.id, "2026-03-28");

    await lockedRun(world, monthDates(3, 28));
    const thr = await draftRun(world, THR_APRIL, "thr");
    const refused = await failureOf(simulateRun(thr));
    expect(refused).not.toBeNull();
    expect(refused!.code).toBe("PAYROLL_RUN_EMPTY");
    expect((refused as { message?: string }).message).toContain(
      "sudah dihitung tahunan",
    );
  }, 600_000);
});
