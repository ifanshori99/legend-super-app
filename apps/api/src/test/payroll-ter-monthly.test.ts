// TER on the monthly total (bead legend-ihjan, brief
// docs/briefs/615-payroll-money-fixes-lead.md card B; PP 58/2023 TER, PER-11/PJ/2025;
// founder rule "no employee under-withheld, no outlet double-pays"). Fail-first:
// written before the implementation.
//
// RULES UNDER TEST
//  1. Several runs of one legal entity pay one employee in the same tax month
//     (regular + THR / off-cycle): PPh 21 of a later run =
//       round(TER(total taxable gross of the month incl. earlier runs) x rate,
//             policy rounding) - PPh 21 already withheld/borne by the earlier
//     locked runs of that month. Not less (under-withholding), not more.
//  2. Two runs computed concurrently never both compute against the same prior
//     total (serialised, or the later one is refused with a 409 "stale").
//  3. December (annual_recalculation) keeps the existing annual rule unchanged.
//  4. The Coretax BPMP export of such a month succeeds with ONE row per
//     employee: gross = sum of the slips, rate = TER(sum), and the sum of the
//     slips' PPh 21 = round(sum gross x rate); under-withholding stays refused.
//
// WORKED NUMBERS (category A, TK/0, NPWP; every value computed by hand from the
// PP 58/2023 Lampiran A brackets in fixtures/payroll/statutory-tables.ts):
//   salary run   gross 8.000.020 -> bracket (7.500.000, 8.550.000] = 150 bp
//                tax 8.000.020 x 1,5% = 120.000,3 -> 120.000 (down and half up)
//   THR run      gross 5.000.310 alone -> bracket <= 5.400.000 = 0% (tax 0):
//                the NAIVE per-run engine withholds 0 on the THR (under-withheld)
//   month total  13.000.330 -> bracket (12.500.000, 13.750.000] = 500 bp (5%)
//                total tax 13.000.330 x 5% = 650.016,5 -> half up 650.017,
//                down 650.016
//   THR run tax  half up 650.017 - 120.000 = 530.017 (down: 530.016)
//
// API USED (real signatures of payroll-run-pph21.service.ts):
//  - `PayrollRunTaxInput.monthScope = { runId }` (required) + the caller's
//    transaction: earlier locked/paid payslips of the same legal entity whose
//    pay date is in the same month are totalled per employee (`monthBasis`:
//    priorGrossIdr, priorTaxIdr). Computing, simulating and locking take a
//    transaction-scoped advisory lock per tenant + legal entity + month.
//  - `lockPayrollRunTax(ctx, input, approved, tx, approvedMonthBasis)`: a basis
//    that changed since the simulation is 409 PAYROLL_PPH21_MONTH_STALE.
//
// ASSUMPTIONS (brief silent; stated so the engineer can contest them):
//  - A later payslip's tax object keeps taxableGrossIdr = ITS OWN run's gross
//    (5.000.310), terRateBp = the rate of the month total (500) and pph21Idr =
//    the increment (530.017). This is what makes "sum pph21 = round(sum gross x
//    rate)" hold in the Coretax export.
//  - Never negative: the later run's pph21Idr is floored at 0 (the brief's
//    preferred choice); only >= 0 is asserted.
//  - Only locked runs have payslips (DB rule PAYR-01), so the earlier runs are
//    seeded locked. Policy rounding with no published PPh 21 policy is the
//    default policy (half_up, as payroll-coretax-export.test.ts documents).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema, idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEFAULT_PPH21_POLICY,
  payrollConfigSnapshotSchema,
  payrollTaxExportSchema,
  type PayslipTax,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { StorageRequest } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  calculatePayrollRunTax,
  lockPayrollRunTax,
  type PayrollRunMonthScope,
  type PayrollRunTaxEmployee,
  type PayrollRunTaxRun,
} from "../services/payroll-run-pph21.service.ts";
import { createPph21PolicyVersion } from "../services/payroll-pph21-policy.service.ts";
import {
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

async function makeEmployee(world: World): Promise<Emp> {
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

type Slip = {
  emp: Emp;
  gross: number;
  bp: number;
  /** PPh 21 deposit of the slip (withheld + employer borne). */
  pph: number;
  borne?: number;
};

type RunDates = { periodStart: string; periodEnd: string; payDate: string };

function calculation(slip: Slip, dates: RunDates) {
  const borne = slip.borne ?? 0;
  const lines: Record<string, unknown>[] = [
    {
      componentCode: "GAJI",
      name: "Gaji pokok",
      category: "base_salary",
      kind: "earning",
      amountIdr: slip.gross,
      taxable: true,
      quantity: null,
      sourceId: null,
    },
  ];
  if (slip.pph - borne > 0)
    lines.push({
      componentCode: "PPH21",
      name: "PPh 21",
      category: "pph21",
      kind: "deduction",
      amountIdr: slip.pph - borne,
      taxable: false,
      quantity: null,
      sourceId: null,
    });
  return {
    employeeId: slip.emp.id,
    employeeNo: `TM-${slip.emp.id.slice(0, 8).toUpperCase()}`,
    employeeName: slip.emp.name,
    positionName: "Kasir",
    outletId: outlet.id,
    periodStart: dates.periodStart,
    periodEnd: dates.periodEnd,
    payDate: dates.payDate,
    grossIdr: slip.gross,
    deductionsIdr: slip.pph - borne,
    netIdr: slip.gross - (slip.pph - borne),
    pph21Idr: slip.pph,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines,
    bpjs: [],
    tax: {
      ptkpStatus: "TK/0",
      method: "ter",
      terCategory: null,
      terRateBp: slip.bp,
      taxableGrossIdr: slip.gross,
      pph21Idr: slip.pph,
      pph21WithheldIdr: slip.pph - borne,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: borne,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      grossSchemeBaseIdr: slip.gross - borne,
      employerSchemeBaseIdr: borne,
    },
    paymentMethod: "bank_transfer",
  };
}

function totalsFor(slips: Slip[]) {
  const gross = slips.reduce((sum, s) => sum + s.gross, 0);
  const pph = slips.reduce((sum, s) => sum + s.pph, 0);
  const borne = slips.reduce((sum, s) => sum + (s.borne ?? 0), 0);
  const net = gross - (pph - borne);
  return {
    employeeCount: slips.length,
    grossIdr: gross,
    deductionsIdr: pph - borne,
    netIdr: net,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    pph21Idr: pph,
    pph21WithheldIdr: pph - borne,
    pph21EmployerBorneIdr: borne,
    pph21RefundIdr: 0,
    pph21EmployerRefundIdr: 0,
    pph21EmployerAllowanceRefundIdr: 0,
    loanRepaymentIdr: 0,
    pph21ReceivableIdr: 0,
    pph21ReceivableCollectedIdr: 0,
    otherDeductionsIdr: 0,
    customDeductionsIdr: 0,
    serviceChargeIdr: 0,
    reimbursementIdr: 0,
    bankTransferIdr: net,
    cashIdr: 0,
  };
}

// Pinned TER table (PAYR-02). Own id/version/date: files run one after the
// other, but a version must not start on the same date as another file's.
const TER_ID = randomUUID();
const TER_VERSION = 9200;
// 1979: below the 1980-2019 range payroll-simulate-kit picks its dates from
// (random first-of-month, chosen before this file publishes). A date inside that
// range can collide with a kit file's row and raise 23505 on
// statutory_rates_tenant_type_published_from_key (batch84 full run, Retro 43).
const TER_FROM = "1979-01-01";

async function ensureTerTable() {
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO statutory_rates
         (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
       VALUES ($1, $2, 'pph21_ter', $3, $4, 'draft', 'PP 58/2023 Lampiran A-C (test)', $5::jsonb, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        TER_ID,
        tenant.id,
        TER_VERSION,
        TER_FROM,
        JSON.stringify(REFERENCE_TER),
        exporterUserId,
      ],
    );
    await conn.query(
      `UPDATE statutory_rates
          SET status = 'published', published_at = now(), published_by = $2
        WHERE id = $1 AND status = 'draft'`,
      [TER_ID, exporterUserId],
    );
  });
}

