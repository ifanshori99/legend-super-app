// Payroll core tables against PostgreSQL with the restricted app role (bead
// legend-gfcr; PRD v1.7 §3 D.30-31, §6 H, R20, PAYR-02, PAYR-04, HR-03,
// TEN-01/02/03): every one of the 15 payroll tables has forced, restrictive
// tenant RLS; the app role cannot delete payroll history; sealed pay amounts
// and published statutory versions and locked runs cannot be rewritten; and a
// composite foreign key can never point into another tenant.
//
// Two disposable tenants (A and B) are seeded as the table owner. Every
// assertion then runs inside a transaction that does `SET LOCAL ROLE
// legend_app` (the runtime role, no BYPASSRLS) with `app.tenant_id` set the
// way `withTenant` sets it, and is always rolled back.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import * as payrollSchema from "../db/schema/payroll.ts";
import {
  openPayrollAmount,
  openPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const TABLES = [
  "statutory_rates",
  "payroll_policies",
  "thr_schedules",
  "pay_components",
  "employee_pay_components",
  "payroll_runs",
  "payslips",
  "bank_transfer_files",
  "payroll_tax_exports",
  "service_charge_pools",
  "service_charge_allocations",
  "employee_loans",
  "payroll_loan_policies",
  "reimbursement_categories",
  "reimbursements",
] as const;
type Table = (typeof TABLES)[number];

/**
 * Payroll tables added by later merged branches (month priors, run results,
 * bank snapshots). Their rows need sealed-run fixtures that their own feature
 * tests already build, so only the structural RLS case runs here.
 */
const RLS_ONLY_TABLES = [
  "payroll_run_month_priors",
  "payroll_run_results",
  "payroll_loan_deductions",
  "payslip_bank_snapshots",
] as const;

/** Tables with a unique key on tenant_id alone (a second row clashes). */
const ONE_ROW_PER_TENANT: ReadonlySet<Table> = new Set([
  "payroll_loan_policies",
]);

/** The app role keeps DELETE only on allocations (recalculation before approval). */
const DELETABLE: ReadonlySet<Table> = new Set(["service_charge_allocations"]);

const PLAIN_AMOUNT = 7654321;
const PLAIN_NET = 4242424;

type Seed = {
  tenantId: string;
  brandId: string;
  entityId: string;
  outletId: string;
  employeeIds: [string, string];
  componentIds: [string, string];
  /** Seeded row id per table (variant 0). */
  ids: Partial<Record<Table, string>>;
};

type Cols = Record<string, unknown>;
type Variant = 0 | 1;

let counter = 0;
const seq = () => ++counter;
/** A calendar date `n` days after 2030-01-01 (unique run periods per call). */
const dayStr = (n: number) =>
  new Date(Date.UTC(2030, 0, 1 + n)).toISOString().slice(0, 10);

/**
 * Column updates that walk a payroll run along the contract's transitions.
 * A locked run needs both approvers, the lock stamp, snapshot and totals.
 */
const RUN_STEPS = {
  simulated: `status = 'simulated'`,
  hr_approved: `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  approved: `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  locked: `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
  paid: `status = 'paid', paid_at = now(), paid_by = 'pay-user'`,
  reversed: `status = 'reversed', reversal = '{"status":"approved"}'`,
} as const;
type RunStep = keyof typeof RUN_STEPS;
const RUN_PATH: RunStep[] = [
  "simulated",
  "hr_approved",
  "approved",
  "locked",
  "paid",
];

const json = (value: unknown) => JSON.stringify(value);
const need = (seed: Seed, table: Table): string => {
  const id = seed.ids[table];
  if (!id) throw new Error(`Seed row missing for ${table}`);
  return id;
};

/**
 * Column values for one valid row per table. `variant` 1 builds a second,
 * non-clashing row for the same tenant (other employee / component / period).
 */
const BUILD: Record<Table, (s: Seed, id: string, v: Variant) => Cols> = {
  statutory_rates: (s) => ({
    tenant_id: s.tenantId,
    type: "ptkp",
    version: 1000 + seq(),
    effective_from: "2026-01-01",
    legal_basis: "PMK test",
    parameters: json({}),
    created_by: "payroll-db-test",
  }),
  payroll_policies: (s) => ({
    tenant_id: s.tenantId,
    legal_entity_id: s.entityId,
    name: "Kebijakan DB",
    employee_group_code: `G${seq()}`,
    employee_group: json({ code: `G${counter}` }),
    cycle: json({ kind: "monthly" }),
    pay_date_adjustment: "none",
    jkk_risk_class: "low",
    bpjs_programmes: json([]),
  }),
  thr_schedules: (s) => ({
    tenant_id: s.tenantId,
    legal_entity_id: s.entityId,
    name: "THR DB",
    holiday_name: "Hari Raya",
    holiday_date: "2026-03-20",
    tenure_as_of_date: "2026-03-20",
    pay_date: "2026-03-10",
    created_by: "payroll-db-test",
  }),
  pay_components: (s) => ({
    tenant_id: s.tenantId,
    code: `TC${seq()}`,
    name: "Komponen DB",
    category: "base_salary",
    kind: "earning",
    recurrence: "fixed",
    taxable: true,
    tax_scheme: "gross",
    bpjs_base: true,
    overtime_base: true,
    thr_base: true,
  }),
  employee_pay_components: (s, id, v) => ({
    id,
    tenant_id: s.tenantId,
    employee_id: s.employeeIds[0],
    component_id: s.componentIds[v],
    amount_encrypted: sealPayrollAmount(idr(PLAIN_AMOUNT), {
      tenantId: s.tenantId,
      table: "employee_pay_components",
      rowId: id,
      field: "amount",
    }),
    pii_key_version: PAYROLL_SEAL_KEY_VERSION,
    effective_from: v === 0 ? "2026-01-01" : "2026-02-01",
    created_by: "payroll-db-test",
  }),
  payroll_runs: (s) => ({
    tenant_id: s.tenantId,
    legal_entity_id: s.entityId,
    payroll_policy_id: need(s, "payroll_policies"),
    run_type: "regular",
    period_start: dayStr(seq()),
    period_end: dayStr(counter + 1),
    pay_date: dayStr(counter + 1),
    created_by: "payroll-db-test",
  }),
  payslips: (s, id, v) => ({
    id,
    tenant_id: s.tenantId,
    payroll_run_id: need(s, "payroll_runs"),
    employee_id: s.employeeIds[v],
    payment_method: "bank_transfer",
    calculation_encrypted: sealPayrollValue(json({ net: PLAIN_NET }), {
      tenantId: s.tenantId,
      table: "payslips",
      rowId: id,
      field: "calculation",
    }),
    pii_key_version: PAYROLL_SEAL_KEY_VERSION,
  }),
  bank_transfer_files: (s) => ({
    tenant_id: s.tenantId,
    payroll_run_id: need(s, "payroll_runs"),
    format: "generic_csv",
    row_count: 1,
    total_idr: 4242424,
    checksum_sha256: "a".repeat(64),
    object_key: `bank/${randomUUID()}.csv`,
    created_by: "payroll-db-test",
  }),
  payroll_tax_exports: (s) => ({
    tenant_id: s.tenantId,
    legal_entity_id: s.entityId,
    kind: "monthly_withholding",
    tax_period: "2026-01",
    created_by: "payroll-db-test",
  }),
  service_charge_pools: (s, _id, v) => ({
    tenant_id: s.tenantId,
    outlet_id: s.outletId,
    period_start: v === 0 ? "2026-01-01" : "2026-02-01",
    period_end: v === 0 ? "2026-01-31" : "2026-02-28",
    amount_idr: 1000000,
    rule: json({ kind: "points" }),
    created_by: "payroll-db-test",
  }),
  service_charge_allocations: (s, _id, v) => ({
    tenant_id: s.tenantId,
    pool_id: need(s, "service_charge_pools"),
    employee_id: s.employeeIds[v],
    points: "1.0000",
    attendance_days: 20,
    weight: 20,
    amount_idr: 500000,
  }),
  employee_loans: (s) => ({
    tenant_id: s.tenantId,
    employee_id: s.employeeIds[0],
    principal_idr: 1000000,
    installment_idr: 500000,
    installment_count: 2,
    outstanding_idr: 1000000,
    first_deduction_period: "2026-02-01",
    reason: "Kasbon DB",
  }),
  payroll_loan_policies: (s) => ({
    tenant_id: s.tenantId,
    max_principal_idr: 5000000,
    max_installments: 12,
    max_deduction_of_net_pay_bp: 3000,
    max_total_open_idr: 20000000,
  }),
  reimbursement_categories: (s) => ({
    tenant_id: s.tenantId,
    name: `Kategori ${seq()}`,
    receipt_required: false,
    limits: json([{ scope: "all" }]),
  }),
  reimbursements: (s) => ({
    tenant_id: s.tenantId,
    employee_id: s.employeeIds[0],
    category_id: need(s, "reimbursement_categories"),
    expense_date: "2026-01-10",
    amount_idr: 50000,
    description: "Klaim DB",
    payout: "cash",
  }),
};

function insertSql(table: Table, cols: Cols) {
  const keys = Object.keys(cols);
  return {
    text: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    values: keys.map((key) => cols[key]),
  };
}

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

type AppScope = {
  /** null = no `app.tenant_id` at all (an unscoped session). */
  tenant: string | null;
  /** `*` (tenant-wide) or a JSON array of outlet ids, as `withTenant` sets it. */
  outlets?: string;
};

/** A legend_app transaction that is always rolled back. */
async function asApp<T>(
  scope: AppScope,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (scope.tenant !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [scope.tenant, scope.outlets ?? "*"],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

type Attempt =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; code: string | undefined };

/** Runs one statement under a savepoint so the transaction stays usable. */
async function attempt(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<Attempt> {
  await client.query("SAVEPOINT attempt");
  try {
    const result = await client.query(text, values);
    await client.query("RELEASE SAVEPOINT attempt");
    return { ok: true, rowCount: result.rowCount ?? 0, rows: result.rows };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    return { ok: false, code: (error as { code?: string }).code };
  }
}

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";
const EXCLUSION_VIOLATION = "23P01";
const GUARD_FIRST: ReadonlySet<Table> = new Set([
  "payslips",
  "bank_transfer_files",
  "service_charge_allocations",
]);

let A: Seed;
let B: Seed;

async function seedTenant(label: string): Promise<Seed> {
  const tenantId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenantId,
      `payroll-db-${label}-${tenantId.slice(0, 8)}`,
      fixtureTenant,
      `Payroll DB tenant ${label}`,
    ],
  );
  const seed: Seed = {
    tenantId,
    brandId: randomUUID(),
    entityId: randomUUID(),
    outletId: randomUUID(),
    employeeIds: [randomUUID(), randomUUID()],
    componentIds: ["", ""],
    ids: {},
  };
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [seed.brandId, tenantId],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payroll DB', false)`,
      [seed.entityId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'P-01', 'Outlet P', 'Jl. P', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [seed.outletId, tenantId, seed.brandId, seed.entityId],
    );
    for (const [index, employeeId] of seed.employeeIds.entries())
      await client.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, 'Karyawan Payroll DB', $4, 'pkwtt', '2025-03-01', 'active')`,
        [
          employeeId,
          tenantId,
          `PDB-${index}-${employeeId.slice(0, 8).toUpperCase()}`,
          seed.outletId,
        ],
      );
    // Two components: the second one lets a test add a non-clashing pay row.
    for (const index of [0, 1] as const) {
      const id = randomUUID();
      const { text, values } = insertSql("pay_components", {
        id,
        ...BUILD.pay_components(seed, id, 0),
      });
      await client.query(text, values);
      seed.componentIds[index] = id;
    }
    for (const table of TABLES) {
      if (table === "pay_components") {
        seed.ids.pay_components = seed.componentIds[0];
        continue;
      }
      const id = randomUUID();
      const { text, values } = insertSql(table, {
        id,
        ...BUILD[table](seed, id, 0),
      });
      await client.query(text, values);
      seed.ids[table] = id;
      if (table === "payroll_runs")
        // Payslips and bank files need a locked run (PAYR-01/04).
        for (const step of [
          "simulated",
          "hr_approved",
          "approved",
          "locked",
        ] as const)
          await client.query(
            `UPDATE payroll_runs SET ${RUN_STEPS[step]} WHERE id = $1`,
            [id],
          );
    }
  });
  return seed;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  A = await seedTenant("A");
  B = await seedTenant("B");
});

afterAll(async () => {
  // Best effort: published statutory rows and locked runs are immutable by
  // design, so the owner skips triggers for the cleanup only.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const seed of [A, B]) {
      if (!seed) continue;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        seed.tenantId,
      ]);
      for (const table of [...TABLES].reverse())
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          seed.tenantId,
        ]);
      for (const table of ["employees", "outlets", "legal_entities", "brands"])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          seed.tenantId,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [seed.tenantId]);
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
    await owner.end();
  }
});

describe("payroll core: coverage", () => {
  it("covers exactly the tables exported by db/schema/payroll.ts", () => {
    const exported = Object.values(payrollSchema)
      .map((value) => {
        try {
          return getTableConfig(value as never).name;
        } catch {
          return null;
        }
      })
      .filter((name): name is string => name !== null)
      .sort();
    // Every exported table is either fully covered (TABLES) or RLS-only.
    expect(exported).toEqual([...TABLES, ...RLS_ONLY_TABLES].sort());
    expect(TABLES).toHaveLength(15);
    expect(TABLES.length + RLS_ONLY_TABLES.length).toBe(19);
  });
});

describe.each(RLS_ONLY_TABLES)("payroll core: %s tenant isolation", (table) => {
  it("[TEN-01] RLS is enabled and forced with a restrictive tenant_isolation policy", async () => {
    const rls = await owner.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = $1::regclass`,
      [`public.${table}`],
    );
    expect(rls.rows[0]).toEqual({ rls: true, forced: true });
    const policies = await owner.query<{
      policyname: string;
      permissive: string;
    }>(
      `SELECT policyname, permissive FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    expect(policies.rows).toContainEqual({
      policyname: "tenant_isolation",
      permissive: "RESTRICTIVE",
    });
  });
});

describe.each(TABLES)("payroll core: %s tenant isolation", (table) => {
  it("[TEN-01] RLS is enabled and forced with a restrictive tenant_isolation policy", async () => {
    const rls = await owner.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = $1::regclass`,
      [`public.${table}`],
    );
    expect(rls.rows[0]).toEqual({ rls: true, forced: true });
    const policies = await owner.query<{
      policyname: string;
      permissive: string;
    }>(
      `SELECT policyname, permissive FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    expect(policies.rows).toContainEqual({
      policyname: "tenant_isolation",
      permissive: "RESTRICTIVE",
    });
    if (table === "service_charge_pools")
      // TEN-03: the only outlet-owned payroll table carries the outlet backstop.
      expect(policies.rows).toContainEqual({
        policyname: "outlet_isolation",
        permissive: "RESTRICTIVE",
      });
  });

  it("[TEN-01] tenant A sees its row; tenant B sees none of tenant A's rows", async () => {
    const id = need(A, table);
    const own = await asApp({ tenant: A.tenantId }, (client) =>
      attempt(client, `SELECT id FROM ${table} WHERE id = $1`, [id]),
    );
    expect(own).toMatchObject({ ok: true, rowCount: 1 });
    const other = await asApp({ tenant: B.tenantId }, async (client) => ({
      byId: await attempt(client, `SELECT id FROM ${table} WHERE id = $1`, [
        id,
      ]),
      byTenant: await attempt(
        client,
        `SELECT id FROM ${table} WHERE tenant_id = $1`,
        [A.tenantId],
      ),
    }));
    expect(other.byId).toMatchObject({ ok: true, rowCount: 0 });
    expect(other.byTenant).toMatchObject({ ok: true, rowCount: 0 });
  });

  it("[TEN-02] tenant B can insert its own row but not a row for tenant A", async () => {
    const result = await asApp({ tenant: B.tenantId }, async (client) => {
      const id = randomUUID();
      const control = insertSql(table, {
        id,
        ...BUILD[table](B, id, 1),
      });
      const mine = await attempt(client, control.text, control.values);
      const foreignId = randomUUID();
      const foreign = insertSql(table, {
        id: foreignId,
        ...BUILD[table](A, foreignId, 1),
      });
      const theirs = await attempt(client, foreign.text, foreign.values);
      return { mine, theirs };
    });
    // A one-row-per-tenant table already holds the seeded row of tenant B: the
    // control insert is refused by the unique key (23505), not by RLS.
    expect(result.mine).toMatchObject(
      ONE_ROW_PER_TENANT.has(table)
        ? { ok: false, code: "23505" }
        : { ok: true, rowCount: 1 },
    );
    // RLS WITH CHECK refuses before any foreign key is looked at. Payslips,
    // bank files and allocations also have a BEFORE INSERT guard that reads
    // the parent under the caller's RLS, so for them it may refuse first
    // (23514); either way the row is refused.
    expect(result.theirs.ok).toBe(false);
    expect(
      GUARD_FIRST.has(table)
        ? [INSUFFICIENT_PRIVILEGE, CHECK_VIOLATION]
        : [INSUFFICIENT_PRIVILEGE],
    ).toContain((result.theirs as { code?: string }).code);
  });

  it("[TEN-02] an unscoped session (no app.tenant_id) sees nothing and writes nothing", async () => {
    const result = await asApp({ tenant: null }, async (client) => {
      const id = randomUUID();
      const write = insertSql(table, { id, ...BUILD[table](A, id, 1) });
      return {
        read: await attempt(client, `SELECT id FROM ${table}`),
        write: await attempt(client, write.text, write.values),
      };
    });
    // Refusing outright (the policy function raises) or an empty result both
    // mean "sees nothing"; returning any row is the failure.
    if (result.read.ok) expect(result.read.rowCount).toBe(0);
    expect(result.write.ok).toBe(false);
  });

  it("[PAYR-04] the app role cannot DELETE or TRUNCATE" + "", async () => {
    const id = need(A, table);
    const result = await asApp({ tenant: A.tenantId }, async (client) => ({
      delete: await attempt(client, `DELETE FROM ${table} WHERE id = $1`, [id]),
      truncate: await attempt(client, `TRUNCATE ${table}`),
    }));
    // TRUNCATE is revoked on every payroll table, allocations included.
    expect(result.truncate).toEqual({
      ok: false,
      code: INSUFFICIENT_PRIVILEGE,
    });
    if (DELETABLE.has(table))
      expect(result.delete).toMatchObject({ ok: true, rowCount: 1 });
    else
      expect(result.delete).toEqual({
        ok: false,
        code: INSUFFICIENT_PRIVILEGE,
      });
  });
});

describe("payroll core: service charge pool outlet isolation (TEN-03)", () => {
  it("a session scoped to other outlets sees no pool; its own outlet or '*' sees it", async () => {
    const id = need(A, "service_charge_pools");
    const result = await asApp(
      { tenant: A.tenantId, outlets: JSON.stringify([randomUUID()]) },
      async (client) => {
        const insert = insertSql("service_charge_pools", {
          ...BUILD.service_charge_pools(A, id, 1),
        });
        return {
          other: await attempt(
            client,
            `SELECT id FROM service_charge_pools WHERE id = $1`,
            [id],
          ),
          insert: await attempt(client, insert.text, insert.values),
        };
      },
    );
    expect(result.other).toMatchObject({ ok: true, rowCount: 0 });
    expect(result.insert).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    for (const outlets of [JSON.stringify([A.outletId]), "*"]) {
      const visible = await asApp({ tenant: A.tenantId, outlets }, (client) =>
        attempt(client, `SELECT id FROM service_charge_pools WHERE id = $1`, [
          id,
        ]),
      );
      expect(visible).toMatchObject({ ok: true, rowCount: 1 });
    }
  });
});

describe("payroll core: composite foreign keys never cross tenants", () => {
  // Each case swaps a parent reference for tenant B's row while the row itself
  // belongs to tenant A. The insert passes RLS (tenant A context), so only the
  // composite (tenant_id, id) foreign key can refuse it.
  const CASES: {
    table: Table;
    over: (b: Seed) => Cols;
    /** The parent is read by a BEFORE INSERT guard under RLS. */
    guarded?: true;
  }[] = [
    {
      table: "payroll_policies",
      over: (b) => ({ legal_entity_id: b.entityId }),
    },
    { table: "thr_schedules", over: (b) => ({ legal_entity_id: b.entityId }) },
    {
      table: "employee_pay_components",
      over: (b) => ({ employee_id: b.employeeIds[0] }),
    },
    {
      table: "employee_pay_components",
      over: (b) => ({ component_id: b.componentIds[0] }),
    },
    { table: "payroll_runs", over: (b) => ({ legal_entity_id: b.entityId }) },
    {
      table: "payroll_runs",
      over: (b) => ({ payroll_policy_id: need(b, "payroll_policies") }),
    },
    {
      table: "payslips",
      over: (b) => ({ payroll_run_id: need(b, "payroll_runs") }),
      guarded: true,
    },
    { table: "payslips", over: (b) => ({ employee_id: b.employeeIds[0] }) },
    {
      table: "bank_transfer_files",
      over: (b) => ({ payroll_run_id: need(b, "payroll_runs") }),
      guarded: true,
    },
    {
      table: "payroll_tax_exports",
      over: (b) => ({ legal_entity_id: b.entityId }),
    },
    { table: "service_charge_pools", over: (b) => ({ outlet_id: b.outletId }) },
    {
      table: "service_charge_allocations",
      over: (b) => ({ pool_id: need(b, "service_charge_pools") }),
      guarded: true,
    },
    {
      table: "service_charge_allocations",
      over: (b) => ({ employee_id: b.employeeIds[0] }),
    },
    {
      table: "employee_loans",
      over: (b) => ({ employee_id: b.employeeIds[0] }),
    },
    {
      table: "reimbursements",
      over: (b) => ({ employee_id: b.employeeIds[0] }),
    },
    {
      table: "reimbursements",
      over: (b) => ({ category_id: need(b, "reimbursement_categories") }),
    },
  ];

  it.each(CASES.map((item, index) => ({ ...item, index })))(
    "[TEN-02] $table row of tenant A cannot reference tenant B's parent (case $index)",
    async ({ table, over, guarded }) => {
      const result = await asApp({ tenant: A.tenantId }, async (client) => {
        const id = randomUUID();
        const good = insertSql(table, { id, ...BUILD[table](A, id, 1) });
        const control = await attempt(client, good.text, good.values);
        const badId = randomUUID();
        const bad = insertSql(table, {
          ...BUILD[table](A, badId, 1),
          id: badId,
          ...over(B),
        });
        return { control, bad: await attempt(client, bad.text, bad.values) };
      });
      expect(result.control).toMatchObject({ ok: true, rowCount: 1 });
      expect(result.bad.ok).toBe(false);
      // The parent-reading guards (see GUARD_FIRST) refuse a cross-tenant
      // parent with 23514 before the foreign key is checked.
      expect(
        guarded
          ? [FOREIGN_KEY_VIOLATION, CHECK_VIOLATION]
          : [FOREIGN_KEY_VIOLATION],
      ).toContain((result.bad as { code?: string }).code);
    },
  );
});

describe("payroll core: employee_pay_components is append-only (HR-03, PAYR-02)", () => {
  it("[HR-03] the amount, key version, dates and links cannot be updated; only effective_to can", async () => {
    const id = need(A, "employee_pay_components");
    const result = await asApp({ tenant: A.tenantId }, async (client) => ({
      amount: await attempt(
        client,
        `UPDATE employee_pay_components SET amount_encrypted = $2 WHERE id = $1`,
        [id, Buffer.from("tampered")],
      ),
      version: await attempt(
        client,
        `UPDATE employee_pay_components SET pii_key_version = 2 WHERE id = $1`,
        [id],
      ),
      from: await attempt(
        client,
        `UPDATE employee_pay_components SET effective_from = '2025-01-01' WHERE id = $1`,
        [id],
      ),
      employee: await attempt(
        client,
        `UPDATE employee_pay_components SET employee_id = $2 WHERE id = $1`,
        [id, A.employeeIds[1]],
      ),
      endDate: await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-01-31' WHERE id = $1 RETURNING effective_to::text AS effective_to`,
        [id],
      ),
    }));
    // The sealed amount and its key version are column-granted since 0248 (the
    // reseal job), so the guard trigger refuses them outside the job (23514).
    for (const denied of [result.amount, result.version])
      expect(denied).toEqual({ ok: false, code: CHECK_VIOLATION });
    for (const denied of [result.from, result.employee])
      expect(denied).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    expect(result.endDate).toMatchObject({ ok: true, rowCount: 1 });
    expect((result.endDate as { rows: unknown[] }).rows[0]).toEqual({
      effective_to: "2026-01-31",
    });
  });

  it("[HR-03] the stored bytes contain no plaintext digits and open only with their own binding", async () => {
    const id = need(A, "employee_pay_components");
    const raw = await asApp({ tenant: A.tenantId }, (client) =>
      client.query<{ amount_encrypted: Buffer; pii_key_version: number }>(
        `SELECT amount_encrypted, pii_key_version FROM employee_pay_components WHERE id = $1`,
        [id],
      ),
    );
    const { amount_encrypted: sealed, pii_key_version: keyVersion } =
      raw.rows[0]!;
    const plain = String(PLAIN_AMOUNT);
    expect(keyVersion).toBe(PAYROLL_SEAL_KEY_VERSION);
    for (const encoding of ["utf8", "latin1", "hex", "base64"] as const)
      expect(sealed.toString(encoding)).not.toContain(
        encoding === "hex"
          ? Buffer.from(plain).toString("hex")
          : encoding === "base64"
            ? Buffer.from(plain).toString("base64")
            : plain,
      );
    const binding = {
      tenantId: A.tenantId,
      table: "employee_pay_components",
      rowId: id,
      field: "amount",
    } as const;
    expect(openPayrollAmount(sealed, binding, keyVersion)).toBe(PLAIN_AMOUNT);
    // Another row, another tenant, another table or another field: fail closed.
    expect(() =>
      openPayrollAmount(
        sealed,
        { ...binding, rowId: randomUUID() },
        keyVersion,
      ),
    ).toThrow();
    expect(() =>
      openPayrollAmount(
        sealed,
        { ...binding, tenantId: B.tenantId },
        keyVersion,
      ),
    ).toThrow();
    expect(() =>
      openPayrollAmount(sealed, { ...binding, table: "payslips" }, keyVersion),
    ).toThrow();
    expect(() =>
      openPayrollAmount(
        sealed,
        { ...binding, field: "calculation" },
        keyVersion,
      ),
    ).toThrow();
  });

  it("[HR-03] ciphertext copied onto another row is stored but cannot be opened there", async () => {
    const sourceId = need(A, "employee_pay_components");
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const source = await client.query<{ amount_encrypted: Buffer }>(
        `SELECT amount_encrypted FROM employee_pay_components WHERE id = $1`,
        [sourceId],
      );
      const copyId = randomUUID();
      const copy = insertSql("employee_pay_components", {
        ...BUILD.employee_pay_components(A, copyId, 1),
        id: copyId,
        amount_encrypted: source.rows[0]!.amount_encrypted,
      });
      await client.query(copy.text, copy.values);
      const stored = await client.query<{ amount_encrypted: Buffer }>(
        `SELECT amount_encrypted FROM employee_pay_components WHERE id = $1`,
        [copyId],
      );
      return { copyId, sealed: stored.rows[0]!.amount_encrypted };
    });
    expect(() =>
      openPayrollAmount(
        result.sealed,
        {
          tenantId: A.tenantId,
          table: "employee_pay_components",
          rowId: result.copyId,
          field: "amount",
        },
        PAYROLL_SEAL_KEY_VERSION,
      ),
    ).toThrow();
  });

  it("[HR-03] a payslip calculation is sealed the same way", async () => {
    const id = need(A, "payslips");
    const raw = await asApp({ tenant: A.tenantId }, (client) =>
      client.query<{ calculation_encrypted: Buffer }>(
        `SELECT calculation_encrypted FROM payslips WHERE id = $1`,
        [id],
      ),
    );
    const sealed = raw.rows[0]!.calculation_encrypted;
    expect(sealed.toString("utf8")).not.toContain(String(PLAIN_NET));
    expect(sealed.toString("latin1")).not.toContain("net");
    const binding = {
      tenantId: A.tenantId,
      table: "payslips",
      rowId: id,
      field: "calculation",
    } as const;
    expect(
      JSON.parse(openPayrollValue(sealed, binding, PAYROLL_SEAL_KEY_VERSION)),
    ).toEqual({ net: PLAIN_NET });
    expect(() =>
      openPayrollValue(
        sealed,
        { ...binding, rowId: randomUUID() },
        PAYROLL_SEAL_KEY_VERSION,
      ),
    ).toThrow();
  });
});

