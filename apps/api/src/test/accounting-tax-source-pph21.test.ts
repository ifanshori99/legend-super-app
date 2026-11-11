// PPh 21 tax report source (bead legend-v4v7c, slice D of 538-G3; PRD v1.7 §3.19
// "Pajak", Coretax e-Bupot per employee). Runs defaultTaxLineSource (type 'pph21')
// inside withTenant against the disposable PostgreSQL database; payroll runs,
// sealed payslips, employees and ledger rows are seeded as the migration owner.
//
// Rules under test (CTO decisions, docs/briefs/538-g3-sub.md "Slice D"):
// - One line per employee, built from the payslips of POSTED payroll runs
//   (status locked or paid) whose period falls in the report period. Payslips
//   are sealed (payroll-sealed); the line's tax is the payslip's tax.pph21Idr
//   and its base the payslip's taxable gross, summed over the employee's runs.
// - Draft/simulated/approved runs and runs of other periods are ignored.
// - The payslip total must equal the ledger credit on the account mapped to
//   pph21_payable, counting only journal entries whose effective source is
//   'payroll' (a reversal counts as the entry it reverses; remittances and
//   opening balances never count). Any difference, a missing posting or an
//   unmapped role fails generation with TAX_REPORT_SOURCE_UNAVAILABLE.
// - The tax id is masked (only the last four digits are shown), never the
//   sealed value; an employee without NPWP has taxIdMasked null.
// - Everything is scoped to the caller's tenant and the requested legal entity.
//
// Assumptions (the spec leaves these open):
// - "Period in report period" = the run's period_end falls in that month; the
//   payroll journal is dated on the period end (see payroll-gl-consumer).
// - An employee without NPWP still gets a line with taxIdMasked null (design
//   note: "null if none"); no 422 for pph21, which is legal at the surcharge rate.
// - A run reversed through the payroll flow has status 'reversed' (excluded from
//   the payslips) and a mirrored 'reversal' journal entry, so both sides net out.
// - A line's base is the sum of tax.taxableGrossIdr over the employee's payslips.
// - Zero tax with no runs nets to an empty array.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { payslipCalculationSchema } from "@starter/shared/hris/payroll/payslips";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HRIS_PII_KEY_VERSION, sealHrisPii } from "../lib/hris-pii";
import { sealPayrollValue } from "../lib/payroll-sealed";
import { defaultTaxLineSource } from "../services/accounting-tax-line-source";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

afterAll(async () => {
  await owner.end();
});

const scopedContext = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

/** Owner transaction scoped to one tenant; `raw` turns triggers off (replica). */
async function asOwner<T>(
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---- Fixtures ----------------------------------------------------------------

type Tenant = { tenantId: string; brandId: string };

/** A fresh tenant (copied from the seeded one, so plan and limits are valid). */
async function makeTenant(): Promise<Tenant> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Pajak PPh21 uji', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `pph21-src-${tenantId.slice(0, 8)}`, fixtureTenant],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  return { tenantId, brandId };
}

type World = {
  tenantId: string;
  entity: string;
  outletId: string;
  cash: string;
  expense: string;
  pph21: string;
  oct: string;
  nov: string;
};

/** A legal entity with an outlet, accounts, mappings and Oct/Nov fiscal periods. */
async function makeEntity(
  tenant: Tenant,
  { mapPph21 = true }: { mapPph21?: boolean } = {},
): Promise<World> {
  const { tenantId, brandId } = tenant;
  const entity = randomUUID();
  const outletId = randomUUID();
  const accounts = {
    cash: randomUUID(),
    expense: randomUUID(),
    pph21: randomUUID(),
  };
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `PT PPh21 ${unique()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PPh21', 'Jl. Pajak', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `PP-${unique()}`.toUpperCase()],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'current_asset'),
            ($2, $4, $5, '6101', 'Beban Gaji', 'expense', 'operating_expense'),
            ($3, $4, $5, '2202', 'Utang PPh 21', 'liability', 'current_liability')`,
    [accounts.cash, accounts.expense, accounts.pph21, tenantId, entity],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'cash_on_hand', $3), ($1, $2, 'salary_expense', $4)`,
    [tenantId, entity, accounts.cash, accounts.expense],
  );
  if (mapPph21)
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'pph21_payable', $3)`,
      [tenantId, entity, accounts.pph21],
    );
  const periods = await owner.query<{ id: string; period: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-10'), ($1, $2, '2026-11') RETURNING id, period`,
    [tenantId, entity],
  );
  const periodId = (period: string) =>
    periods.rows.find((row) => row.period === period)!.id;
  return {
    tenantId,
    entity,
    outletId,
    ...accounts,
    oct: periodId("2026-10"),
    nov: periodId("2026-11"),
  };
}

