// Payroll run LOCK step + reversal (beads legend-b9y4y; design
// docs/briefs/sub-payroll-run-lock-design.md sections 3.2, 4 and 6 tests 1-3;
// PRD PAYR-01..PAYR-05; founder rule "jangan sampai rugi": no month under- or
// double-withheld, no money to a wrong account, no reversal that breaks a later
// run's tax). Fail-first: written before the implementation.
//
// RULES UNDER TEST (service API of the design, not of any implementation)
//  1. [lock-atomic] `lockPayrollRunInTransaction` writes status `locked`,
//     payslips (with the monthly PPh 21), month-dependency edges and the payee
//     bank snapshot in ONE transaction.
//     (a) a bank_transfer payee with net > 0 and no bank account:
//         422 PAYROLL_BANK_ACCOUNT_MISSING, nothing persisted (run stays
//         `approved`, 0 payslips, 0 snapshots, 0 edges, 0 payroll.locked events);
//     (b) a wrong approved month basis: 409 PAYROLL_PPH21_MONTH_STALE, nothing
//         persisted;
//     (c) happy path: status `locked`, the sealed slip's tax equals the
//         recomputed one, snapshot count = bank_transfer slips with net > 0
//         (a cash slip is excluded).
//  2. [lock-parallel-month] two runs (regular 8.000.020, THR 5.000.310) of one
//     legal entity + month locked concurrently: exactly one is fulfilled, the
//     other is 409 PAYROLL_PPH21_MONTH_STALE; after SQL re-approval with a fresh
//     simulation the loser locks; PPh 21 of both slips = 650.017 (half up) and
//     the loser has exactly one edge, to the winner.
//  3. [reversal-blocked] reversing the earlier run is refused 409
//     PAYROLL_RUN_REVERSAL_BLOCKED while the later run depends on it; a direct
//     SQL update to `reversed` fails with SQLSTATE 23514; deciding as the
//     requester is 403 PAYROLL_APPROVER_NOT_DISTINCT; reversing the later run
//     first, then the earlier one, works.
//
// WORKED NUMBERS (TK/0, NPWP, TER; from payroll-ter-monthly.test.ts, computed by
// hand from PP 58/2023 Lampiran A): salary 8.000.020 alone = 150 bp -> 120.000;
// THR 5.000.310 alone = 0 bp -> 0; month total 13.000.330 = 500 bp ->
// round(650.016,5) = 650.017 half up. Whoever locks second withholds the
// difference to 650.017.
//
// ASSUMPTIONS (design silent; stated so the engineer can contest them)
//  - Run approvers/creator are uuids (payrollRunSchema needs userIdSchema).
//  - Calculations are built from the engine's own simulated tax (the lock
//    re-proves tax equality), with lines GAJI + one PPH21 deduction line; the
//    run's totals are `sumPayrollRunTotals` of those calculations.
//  - The pinned statutory versions (ptkp, pph21_ter, pph21_annual) are published
//    rows of the test tenant (design 3.2 step 8).
//  - The payroll.locked event is counted in `domain_event_outbox` by event name
//    and the run id appearing in the event JSON.
//  - Reversal request permission: payroll.lock; decide: payroll.cancel.approve.
//  - The request step may or may not fast-fail with REVERSAL_BLOCKED (design 4);
//    the test accepts the 409 from either request or decide.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema, idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payrollConfigSnapshotSchema,
  payrollRunIdSchema,
  payslipCalculationSchema,
  payslipTaxSchema,
  sumPayrollRunTotals,
  type PayslipCalculation,
  type PayslipTax,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { StorageRequest } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  calculatePayrollRunTax,
  type PayrollRunMonthScope,
  type PayrollRunTaxEmployee,
  type PayrollRunTaxRun,
} from "../services/payroll-run-pph21.service.ts";
import type { PayrollRunLockEmployee } from "../services/payroll-run-lock.service.ts";
import {
  REFERENCE_PPH21_ANNUAL,
  REFERENCE_PTKP,
  REFERENCE_TABLES,
  REFERENCE_TER,
} from "./fixtures/payroll/statutory-tables.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