describe("payroll core: payslips and bank files are written once (PAYR-04)", () => {
  it("only pdf_object_key and viewed_at of a payslip can be updated", async () => {
    const id = need(A, "payslips");
    const result = await asApp({ tenant: A.tenantId }, async (client) => ({
      calculation: await attempt(
        client,
        `UPDATE payslips SET calculation_encrypted = $2 WHERE id = $1`,
        [id, Buffer.from("tampered")],
      ),
      method: await attempt(
        client,
        `UPDATE payslips SET payment_method = 'cash' WHERE id = $1`,
        [id],
      ),
      employee: await attempt(
        client,
        `UPDATE payslips SET employee_id = $2 WHERE id = $1`,
        [id, A.employeeIds[1]],
      ),
      pdf: await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = 'payslips/x.pdf' WHERE id = $1`,
        [id],
      ),
      viewed: await attempt(
        client,
        `UPDATE payslips SET viewed_at = now() WHERE id = $1`,
        [id],
      ),
    }));
    // calculation_encrypted is column-granted since 0248 (the reseal job); the
    // guard trigger refuses it outside the job (23514).
    expect(result.calculation).toEqual({ ok: false, code: CHECK_VIOLATION });
    for (const denied of [result.method, result.employee])
      expect(denied).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    expect(result.pdf).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.viewed).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a bank transfer file cannot be updated at all", async () => {
    const id = need(A, "bank_transfer_files");
    const result = await asApp({ tenant: A.tenantId }, async (client) => ({
      total: await attempt(
        client,
        `UPDATE bank_transfer_files SET total_idr = 1 WHERE id = $1`,
        [id],
      ),
      key: await attempt(
        client,
        `UPDATE bank_transfer_files SET object_key = 'other' WHERE id = $1`,
        [id],
      ),
    }));
    expect(result.total).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
    expect(result.key).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
  });
});

describe("payroll core: statutory_rates versions (PAYR-02, R20)", () => {
  it("a draft can be edited; after publish every UPDATE and DELETE fails", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = randomUUID();
      const row = insertSql("statutory_rates", {
        id,
        ...BUILD.statutory_rates(A, id, 1),
      });
      await client.query(row.text, row.values);
      const editDraft = await attempt(
        client,
        `UPDATE statutory_rates SET legal_basis = 'Diubah saat draft', parameters = '{"a":1}' WHERE id = $1`,
        [id],
      );
      const identity = await attempt(
        client,
        `UPDATE statutory_rates SET version = version + 1 WHERE id = $1`,
        [id],
      );
      const publish = await attempt(
        client,
        `UPDATE statutory_rates
            SET status = 'published', published_at = now(), published_by = 'payroll-db-test'
          WHERE id = $1`,
        [id],
      );
      const editPublished = await attempt(
        client,
        `UPDATE statutory_rates SET legal_basis = 'Diubah diam-diam' WHERE id = $1`,
        [id],
      );
      const params = await attempt(
        client,
        `UPDATE statutory_rates SET parameters = '{"b":2}' WHERE id = $1`,
        [id],
      );
      const archive = await attempt(
        client,
        `UPDATE statutory_rates SET status = 'archived', published_at = NULL, published_by = NULL WHERE id = $1`,
        [id],
      );
      const remove = await attempt(
        client,
        `DELETE FROM statutory_rates WHERE id = $1`,
        [id],
      );
      const after = await client.query<{ legal_basis: string; status: string }>(
        `SELECT legal_basis, status FROM statutory_rates WHERE id = $1`,
        [id],
      );
      return {
        editDraft,
        identity,
        publish,
        editPublished,
        params,
        archive,
        remove,
        after: after.rows[0],
      };
    });
    expect(result.editDraft).toMatchObject({ ok: true, rowCount: 1 });
    // Identity (type, version, tenant) never changes, even on a draft.
    expect(result.identity).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.publish).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.editPublished).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.params).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.archive).toEqual({ ok: false, code: CHECK_VIOLATION });
    // DELETE is revoked from the app role; the trigger would refuse it too.
    expect(result.remove.ok).toBe(false);
    expect([INSUFFICIENT_PRIVILEGE, CHECK_VIOLATION]).toContain(
      (result.remove as { code?: string }).code,
    );
    expect(result.after).toEqual({
      legal_basis: "Diubah saat draft",
      status: "published",
    });
  });

  it("a draft can be archived exactly once, then it is frozen", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = randomUUID();
      const row = insertSql("statutory_rates", {
        id,
        ...BUILD.statutory_rates(A, id, 1),
      });
      await client.query(row.text, row.values);
      return {
        archive: await attempt(
          client,
          `UPDATE statutory_rates SET status = 'archived' WHERE id = $1`,
          [id],
        ),
        again: await attempt(
          client,
          `UPDATE statutory_rates SET legal_basis = 'Lagi' WHERE id = $1`,
          [id],
        ),
      };
    });
    expect(result.archive).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.again).toEqual({ ok: false, code: CHECK_VIOLATION });
  });

  it("two published versions of one type cannot share an effective date", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const ids = [randomUUID(), randomUUID()];
      for (const id of ids) {
        const row = insertSql("statutory_rates", {
          id,
          ...BUILD.statutory_rates(A, id, 1),
          effective_from: "2031-05-01",
        });
        await client.query(row.text, row.values);
      }
      const publish = (id: string) =>
        attempt(
          client,
          `UPDATE statutory_rates
              SET status = 'published', published_at = now(), published_by = 'payroll-db-test'
            WHERE id = $1`,
          [id],
        );
      return [await publish(ids[0]!), await publish(ids[1]!)];
    });
    expect(result[0]).toMatchObject({ ok: true, rowCount: 1 });
    expect(result[1]).toEqual({ ok: false, code: UNIQUE_VIOLATION });
  });

  it("[PAYR-02] a version cannot be inserted as published or archived", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const out: Record<string, Attempt> = {};
      for (const status of ["published", "archived"]) {
        const id = randomUUID();
        const row = insertSql("statutory_rates", {
          id,
          ...BUILD.statutory_rates(A, id, 1),
          effective_from: "2020-01-01",
          status,
          ...(status === "published"
            ? { published_at: new Date(), published_by: "payroll-db-test" }
            : {}),
        });
        out[status] = await attempt(client, row.text, row.values);
      }
      return out;
    });
    expect(result.published).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.archived).toEqual({ ok: false, code: CHECK_VIOLATION });
  });
});

/** Inserts a draft run (unique period) and optionally walks it forward. */
async function newRun(
  client: PoolClient,
  upTo?: RunStep,
  over: Cols = {},
): Promise<string> {
  const id = randomUUID();
  const row = insertSql("payroll_runs", {
    id,
    ...BUILD.payroll_runs(A, id, 1),
    ...over,
  });
  await client.query(row.text, row.values);
  if (upTo)
    for (const step of RUN_PATH.slice(0, RUN_PATH.indexOf(upTo) + 1))
      await client.query(
        `UPDATE payroll_runs SET ${RUN_STEPS[step]} WHERE id = $1`,
        [id],
      );
  return id;
}
const runUpdate = (
  client: PoolClient,
  id: string,
  set: string,
  extra: unknown[] = [],
) =>
  attempt(client, `UPDATE payroll_runs SET ${set} WHERE id = $1`, [
    id,
    ...extra,
  ]);

describe("payroll core: payroll_runs guards (PAYR-01, PAYR-02, PAYR-04, PAYR-05)", () => {
  it("[PAYR-01] a run is born a draft", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const out: Record<string, Attempt> = {};
      for (const status of ["simulated", "locked", "paid", "reversed"]) {
        const id = randomUUID();
        const row = insertSql("payroll_runs", {
          id,
          ...BUILD.payroll_runs(A, id, 1),
          status,
          config_snapshot: json({ v: 1 }),
          totals: json({ t: 1 }),
          approved_by_hr: "hr-user",
          approved_by_hr_at: new Date(),
          approved_by_finance: "finance-user",
          approved_by_finance_at: new Date(),
          locked_by: "lock-user",
          locked_at: new Date(),
          paid_by: "pay-user",
          paid_at: new Date(),
          reversal: json({ status: "approved" }),
        });
        out[status] = await attempt(client, row.text, row.values);
      }
      return out;
    });
    for (const [status, outcome] of Object.entries(result))
      expect({ status, ...outcome }).toEqual({
        status,
        ok: false,
        code: CHECK_VIOLATION,
      });
  });

  it("[PAYR-01] a run moves only along draft > simulated > hr_approved > approved > locked > paid", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client);
      const skipToLocked = await runUpdate(client, id, RUN_STEPS.locked);
      const skipToApproved = await runUpdate(client, id, RUN_STEPS.approved);
      const toPaid = await runUpdate(client, id, RUN_STEPS.paid);
      const simulated = await runUpdate(client, id, RUN_STEPS.simulated);
      const backward = await runUpdate(client, id, `status = 'draft'`);
      return { skipToLocked, skipToApproved, toPaid, simulated, backward };
    });
    // draft -> locked fails on the transition guard, not only on the checks.
    expect(result.skipToLocked).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.skipToApproved).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.toPaid).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.simulated).toMatchObject({ ok: true, rowCount: 1 });
    // An unfinished run can be sent back to draft.
    expect(result.backward).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("[PAYR-01] draft > locked fails even with every locked column filled in", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client);
      return runUpdate(
        client,
        id,
        `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}',
         approved_by_hr = 'hr-user', approved_by_hr_at = now(),
         approved_by_finance = 'finance-user', approved_by_finance_at = now(),
         locked_by = 'lock-user', locked_at = now()`,
      );
    });
    expect(result).toEqual({ ok: false, code: CHECK_VIOLATION });
  });

  it("[PAYR-01] a locked run needs both approvers, distinct, and a locker", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client);
      await runUpdate(client, id, RUN_STEPS.simulated);
      // hr_approved and approved WITHOUT the approver columns (the checks only
      // bind from `locked` on), so each missing piece is tested in turn.
      await runUpdate(client, id, `status = 'hr_approved'`);
      await runUpdate(client, id, `status = 'approved'`);
      const snapshot = `config_snapshot = '{"v":1}', totals = '{"t":1}', locked_at = now()`;
      const noApprovers = await runUpdate(
        client,
        id,
        `status = 'locked', ${snapshot}, locked_by = 'lock-user'`,
      );
      await runUpdate(
        client,
        id,
        `approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
      );
      const noFinance = await runUpdate(
        client,
        id,
        `status = 'locked', ${snapshot}, locked_by = 'lock-user'`,
      );
      const sameApprover = await runUpdate(
        client,
        id,
        `approved_by_finance = 'hr-user', approved_by_finance_at = now()`,
      );
      await runUpdate(
        client,
        id,
        `approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
      );
      const noLocker = await runUpdate(
        client,
        id,
        `status = 'locked', ${snapshot}`,
      );
      const noSnapshot = await runUpdate(
        client,
        id,
        `status = 'locked', totals = '{"t":1}', locked_at = now(), locked_by = 'lock-user'`,
      );
      const noTotals = await runUpdate(
        client,
        id,
        `status = 'locked', config_snapshot = '{"v":1}', locked_at = now(), locked_by = 'lock-user'`,
      );
      const full = await runUpdate(
        client,
        id,
        `status = 'locked', ${snapshot}, locked_by = 'lock-user'`,
      );
      return {
        noApprovers,
        noFinance,
        sameApprover,
        noLocker,
        noSnapshot,
        noTotals,
        full,
      };
    });
    for (const [name, outcome] of Object.entries({
      noApprovers: result.noApprovers,
      noFinance: result.noFinance,
      sameApprover: result.sameApprover,
      noLocker: result.noLocker,
      noSnapshot: result.noSnapshot,
      noTotals: result.noTotals,
    }))
      expect({ name, ...outcome }).toEqual({
        name,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.full).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a paid run needs paid_at and paid_by together", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client, "locked");
      return {
        noPayer: await runUpdate(
          client,
          id,
          `status = 'paid', paid_at = now()`,
        ),
        noTime: await runUpdate(
          client,
          id,
          `status = 'paid', paid_by = 'pay-user'`,
        ),
        full: await runUpdate(client, id, RUN_STEPS.paid),
      };
    });
    expect(result.noPayer).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.noTime).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.full).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("[PAYR-02] a locked run keeps its snapshot, totals, period, policy and approvals", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client, "locked");
      const blocked = {
        snapshot: await runUpdate(client, id, `config_snapshot = '{"v":2}'`),
        totals: await runUpdate(client, id, `totals = '{"t":2}'`),
        periodEnd: await runUpdate(client, id, `period_end = '2031-01-01'`),
        payDate: await runUpdate(client, id, `pay_date = '2031-01-02'`),
        // Another id: the guard (BEFORE trigger) refuses before the FK is checked.
        policy: await runUpdate(client, id, `payroll_policy_id = $2`, [
          randomUUID(),
        ]),
        approver: await runUpdate(client, id, `approved_by_hr = 'someone'`),
        locker: await runUpdate(client, id, `locked_by = 'someone'`),
        lockedAt: await runUpdate(
          client,
          id,
          `locked_at = now() + interval '1 hour'`,
        ),
        backToDraft: await runUpdate(client, id, `status = 'draft'`),
        backToApproved: await runUpdate(client, id, `status = 'approved'`),
        createdBy: await runUpdate(client, id, `created_by = 'someone'`),
      };
      const paid = await runUpdate(client, id, RUN_STEPS.paid);
      const final = await client.query<{
        status: string;
        config_snapshot: unknown;
        totals: unknown;
      }>(
        `SELECT status, config_snapshot, totals FROM payroll_runs WHERE id = $1`,
        [id],
      );
      return { blocked, paid, final: final.rows[0] };
    });
    for (const [name, outcome] of Object.entries(result.blocked))
      expect({ name, ...outcome }).toEqual({
        name,
        ok: false,
        code: CHECK_VIOLATION,
      });
    // locked -> paid is allowed and changes nothing else.
    expect(result.paid).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.final).toEqual({
      status: "paid",
      config_snapshot: { v: 1 },
      totals: { t: 1 },
    });
  });

  it("[PAYR-05] a paid run cannot change, and cannot be reversed", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client, "paid");
      return {
        paidAt: await runUpdate(
          client,
          id,
          `paid_at = now() + interval '1 day'`,
        ),
        paidBy: await runUpdate(client, id, `paid_by = 'someone'`),
        toLocked: await runUpdate(client, id, `status = 'locked'`),
        toReversed: await runUpdate(client, id, RUN_STEPS.reversed),
        reversalOnly: await runUpdate(
          client,
          id,
          `reversal = '{"status":"requested"}'`,
        ),
        remove: await attempt(
          client,
          `DELETE FROM payroll_runs WHERE id = $1`,
          [id],
        ),
      };
    });
    for (const [name, outcome] of Object.entries({
      paidAt: result.paidAt,
      paidBy: result.paidBy,
      toLocked: result.toLocked,
      toReversed: result.toReversed,
      reversalOnly: result.reversalOnly,
    }))
      expect({ name, ...outcome }).toEqual({
        name,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.remove).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
  });

  it("[PAYR-05] a locked run is reversed only through an approved reversal, then is frozen", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client, "locked");
      const requested = await runUpdate(
        client,
        id,
        `status = 'reversed', reversal = '{"status":"requested"}'`,
      );
      const rejected = await runUpdate(
        client,
        id,
        `status = 'reversed', reversal = '{"status":"rejected"}'`,
      );
      // While locked, the reversal record itself may change (request, reject).
      const request = await runUpdate(
        client,
        id,
        `reversal = '{"status":"requested"}'`,
      );
      const approved = await runUpdate(client, id, RUN_STEPS.reversed);
      return {
        requested,
        rejected,
        request,
        approved,
        reopen: await runUpdate(client, id, `status = 'locked'`),
        repay: await runUpdate(client, id, `status = 'paid'`),
        edit: await runUpdate(
          client,
          id,
          `reversal = '{"status":"approved","x":1}'`,
        ),
      };
    });
    for (const [name, outcome] of Object.entries({
      requested: result.requested,
      rejected: result.rejected,
      reopen: result.reopen,
      repay: result.repay,
      edit: result.edit,
    }))
      expect({ name, ...outcome }).toEqual({
        name,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.request).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.approved).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("[PAYR-05] a run cannot be reversed without any reversal record (NULL must not pass the check)", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newRun(client, "locked");
      return runUpdate(client, id, `status = 'reversed'`);
    });
    // SCHEMA BUG if this fails: payroll_runs_reversed_check evaluates to NULL
    // (which a CHECK accepts) when `reversal` is NULL.
    expect(result).toEqual({ ok: false, code: CHECK_VIOLATION });
  });

  it("[PAYR-02] only one live regular run per policy and period start; a reversed run frees the period", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const start = dayStr(5000 + seq());
      const first = await newRun(client, undefined, {
        period_start: start,
        period_end: start,
      });
      const duplicateRow = insertSql("payroll_runs", {
        id: randomUUID(),
        ...BUILD.payroll_runs(A, "", 1),
        period_start: start,
        period_end: start,
      });
      const duplicate = await attempt(
        client,
        duplicateRow.text,
        duplicateRow.values,
      );
      // Another policy, an off-cycle run, and a different start are all fine.
      const offCycleRow = insertSql("payroll_runs", {
        id: randomUUID(),
        ...BUILD.payroll_runs(A, "", 1),
        run_type: "off_cycle",
        period_start: start,
        period_end: start,
      });
      const offCycle = await attempt(
        client,
        offCycleRow.text,
        offCycleRow.values,
      );
      // Reverse the first run through its lifecycle; the period is free again.
      for (const step of RUN_PATH.slice(0, 4))
        await runUpdate(client, first, RUN_STEPS[step]);
      await runUpdate(client, first, RUN_STEPS.reversed);
      const redoRow = insertSql("payroll_runs", {
        id: randomUUID(),
        ...BUILD.payroll_runs(A, "", 1),
        period_start: start,
        period_end: start,
      });
      const redo = await attempt(client, redoRow.text, redoRow.values);
      return { duplicate, offCycle, redo };
    });
    expect(result.duplicate).toEqual({ ok: false, code: UNIQUE_VIOLATION });
    expect(result.offCycle).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.redo).toMatchObject({ ok: true, rowCount: 1 });
  });
});

describe("payroll core: payslips and bank files need a locked run (PAYR-01, PAYR-04)", () => {
  it("a payslip can be inserted only for a locked run", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const out: Record<string, Attempt> = {};
      for (const upTo of [
        undefined,
        "simulated",
        "approved",
        "locked",
        "paid",
      ] as const) {
        const runId = await newRun(client, upTo);
        const id = randomUUID();
        const row = insertSql("payslips", {
          ...BUILD.payslips(A, id, 1),
          id,
          payroll_run_id: runId,
        });
        out[upTo ?? "draft"] = await attempt(client, row.text, row.values);
      }
      return out;
    });
    for (const status of ["draft", "simulated", "approved", "paid"])
      expect({ status, ...result[status]! }).toEqual({
        status,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.locked).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a payslip cannot be added to a reversed run", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const runId = await newRun(client, "locked");
      await runUpdate(client, runId, RUN_STEPS.reversed);
      const id = randomUUID();
      const row = insertSql("payslips", {
        ...BUILD.payslips(A, id, 1),
        id,
        payroll_run_id: runId,
      });
      return attempt(client, row.text, row.values);
    });
    expect(result).toEqual({ ok: false, code: CHECK_VIOLATION });
  });

  it("a bank file can be inserted only for a locked or paid run", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const out: Record<string, Attempt> = {};
      for (const upTo of [undefined, "approved", "locked", "paid"] as const) {
        const runId = await newRun(client, upTo);
        const row = insertSql("bank_transfer_files", {
          ...BUILD.bank_transfer_files(A, "", 1),
          payroll_run_id: runId,
        });
        out[upTo ?? "draft"] = await attempt(client, row.text, row.values);
      }
      const reversed = await newRun(client, "locked");
      await runUpdate(client, reversed, RUN_STEPS.reversed);
      const row = insertSql("bank_transfer_files", {
        ...BUILD.bank_transfer_files(A, "", 1),
        payroll_run_id: reversed,
      });
      out.reversed = await attempt(client, row.text, row.values);
      return out;
    });
    for (const status of ["draft", "approved", "reversed"])
      expect({ status, ...result[status]! }).toEqual({
        status,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.locked).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.paid).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a payslip PDF key and first view are set once and never repointed", async () => {
    const id = need(A, "payslips");
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const pdf = await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = 'payslips/a.pdf' WHERE id = $1`,
        [id],
      );
      const repoint = await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = 'payslips/b.pdf' WHERE id = $1`,
        [id],
      );
      const clearPdf = await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = NULL WHERE id = $1`,
        [id],
      );
      const viewed = await attempt(
        client,
        `UPDATE payslips SET viewed_at = '2026-02-01T00:00:00Z' WHERE id = $1`,
        [id],
      );
      const viewedAgain = await attempt(
        client,
        `UPDATE payslips SET viewed_at = now() WHERE id = $1`,
        [id],
      );
      const key = await client.query<{ pdf_object_key: string }>(
        `SELECT pdf_object_key FROM payslips WHERE id = $1`,
        [id],
      );
      return { pdf, repoint, clearPdf, viewed, viewedAgain, key: key.rows[0] };
    });
    expect(result.pdf).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.repoint).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.clearPdf).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.viewed).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.viewedAgain).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.key).toEqual({ pdf_object_key: "payslips/a.pdf" });
  });
});