type Employee = { id: string; name: string; npwp: string | null };

async function makeEmployee(
  world: World,
  { name, npwp }: { name: string; npwp: string | null },
): Promise<Employee> {
  const id = randomUUID();
  const sealed = npwp
    ? sealHrisPii(
        npwp,
        {
          tenantId: world.tenantId,
          table: "employees",
          rowId: id,
          field: "npwp",
        },
        HRIS_PII_KEY_VERSION,
      )
    : null;
  await owner.query(
    `INSERT INTO employees (id, tenant_id, legal_entity_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status, npwp_encrypted, npwp_hmac, pii_key_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'pkwt', '2026-01-01', 'active', $7, $8, $9)`,
    [
      id,
      world.tenantId,
      world.entity,
      `E-${unique().toUpperCase()}`,
      name,
      world.outletId,
      sealed,
      npwp ? randomBytes(32).toString("hex") : null,
      HRIS_PII_KEY_VERSION,
    ],
  );
  return { id, name, npwp };
}

/** A valid TER payslip calculation: one taxable salary line, PPh 21 withheld. */
function calculationOf(
  world: World,
  employee: Employee,
  slip: { baseIdr: number; taxIdr: number },
  periodStart: string,
  periodEnd: string,
) {
  const { baseIdr, taxIdr } = slip;
  return payslipCalculationSchema.parse({
    employeeId: employee.id,
    employeeNo: "EMP-0001",
    employeeName: employee.name,
    positionName: null,
    outletId: world.outletId,
    periodStart,
    periodEnd,
    payDate: periodEnd,
    grossIdr: baseIdr,
    deductionsIdr: taxIdr,
    netIdr: baseIdr - taxIdr,
    pph21Idr: taxIdr,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines: [
      {
        componentCode: "BASIC",
        name: "Gaji pokok",
        category: "base_salary",
        kind: "earning",
        amountIdr: baseIdr,
        taxable: true,
        quantity: null,
        sourceId: null,
      },
      {
        componentCode: "PPH21",
        name: "PPh 21",
        category: "pph21",
        kind: "deduction",
        amountIdr: taxIdr,
        taxable: false,
        quantity: null,
        sourceId: null,
      },
    ],
    bpjs: [],
    tax: {
      ptkpStatus: "TK/0",
      method: "ter",
      terCategory: "A",
      terRateBp: 250,
      taxableGrossIdr: baseIdr,
      pph21Idr: taxIdr,
      pph21WithheldIdr: taxIdr,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: employee.npwp === null,
      grossSchemeBaseIdr: baseIdr,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: "cash",
  });
}

const RUN_STEPS = {
  simulated: `status = 'simulated'`,
  hr_approved: `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  approved: `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  locked: `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
  paid: `status = 'paid', paid_at = now(), paid_by = 'pay-user'`,
  reversed: `status = 'reversed', reversal = '{"status":"approved"}'`,
} as const;
type RunStatus = "draft" | "approved" | "locked" | "paid" | "reversed";
const PATHS: Record<RunStatus, (keyof typeof RUN_STEPS)[]> = {
  draft: [],
  approved: ["simulated", "hr_approved", "approved"],
  locked: ["simulated", "hr_approved", "approved", "locked"],
  paid: ["simulated", "hr_approved", "approved", "locked", "paid"],
  reversed: ["simulated", "hr_approved", "approved", "locked", "reversed"],
};

type Slip = { employee: Employee; baseIdr: number; taxIdr: number };

type PostedRun = {
  runId: string;
  entryId: string | null;
  taxIdr: number;
};

type PostLedger =
  | "match" // one payroll entry crediting exactly the payslip PPh 21
  | "none" // no ledger posting at all
  | number; // payroll entry crediting this amount instead

type Period = "2026-10" | "2026-11";
const PERIODS = {
  "2026-10": { start: "2026-10-01", end: "2026-10-31" },
  "2026-11": { start: "2026-11-01", end: "2026-11-30" },
} as const;

/**
 * A payroll run with sealed payslips for the given employees, walked to
 * `status`. Posted runs (locked/paid/reversed) get the payroll journal entry
 * the GL consumer would post: expense debit, cash and PPh 21 payable credits.
 */
async function seedRun(
  world: World,
  {
    status,
    slips,
    period = "2026-11",
    runType = "regular",
    ledger = "match",
  }: {
    status: RunStatus;
    slips: Slip[];
    period?: Period;
    runType?: "regular" | "off_cycle";
    ledger?: PostLedger;
  },
): Promise<PostedRun> {
  const { tenantId } = world;
  const { start, end } = PERIODS[period];
  const runId = randomUUID();
  await asOwner(tenantId, async (client) => {
    // One policy per entity (unique per tenant, entity and group code).
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan PPh21', 'GK', '{"code":"GK"}', '{"kind":"monthly"}', 'none', 'low', '[]')
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, world.entity],
    );
    const policy = await client.query<{ id: string }>(
      `SELECT id FROM payroll_policies
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND employee_group_code = 'GK'`,
      [tenantId, world.entity],
    );
    const policyId = policy.rows[0]!.id;
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'pph21-source-test')`,
      [runId, tenantId, world.entity, policyId, runType, start, end],
    );
    for (const step of PATHS[status])
      await client.query(
        `UPDATE payroll_runs SET ${RUN_STEPS[step]} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
  });
  // Payslips are written with triggers off so a draft or approved run can hold
  // them too (the report must still ignore those).
  await asOwner(
    tenantId,
    async (client) => {
      for (const slip of slips) {
        const payslipId = randomUUID();
        const calc = calculationOf(world, slip.employee, slip, start, end);
        await client.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                                 calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'cash', $5, $6)`,
          [
            payslipId,
            tenantId,
            runId,
            slip.employee.id,
            sealPayrollValue(
              JSON.stringify(calc),
              {
                tenantId,
                table: "payslips",
                rowId: payslipId,
                field: "calculation",
              },
              HRIS_PII_KEY_VERSION,
            ),
            HRIS_PII_KEY_VERSION,
          ],
        );
      }
    },
    true,
  );

  const taxIdr = slips.reduce((sum, s) => sum + s.taxIdr, 0);
  const posted =
    status === "locked" || status === "paid" || status === "reversed";
  let entryId: string | null = null;
  if (posted && ledger !== "none") {
    const credited = ledger === "match" ? taxIdr : ledger;
    const gross = slips.reduce((sum, s) => sum + s.baseIdr, 0);
    entryId = await postEntry(world, {
      period: period === "2026-10" ? world.oct : world.nov,
      entryDate: end,
      sourceType: "payroll",
      sourceId: runId,
      lines: [
        [world.expense, gross, 0],
        [world.cash, 0, gross - credited],
        [world.pph21, 0, credited],
      ],
    });
    if (status === "reversed")
      await reverseEntry(
        world,
        entryId,
        period === "2026-10" ? world.oct : world.nov,
        end,
        [
          [world.expense, 0, gross],
          [world.cash, gross - credited, 0],
          [world.pph21, credited, 0],
        ],
      );
  }
  return { runId, entryId, taxIdr };
}