// ---- App, storage, DB pool -------------------------------------------------

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
class RecordingStorage extends FakeObjectStorage {
  puts: StorageRequest[] = [];
  override async put(context: ScopedTenantContext, input: StorageRequest) {
    this.puts.push(input);
    return super.put(context, input);
  }
}
const storage = new RecordingStorage();
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime: {
    storage,
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
const createdWorlds: World[] = [];

const key = () => `ter-monthly-${randomUUID()}`;
const EXPORT_PATH = "/api/hris/payroll/tax-exports";

const tenantScope = () =>
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
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId, email };
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
        `TER monthly ${roleId.slice(0, 8)}`,
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
let exporter: Client;
let hr: Client;
let orgAdmin: Client;
let exporterUserId: string;

// ---- Fixtures: worlds, employees, runs --------------------------------------

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string; name: string; nik: string; npwp: string };

/** A legal entity (NPWP through the org API) plus a payroll policy. */
async function makeWorld(): Promise<World> {
  const created = await orgAdmin
    .post("/api/org/legal-entities")
    .set(originHeader)
    .send({
      name: `PT TER Monthly ${++counter}`,
      npwp: digits(16),
      isPkp: false,
      address: "Kota Bandung",
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const entityId = created.body.data.id as string;
  const policyId = randomUUID();
  await asTenant(async (conn) => {
    const code = `TM${policyId.slice(0, 8)}`;
    await conn.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan TER bulanan', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenant.id, entityId, code, JSON.stringify({ code })],
    );
  });
  const world = { entityId, policyId };
  createdWorlds.push(world);
  return world;
}

async function makeEmployee(world: World, withBank = true): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: `TER Person ${++counter}`,
    nik: digits(16),
    npwp: digits(15),
  };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        emp.id,
        tenant.id,
        `TM-${emp.id.slice(0, 8).toUpperCase()}`,
        emp.name,
        outlet.id,
        world.entityId,
      ],
    );
  });
  // No PII row at all = no bank account on file (snapshot cannot be frozen).
  if (!withBank) return emp;
  const put = await hr
    .put(`/api/hris/employees/${emp.id}/pii`)
    .set(originHeader)
    .send({
      nik: emp.nik,
      npwp: emp.npwp,
      bankAccount: digits(12),
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return emp;
}

// ---- Fixtures: pinned statutory tables, runs, approvals --------------------------

const date = (value: string) => businessDateSchema.parse(value);

// Pinned tables (PAYR-02): ptkp, pph21_ter, pph21_annual. Own ids/versions; the
// effective date is old so that no other file's version starts on it.
const PINNED = [
  { type: "ptkp", id: randomUUID(), version: 9301, params: REFERENCE_PTKP },
  { type: "pph21_ter", id: randomUUID(), version: 9302, params: REFERENCE_TER },
  {
    type: "pph21_annual",
    id: randomUUID(),
    version: 9303,
    params: REFERENCE_PPH21_ANNUAL,
  },
] as const;
const PINNED_FROM = "2002-01-01";

async function ensureStatutoryTables() {
  await asTenant(async (conn) => {
    for (const row of PINNED) {
      await conn.query(
        `INSERT INTO statutory_rates
           (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', 'PP 58/2023 (test)', $6::jsonb, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          tenant.id,
          row.type,
          row.version,
          PINNED_FROM,
          JSON.stringify(row.params),
          exporterUserId,
        ],
      );
      await conn.query(
        `UPDATE statutory_rates
            SET status = 'published', published_at = now(), published_by = $2
          WHERE id = $1 AND status = 'draft'`,
        [row.id, exporterUserId],
      );
    }
  });
}

function snapshotFor(world: World) {
  return payrollConfigSnapshotSchema.parse({
    statutoryVersions: PINNED.map((row) => ({
      type: row.type,
      versionId: row.id,
      version: row.version,
      effectiveFrom: PINNED_FROM,
    })),
    policy: {
      id: world.policyId,
      cycle: {
        frequency: "monthly",
        cutoffDay: null,
        payDay: null,
        payMonthOffset: 0,
      },
      payDateAdjustment: "none",
      jkkRiskClass: "low",
      bpjsProgrammes: [],
    },
    components: [
      {
        id: randomUUID(),
        code: "GAJI",
        category: "base_salary",
        taxable: true,
        taxScheme: "gross",
        bpjsBase: true,
        overtimeBase: true,
        thrBase: true,
      },
    ],
    loanMaxDeductionOfNetPayBp: 0,
    pph21Policy: null,
    capturedAt: "2026-11-01T00:00:00.000Z",
  });
}

// Run approvers and creator are uuids (payrollRunSchema).
const CREATOR = randomUUID();
const HR_APPROVER = randomUUID();
const FINANCE_APPROVER = randomUUID();

type RunDates = { periodStart: string; periodEnd: string; payDate: string };
const NOV = (pay: number): RunDates => ({
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: `2026-11-${String(pay).padStart(2, "0")}`,
});
const EARLIER_PAY = 15;
const THR_PAY = 28;

/** Run row born a draft (the DB only allows that). */
async function seedDraftRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant(async (conn) => {
    // payroll_runs_thr_schedule_check: a THR run needs a THR schedule.
    let thrScheduleId: string | null = null;
    if (runType === "thr") {
      thrScheduleId = randomUUID();
      createdThrSchedules.push(thrScheduleId);
      await conn.query(
        `INSERT INTO thr_schedules (id, tenant_id, legal_entity_id, name, holiday_name,
                                    holiday_date, tenure_as_of_date, pay_date, created_by)
         VALUES ($1, $2, $3, 'THR uji kunci payroll', 'Hari raya uji', $4, $4, $4, 'run-lock-test')`,
        [thrScheduleId, tenant.id, world.entityId, dates.payDate],
      );
    }
    await conn.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, thr_schedule_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId,
        tenant.id,
        world.entityId,
        world.policyId,
        runType,
        dates.periodStart,
        dates.periodEnd,
        dates.payDate,
        thrScheduleId,
        CREATOR,
      ],
    );
  });
  return runId;
}

/** draft -> simulated (totals + snapshot) -> hr_approved -> approved. */
async function approveRun(
  world: World,
  runId: string,
  calcs: PayslipCalculation[],
) {
  await ensureStatutoryTables();
  await asTenant(async (conn) => {
    await conn.query(
      `UPDATE payroll_runs SET status = 'simulated', simulation_count = 1,
              last_simulated_at = now(), totals = $2::jsonb, config_snapshot = $3::jsonb
        WHERE id = $1`,
      [
        runId,
        JSON.stringify(sumPayrollRunTotals(calcs)),
        JSON.stringify(snapshotFor(world)),
      ],
    );
    await conn.query(
      `UPDATE payroll_runs SET status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()
        WHERE id = $1`,
      [runId, HR_APPROVER],
    );
    await conn.query(
      `UPDATE payroll_runs SET status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()
        WHERE id = $1`,
      [runId, FINANCE_APPROVER],
    );
  });
}

/** approved -> draft (return_to_draft), the way the reducer clears the run. */
const returnToDraft = (runId: string) =>
  asTenant((conn) =>
    conn.query(
      `UPDATE payroll_runs SET status = 'draft', simulation_count = 0, last_simulated_at = NULL,
              totals = NULL, config_snapshot = NULL, approved_by_hr = NULL,
              approved_by_hr_at = NULL, approved_by_finance = NULL,
              approved_by_finance_at = NULL
        WHERE id = $1`,
      [runId],
    ),
  );

// ---- Tax engine adapters (the engine's real signatures, as in ter-monthly) -----------

type Facts = { run: PayrollRunTaxRun; monthScope: PayrollRunMonthScope };

function runFacts(runId: string, payDate: string): Facts {
  return {
    run: { status: "approved", payDate: date(payDate), configSnapshot: null },
    monthScope: { runId: runId as PayrollRunMonthScope["runId"] },
  };
}

const earner = (emp: Emp, gross: number): PayrollRunTaxEmployee => ({
  employeeId: emp.id,
  ptkpStatus: "TK/0",
  hasTaxId: true,
  earnings: [{ amountIdr: idr(gross), taxable: true, taxScheme: "gross" }],
  employerBenefitIdr: idr(0),
  employeeDeductibleIdr: idr(0),
  lastTaxPeriod: false,
  monthsWorked: 11,
  priorPeriods: [],
});

/** One employee of a run to be locked. */
type Planned = {
  emp: Emp;
  gross: number;
  method: "bank_transfer" | "cash";
};

function calculationOf(p: Planned, tax: PayslipTax, dates: RunDates) {
  const withheld = Number(tax.pph21WithheldIdr);
  const lines: Record<string, unknown>[] = [
    {
      componentCode: "GAJI",
      name: "Gaji pokok",
      category: "base_salary",
      kind: "earning",
      amountIdr: p.gross,
      taxable: true,
      quantity: null,
      sourceId: null,
    },
  ];
  if (withheld > 0)
    lines.push({
      componentCode: "PPH21",
      name: "PPh 21",
      category: "pph21",
      kind: "deduction",
      amountIdr: withheld,
      taxable: false,
      quantity: null,
      sourceId: null,
    });
  return payslipCalculationSchema.parse({
    employeeId: p.emp.id,
    employeeNo: `RL-${p.emp.id.slice(0, 8).toUpperCase()}`,
    employeeName: p.emp.name,
    positionName: "Kasir",
    outletId: outlet.id,
    periodStart: dates.periodStart,
    periodEnd: dates.periodEnd,
    payDate: dates.payDate,
    grossIdr: p.gross,
    deductionsIdr: withheld,
    netIdr: p.gross - withheld,
    pph21Idr: Number(tax.pph21Idr),
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines,
    bpjs: [],
    tax,
    paymentMethod: p.method,
  });
}

type Sim = Awaited<ReturnType<typeof calculatePayrollRunTax>>;

/** The approved simulation of a run: what the lock step receives from its caller. */
async function simulate(
  runId: string,
  dates: RunDates,
  planned: Planned[],
): Promise<{
  employees: PayrollRunLockEmployee[];
  calcs: PayslipCalculation[];
  sim: Sim;
}> {
  const facts = runFacts(runId, dates.payDate);
  const taxEmployees = planned.map((p) => earner(p.emp, p.gross));
  const sim = await withTenant(db, tenantScope(), (tx) =>
    calculatePayrollRunTax(
      tenantScope(),
      {
        run: facts.run,
        tables: REFERENCE_TABLES,
        employees: taxEmployees,
        monthScope: facts.monthScope,
      },
      tx,
    ),
  );
  const calcs: PayslipCalculation[] = [];
  const employees: PayrollRunLockEmployee[] = planned.map((p, i) => {
    const simulated = sim.payslips.find((s) => s.employeeId === p.emp.id);
    expect(simulated, "the engine priced the employee").toBeDefined();
    const calculation = calculationOf(
      p,
      payslipTaxSchema.parse(simulated!.tax),
      dates,
    );
    calcs.push(calculation);
    const { employeeId: _employeeId, ...taxInput } = taxEmployees[i]!;
    return {
      calculation,
      taxInput,
      approvedMonthBasis: simulated!.monthBasis ?? null,
    };
  });
  return { employees, calcs, sim };
}

/** A run seeded as `approved` with a fresh simulation, ready to lock. */
async function approvedRun(
  world: World,
  dates: RunDates,
  planned: Planned[],
  runType: "regular" | "thr" = "regular",
) {
  const runId = await seedDraftRun(world, dates, runType);
  const simulated = await simulate(runId, dates, planned);
  await approveRun(world, runId, simulated.calcs);
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return { runId, ...simulated };
}

// ---- Service adapters (design 3.2 and 4) ----------------------------------------------

async function lockRun(
  runId: string,
  employees: readonly PayrollRunLockEmployee[],
) {
  const { lockPayrollRunInTransaction } = await import(
    "../services/payroll-run-lock.service.ts"
  );
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), exporterUserId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
      employees,
    }),
  );
}

async function requestReversal(runId: string, actor: string) {
  const { requestPayrollRunReversalInTransaction } = await import(
    "../services/payroll-run-reversal.service.ts"
  );
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
  const { decidePayrollRunReversalInTransaction } = await import(
    "../services/payroll-run-reversal.service.ts"
  );
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

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

// ---- DB readers ---------------------------------------------------------------------

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

const countOf = async (table: string, column: string, runId: string) =>
  Number(
    (
      await scalar(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${column} = $2`,
        [tenant.id, runId],
      )
    ).n,
  );
const payslipCount = (runId: string) =>
  countOf("payslips", "payroll_run_id", runId);
const snapshotCount = (runId: string) =>
  countOf("payslip_bank_snapshots", "payroll_run_id", runId);
const edgeCount = (runId: string) =>
  countOf("payroll_run_month_priors", "payroll_run_id", runId);

const lockedEventCount = async (runId: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'payroll.locked'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    ).rows[0].n,
  );

const priorsOf = async (runId: string) =>
  asTenant(
    async (conn) =>
      (
        await conn.query(
          "SELECT prior_payroll_run_id FROM payroll_run_month_priors WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenant.id, runId],
        )
      ).rows.map((row) => row.prior_payroll_run_id as string),
  );

/** The stored (decrypted) calculation of every payslip of the given runs. */
const storedSlips = (runIds: string[]) =>
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
      calculation: JSON.parse(
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
      ) as { pph21Idr: number; netIdr: number; tax: unknown },
    }));
  });