describe("payroll core: employee pay windows (HR-03, PAYR-02)", () => {
  it("windows of one employee and component never overlap; adjacent ones are fine", async () => {
    const seeded = need(A, "employee_pay_components");
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const close = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-03-31' WHERE id = $1`,
        [seeded],
      );
      const insertFrom = async (from: string, to: string | null = null) => {
        const id = randomUUID();
        const row = insertSql("employee_pay_components", {
          ...BUILD.employee_pay_components(A, id, 0),
          id,
          effective_from: from,
          effective_to: to,
        });
        return attempt(client, row.text, row.values);
      };
      return {
        close,
        // Starts inside the closed window.
        overlapOpen: await insertFrom("2026-03-01"),
        overlapClosed: await insertFrom("2026-02-01", "2026-02-15"),
        // Starts before it and runs into it.
        coversWindow: await insertFrom("2025-12-01", "2026-01-10"),
        adjacent: await insertFrom("2026-04-01"),
        before: await insertFrom("2025-11-01", "2025-12-31"),
      };
    });
    expect(result.close).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.overlapOpen).toEqual({
      ok: false,
      code: EXCLUSION_VIOLATION,
    });
    expect(result.overlapClosed).toEqual({
      ok: false,
      code: EXCLUSION_VIOLATION,
    });
    expect(result.coversWindow).toEqual({
      ok: false,
      code: EXCLUSION_VIOLATION,
    });
    expect(result.adjacent).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.before).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a different component or employee may be paid in the same days", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const insert = async (cols: Cols) => {
        const id = randomUUID();
        const row = insertSql("employee_pay_components", {
          ...BUILD.employee_pay_components(A, id, 1),
          id,
          effective_from: "2026-01-01",
          ...cols,
        });
        return attempt(client, row.text, row.values);
      };
      return {
        otherComponent: await insert({}),
        otherEmployee: await insert({
          employee_id: A.employeeIds[1],
          component_id: A.componentIds[0],
        }),
      };
    });
    expect(result.otherComponent).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.otherEmployee).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("a window is closed once: NULL to a date is allowed, date to NULL or another date is not", async () => {
    const id = need(A, "employee_pay_components");
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const beforeStart = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2025-12-31' WHERE id = $1`,
        [id],
      );
      const close = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-06-30' WHERE id = $1`,
        [id],
      );
      const reopen = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = NULL WHERE id = $1`,
        [id],
      );
      const shorten = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-05-31' WHERE id = $1`,
        [id],
      );
      const extend = await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-12-31' WHERE id = $1`,
        [id],
      );
      const stored = await client.query<{ effective_to: string }>(
        `SELECT effective_to::text AS effective_to FROM employee_pay_components WHERE id = $1`,
        [id],
      );
      return {
        beforeStart,
        close,
        reopen,
        shorten,
        extend,
        stored: stored.rows[0],
      };
    });
    expect(result.beforeStart).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.close).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.reopen).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.shorten).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.extend).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.stored).toEqual({ effective_to: "2026-06-30" });
  });
});