type Posting = [account: string, debitIdr: number, creditIdr: number];

/** One balanced journal entry in its own transaction. Zero-sided lines are kept. */
async function postEntry(
  world: World,
  input: {
    period: string;
    entryDate: string;
    sourceType: "payroll" | "manual" | "opening_balance" | "reversal";
    sourceId?: string | null;
    reversalOf?: string;
    lines: Posting[];
  },
): Promise<string> {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PPh 21 source test', $8, $9, $10)
       RETURNING id`,
      [
        world.tenantId,
        world.entity,
        world.outletId,
        input.entryDate,
        input.period,
        input.sourceType,
        input.sourceId ?? null,
        input.reversalOf ?? null,
        `pph21-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const [account, debit, credit] of input.lines) {
      if (debit === 0 && credit === 0) continue;
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          world.tenantId,
          entryId,
          account,
          world.outletId,
          lineNo++,
          debit,
          credit,
        ],
      );
    }
    await client.query("COMMIT");
    return entryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const reverseEntry = (
  world: World,
  entryId: string,
  period: string,
  date: string,
  lines: Posting[],
) =>
  postEntry(world, {
    period,
    entryDate: date,
    sourceType: "reversal",
    reversalOf: entryId,
    lines,
  });

const pph21Lines = (world: World, period = "2026-11") =>
  withTenant(db, scopedContext(world.tenantId), (tx) =>
    defaultTaxLineSource(tx, {
      tenantId: world.tenantId,
      legalEntityId: world.entity,
      type: "pph21",
      period,
    }),
  );

