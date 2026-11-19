// One payroll run's PPh 21 end to end against PostgreSQL with the restricted
// app role (beads legend-iwgb, legend-oo3q, legend-y4wp; PRD v1.7 §3 D.30
// "PPh 21", PAYR-02, PAYR-03, R15, R20): tenant policy versions published by
// a payroll admin, a draft run priced with the version in force on the pay
// date, the version captured into the config snapshot at lock, a newer
// version published afterwards, the LOCKED run still priced with the pinned
// version, a DRAFT copy priced with the newer one, a tampered snapshot, tenant
// isolation, and a December annual recalculation through the same service.
//
// Every expected value was computed BY HAND (python3, exact integer
// arithmetic) from the PP 58/2023 Lampiran and the rules documented in
// payroll-pph21-ter.test.ts; none is copied from the engine. Integer IDR.
//
// Pay date 2026-11-28; policy v1 = rounding `down`, effective 2026-11-10;
// policy v2 = rounding `half_up`, effective 2026-11-20. Both are published on
// 2026-11-08 (`now` below), so the pay date falls under v2 once it exists.
// TER month (no December): tax = R(X x rate x (10000 + s) / 10^8) with ONE
// rounding R, s = 2000 bp only without NPWP. Brackets are the "s.d." bounds
// of the PP 58/2023 Lampiran (inclusive).
//
//   E1 TK/0 (A), NPWP, gross: lines 8.000.000 (taxable) + 500.000 (not
//      taxable, excluded) + employer BPJS benefit 155.567 -> X = 8.155.567,
//      bracket (7.500.000, 8.550.000] = 150 bp (1,5%),
//      X x 150 / 10^4 = 122.333,505 -> down 122.333, half up 122.334.
//   E2 K/1 (B), NPWP, gross 12.000.000 + gross_up 2.000.000. Tax allowance S =
//      least fixed point of S -> T(12.000.000 + 2.000.000 + S) - floor(T x
//      12.000.000 / X): S0 = 0, X = 14.000.000 (500 bp) T = 700.000
//      W = 600.000 -> S1 = 100.000; X = 14.100.000 T = 705.000 W = 600.000 ->
//      105.000; X = 14.105.000 T = 705.250 W = 600.000 -> 105.250;
//      X = 14.105.250 T = 705.262,5 (down 705.262, half up 705.263), W
//      599.999 (down) / 600.000 (half up) -> 105.263; X = 14.105.263
//      T = 705.263,15 -> 705.263, W = 599.999 -> 105.264; X = 14.105.264
//      T = 705.263,2 -> 705.263, W = 599.999 -> 105.264 (no increase: stop).
//      Final X = 14.105.264, T = 705.263, W = floor(705.263 x 12.000.000 /
//      14.105.264) = 599.999, A = 105.264 (all gross_up), borne 0,
//      withheld = W + A = 705.263. Same in both rounding modes.
//   E3 K/0 (A), NPWP, gross 6.000.000 + net 4.000.000. S0 = 0: X = 10.000.000
//      (200 bp) T = 200.000 W = 120.000 -> S = 80.000; X = 10.080.000 (225 bp)
//      T = 226.800 W = floor(226.800 x 6.000.000 / 10.080.000) = 135.000 ->
//      S = 91.800; then rounding decides the tail:
//      down:    X = 10.091.800 T = 227.065,5 -> 227.065 W 134.999 -> 92.066;
//               X = 10.092.066 T = 227.071,5 -> 227.071 W 134.999 -> 92.072;
//               X = 10.092.072 T = 227.071,62 -> 227.071 W 134.999 -> 92.072
//               stop. T = 227.071, W = 134.999, borne B = 92.072.
//      half_up: X = 10.091.800 T = 227.065,5 -> 227.066 W 135.000 -> 92.066;
//               X = 10.092.066 T = 227.071,485 -> 227.071 W 134.999 -> 92.072;
//               X = 10.092.072 T = 227.071,62 -> 227.072 W 135.000 -> 92.072
//               stop. T = 227.072, W = 135.000, borne B = 92.072.
//      allowance 0 (no gross_up line), withheld = W.
//   E4 TK/1 (A), NO NPWP, gross 9.000.333, bracket (8.550.000, 9.650.000] =
//      175 bp, s = 2000: 9.000.333 x 175 x 12.000 / 10^8 = 189.006,993 ->
//      down 189.006, half up 189.007.
//   E5 K/I/2 (normalised to K/2, category B), NPWP, gross 20.000.007,
//      bracket 800 bp: 20.000.007 x 800 / 10^4 = 1.600.000,56 -> down
//      1.600.000, half up 1.600.001.
//
// December (E6, TK/0, NPWP, pay date 2026-12-28, policy v2): annual
// recalculation. Prior 11 months: taxable gross 11 x 8.000.000 = 88.000.000,
// employee JHT/JP 11 x 120.000 = 1.320.000, PPh 21 withheld 1.320.000. Year:
// bruto 88.000.000 + 8.000.000 = 96.000.000; biaya jabatan min(5% =
// 4.800.000, 500.000 x 12 = 6.000.000) = 4.800.000; JHT/JP 1.320.000 + 120.000
// = 1.440.000; neto = 96.000.000 - 4.800.000 - 1.440.000 = 89.760.000; PTKP
// TK/0 54.000.000; PKP = 35.760.000 (already a whole thousand); tax 5% =
// 1.788.000; period tax = 1.788.000 - 1.320.000 = 468.000.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema, idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  DEFAULT_PPH21_POLICY,
  pph21ParametersHash,
  type PayslipTax,
  type Pph21PolicyRef,
} from "@starter/shared/hris/payroll";
import {
  calculatePayrollRunTax,
  capturePph21PolicyForLock,
  lockPayrollRunTax,
  type PayrollRunTaxEmployee,
  type PayrollRunTaxRun,
} from "../services/payroll-run-pph21.service.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createPph21PolicyVersion } from "../services/payroll-pph21-policy.service.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