describe("payroll core: service charge pool guards (PAYR-04)", () => {
  const newPool = async (client: PoolClient, over: Cols = {}) => {
    const id = randomUUID();
    const start = dayStr(8000 + seq());
    const row = insertSql("service_charge_pools", {
      ...BUILD.service_charge_pools(A, id, 1),
      id,
      period_start: start,
      period_end: start,
      ...over,
    });
    await client.query(row.text, row.values);
    return id;
  };
  const poolUpdate = (client: PoolClient, id: string, set: string) =>
    attempt(client, `UPDATE service_charge_pools SET ${set} WHERE id = $1`, [
      id,
    ]);

  it("a pool is born a draft", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const out: Record<string, Attempt> = {};
      for (const status of [
        "calculated",
        "approved",
        "distributed",
        "cancelled",
      ]) {
        const id = randomUUID();
        const start = dayStr(9000 + seq());
        const row = insertSql("service_charge_pools", {
          ...BUILD.service_charge_pools(A, id, 1),
          id,
          period_start: start,
          period_end: start,
          status,
          ...(status === "approved" || status === "distributed"
            ? { approved_by: "u", approved_at: new Date() }
            : {}),
          ...(status === "distributed"
            ? { payroll_run_id: need(A, "payroll_runs") }
            : {}),
        });
        out[status] = await attempt(client, row.text, row.values);
      }
      return out;
    });
    for (const [status, outcome] of Object.entries(result))
      expect({ status, ...outcome }).toEqual({
        status,
        ok: false,
        code: CHECK_VIOLATION,
      });
  });

  it("a pool moves draft > calculated > approved > distributed only, and an approved pool is fixed", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newPool(client);
      const skip = await poolUpdate(
        client,
        id,
        `status = 'approved', approved_by = 'u', approved_at = now()`,
      );
      const calculate = await poolUpdate(client, id, `status = 'calculated'`);
      const editWhileCalculated = await poolUpdate(
        client,
        id,
        `amount_idr = 2000000`,
      );
      const approve = await poolUpdate(
        client,
        id,
        `status = 'approved', approved_by = 'u', approved_at = now()`,
      );
      return {
        skip,
        calculate,
        editWhileCalculated,
        approve,
        amount: await poolUpdate(client, id, `amount_idr = 3000000`),
        rule: await poolUpdate(client, id, `rule = '{"kind":"other"}'`),
        period: await poolUpdate(client, id, `period_end = '2040-01-01'`),
        outlet: await poolUpdate(client, id, `outlet_id = '${randomUUID()}'`),
        approver: await poolUpdate(client, id, `approved_by = 'someone'`),
        backToDraft: await poolUpdate(client, id, `status = 'draft'`),
        createdBy: await poolUpdate(client, id, `created_by = 'someone'`),
        remove: await attempt(
          client,
          `DELETE FROM service_charge_pools WHERE id = $1`,
          [id],
        ),
      };
    });
    expect(result.skip).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.calculate).toMatchObject({ ok: true, rowCount: 1 });
    // Until approval a pool may still be recalculated with another amount.
    expect(result.editWhileCalculated).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.approve).toMatchObject({ ok: true, rowCount: 1 });
    for (const name of [
      "amount",
      "rule",
      "period",
      "outlet",
      "approver",
      "backToDraft",
      "createdBy",
    ] as const)
      expect({ name, ...result[name] }).toEqual({
        name,
        ok: false,
        code: CHECK_VIOLATION,
      });
    expect(result.remove).toEqual({ ok: false, code: INSUFFICIENT_PRIVILEGE });
  });

  it("a cancelled pool is frozen", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const id = await newPool(client);
      return {
        cancel: await poolUpdate(client, id, `status = 'cancelled'`),
        edit: await poolUpdate(client, id, `amount_idr = 5`),
        revive: await poolUpdate(client, id, `status = 'draft'`),
      };
    });
    expect(result.cancel).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.edit).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.revive).toEqual({ ok: false, code: CHECK_VIOLATION });
  });

  it("allocations change only while the pool is draft or calculated", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => {
      const poolId = await newPool(client);
      const allocate = async (employeeId: string) => {
        const id = randomUUID();
        const row = insertSql("service_charge_allocations", {
          ...BUILD.service_charge_allocations(A, id, 0),
          id,
          pool_id: poolId,
          employee_id: employeeId,
        });
        return { id, outcome: await attempt(client, row.text, row.values) };
      };
      const whileDraft = await allocate(A.employeeIds[0]);
      await poolUpdate(client, poolId, `status = 'calculated'`);
      const whileCalculated = await allocate(A.employeeIds[1]);
      const recalcDelete = await attempt(
        client,
        `DELETE FROM service_charge_allocations WHERE id = $1`,
        [whileDraft.id],
      );
      const replacement = await allocate(A.employeeIds[0]);
      await poolUpdate(
        client,
        poolId,
        `status = 'approved', approved_by = 'u', approved_at = now()`,
      );
      const edit = await attempt(
        client,
        `UPDATE service_charge_allocations SET amount_idr = 1 WHERE id = $1`,
        [whileCalculated.id],
      );
      const remove = await attempt(
        client,
        `DELETE FROM service_charge_allocations WHERE id = $1`,
        [whileCalculated.id],
      );
      // A free employee slot: only the pool state can refuse it.
      await attempt(
        client,
        `DELETE FROM service_charge_allocations WHERE id = $1`,
        [replacement.id],
      );
      const afterApproval = await allocate(A.employeeIds[0]);
      return {
        whileDraft: whileDraft.outcome,
        whileCalculated: whileCalculated.outcome,
        recalcDelete,
        replacement: replacement.outcome,
        edit,
        remove,
        afterApproval: afterApproval.outcome,
      };
    });
    expect(result.whileDraft).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.whileCalculated).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.recalcDelete).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.replacement).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.edit).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.remove).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.afterApproval).toEqual({ ok: false, code: CHECK_VIOLATION });
  });
});