type Lines = Awaited<ReturnType<typeof pph21Lines>>;
const lineOf = (lines: Lines, employee: Employee) =>
  lines.find((line) => line.subjectId === employee.id);

// ---- Tests ---------------------------------------------------------------------

describe("legend-v4v7c PPh 21 tax line source", () => {
  it("legend-v4v7c reports one line per employee from locked and paid runs, summed over runs", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari Wulandari",
      npwp: "012345678901234",
    });
    const budi = await makeEmployee(world, {
      name: "Budi Santoso",
      npwp: "098765432109876",
    });
    await seedRun(world, {
      status: "locked",
      slips: [
        { employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 },
        { employee: budi, baseIdr: 6_000_000, taxIdr: 90_000 },
      ],
    });
    // A second, paid off-cycle run in the same period adds to Sari's line.
    await seedRun(world, {
      status: "paid",
      runType: "off_cycle",
      slips: [{ employee: sari, baseIdr: 4_000_000, taxIdr: 120_000 }],
    });

    const lines = await pph21Lines(world);

    expect(lines).toHaveLength(2);
    expect(lineOf(lines, sari)).toMatchObject({
      subjectType: "employee",
      subjectId: sari.id,
      subjectName: "Sari Wulandari",
      outletId: world.outletId,
      baseIdr: 14_000_000,
      taxIdr: 370_000,
    });
    expect(lineOf(lines, budi)).toMatchObject({
      subjectType: "employee",
      subjectName: "Budi Santoso",
      baseIdr: 6_000_000,
      taxIdr: 90_000,
    });
    // The lines add up to what the ledger holds on PPh 21 payable.
    expect(lines.reduce((sum, line) => sum + line.taxIdr, 0)).toBe(460_000);
  });

  it("legend-v4v7c shows the NPWP masked to its last four digits, null when the employee has none", async () => {
    const world = await makeEntity(await makeTenant());
    const withNpwp = await makeEmployee(world, {
      name: "Dewi Lestari",
      npwp: "012345678901234",
    });
    const without = await makeEmployee(world, {
      name: "Eko Prasetyo",
      npwp: null,
    });
    await seedRun(world, {
      status: "locked",
      slips: [
        { employee: withNpwp, baseIdr: 8_000_000, taxIdr: 120_000 },
        { employee: without, baseIdr: 8_000_000, taxIdr: 150_000 },
      ],
    });

    const lines = await pph21Lines(world);

    const masked = lineOf(lines, withNpwp)!.taxIdMasked!;
    expect(masked).toMatch(/1234$/);
    expect(masked).not.toContain("012345678901234");
    expect(masked).not.toContain("0123456789");
    expect(masked.length).toBeLessThanOrEqual(30);
    expect(lineOf(lines, without)!.taxIdMasked).toBeNull();
    // Nothing in the report carries the full number.
    expect(JSON.stringify(lines)).not.toContain("012345678901234");
  });

  it("legend-v4v7c ignores draft and approved runs, which are not posted to the ledger", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const budi = await makeEmployee(world, {
      name: "Budi",
      npwp: "098765432109876",
    });
    await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    await seedRun(world, {
      status: "draft",
      runType: "off_cycle",
      slips: [{ employee: budi, baseIdr: 5_000_000, taxIdr: 75_000 }],
    });
    await seedRun(world, {
      status: "approved",
      runType: "off_cycle",
      slips: [{ employee: budi, baseIdr: 7_000_000, taxIdr: 100_000 }],
    });

    const lines = await pph21Lines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      subjectId: sari.id,
      taxIdr: 250_000,
      baseIdr: 10_000_000,
    });
    expect(lineOf(lines, budi)).toBeUndefined();
  });

  it("legend-v4v7c keeps each period to its own runs", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      period: "2026-10",
      slips: [{ employee: sari, baseIdr: 9_000_000, taxIdr: 180_000 }],
    });
    await seedRun(world, {
      status: "paid",
      period: "2026-11",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    const nov = await pph21Lines(world, "2026-11");
    const oct = await pph21Lines(world, "2026-10");

    expect(nov).toHaveLength(1);
    expect(nov[0]).toMatchObject({ taxIdr: 250_000, baseIdr: 10_000_000 });
    expect(oct).toHaveLength(1);
    expect(oct[0]).toMatchObject({ taxIdr: 180_000, baseIdr: 9_000_000 });
  });

  it("legend-v4v7c returns no lines for a period without posted runs", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    // Only a draft run exists in November; October has nothing at all.
    await seedRun(world, {
      status: "draft",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    expect(await pph21Lines(world, "2026-11")).toEqual([]);
    expect(await pph21Lines(world, "2026-10")).toEqual([]);
  });

  it("legend-v4v7c leaves out a run that was reversed and still reconciles to the ledger", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const budi = await makeEmployee(world, {
      name: "Budi",
      npwp: "098765432109876",
    });
    await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    // Posted, then reversed: the mirror entry nets the ledger back to zero.
    await seedRun(world, {
      status: "reversed",
      runType: "off_cycle",
      slips: [{ employee: budi, baseIdr: 6_000_000, taxIdr: 90_000 }],
    });

    const lines = await pph21Lines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subjectId: sari.id, taxIdr: 250_000 });
  });

  it("legend-v4v7c refuses when the ledger reversed a run that the payslips still show as posted", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const run = await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    // A reversal journal without the run leaving 'locked': the two sources differ.
    await reverseEntry(world, run.entryId!, world.nov, "2026-11-30", [
      [world.expense, 0, 10_000_000],
      [world.cash, 9_750_000, 0],
      [world.pph21, 250_000, 0],
    ]);

    await expect(pph21Lines(world)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });

  it("legend-v4v7c refuses when the payslips hold more PPh 21 than the ledger", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      ledger: 200_000,
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    await expect(pph21Lines(world)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });

  it("legend-v4v7c refuses when the ledger holds more PPh 21 than the payslips", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "paid",
      ledger: 300_000,
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    await expect(pph21Lines(world)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });

  it("legend-v4v7c refuses a posted run that has no payroll journal entry", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      ledger: "none",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    await expect(pph21Lines(world)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });

  it("legend-v4v7c refuses an unreadable payslip with the payslip count only, no raw parse text", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const run = await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    await asOwner(
      world.tenantId,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
          [world.tenantId, run.runId],
        );
        const id = rows[0]!.id;
        await client.query(
          "UPDATE payslips SET calculation_encrypted = $3 WHERE tenant_id = $1 AND id = $2",
          [
            world.tenantId,
            id,
            sealPayrollValue(
              JSON.stringify({ secretField: "98765432" }),
              {
                tenantId: world.tenantId,
                table: "payslips",
                rowId: id,
                field: "calculation",
              },
              HRIS_PII_KEY_VERSION,
            ),
          ],
        );
      },
      true,
    );

    const error = await pph21Lines(world).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
    const message = (error as Error).message;
    expect(message).toContain("1 slip gaji");
    expect(message).not.toMatch(/98765432|secretField|expected|invalid/i);
  });

  it("legend-v4v7c refuses when PPh 21 payable has no mapped account", async () => {
    const world = await makeEntity(await makeTenant(), { mapPph21: false });
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });

    await expect(pph21Lines(world)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });

  it("legend-v4v7c does not count a remittance debit on the PPh 21 payable account", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    // October's tax paid to the state in November (manual debit): not
    // withholding of this period's payslips, and a legitimate remittance.
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-10",
      sourceType: "manual",
      lines: [
        [world.pph21, 180_000, 0],
        [world.cash, 0, 180_000],
      ],
    });

    const lines = await pph21Lines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subjectId: sari.id, taxIdr: 250_000 });
  });

  it.each(["manual", "opening_balance"] as const)(
    "legend-v4v7c refuses a %s credit on the PPh 21 payable account, naming the source",
    async (sourceType) => {
      const world = await makeEntity(await makeTenant());
      const sari = await makeEmployee(world, {
        name: "Sari",
        npwp: "012345678901234",
      });
      await seedRun(world, {
        status: "locked",
        slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
      });
      await postEntry(world, {
        period: world.nov,
        entryDate: "2026-11-01",
        sourceType,
        lines: [
          [world.cash, 500_000, 0],
          [world.pph21, 0, 500_000],
        ],
      });

      const error = await pph21Lines(world).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
      expect((error as Error).message).toContain(sourceType);
      expect((error as Error).message).not.toContain("500000");
    },
  );

  it("legend-v4v7c refuses an undecryptable NPWP without the raw error text", async () => {
    const world = await makeEntity(await makeTenant());
    const sari = await makeEmployee(world, {
      name: "Sari",
      npwp: "012345678901234",
    });
    await seedRun(world, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    // Sealed for another row: authentication fails when it is opened.
    await asOwner(
      world.tenantId,
      (client) =>
        client.query(
          "UPDATE employees SET npwp_encrypted = $3 WHERE tenant_id = $1 AND id = $2",
          [
            world.tenantId,
            sari.id,
            sealHrisPii(
              "012345678901234",
              {
                tenantId: world.tenantId,
                table: "employees",
                rowId: randomUUID(),
                field: "npwp",
              },
              HRIS_PII_KEY_VERSION,
            ),
          ],
        ),
      true,
    );

    const error = await pph21Lines(world).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
    const message = (error as Error).message;
    expect(message).toContain("NPWP");
    expect(message).not.toMatch(
      /auth|decrypt|tag|unsupported|012345678901234/i,
    );
  });

  it("legend-v4v7c never includes another tenant's payroll, even for the same period", async () => {
    const mine = await makeEntity(await makeTenant());
    const other = await makeEntity(await makeTenant());
    const sari = await makeEmployee(mine, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const outsider = await makeEmployee(other, {
      name: "Orang Lain",
      npwp: "055555555555555",
    });
    await seedRun(mine, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    await seedRun(other, {
      status: "locked",
      slips: [{ employee: outsider, baseIdr: 50_000_000, taxIdr: 2_000_000 }],
    });

    const lines = await pph21Lines(mine);
    const theirs = await pph21Lines(other);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subjectId: sari.id, taxIdr: 250_000 });
    expect(lineOf(lines, outsider)).toBeUndefined();
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({
      subjectId: outsider.id,
      taxIdr: 2_000_000,
    });
  });

  it("legend-v4v7c keeps one legal entity's payroll out of another entity's report in the same tenant", async () => {
    const tenant = await makeTenant();
    const first = await makeEntity(tenant);
    const second = await makeEntity(tenant);
    const sari = await makeEmployee(first, {
      name: "Sari",
      npwp: "012345678901234",
    });
    const rina = await makeEmployee(second, {
      name: "Rina",
      npwp: "077777777777777",
    });
    await seedRun(first, {
      status: "locked",
      slips: [{ employee: sari, baseIdr: 10_000_000, taxIdr: 250_000 }],
    });
    await seedRun(second, {
      status: "locked",
      slips: [{ employee: rina, baseIdr: 12_000_000, taxIdr: 300_000 }],
    });

    const firstLines = await pph21Lines(first);
    const secondLines = await pph21Lines(second);

    expect(firstLines).toHaveLength(1);
    expect(firstLines[0]).toMatchObject({
      subjectId: sari.id,
      taxIdr: 250_000,
    });
    expect(secondLines).toHaveLength(1);
    expect(secondLines[0]).toMatchObject({
      subjectId: rina.id,
      taxIdr: 300_000,
    });
  });
});