const reversalOf = async (runId: string) =>
  (
    await scalar(
      "SELECT reversal FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).reversal as { status: string } | null;

const halfUp = (gross: number, bp: number) =>
  Math.floor((gross * bp + 5_000) / 10_000);
const SALARY_GROSS = 8_000_020; // 150 bp, tax 120.000 alone
const THR_GROSS = 5_000_310; // alone 0 bp
const MONTH_TAX = halfUp(SALARY_GROSS + THR_GROSS, 500); // 650.017

// ---- Setup / teardown ------------------------------------------------------------

let approver: { userId: string }; // payroll.cancel.approve, not the requester

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("Run lock locker");
  await grantRole(lock.userId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    // The requester may also hold the decide permission: the reducer, not the
    // permission, must refuse the same person deciding (403 NOT_DISTINCT).
    "payroll.cancel.approve",
  ]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("Run lock HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const decider = await signedInClient("Run lock reversal approver");
  await grantRole(decider.userId, ["payroll.view", "payroll.cancel.approve"]);
  approver = { userId: decider.userId };

  const admin = agent(app);
  const email = await signUp(admin, "Run lock org admin");
  await setRole(email, "admin");
  const session = await admin.get("/api/auth/get-session");
  const adminId = session.body.user.id as string;
  createdUsers.push(adminId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, adminId],
  );
  await verifySessionMfa(email);
  orgAdmin = admin;
  // No tenant PPh 21 policy version: the default policy (half up) applies.
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  await asTenant(async (conn) => {
    const entities = createdWorlds.map((w) => w.entityId);
    // Raw (replica role): append-only tables reference payslips and runs. The
    // month-priors table does not exist before the implementation.
    for (const table of ["payroll_run_month_priors", "payslip_bank_snapshots"])
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
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM thr_schedules WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdThrSchedules],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdWorlds.map((w) => w.policyId),
    ]);
    await conn.query(
      "DELETE FROM statutory_rates WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, PINNED.map((row) => row.id)],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRoles],
    );
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      entities,
    ]);
  }, true);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- 1. [lock-atomic] -------------------------------------------------------------