describe("payroll core: loan policy total open cap (legend-hjaot)", () => {
  const setTotal = (client: PoolClient, value: number | null) =>
    attempt(
      client,
      "UPDATE payroll_loan_policies SET max_total_open_idr = $2 WHERE id = $1",
      [need(A, "payroll_loan_policies"), value],
    );

  it("rejects a total of zero or below, and NULL", async () => {
    const result = await asApp({ tenant: A.tenantId }, async (client) => ({
      zero: await setTotal(client, 0),
      negative: await setTotal(client, -1),
      missing: await setTotal(client, null),
      // Seeded per-loan ceiling is 5,000,000: the total may not be below it.
      belowCeiling: await setTotal(client, 4_999_999),
      valid: await setTotal(client, 5_000_000),
    }));
    expect(result.zero).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.negative).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.missing).toEqual({ ok: false, code: NOT_NULL_VIOLATION });
    expect(result.belowCeiling).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.valid).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("refuses to insert a policy without a total or with a non-positive one", async () => {
    // Constraints fire before the one-row-per-tenant unique index, so the
    // seeded row can stay; everything is rolled back anyway.
    const result = await asApp({ tenant: B.tenantId }, async (client) => {
      const insertWith = (total: number | null) =>
        attempt(
          client,
          `INSERT INTO payroll_loan_policies
             (tenant_id, max_principal_idr, max_installments, max_deduction_of_net_pay_bp, max_total_open_idr)
           VALUES ($1, 5000000, 12, 3000, $2)`,
          [B.tenantId, total],
        );
      return {
        zero: await insertWith(0),
        negative: await insertWith(-5),
        missing: await insertWith(null),
      };
    });
    expect(result.zero).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.negative).toEqual({ ok: false, code: CHECK_VIOLATION });
    expect(result.missing).toEqual({ ok: false, code: NOT_NULL_VIOLATION });
  });
});