// Own tenant: policy versions are numbered per tenant, so sharing the fixture
// tenant with payroll-pph21-policy-db.test.ts under 2 workers made both files
// collide (PAYROLL_PPH21_POLICY_CONFLICT, wrong version counts; bead
// legend-gx3i4). The fixture tenant is only the template for the tenant rows.
const fixtureTenant = cafeLegendPlatformFixtures.tenant;
const tenantId = randomUUID();
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

/** A user holding a custom role with exactly `permissions` tenant-wide. */
async function actor(permissions: string[]): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'PPh21 run DB', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `PPh21 run test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId],
    );
  });
  return userId;
}

async function clearPolicies() {
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, (client) =>
      client.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
        tenant,
      ]),
    );
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
async function failureCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("Expected the call to fail");
}

const date = (value: string) => businessDateSchema.parse(value);
const PAY_DATE = date("2026-11-28");
const DECEMBER_PAY_DATE = date("2026-12-28");
/** Policies are published on this day, before both effective dates. */
const NOW = new Date("2026-11-08T03:00:00Z");

// Month totals read payslips by employee id (a uuid column), so each label
// (E1..E6) maps to a real uuid; results are compared by label.
const EMPLOYEE_IDS = new Map<string, string>();
const idOf = (label: string): string => {
  let id = EMPLOYEE_IDS.get(label);
  if (id === undefined) {
    id = randomUUID();
    EMPLOYEE_IDS.set(label, id);
  }
  return id;
};
const labelOf = (id: string): string =>
  [...EMPLOYEE_IDS].find(([, value]) => value === id)?.[0] ?? id;

const employee = (
  label: string,
  fields: Omit<
    PayrollRunTaxEmployee,
    | "employeeId"
    | "lastTaxPeriod"
    | "monthsWorked"
    | "priorPeriods"
    | "lastPeriodEarlier"
  > &
    Partial<
      Pick<
        PayrollRunTaxEmployee,
        "lastTaxPeriod" | "monthsWorked" | "priorPeriods" | "lastPeriodEarlier"
      >
    >,
): PayrollRunTaxEmployee => ({
  employeeId: idOf(label),
  lastTaxPeriod: false,
  monthsWorked: 11,
  priorPeriods: [],
  lastPeriodEarlier: [],
  ...fields,
});

const EMPLOYEES: PayrollRunTaxEmployee[] = [
  employee("E1", {
    ptkpStatus: "TK/0",
    hasTaxId: true,
    earnings: [
      { amountIdr: 8_000_000, taxable: true, taxScheme: "gross" },
      { amountIdr: 500_000, taxable: false, taxScheme: "gross" },
    ],
    employerBenefitIdr: 155_567,
    employeeDeductibleIdr: 100_000,
  }),
  employee("E2", {
    ptkpStatus: "K/1",
    hasTaxId: true,
    earnings: [
      { amountIdr: 12_000_000, taxable: true, taxScheme: "gross" },
      { amountIdr: 2_000_000, taxable: true, taxScheme: "gross_up" },
    ],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
  }),
  employee("E3", {
    ptkpStatus: "K/0",
    hasTaxId: true,
    earnings: [
      { amountIdr: 6_000_000, taxable: true, taxScheme: "gross" },
      { amountIdr: 4_000_000, taxable: true, taxScheme: "net" },
    ],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
  }),
  employee("E4", {
    ptkpStatus: "TK/1",
    hasTaxId: false,
    earnings: [{ amountIdr: 9_000_333, taxable: true, taxScheme: "gross" }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
  }),
  employee("E5", {
    ptkpStatus: "K/I/2",
    hasTaxId: true,
    earnings: [{ amountIdr: 20_000_007, taxable: true, taxScheme: "gross" }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
  }),
];

/** PayslipTax with plain numbers (the Idr brand is irrelevant to toEqual). */
type PlainTax = {
  [K in keyof PayslipTax]: NonNullable<PayslipTax[K]> extends number
    ? number
    : PayslipTax[K];
};

const NO_REFUND = {
  pph21RefundIdr: 0,
  pph21EmployerRefundIdr: 0,
  pph21EmployerAllowanceRefundIdr: 0,
  // Pay left covers every TER tax here: nothing borne for the cap (legend-4ndx).
  pph21ReceivableIdr: 0,
  method: "ter",
} as const;

/** Expected TER payslip tax, written out field by field. */
const expectedTax = (
  fields: Pick<
    PlainTax,
    | "ptkpStatus"
    | "terCategory"
    | "terRateBp"
    | "taxableGrossIdr"
    | "pph21Idr"
    | "pph21WithheldIdr"
    | "taxAllowanceIdr"
    | "pph21EmployerBorneIdr"
    | "noTaxIdSurchargeApplied"
    | "grossSchemeBaseIdr"
  >,
): PlainTax => ({
  ...NO_REFUND,
  ...fields,
  // The rest of X (gross-up / net lines, covered tax) is the employer's.
  employerSchemeBaseIdr: fields.taxableGrossIdr - fields.grossSchemeBaseIdr,
});

// Policy v1 (rounding down).
const EXPECTED_V1: Record<string, PlainTax> = {
  E1: expectedTax({
    ptkpStatus: "TK/0",
    terCategory: "A",
    terRateBp: 150,
    taxableGrossIdr: 8_155_567,
    pph21Idr: 122_333,
    pph21WithheldIdr: 122_333,
    taxAllowanceIdr: 0,
    pph21EmployerBorneIdr: 0,
    grossSchemeBaseIdr: 8_155_567,
    noTaxIdSurchargeApplied: false,
  }),
  E2: expectedTax({
    ptkpStatus: "K/1",
    terCategory: "B",
    terRateBp: 500,
    taxableGrossIdr: 14_105_264,
    pph21Idr: 705_263,
    pph21WithheldIdr: 705_263,
    taxAllowanceIdr: 105_264,
    pph21EmployerBorneIdr: 0,
    grossSchemeBaseIdr: 12_000_000,
    noTaxIdSurchargeApplied: false,
  }),
  E3: expectedTax({
    ptkpStatus: "K/0",
    terCategory: "A",
    terRateBp: 225,
    taxableGrossIdr: 10_092_072,
    pph21Idr: 227_071,
    pph21WithheldIdr: 134_999,
    taxAllowanceIdr: 0,
    pph21EmployerBorneIdr: 92_072,
    grossSchemeBaseIdr: 6_000_000,
    noTaxIdSurchargeApplied: false,
  }),
  E4: expectedTax({
    ptkpStatus: "TK/1",
    terCategory: "A",
    terRateBp: 175,
    taxableGrossIdr: 9_000_333,
    pph21Idr: 189_006,
    pph21WithheldIdr: 189_006,
    taxAllowanceIdr: 0,
    pph21EmployerBorneIdr: 0,
    grossSchemeBaseIdr: 9_000_333,
    noTaxIdSurchargeApplied: true,
  }),
  E5: expectedTax({
    ptkpStatus: "K/I/2",
    terCategory: "B",
    terRateBp: 800,
    taxableGrossIdr: 20_000_007,
    pph21Idr: 1_600_000,
    pph21WithheldIdr: 1_600_000,
    taxAllowanceIdr: 0,
    pph21EmployerBorneIdr: 0,
    grossSchemeBaseIdr: 20_000_007,
    noTaxIdSurchargeApplied: false,
  }),
};

// Policy v2 (rounding half up): only the amounts the rounding moves differ.
const EXPECTED_V2: Record<string, PlainTax> = {
  ...EXPECTED_V1,
  E1: { ...EXPECTED_V1.E1!, pph21Idr: 122_334, pph21WithheldIdr: 122_334 },
  E3: { ...EXPECTED_V1.E3!, pph21Idr: 227_072, pph21WithheldIdr: 135_000 },
  E4: { ...EXPECTED_V1.E4!, pph21Idr: 189_007, pph21WithheldIdr: 189_007 },
  E5: { ...EXPECTED_V1.E5!, pph21Idr: 1_600_001, pph21WithheldIdr: 1_600_001 },
};

const taxesOf = (result: {
  payslips: { employeeId: string; tax: PayslipTax }[];
}) =>
  Object.fromEntries(
    result.payslips.map((p) => [labelOf(p.employeeId), p.tax]),
  );

let admin: string;
let v1Ref: Pph21PolicyRef;
let v2Ref: Pph21PolicyRef;
let lockedRun: PayrollRunTaxRun;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'PPh21 run tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `pph21-runt-${tenantId.slice(0, 8)}`, fixtureTenant.id],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'PPh21 run RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `pph21-run-${otherTenant.slice(0, 8)}`, fixtureTenant.id],
  );
  await clearPolicies();
  admin = await actor(["payroll.view", "payroll.run"]);
  await seedRunRows(tenantId);
  await seedRunRows(otherTenant);
});

afterAll(async () => {
  await clearPolicies();
  await dropRunRows(tenantId);
  await dropRunRows(otherTenant);
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  // Audit rows are append-only (trigger): suspend it for one purge so both
  // tenants can really be removed; a failure here must be visible.
  const purge = await owner.connect();
  try {
    await purge.query("BEGIN");
    await purge.query(
      "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
    );
    await purge.query("DELETE FROM audit_logs WHERE tenant_id = ANY($1)", [
      [tenantId, otherTenant],
    ]);
    await purge.query(
      "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
    );
    await purge.query("COMMIT");
  } catch (error) {
    await purge.query("ROLLBACK");
    throw error;
  } finally {
    purge.release();
  }
  for (const tenant of [tenantId, otherTenant])
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

const draftRun = (payDate = PAY_DATE): PayrollRunTaxRun => ({
  status: "draft",
  payDate,
  configSnapshot: null,
});
// `monthScope` ({ runId }) is required: the service reads the legal entity and
// the pay date of the run from its row, so every pay date used below has a draft run row in
// each tenant (periods differ so no two runs of a tenant share one).
type Seeded = { entityId: string; runs: Map<string, string> };
const seeded = new Map<string, Seeded>();
const RUN_ROWS: [string, string, string][] = [
  // pay date, period start, period end
  ["2026-11-28", "2026-11-01", "2026-11-30"],
  ["2026-11-09", "2026-10-01", "2026-10-31"],
  ["2026-12-28", "2026-12-01", "2026-12-31"],
];

async function seedRunRows(tenant: string): Promise<void> {
  const entityId = randomUUID();
  const policyId = randomUUID();
  const runs = new Map<string, string>();
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT PPh21 Run DB', false)`,
      [entityId, tenant],
    );
    const code = `RD${policyId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan PPh21 run', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenant, entityId, code, JSON.stringify({ code })],
    );
    for (const [payDate, start, end] of RUN_ROWS) {
      const runId = randomUUID();
      runs.set(payDate, runId);
      await client.query(
        `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                   period_start, period_end, pay_date, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $6, $7, 'pph21-run-db-test')`,
        [runId, tenant, entityId, policyId, start, end, payDate],
      );
    }
  });
  seeded.set(tenant, { entityId, runs });
}

async function dropRunRows(tenant: string): Promise<void> {
  const rows = seeded.get(tenant);
  if (!rows) return;
  await asOwner(tenant, async (client) => {
    await client.query("DELETE FROM payroll_runs WHERE id = ANY($1)", [
      [...rows.runs.values()],
    ]);
    await client.query(
      "DELETE FROM payroll_policies WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant, rows.entityId],
    );
    await client.query("DELETE FROM legal_entities WHERE id = $1", [
      rows.entityId,
    ]);
  });
}

const scopeOf = (run: PayrollRunTaxRun, tenant: string) => {
  const rows = seeded.get(tenant)!;
  const runId = rows.runs.get(run.payDate);
  if (runId === undefined) throw new Error(`no run row for ${run.payDate}`);
  return { runId: runId as never };
};
const inputOf = (
  run: PayrollRunTaxRun,
  employees: PayrollRunTaxEmployee[],
  tenant: string,
) => ({
  run,
  tables: REFERENCE_TABLES,
  employees,
  monthScope: scopeOf(run, tenant),
});

const calculate = (
  run: PayrollRunTaxRun,
  employees: PayrollRunTaxEmployee[] = EMPLOYEES,
  tenant: string = tenantId,
) =>
  withTenant(db, tenantScope(tenant), (tx) =>
    calculatePayrollRunTax(
      tenantScope(tenant),
      inputOf(run, employees, tenant),
      tx,
    ),
  );

describe("payroll run PPh 21: one run from draft to lock to a newer policy", () => {
  it("prices a draft run with the default policy while the tenant has no version", async () => {
    const result = await calculate(draftRun());
    expect(result.pph21Policy).toBeNull();
    expect(result.parameters).toEqual(DEFAULT_PPH21_POLICY);
    // Default is half up: the same amounts as policy v2 below.
    expect(taxesOf(result)).toEqual(EXPECTED_V2);
    expect(await capturePph21PolicyForLock(tenantScope(), PAY_DATE)).toBeNull();
  });

  it("publishes v1 (down) and prices the draft run with it", async () => {
    const v1 = await createPph21PolicyVersion(
      tenantScope(),
      admin,
      {
        effectiveFrom: date("2026-11-10"),
        parameters: { ...DEFAULT_PPH21_POLICY, roundingMode: "down" },
        reason: "Saran konsultan pajak 2026",
      },
      NOW,
    );
    v1Ref = {
      versionId: v1.id,
      version: 1,
      effectiveFrom: date("2026-11-10"),
      parametersHash: pph21ParametersHash({
        ...DEFAULT_PPH21_POLICY,
        roundingMode: "down",
      }),
    };
    const result = await calculate(draftRun());
    expect(result.pph21Policy).toEqual(v1Ref);
    expect(result.parameters.roundingMode).toBe("down");
    expect(taxesOf(result)).toEqual(EXPECTED_V1);
    // A pay date before v1 still gets the default (half up).
    const early = await calculate(draftRun(date("2026-11-09")));
    expect(early.pph21Policy).toBeNull();
    expect(taxesOf(early)).toEqual(EXPECTED_V2);
  });

  it("locks: the snapshot captures v1", async () => {
    const captured = await capturePph21PolicyForLock(tenantScope(), PAY_DATE);
    expect(captured).toEqual(v1Ref);
    lockedRun = {
      status: "locked",
      payDate: PAY_DATE,
      configSnapshot: { pph21Policy: captured },
    };
    const locked = await calculate(lockedRun);
    expect(locked.pph21Policy).toEqual(v1Ref);
    expect(taxesOf(locked)).toEqual(EXPECTED_V1);
  });

  it("keeps the locked run on v1 after v2 is published, and prices a draft copy with v2", async () => {
    const v2 = await createPph21PolicyVersion(
      tenantScope(),
      admin,
      {
        effectiveFrom: date("2026-11-20"),
        parameters: { ...DEFAULT_PPH21_POLICY, roundingMode: "half_up" },
        reason: "Coretax mulai berlaku",
      },
      NOW,
    );
    expect(v2.version).toBe(2);
    v2Ref = {
      versionId: v2.id,
      version: 2,
      effectiveFrom: date("2026-11-20"),
      parametersHash: pph21ParametersHash({
        ...DEFAULT_PPH21_POLICY,
        roundingMode: "half_up",
      }),
    };

    // The locked run is identical to before: v1 is pinned.
    const locked = await calculate(lockedRun);
    expect(locked.pph21Policy).toEqual(v1Ref);
    expect(taxesOf(locked)).toEqual(EXPECTED_V1);
    // Same for a paid run with that snapshot.
    const paid = await calculate({ ...lockedRun, status: "paid" });
    expect(taxesOf(paid)).toEqual(EXPECTED_V1);

    // A draft copy of the same run (same pay date) uses v2.
    const draft = await calculate(draftRun());
    expect(draft.pph21Policy).toEqual(v2Ref);
    expect(draft.parameters.roundingMode).toBe("half_up");
    expect(taxesOf(draft)).toEqual(EXPECTED_V2);
    // The amounts the rounding moves: E1, E3, E4, E5; E2 does not move.
    const moved = Object.keys(EXPECTED_V1).filter(
      (id) => EXPECTED_V1[id]!.pph21Idr !== EXPECTED_V2[id]!.pph21Idr,
    );
    expect(moved).toEqual(["E1", "E3", "E4", "E5"]);

    expect(await capturePph21PolicyForLock(tenantScope(), PAY_DATE)).toEqual(
      v2Ref,
    );
  });

  it("refuses a tampered snapshot with PAYROLL_SNAPSHOT_MISMATCH", async () => {
    const tampered = (pph21Policy: Pph21PolicyRef): PayrollRunTaxRun => ({
      ...lockedRun,
      configSnapshot: { pph21Policy },
    });
    // Wrong version number, wrong effective date, unknown version id.
    expect(
      await failureCode(calculate(tampered({ ...v1Ref, version: 2 }))),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    expect(
      await failureCode(
        calculate(tampered({ ...v1Ref, effectiveFrom: date("2026-11-11") })),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    expect(
      await failureCode(
        calculate(tampered({ ...v1Ref, versionId: randomUUID() as never })),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // A frozen run without a snapshot.
    expect(
      await failureCode(calculate({ ...lockedRun, configSnapshot: null })),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
  });

  it("does not show tenant A's policy to tenant B", async () => {
    // A draft run of tenant B gets the default policy (half up).
    const draft = await calculate(draftRun(), EMPLOYEES, otherTenant);
    expect(draft.pph21Policy).toBeNull();
    expect(draft.parameters).toEqual(DEFAULT_PPH21_POLICY);
    expect(taxesOf(draft)).toEqual(EXPECTED_V2);
    expect(
      await capturePph21PolicyForLock(tenantScope(otherTenant), PAY_DATE),
    ).toBeNull();
    // Tenant A's pinned version does not exist for tenant B.
    expect(
      await failureCode(calculate(lockedRun, EMPLOYEES, otherTenant)),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // A tenant B run locked with "no version" stays on the default policy.
    const lockedDefault = await calculate(
      {
        status: "locked",
        payDate: PAY_DATE,
        configSnapshot: { pph21Policy: null },
      },
      EMPLOYEES,
      otherTenant,
    );
    expect(lockedDefault.pph21Policy).toBeNull();
    expect(taxesOf(lockedDefault)).toEqual(EXPECTED_V2);
  });

  it("keeps a run locked with 'no version' on the default after a version is published", async () => {
    // Tenant A has v1 and v2 now; a snapshot that pinned null still means the
    // default policy (half up), not v1 (down).
    const pinnedDefault = await calculate({
      status: "locked",
      payDate: PAY_DATE,
      configSnapshot: { pph21Policy: null },
    });
    expect(pinnedDefault.pph21Policy).toBeNull();
    expect(pinnedDefault.parameters).toEqual(DEFAULT_PPH21_POLICY);
    expect(taxesOf(pinnedDefault)).toEqual(EXPECTED_V2);
  });

  it("recalculates December for one employee with prior year-to-date amounts", async () => {
    const december = employee("E6", {
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: true,
      monthsWorked: 12,
      earnings: [{ amountIdr: 8_000_000, taxable: true, taxScheme: "gross" }],
      employerBenefitIdr: 0,
      employeeDeductibleIdr: 120_000,
      // Jan-Nov: 8_000_000 gross a month, TER A 1.5% = 120_000 withheld,
      // JHT/JP 120_000. Sums: X 88_000_000, deductible 1_320_000, withheld
      // 1_320_000, borne 0.
      priorPeriods: Array.from({ length: 11 }, () => ({
        employeeDeductibleIdr: 120_000,
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
      })),
    });
    const result = await calculate(draftRun(DECEMBER_PAY_DATE), [december]);
    // v2 is in force on 2026-12-28.
    expect(result.pph21Policy).toEqual(v2Ref);
    expect(
      result.payslips.map(({ employeeId, tax }) => ({
        employeeId: labelOf(employeeId),
        tax,
      })),
    ).toEqual([
      {
        employeeId: "E6",
        tax: {
          ptkpStatus: "TK/0",
          method: "annual_recalculation",
          terCategory: null,
          terRateBp: null,
          taxableGrossIdr: 8_000_000,
          pph21Idr: 468_000,
          pph21WithheldIdr: 468_000,
          taxAllowanceIdr: 0,
          pph21EmployerBorneIdr: 0,
          pph21RefundIdr: 0,
          pph21EmployerRefundIdr: 0,
          pph21EmployerAllowanceRefundIdr: 0,
          // W 468_000 is within the pay left (8_000_000 - 120_000).
          pph21ReceivableIdr: 0,
          noTaxIdSurchargeApplied: false,
          grossSchemeBaseIdr: 8_000_000,
          employerSchemeBaseIdr: 0,
        },
      },
    ]);
  });

  it("refuses a pinned ref whose parameters hash differs", async () => {
    // Right id, number and date, but the hash of another parameter set (v2's
    // instead of v1's): the stored version no longer matches what was pinned.
    expect(
      await failureCode(
        calculate({
          ...lockedRun,
          configSnapshot: {
            pph21Policy: { ...v1Ref, parametersHash: v2Ref.parametersHash },
          },
        }),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
  });

  const approvedRun = (): PayrollRunTaxRun => ({
    status: "approved",
    payDate: PAY_DATE,
    configSnapshot: null,
  });
  // The lock step approved with the month basis a simulation of the same run
  // just stored (nothing locks between them here, so it is never stale).
  const lockIn = (approved: Pph21PolicyRef | null, tenant: string = tenantId) =>
    withTenant(db, tenantScope(tenant), async (tx) => {
      const input = inputOf(approvedRun(), EMPLOYEES, tenant);
      const simulated = await calculatePayrollRunTax(
        tenantScope(tenant),
        input,
        tx,
      );
      const basis = new Map(
        simulated.payslips.flatMap((p) =>
          p.monthBasis === undefined
            ? []
            : [[p.employeeId, p.monthBasis] as const],
        ),
      );
      return lockPayrollRunTax(tenantScope(tenant), input, approved, tx, basis);
    });

  it("locks with the ref the run was approved with, pinned from the same computation as the payslips", async () => {
    // v2 is in force on the pay date and was shown at approval.
    const locked = await lockIn(v2Ref);
    expect(locked.pph21Policy).toEqual(v2Ref);
    expect(taxesOf(locked)).toEqual(EXPECTED_V2);
    // Capture inside a transaction with the same approved ref.
    expect(
      await withTenant(db, tenantScope(), (tx) =>
        capturePph21PolicyForLock(tenantScope(), PAY_DATE, {
          tx,
          approved: v2Ref,
        }),
      ),
    ).toEqual(v2Ref);
  });

  it("refuses the lock when the approved version is no longer the one in force", async () => {
    // Approved while v1 was in force; v2 was published since.
    expect(await failureCode(lockIn(v1Ref))).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // Approved with the default policy (null) while a version is in force.
    expect(await failureCode(lockIn(null))).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // Same id/number/date but other parameters hash.
    expect(
      await failureCode(
        lockIn({ ...v2Ref, parametersHash: v1Ref.parametersHash }),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    expect(
      await failureCode(
        withTenant(db, tenantScope(), (tx) =>
          capturePph21PolicyForLock(tenantScope(), PAY_DATE, {
            tx,
            approved: v1Ref,
          }),
        ),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // Tenant B has no version: approved with tenant A's ref is refused, with
    // null accepted.
    expect(await failureCode(lockIn(v2Ref, otherTenant))).toBe(
      "PAYROLL_SNAPSHOT_MISMATCH",
    );
    expect((await lockIn(null, otherTenant)).pph21Policy).toBeNull();
  });

  it("refuses a lock when v3 is published between approval and lock", async () => {
    // Approval showed v2; the payslips of the lock would use v3 (down).
    const v3 = await createPph21PolicyVersion(
      tenantScope(),
      admin,
      {
        effectiveFrom: date("2026-11-25"),
        parameters: { ...DEFAULT_PPH21_POLICY, roundingMode: "down" },
        reason: "Koreksi saran konsultan",
      },
      NOW,
    );
    expect(v3.version).toBe(3);
    expect(await failureCode(lockIn(v2Ref))).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // Approving again against v3 locks with v3, payslips and ref in step.
    const v3Ref = {
      versionId: v3.id,
      version: 3,
      effectiveFrom: date("2026-11-25"),
      parametersHash: v1Ref.parametersHash,
    };
    const relocked = await lockIn(v3Ref);
    expect(relocked.pph21Policy).toEqual(v3Ref);
    expect(taxesOf(relocked)).toEqual(EXPECTED_V1);
  });
});