describe("run lock writes monthly tax and bank snapshot in one transaction", () => {
  it("[lock-atomic-a] a bank_transfer payee with net > 0 and no bank account: 422 PAYROLL_BANK_ACCOUNT_MISSING and nothing persisted", async () => {
    const world = await makeWorld();
    const paid = await makeEmployee(world);
    const noBank = await makeEmployee(world, false);
    const { runId, employees } = await approvedRun(world, NOV(THR_PAY), [
      { emp: paid, gross: SALARY_GROSS, method: "bank_transfer" },
      { emp: noBank, gross: SALARY_GROSS, method: "bank_transfer" },
    ]);

    const refused = await failureOf(lockRun(runId, employees));
    expect(refused, "the lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_BANK_ACCOUNT_MISSING");

    // The tax part and the status ran before the snapshot in the transaction:
    // all of it rolled back.
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
    expect(await edgeCount(runId)).toBe(0);
    expect(await lockedEventCount(runId)).toBe(0);
  });

  it("[lock-atomic-b] a wrong approved month basis: 409 PAYROLL_PPH21_MONTH_STALE and nothing persisted", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const { runId, employees } = await approvedRun(world, NOV(THR_PAY), [
      { emp, gross: THR_GROSS, method: "bank_transfer" },
    ]);
    // The simulation claims a prior of 1.000 that the month does not hold.
    const wrong = employees.map((e) => ({
      ...e,
      approvedMonthBasis: {
        priorGrossIdr: idr(1_000),
        priorTaxIdr: idr(0),
        priorEmployeeTaxIdr: idr(0),
      },
    })) as PayrollRunLockEmployee[];

    const refused = await failureOf(lockRun(runId, wrong));
    expect(refused, "the stale lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
    expect(await edgeCount(runId)).toBe(0);
    expect(await lockedEventCount(runId)).toBe(0);
  });

  it("[lock-atomic-c] a good lock: status locked, sealed slip tax = recomputed tax, one snapshot per bank_transfer slip with net > 0 (cash excluded)", async () => {
    const world = await makeWorld();
    const bank = await makeEmployee(world);
    const cash = await makeEmployee(world);
    const { runId, employees, calcs } = await approvedRun(
      world,
      NOV(THR_PAY),
      [
        { emp: bank, gross: SALARY_GROSS, method: "bank_transfer" },
        { emp: cash, gross: 3_000_000, method: "cash" },
      ],
    );

    const result = await lockRun(runId, employees);
    expect(await runStatus(runId)).toBe("locked");
    expect(result.bankSnapshotCount).toBe(1);
    expect(result.payslips).toHaveLength(2);
    expect(await snapshotCount(runId)).toBe(1);
    expect(await payslipCount(runId)).toBe(2);
    expect(await lockedEventCount(runId)).toBe(1);

    const stored = await storedSlips([runId]);
    for (const calc of calcs) {
      const slip = stored.find((s) => s.employeeId === calc.employeeId);
      expect(slip, "a payslip exists for the employee").toBeDefined();
      // The sealed tax is the recomputed tax; nobody's net exceeds gross - tax.
      expect(isDeepStrictEqual(slip!.calculation.tax, calc.tax)).toBe(true);
      expect(slip!.calculation.netIdr).toBe(Number(calc.netIdr));
      const planned = result.payslips.find(
        (p) => p.employeeId === calc.employeeId,
      );
      expect(Number(planned!.netIdr)).toBe(Number(calc.netIdr));
    }
  });
});