function snapshotFor(world: World) {
  return payrollConfigSnapshotSchema.parse({
    statutoryVersions: [
      {
        type: "pph21_ter",
        versionId: TER_ID,
        version: TER_VERSION,
        effectiveFrom: TER_FROM,
      },
    ],
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
    capturedAt: "2037-03-31T00:00:00.000Z",
  });
}

const STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
];

/** A run row: `draft` (nothing else) or `locked` (with its payslips). */
async function seedRun(
  world: World,
  status: "draft" | "locked",
  slips: Slip[],
  dates: RunDates,
  runType: "regular" | "thr" | "off_cycle" = "regular",
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  if (status === "locked") await ensureTerTable();
  await asTenant(async (conn) => {
    // payroll_runs_thr_schedule_check: a THR run needs a THR schedule (and only
    // a THR run has one); one live run per schedule.
    let thrScheduleId: string | null = null;
    if (runType === "thr") {
      thrScheduleId = randomUUID();
      createdThrSchedules.push(thrScheduleId);
      await conn.query(
        `INSERT INTO thr_schedules (id, tenant_id, legal_entity_id, name, holiday_name,
                                    holiday_date, tenure_as_of_date, pay_date, created_by)
         VALUES ($1, $2, $3, 'THR uji TER bulanan', 'Hari raya uji', $4, $4, $4, 'ter-monthly-test')`,
        [thrScheduleId, tenant.id, world.entityId, dates.payDate],
      );
    }
    await conn.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, thr_schedule_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ter-monthly-test')`,
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
      ],
    );
    if (status === "draft") return;
    for (const step of STEPS)
      await conn.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
    await conn.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
              totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
        WHERE id = $1`,
      [
        runId,
        JSON.stringify(totalsFor(slips)),
        JSON.stringify(snapshotFor(world)),
      ],
    );
    for (const slip of slips) {
      const id = randomUUID();
      await conn.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
        [
          id,
          tenant.id,
          runId,
          slip.emp.id,
          sealPayrollValue(JSON.stringify(calculation(slip, dates)), {
            tenantId: tenant.id,
            table: "payslips",
            rowId: id,
            field: "calculation",
          }),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
    }
  });
  return runId;
}

// ---- Tax engine adapters (ASSUMPTIONS above live here) ----------------------

const date = (value: string) => businessDateSchema.parse(value);

type Facts = { run: PayrollRunTaxRun; monthScope: PayrollRunMonthScope };

/** The run being computed plus its month scope (excluded from the prior). */
function runFacts(
  _world: World,
  runId: string,
  payDate: string,
  status: "draft" | "approved" = "draft",
): Facts {
  return {
    run: { status, payDate: date(payDate), configSnapshot: null },
    monthScope: { runId: runId as PayrollRunMonthScope["runId"] },
  };
}

const earner = (
  emp: Emp,
  gross: number,
  extra: Partial<PayrollRunTaxEmployee> = {},
): PayrollRunTaxEmployee => ({
  employeeId: emp.id,
  ptkpStatus: "TK/0",
  hasTaxId: true,
  earnings: [{ amountIdr: idr(gross), taxable: true, taxScheme: "gross" }],
  employerBenefitIdr: idr(0),
  employeeDeductibleIdr: idr(0),
  lastTaxPeriod: false,
  monthsWorked: 11,
  priorPeriods: [],
  lastPeriodEarlier: [],
  ...extra,
});

type Sim = Awaited<ReturnType<typeof calculatePayrollRunTax>>;

const inputOf = (facts: Facts, employees: PayrollRunTaxEmployee[]) => ({
  run: facts.run,
  tables: REFERENCE_TABLES,
  employees,
  monthScope: facts.monthScope,
});

/** Simulation: computed inside its own transaction (month lock to its end). */
const calculate = (facts: Facts, employees: PayrollRunTaxEmployee[]) =>
  withTenant(db, tenantScope(), (tx) =>
    calculatePayrollRunTax(tenantScope(), inputOf(facts, employees), tx),
  );

/** What a simulation stored: the month basis per employee. */
const basisOf = (sim: Sim) =>
  new Map(
    sim.payslips.flatMap((p) =>
      p.monthBasis === undefined ? [] : [[p.employeeId, p.monthBasis] as const],
    ),
  );

/** The lock step, approved with the basis of `sim` (default: a fresh simulation). */
const lockIn = async (
  facts: Facts,
  employees: PayrollRunTaxEmployee[],
  sim?: Sim,
) => {
  const approved = basisOf(sim ?? (await calculate(facts, employees)));
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunTax(
      tenantScope(),
      inputOf(facts, employees),
      null,
      tx,
      approved,
    ),
  );
};

const taxOf = (
  result: { payslips: { employeeId: string; tax: PayslipTax }[] },
  emp: Emp,
) => {
  const found = result.payslips.find((p) => p.employeeId === emp.id);
  expect(found, "the employee has a payslip tax").toBeDefined();
  return found!.tax;
};

/** Hand-rounded round(gross x bp / 10000). */
const halfUp = (gross: number, bp: number) =>
  Math.floor((gross * bp + 5_000) / 10_000);
const down = (gross: number, bp: number) => Math.floor((gross * bp) / 10_000);

// ---- Constants of the worked example ------------------------------------------

const SALARY_GROSS = 8_000_020; // 150 bp, tax 120.000
const SALARY_PPH = 120_000;
const THR_GROSS = 5_000_310; // alone: 0 bp
const TOTAL_GROSS = SALARY_GROSS + THR_GROSS; // 13.000.330: 500 bp
const TOTAL_BP = 500;
const THR_PPH_HALF_UP = 530_017; // 650.017 - 120.000
const THR_PPH_DOWN = 530_016; // 650.016 - 120.000

const NOV = (pay: number) => ({
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: `2026-11-${String(pay).padStart(2, "0")}`,
});
const EARLIER_PAY = 15;
const THR_PAY = 28;

/** Seeds the salary run (locked) and a draft THR run of one employee. */
async function salaryThenThr(extra: Partial<Slip> = {}) {
  const world = await makeWorld();
  const emp = await makeEmployee(world);
  await seedRun(
    world,
    "locked",
    [{ emp, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH, ...extra }],
    NOV(EARLIER_PAY),
  );
  const thrRunId = await seedRun(world, "draft", [], NOV(THR_PAY), "thr");
  return { world, emp, thrRunId };
}

// ---- Policy helpers (rounding `down` test) --------------------------------------

async function actor(permissions: string[]): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'TER monthly', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `TER monthly policy ${roleId.slice(0, 8)}`,
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
  return userId;
}

const clearPolicies = () =>
  asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );

// ---- Setup / teardown ------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("TER monthly locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("TER monthly HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;

  const admin = agent(app);
  const email = await signUp(admin, "TER monthly org admin");
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

  // No tenant policy version: the default policy (half up) applies first.
  await clearPolicies();
});

afterAll(async () => {
  await clearPolicies();
  await asTenant(async (conn) => {
    const entities = createdWorlds.map((w) => w.entityId);
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ter-monthly-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_tax_exports WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, entities],
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
      "DELETE FROM statutory_rates WHERE tenant_id = $1 AND id = $2",
      [tenant.id, TER_ID],
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

// ---- 1. The month total, one employee, two runs -----------------------------------

describe("TER on the monthly total: salary run then THR run", () => {
  it("[ter-month-thr-after-salary] the THR run withholds round(TER(total) x rate) minus what the salary run withheld", async () => {
    // Sanity of the hand numbers.
    expect(halfUp(SALARY_GROSS, 150)).toBe(SALARY_PPH);
    expect(halfUp(TOTAL_GROSS, TOTAL_BP)).toBe(SALARY_PPH + THR_PPH_HALF_UP);

    const { world, emp, thrRunId } = await salaryThenThr();
    const facts = runFacts(world, thrRunId, NOV(THR_PAY).payDate);

    const simulated = taxOf(
      await calculate(facts, [earner(emp, THR_GROSS)]),
      emp,
    );
    expect(simulated.method).toBe("ter");
    expect(simulated.terRateBp).toBe(TOTAL_BP); // rate of the month total, not 0
    expect(Number(simulated.taxableGrossIdr)).toBe(THR_GROSS); // own run's gross
    // Not less: the naive per-run engine would withhold 0 on the THR.
    expect(Number(simulated.pph21Idr)).toBe(THR_PPH_HALF_UP);
    expect(Number(simulated.pph21WithheldIdr)).toBe(THR_PPH_HALF_UP);
    // Not more: both runs together are exactly the month's tax.
    expect(SALARY_PPH + Number(simulated.pph21Idr)).toBe(
      halfUp(TOTAL_GROSS, TOTAL_BP),
    );

    // The lock step computes the same amount (inside the lock transaction).
    const locked = taxOf(await lockIn(facts, [earner(emp, THR_GROSS)]), emp);
    expect(Number(locked.pph21Idr)).toBe(THR_PPH_HALF_UP);
    expect(locked.terRateBp).toBe(TOTAL_BP);
  });

  it("[ter-month-employer-borne-counts] tax the earlier run's employer bore counts as already paid", async () => {
    // The earlier slip deposited 120.000: 90.000 withheld + 30.000 borne. The
    // whole 120.000 is already paid for the month, whoever funded it.
    //
    // Hand arithmetic (500 bp for the month, half up). The month total includes
    // the tax S the employer now covers on this run (taxable benefit), with
    //   X = 5.000.310 + S and S = employerPart(X):
    //   step-up on the salary = round(8.000.020 x 5%) - 120.000 = 280.001
    //     employer share (earlier payer: 30.000 of 120.000) = 280.001 x 30.000 / 120.000
    //       = 70.000,25 -> 70.000
    //   the rest = 5% x (5.000.310 + S) splits by mix; the employer gets 5% x S
    //   S = 70.000 + 5% x S -> S = 73.684 (S = 73.684: 0,05 x 73.684 = 3.684,2 -> 3.684;
    //     70.000 + 3.684 = 73.684, the least fixed point)
    //   month total = round((13.000.330 + 73.684) x 5%) = round(653.700,7) = 653.701
    //   this run = 653.701 - 120.000 = 533.701
    // Not 530.017 (the old split, which ignored that the employer covers part of
    // this run's tax and that tax itself is taxable).
    const monthTotalGross = SALARY_GROSS + THR_GROSS + 73_684;
    expect(halfUp(monthTotalGross, 500)).toBe(653_701);

    const { world, emp, thrRunId } = await salaryThenThr({ borne: 30_000 });
    const tax = taxOf(
      await calculate(runFacts(world, thrRunId, NOV(THR_PAY).payDate), [
        earner(emp, THR_GROSS),
      ]),
      emp,
    );
    expect(tax.terRateBp).toBe(500);
    expect(Number(tax.pph21Idr)).toBe(533_701);
    // Together with the earlier 120.000 (90.000 + 30.000 borne) the month's tax.
    expect(SALARY_PPH + Number(tax.pph21Idr)).toBe(653_701);
    // The employer covers about 73.684; its share of the step-up splits
    // 70.000,25 between whole rupiah, so allow the one rupiah of that rounding.
    const borne = Number(tax.pph21EmployerBorneIdr);
    expect(borne).toBeGreaterThanOrEqual(73_684);
    expect(borne).toBeLessThanOrEqual(73_685);
    // The employee carries the rest of the deposit.
    expect(
      Number(tax.pph21WithheldIdr) -
        Number(tax.taxAllowanceIdr) +
        Number(tax.pph21ReceivableIdr),
    ).toBe(533_701 - borne);
  });

  it("[ter-month-first-run-unchanged] a run with no earlier run in the month is plain TER of its own gross", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const runId = await seedRun(world, "draft", [], NOV(EARLIER_PAY));
    const tax = taxOf(
      await calculate(runFacts(world, runId, NOV(EARLIER_PAY).payDate), [
        earner(emp, SALARY_GROSS),
      ]),
      emp,
    );
    expect(tax.terRateBp).toBe(150);
    expect(Number(tax.pph21Idr)).toBe(SALARY_PPH);
  });

  it("[ter-month-other-scopes-ignored] another employee's slip and another month's slip never count", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const colleague = await makeEmployee(world);
    // Same month, another employee: 8.000.020 at 150 bp.
    await seedRun(
      world,
      "locked",
      [{ emp: colleague, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH }],
      NOV(EARLIER_PAY),
    );
    // Same employee, October: never part of November's total.
    await seedRun(
      world,
      "locked",
      [{ emp, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH }],
      {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        payDate: "2026-10-28",
      },
    );
    const runId = await seedRun(world, "draft", [], NOV(THR_PAY), "thr");
    const tax = taxOf(
      await calculate(runFacts(world, runId, NOV(THR_PAY).payDate), [
        earner(emp, THR_GROSS),
      ]),
      emp,
    );
    // THR of 5.000.310 alone is in the 0% bracket.
    expect(tax.terRateBp).toBe(0);
    expect(Number(tax.pph21Idr)).toBe(0);
  });

  it("[ter-month-never-negative] earlier runs that withheld more than the month needs never make the later run negative", async () => {
    // The salary run withheld 700.000 (more than the 650.017 the month needs).
    const { world, emp, thrRunId } = await salaryThenThr({ pph: 700_000 });
    const tax = taxOf(
      await calculate(runFacts(world, thrRunId, NOV(THR_PAY).payDate), [
        earner(emp, THR_GROSS),
      ]),
      emp,
    );
    expect(Number(tax.pph21Idr)).toBeGreaterThanOrEqual(0);
    expect(Number(tax.pph21WithheldIdr)).toBeGreaterThanOrEqual(0);
    expect(Number(tax.pph21EmployerBorneIdr)).toBeGreaterThanOrEqual(0);
  });
  it("[ter-month-zero-pay-catch-up] a later run that pays nothing still collects the tax the earlier runs under-withheld, from the employee, never from the employer", async () => {
    // The salary run withheld only 100.000, but the month's tax on its gross
    // 8.000.020 (150 bp) is 120.000. The later run pays this employee zero.
    const { world, emp, thrRunId } = await salaryThenThr({ pph: 100_000 });
    const tax = taxOf(
      await calculate(runFacts(world, thrRunId, NOV(THR_PAY).payDate), [
        earner(emp, 0),
      ]),
      emp,
    );
    // Catch-up of 20.000 is owed, and the employer bears none of it.
    expect(Number(tax.pph21Idr)).toBe(20_000);
    expect(Number(tax.pph21EmployerBorneIdr)).toBe(0);
    // With no pay in this run the employee's share cannot be deducted now: it
    // is the employee's withholding or their receivable, never lost.
    expect(
      Number(tax.pph21WithheldIdr) -
        Number(tax.taxAllowanceIdr) +
        Number(tax.pph21ReceivableIdr),
    ).toBe(20_000);
  });

  // Fix R1 (docs/briefs/615-payroll-money-fixes-lead.md). Worked numbers, TER
  // category A (TK/0), half-up rounding, one employee, November 2026:
  //   Earlier run: salary 8.000.020 at 150 bp = 120.000 (rate 1,5%).
  //   Later THR run, total crosses into 500 bp (12.500.001 - 13.750.000).
  //   Step-up of the salary gross caused by the higher rate:
  //     round(8.000.020 x 5%) - round(8.000.020 x 1,5%) = 400.001 - 120.000 = 280.001
  //   It is tax on the EARLIER salary, so it follows whoever funded the earlier
  //   tax, not the mix of the THR run.
  const STEP_UP = halfUp(SALARY_GROSS, 500) - SALARY_PPH; // 280.001
  const R1_THR_GROSS = 5_000_000; // THR gross incl. its own tax, at 500 bp: 250.000
  const MONTH_M = SALARY_GROSS + R1_THR_GROSS; // 13.000.020: 500 bp
  const MONTH_TAX = halfUp(MONTH_M, 500); // 650.001 = 13.000.020 x 5% exactly

  it("[ter-month-net-thr-step-up] a net-scheme THR after a gross-scheme salary: the employee carries the step-up on the salary, the employer only the tax on the THR", async () => {
    // THR net amount N = 4.750.000, the employer bears the tax B (itself part of
    // the gross). Fixed point at 500 bp: B = 5% x (N + B) -> B = N / 19 = 250.000,
    //   so the THR gross = N + B = 5.000.000 and the month total
    //   M = 8.000.020 + 5.000.000 = 13.000.020 (500 bp).
    // (a) month tax = round(13.000.020 x 5%) = 650.001
    //     = 120.000 (earlier run) + 530.001 (this run).
    // (b) employee part of this run = step-up = 280.001 (the earlier 120.000 was
    //     all withheld from the employee, so the step-up on that salary is theirs).
    // (c) employer part = 530.001 - 280.001 = 250.000 = 5% of the THR gross
    //     5.000.000, i.e. only the tax on the THR itself, gross-up included.
    const netThr = 4_750_000;
    expect(STEP_UP).toBe(280_001);
    expect(MONTH_TAX).toBe(650_001);
    expect(MONTH_TAX - SALARY_PPH).toBe(530_001);
    expect(halfUp(R1_THR_GROSS, 500)).toBe(250_000);

    const { world, emp, thrRunId } = await salaryThenThr();
    const facts = runFacts(world, thrRunId, NOV(THR_PAY).payDate);
    const employees = [
      earner(emp, netThr, {
        earnings: [{ amountIdr: idr(netThr), taxable: true, taxScheme: "net" }],
      }),
    ];

    const check = (tax: PayslipTax) => {
      expect(tax.terRateBp).toBe(500);
      // (a) both runs together are the month's tax.
      expect(SALARY_PPH + Number(tax.pph21Idr)).toBe(MONTH_TAX);
      // (b) the employee's part (withheld net of allowance, plus receivable).
      expect(
        Number(tax.pph21WithheldIdr) -
          Number(tax.taxAllowanceIdr) +
          Number(tax.pph21ReceivableIdr),
      ).toBe(STEP_UP);
      // (c) the employer bears only the tax on the THR gross at the month's rate.
      expect(Number(tax.pph21EmployerBorneIdr)).toBe(halfUp(R1_THR_GROSS, 500));
      expect(Number(tax.pph21Idr)).toBe(
        STEP_UP + Number(tax.pph21EmployerBorneIdr),
      );
    };
    check(taxOf(await calculate(facts, employees), emp));
    check(taxOf(await lockIn(facts, employees), emp));
  });

  it("[ter-month-step-up-follows-earlier-payer] when the earlier slip was net-scheme (all its tax borne), the step-up stays with the employer", async () => {
    // The earlier salary slip's 120.000 was entirely borne by the employer
    // (withheld 0). The THR is gross-scheme 5.000.000 (employee-funded) and the
    // employer covers tax S on this run, which is itself taxable: X = 5.000.000 + S.
    //   step-up on the salary = round(8.000.020 x 5%) - 120.000 = 280.001
    //     -> all employer (earlier payer: 280.001 x 0 / 120.000 = 0 for the employee)
    //   the rest = 5% x (5.000.000 + S) splits by mix: the employee has
    //     5.000.000 / (5.000.000 + S) of it = 250.000, the employer 5% x S
    //   S = 280.001 + 5% x S -> S = 294.738
    //     (0,05 x 294.738 = 14.736,9 -> 14.737; 280.001 + 14.737 = 294.738, the
    //      least fixed point)
    //   month total = round((13.000.020 + 294.738) x 5%) = round(664.737,9) = 664.738
    //   this run = 664.738 - 120.000 = 544.738 = 250.000 (employee) + 294.738 (employer)
    const employerCover = 294_738;
    expect(
      Math.round(0.05 * employerCover) + halfUp(SALARY_GROSS, 500) - SALARY_PPH,
    ).toBe(employerCover);
    expect(halfUp(SALARY_GROSS + R1_THR_GROSS + employerCover, 500)).toBe(
      664_738,
    );

    const { world, emp, thrRunId } = await salaryThenThr({
      borne: SALARY_PPH,
    });
    const tax = taxOf(
      await calculate(runFacts(world, thrRunId, NOV(THR_PAY).payDate), [
        earner(emp, R1_THR_GROSS),
      ]),
      emp,
    );
    expect(tax.terRateBp).toBe(500);
    // The employee withholds exactly the tax on their own THR; the step-up on the
    // salary (280.001) and the tax on the employer-covered part are the employer's.
    expect(
      Number(tax.pph21WithheldIdr) -
        Number(tax.taxAllowanceIdr) +
        Number(tax.pph21ReceivableIdr),
    ).toBe(halfUp(R1_THR_GROSS, 500));
    expect(Number(tax.pph21EmployerBorneIdr)).toBe(employerCover);
    expect(Number(tax.pph21Idr)).toBe(544_738);
    expect(SALARY_PPH + Number(tax.pph21Idr)).toBe(664_738);
  });

  it("[ter-month-run-mismatch] a pay date that disagrees with the run row is refused with 409 PAYROLL_PPH21_RUN_MISMATCH", async () => {
    const { world, emp, thrRunId } = await salaryThenThr();
    // The row says the THR run pays on 2026-11-28; the caller claims 12-28.
    const failure = await calculate(runFacts(world, thrRunId, "2026-12-28"), [
      earner(emp, THR_GROSS),
    ]).then(
      () => null,
      (error: unknown) => error as { status?: number; code?: string },
    );
    expect(failure, "the mismatching pay date must be refused").not.toBeNull();
    expect(failure!.status).toBe(409);
    expect(failure!.code).toBe("PAYROLL_PPH21_RUN_MISMATCH");
  });

  it("[ter-month-unknown-run] a run id that has no payroll_runs row is refused with 404 PAYROLL_RUN_NOT_FOUND", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const failure = await calculate(
      runFacts(world, randomUUID(), NOV(THR_PAY).payDate),
      [earner(emp, THR_GROSS)],
    ).then(
      () => null,
      (error: unknown) => error as { status?: number; code?: string },
    );
    expect(failure, "an unknown run must be refused").not.toBeNull();
    expect(failure!.status).toBe(404);
    expect(failure!.code).toBe("PAYROLL_RUN_NOT_FOUND");
  });
});

// ---- 2. December keeps the annual rule -----------------------------------------

describe("TER on the monthly total: December", () => {
  it("[ter-month-december-unchanged] the annual recalculation is the same with or without an earlier December run", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const decPay = {
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
    };
    // Jan-Nov: 8.000.000 gross, TER A 1,5% = 120.000 withheld, JHT/JP 120.000
    // (the same year as payroll-run-pph21-db.test.ts: December tax 468.000).
    const priorPeriods = Array.from({ length: 11 }, () => ({
      employeeDeductibleIdr: idr(120_000),
      tax: {
        ptkpStatus: "TK/0" as const,
        method: "ter" as const,
        terCategory: "A" as const,
        terRateBp: 150,
        taxableGrossIdr: idr(8_000_000),
        pph21Idr: idr(120_000),
        pph21WithheldIdr: idr(120_000),
        taxAllowanceIdr: idr(0),
        pph21EmployerBorneIdr: idr(0),
        pph21RefundIdr: idr(0),
        pph21EmployerRefundIdr: idr(0),
        noTaxIdSurchargeApplied: false,
        grossSchemeBaseIdr: idr(8_000_000),
        employerSchemeBaseIdr: idr(0),
      },
    }));
    const december = earner(emp, 8_000_000, {
      lastTaxPeriod: true,
      monthsWorked: 12,
      employeeDeductibleIdr: idr(120_000),
      priorPeriods,
    });
    const runId = await seedRun(
      world,
      "draft",
      [],
      { ...decPay, payDate: "2026-12-28" },
      "regular",
    );
    const facts = runFacts(world, runId, "2026-12-28");

    const baseline = taxOf(await calculate(facts, [december]), emp);
    expect(baseline.method).toBe("annual_recalculation");
    expect(Number(baseline.pph21Idr)).toBe(468_000);

    // An earlier December run of the same employee is now locked.
    await seedRun(
      world,
      "locked",
      [{ emp, gross: 8_000_000, bp: 150, pph: 120_000 }],
      { ...decPay, payDate: "2026-12-15" },
      "off_cycle",
    );
    const withEarlier = taxOf(await calculate(facts, [december]), emp);
    expect(withEarlier).toEqual(baseline);
    const locked = taxOf(await lockIn(facts, [december]), emp);
    expect(locked).toEqual(baseline);
  });
});

// ---- 3. Policy rounding ------------------------------------------------------------

describe("TER on the monthly total: policy rounding", () => {
  it("[ter-month-down-policy] a tenant policy that rounds down rounds the month total down", async () => {
    expect(down(TOTAL_GROSS, TOTAL_BP)).toBe(SALARY_PPH + THR_PPH_DOWN);
    const admin = await actor(["payroll.view", "payroll.run"]);
    await createPph21PolicyVersion(
      tenantScope(),
      admin,
      {
        effectiveFrom: date("2026-11-10"),
        parameters: { ...DEFAULT_PPH21_POLICY, roundingMode: "down" },
        reason: "TER bulanan: pembulatan ke bawah",
      },
      new Date("2026-11-08T03:00:00Z"),
    );
    const { world, emp, thrRunId } = await salaryThenThr();
    const result = await calculate(
      runFacts(world, thrRunId, NOV(THR_PAY).payDate),
      [earner(emp, THR_GROSS)],
    );
    const tax = taxOf(result, emp);
    expect(result.parameters.roundingMode).toBe("down");
    expect(tax.terRateBp).toBe(TOTAL_BP);
    expect(Number(tax.pph21Idr)).toBe(THR_PPH_DOWN);
    await clearPolicies();
  });
});

// ---- 4. Concurrent runs ----------------------------------------------------------------

type DbTx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Two locked rows without payslips: each lock transaction inserts its own. */
async function twoEmptyRuns() {
  const world = await makeWorld();
  const emp = await makeEmployee(world);
  const runA = await seedRun(world, "locked", [], NOV(EARLIER_PAY));
  const runB = await seedRun(world, "locked", [], NOV(THR_PAY), "thr");
  const insertPayslip = async (
    tx: DbTx,
    runId: string,
    dates: RunDates,
    gross: number,
    tax: PayslipTax,
  ) => {
    const id = randomUUID();
    const slip: Slip = {
      emp,
      gross,
      bp: tax.terRateBp ?? 0,
      pph: Number(tax.pph21Idr),
    };
    const sealed = sealPayrollValue(JSON.stringify(calculation(slip, dates)), {
      tenantId: tenant.id,
      table: "payslips",
      rowId: id,
      field: "calculation",
    });
    await tx.execute(sql`
      INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                            calculation_encrypted, pii_key_version)
      VALUES (${id}, ${tenant.id}, ${runId}, ${emp.id}, 'bank_transfer',
              ${sealed}, ${PAYROLL_SEAL_KEY_VERSION})`);
  };
  return { world, emp, runA, runB, insertPayslip };
}

describe("TER on the monthly total: two runs computed at the same time", () => {
  it("[ter-month-concurrent-serialised] a run computed while another is still open waits and sees the other's payslips: no under-withholding", async () => {
    const { world, emp, runA, runB, insertPayslip } = await twoEmptyRuns();
    const APP_B = `ter-race-b-${randomUUID().slice(0, 8)}`;
    let bDone = false;
    let aComputedResolve!: () => void;
    const aComputed = new Promise<void>((resolve) => {
      aComputedResolve = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    // Transaction A: the salary run computes, then stays open (holds the month
    // lock) until it has written its payslip, like the lock transaction.
    const settledA = withTenant(db, tenantScope(), async (tx) => {
      const sim = await calculatePayrollRunTax(
        tenantScope(),
        inputOf(runFacts(world, runA, NOV(EARLIER_PAY).payDate, "approved"), [
          earner(emp, SALARY_GROSS),
        ]),
        tx,
      );
      aComputedResolve();
      await gate;
      await insertPayslip(
        tx,
        runA,
        NOV(EARLIER_PAY),
        SALARY_GROSS,
        taxOf(sim, emp),
      );
      return sim;
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([aComputed, settledA]);

    // Transaction B: the THR run starts while A is still open.
    const settledB = withTenant(db, tenantScope(), async (tx) => {
      await tx.execute(
        sql`SELECT set_config('application_name', ${APP_B}, true)`,
      );
      const sim = await calculatePayrollRunTax(
        tenantScope(),
        inputOf(runFacts(world, runB, NOV(THR_PAY).payDate, "approved"), [
          earner(emp, THR_GROSS),
        ]),
        tx,
      );
      bDone = true;
      return sim;
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Wait until B has either finished computing (no lock: the race is real)
    // or is blocked on a lock held by A (serialised). Bounded: if the blocked
    // state cannot be observed A proceeds anyway after 8 s.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !bDone) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [APP_B],
      );
      if ((waiting.rowCount ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    openGate();
    const [a, b] = await Promise.all([settledA, settledB]);

    expect(a.ok, a.ok ? "" : String(a.error)).toBe(true);
    expect(b.ok, b.ok ? "" : String(b.error)).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(Number(taxOf(a.value, emp).pph21Idr)).toBe(SALARY_PPH);
    // B computed against A's payslip: the two add up to the month's tax
    // exactly (not 0 = under-withheld, not 650.017 = double).
    const bTax = taxOf(b.value, emp);
    expect(Number(bTax.pph21Idr)).toBe(THR_PPH_HALF_UP);
    expect(SALARY_PPH + Number(bTax.pph21Idr)).toBe(
      halfUp(TOTAL_GROSS, TOTAL_BP),
    );
    expect(b.value.payslips[0]!.monthBasis).toEqual({
      priorGrossIdr: SALARY_GROSS,
      priorTaxIdr: SALARY_PPH,
      // The salary slip is gross-scheme: all of its tax is employee-funded.
      priorEmployeeTaxIdr: SALARY_PPH,
    });
  }, 40_000);

  it("[ter-month-stale-lock] a run simulated before another run of the month locked is refused at lock with 409 PAYROLL_PPH21_MONTH_STALE, and locks correctly after a re-simulation", async () => {
    const { world, emp, runA, runB, insertPayslip } = await twoEmptyRuns();
    const factsA = runFacts(world, runA, NOV(EARLIER_PAY).payDate, "approved");
    const factsB = runFacts(world, runB, NOV(THR_PAY).payDate, "approved");
    const salary = [earner(emp, SALARY_GROSS)];
    const thr = [earner(emp, THR_GROSS)];

    // Both are simulated while the month holds no payslip: B shows 0 tax.
    const simA = await calculate(factsA, salary);
    const simB = await calculate(factsB, thr);
    expect(Number(taxOf(simB, emp).pph21Idr)).toBe(0);

    // A locks first and writes its payslip in the lock transaction.
    await withTenant(db, tenantScope(), async (tx) => {
      const locked = await lockPayrollRunTax(
        tenantScope(),
        inputOf(factsA, salary),
        null,
        tx,
        basisOf(simA),
      );
      await insertPayslip(
        tx,
        runA,
        NOV(EARLIER_PAY),
        SALARY_GROSS,
        taxOf(locked, emp),
      );
    });

    // B's stored simulation (prior 0) is stale: refused, never locked at 0.
    const stale = await lockIn(factsB, thr, simB).then(
      () => null,
      (error: unknown) => error as { status?: number; code?: string },
    );
    expect(stale, "the stale lock must be refused").not.toBeNull();
    expect(stale!.status).toBe(409);
    expect(stale!.code).toBe("PAYROLL_PPH21_MONTH_STALE");

    // Re-simulated, B locks with the right tax: 530.017.
    const fresh = await calculate(factsB, thr);
    expect(Number(taxOf(fresh, emp).pph21Idr)).toBe(THR_PPH_HALF_UP);
    const locked = await lockIn(factsB, thr, fresh);
    expect(Number(taxOf(locked, emp).pph21Idr)).toBe(THR_PPH_HALF_UP);
    expect(SALARY_PPH + Number(taxOf(locked, emp).pph21Idr)).toBe(
      halfUp(TOTAL_GROSS, TOTAL_BP),
    );
  }, 40_000);
});

// ---- 5. Coretax export of a multi-run month ------------------------------------------

const YEAR = 2037;
const PERIOD = `${YEAR}-03`;
const MARCH_A = {
  periodStart: `${YEAR}-03-01`,
  periodEnd: `${YEAR}-03-15`,
  payDate: `${YEAR}-03-16`,
};
const MARCH_B = {
  periodStart: `${YEAR}-03-16`,
  periodEnd: `${YEAR}-03-31`,
  payDate: `${YEAR}-03-31`,
};

const exportTax = async (world: World) => {
  await ensureTerTable();
  storage.puts.length = 0;
  return exporter.post(EXPORT_PATH).set(originHeader).send({
    legalEntityId: world.entityId,
    kind: "monthly_withholding",
    taxPeriod: PERIOD,
    idempotencyKey: key(),
  });
};
const storedXml = () => {
  expect(storage.puts, "the export wrote exactly one object").toHaveLength(1);
  const content = storage.puts[0]!.content;
  return typeof content === "string"
    ? content
    : Buffer.from(content).toString("utf8");
};
const blocksByNik = (xml: string) => {
  const map = new Map<string, string>();
  for (const block of xml.match(/<MmPayroll>[\s\S]*?<\/MmPayroll>/g) ?? []) {
    map.set(/<CounterpartTin>(\d+)<\/CounterpartTin>/.exec(block)![1]!, block);
  }
  return map;
};
const field = (block: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1];
const exportCount = (entityId: string) =>
  asTenant(async (conn) =>
    Number(
      (
        await conn.query(
          "SELECT count(*)::int AS n FROM payroll_tax_exports WHERE tenant_id = $1 AND legal_entity_id = $2",
          [tenant.id, entityId],
        )
      ).rows[0].n,
    ),
  );

describe("Coretax export of a month with a salary run and a THR run", () => {
  it("[ter-month-coretax-export] succeeds with one row per employee: gross = sum, rate = TER(sum), sum of PPh 21 = round(sum gross x rate)", async () => {
    const world = await makeWorld();
    const both = await makeEmployee(world); // salary + THR
    const single = await makeEmployee(world); // salary only
    await seedRun(
      world,
      "locked",
      [
        { emp: both, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH },
        { emp: single, gross: 9_000_000, bp: 175, pph: 157_500 },
      ],
      MARCH_A,
    );
    // THR run: rate of the month total (500 bp), increment 530.017.
    await seedRun(
      world,
      "locked",
      [{ emp: both, gross: THR_GROSS, bp: TOTAL_BP, pph: THR_PPH_HALF_UP }],
      MARCH_B,
      "thr",
    );

    const response = await exportTax(world);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(payrollTaxExportSchema.parse(response.body.data).status).toBe(
      "ready",
    );
    const xml = storedXml();
    const blocks = blocksByNik(xml);
    // One row per employee, not one per slip.
    expect(blocks.size).toBe(2);
    expect((xml.match(/<MmPayroll>/g) ?? []).length).toBe(2);
    const bothBlock = blocks.get(both.nik)!;
    expect(field(bothBlock, "Gross")).toBe(String(TOTAL_GROSS));
    expect(field(bothBlock, "Rate")).toBe("5");
    expect(field(bothBlock, "WithholdingDate")).toBe(`${YEAR}-03-31`);
    const singleBlock = blocks.get(single.nik)!;
    expect(field(singleBlock, "Gross")).toBe("9000000");
    expect(field(singleBlock, "Rate")).toBe("1.75");
    expect(await exportCount(world.entityId)).toBe(1);
  });

  it("[ter-month-coretax-under-withheld] a month whose slips withheld less than round(sum gross x rate) is still refused with 422", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [{ emp, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH }],
      MARCH_A,
    );
    // The old per-run engine: the THR alone is in the 0% bracket, so nothing
    // was withheld. The month's tax is 650.017, only 120.000 was deposited.
    await seedRun(
      world,
      "locked",
      [{ emp, gross: THR_GROSS, bp: 0, pph: 0 }],
      MARCH_B,
      "thr",
    );
    const response = await exportTax(world);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_TER_MISMATCH");
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[ter-month-coretax-over-withheld] a month whose slips withheld more than round(sum gross x rate) is refused with 422", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [{ emp, gross: SALARY_GROSS, bp: 150, pph: SALARY_PPH }],
      MARCH_A,
    );
    // 120.000 + 530.018 = 650.018, one rupiah more than the month's 650.017.
    await seedRun(
      world,
      "locked",
      [{ emp, gross: THR_GROSS, bp: TOTAL_BP, pph: THR_PPH_HALF_UP + 1 }],
      MARCH_B,
      "thr",
    );
    const response = await exportTax(world);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_TER_MISMATCH");
    expect(await exportCount(world.entityId)).toBe(0);
  });
});