// ---- 2. [lock-parallel-month] ------------------------------------------------------

describe("two parallel locks of runs in the same month", () => {
  it("[lock-parallel-month] one wins, the other is 409 PAYROLL_PPH21_MONTH_STALE; after re-approval the month withholds exactly round(TER(total) x rate)", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const salary = await approvedRun(world, NOV(EARLIER_PAY), [
      { emp, gross: SALARY_GROSS, method: "bank_transfer" },
    ]);
    const thr = await approvedRun(
      world,
      NOV(THR_PAY),
      [{ emp, gross: THR_GROSS, method: "bank_transfer" }],
      "thr",
    );

    // Both were approved against an empty month (zero basis).
    const [a, b] = await Promise.allSettled([
      lockRun(salary.runId, salary.employees),
      lockRun(thr.runId, thr.employees),
    ]);
    const settled = [
      { name: "salary", result: a, run: salary },
      { name: "thr", result: b, run: thr },
    ];
    const winners = settled.filter((s) => s.result.status === "fulfilled");
    const losers = settled.filter((s) => s.result.status === "rejected");
    expect(winners, "exactly one lock succeeds").toHaveLength(1);
    expect(losers, "exactly one lock is refused").toHaveLength(1);
    const winner = winners[0]!;
    const loser = losers[0]!;
    const failure = (loser.result as PromiseRejectedResult)
      .reason as Failure;
    expect(failure.status).toBe(409);
    expect(failure.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    expect(await runStatus(loser.run.runId)).toBe("approved");
    expect(await payslipCount(loser.run.runId)).toBe(0);

    // The loser is re-simulated against the winner's payslip, re-approved
    // through SQL (return_to_draft -> simulated -> hr_approved -> approved).
    const dates = loser.name === "salary" ? NOV(EARLIER_PAY) : NOV(THR_PAY);
    const gross = loser.name === "salary" ? SALARY_GROSS : THR_GROSS;
    await returnToDraft(loser.run.runId);
    const fresh = await simulate(loser.run.runId, dates, [
      { emp, gross, method: "bank_transfer" },
    ]);
    await approveRun(world, loser.run.runId, fresh.calcs);
    await lockRun(loser.run.runId, fresh.employees);

    expect(await runStatus(salary.runId)).toBe("locked");
    expect(await runStatus(thr.runId)).toBe("locked");
    const stored = await storedSlips([salary.runId, thr.runId]);
    expect(stored).toHaveLength(2);
    const total = stored.reduce((sum, s) => sum + s.calculation.pph21Idr, 0);
    // Not 120.000 + 650.017 (double), not less (missing).
    expect(total).toBe(MONTH_TAX);
    expect(await priorsOf(loser.run.runId)).toEqual([winner.run.runId]);
    expect(await edgeCount(winner.run.runId)).toBe(0);
  }, 90_000);
});

// ---- 3. [reversal-blocked] -----------------------------------------------------------

describe("run reversal", () => {
  it("[reversal-blocked] refused while a later run of the month depends on it; SQL bypass fails with 23514; reverse later first, then earlier", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    // A locks first; B is simulated and locked on top of A (edge B -> A).
    const earlier = await approvedRun(world, NOV(EARLIER_PAY), [
      { emp, gross: SALARY_GROSS, method: "bank_transfer" },
    ]);
    await lockRun(earlier.runId, earlier.employees);
    const later = await approvedRun(
      world,
      NOV(THR_PAY),
      [{ emp, gross: THR_GROSS, method: "bank_transfer" }],
      "thr",
    );
    await lockRun(later.runId, later.employees);
    expect(await priorsOf(later.runId)).toEqual([earlier.runId]);

    // The requester cannot decide their own request (reducer, not permission).
    await requestReversal(later.runId, exporterUserId);
    const self = await failureOf(
      decideReversal(later.runId, exporterUserId, "approve"),
    );
    expect(self, "the requester must not decide").not.toBeNull();
    expect(self!.status).toBe(403);
    expect(self!.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect(await runStatus(later.runId)).toBe("locked");

    // A (the earlier run) cannot be reversed: B's tax was computed on it.
    const blocked = await failureOf(
      (async () => {
        await requestReversal(earlier.runId, exporterUserId);
        await decideReversal(earlier.runId, approver.userId, "approve");
      })(),
    );
    expect(blocked, "reversing the earlier run must be refused").not.toBeNull();
    expect(blocked!.status).toBe(409);
    expect(blocked!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
    expect(await runStatus(earlier.runId)).toBe("locked");

    // The DB refuses the same move written directly (trigger, SQLSTATE 23514).
    const bypass = await asTenant((conn) =>
      conn.query(
        `UPDATE payroll_runs SET status = 'reversed', reversal = $2::jsonb WHERE id = $1`,
        [
          earlier.runId,
          JSON.stringify({
            status: "approved",
            reason: "Uji langsung lewat SQL",
            requestedBy: exporterUserId,
            requestedAt: "2026-11-30T00:00:00.000Z",
            decidedBy: approver.userId,
            decidedAt: "2026-11-30T00:01:00.000Z",
          }),
        ],
      ),
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(bypass, "the direct update must be refused").not.toBeNull();
    expect(bypass!.code).toBe("23514");
    expect(await runStatus(earlier.runId)).toBe("locked");

    // Reverse the later run first (its request is already pending), then A.
    await decideReversal(later.runId, approver.userId, "approve");
    expect(await runStatus(later.runId)).toBe("reversed");
    const pending = await reversalOf(earlier.runId);
    if (pending?.status !== "pending")
      await requestReversal(earlier.runId, exporterUserId);
    await decideReversal(earlier.runId, approver.userId, "approve");
    expect(await runStatus(earlier.runId)).toBe("reversed");
  }, 90_000);
});
