// legend-1265 G3: `node dist/backfill-ptkp-history.js` runs as the migration
// owner only, and proves it on a real database with row level security and two
// tenants that hold locked payslips. The app login (legend_app, no BYPASSRLS)
// must never run it: it cannot write the history, and a role that cannot see
// the rows would report a clean "0 employees". Needs
// `heavy pnpm --filter @starter/api build` first; skipped on a tree without dist/.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealPayrollValue } from "../lib/payroll-sealed.ts";
import { insertPolicy } from "./payroll-simulate-kit.ts";

const apiDir = resolve(import.meta.dirname, "../..");
const script = resolve(apiDir, "dist/backfill-ptkp-history.js");
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appUrl = process.env.DATABASE_URL!;
const ownerUrl = process.env.STARTER_TEST_DATABASE_URL!;

type Seed = { tenantId: string; employeeId: string; currentStatus: string };
const seeded: Seed[] = [];

async function inTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // Triggers off: the seed writes locked runs and slips directly.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

/** One tenant with a locked 2026 run and one sealed payslip (status TK/0). */
async function seedTenant(currentStatus: string): Promise<Seed> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const entityId = randomUUID();
  const outletId = randomUUID();
  const employeeId = randomUUID();
  const policyId = randomUUID();
  const runId = randomUUID();
  const slipId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
     VALUES ($1, $2, $3, 'free', 'shared', '{}', 'ptkp-cli-1265')`,
    [tenantId, `ptkp-${tag}`, `PTKP CLI ${tag}`],
  );
  await inTenant(tenantId, async (c) => {
    await c.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [brandId, tenantId, `b-${tag}`, `Brand ${tag}`],
    );
    await c.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
      [entityId, tenantId, `PT ${tag}`],
    );
    await c.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', '{}')`,
      [outletId, tenantId, brandId, entityId, `O${tag}`.toUpperCase(), tag],
    );
    await c.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status, ptkp_status)
       VALUES ($1, $2, $3, 'Karyawan Uji', $4, $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        employeeId,
        tenantId,
        `E-${tag.toUpperCase()}`,
        outletId,
        entityId,
        currentStatus,
      ],
    );
    await insertPolicy(c, tenantId, entityId, policyId);
    await c.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by, status,
                                 config_snapshot, totals, approved_by_hr, approved_by_hr_at,
                                 approved_by_finance, approved_by_finance_at, locked_by, locked_at)
       VALUES ($1, $2, $3, $4, 'regular', '2026-01-01', '2026-01-31', '2026-01-28',
               'ptkp-cli-1265', 'locked', '{}', '{}', 'hr-1265', now(),
               'finance-1265', now(), 'lock-1265', now())`,
      [runId, tenantId, entityId, policyId],
    );
    const calculation = {
      employeeId,
      employeeNo: `E-${tag.toUpperCase()}`,
      employeeName: "Karyawan Uji",
      positionName: null,
      outletId,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-01-28",
      grossIdr: 5000000,
      deductionsIdr: 0,
      netIdr: 5000000,
      pph21Idr: 0,
      bpjsEmployeeIdr: 0,
      bpjsCompanyIdr: 0,
      serviceChargeIdr: 0,
      overtimeIdr: 0,
      lines: [
        {
          componentCode: "GAJI",
          name: "Gaji pokok",
          category: "base_salary",
          kind: "earning",
          amountIdr: 5000000,
          taxable: true,
          quantity: null,
          sourceId: null,
        },
      ],
      bpjs: [],
      tax: {
        ptkpStatus: "TK/0",
        method: "ter",
        terCategory: "A",
        terRateBp: 0,
        taxableGrossIdr: 5000000,
        pph21Idr: 0,
        pph21WithheldIdr: 0,
        taxAllowanceIdr: 0,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
        pph21EmployerRefundIdr: 0,
        noTaxIdSurchargeApplied: false,
        grossSchemeBaseIdr: 5000000,
        employerSchemeBaseIdr: 0,
      },
      paymentMethod: "cash",
    };
    await c.query(
      `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                             calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, $4, 'cash', $5, 1)`,
      [
        slipId,
        tenantId,
        runId,
        employeeId,
        sealPayrollValue(
          JSON.stringify(calculation),
          { tenantId, table: "payslips", rowId: slipId, field: "calculation" },
          1,
        ),
      ],
    );
  });
  return { tenantId, employeeId, currentStatus };
}

const history = async (seed: Seed) =>
  (
    await inTenant(seed.tenantId, (c) =>
      c.query<{ effective_from: string; ptkp_status: string }>(
        `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, ptkp_status
           FROM employee_ptkp_history
          WHERE tenant_id = $1 AND employee_id = $2 ORDER BY effective_from`,
        [seed.tenantId, seed.employeeId],
      ),
    )
  ).rows;

async function clearHistory() {
  for (const seed of seeded)
    await inTenant(seed.tenantId, (c) =>
      c.query("DELETE FROM employee_ptkp_history WHERE tenant_id = $1", [
        seed.tenantId,
      ]),
    );
}

function run(env: Record<string, string | undefined>, args: string[] = []) {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  delete merged.MIGRATION_DATABASE_URL;
  delete merged.MIGRATION_DATABASE_URL_FILE;
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: merged,
    timeout: 60_000,
  });
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
  };
}

describe.skipIf(!existsSync(script))("backfill-ptkp-history in dist", () => {
  beforeAll(async () => {
    seeded.push(await seedTenant("K/0"), await seedTenant("TK/0"));
  }, 60_000);

  afterAll(async () => {
    for (const seed of seeded)
      await inTenant(seed.tenantId, async (c) => {
        for (const table of [
          "employee_ptkp_history",
          "payslips",
          "payroll_runs",
          "payroll_policies",
          "employees",
          "outlets",
          "legal_entities",
          "brands",
        ])
          await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            seed.tenantId,
          ]);
      });
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      seeded.map((seed) => seed.tenantId),
    ]);
    await owner.end();
  }, 60_000);

  it("the app login cannot read the payroll rows without a tenant context (RLS is real)", async () => {
    const app = new Pool({ connectionString: appUrl, max: 1 });
    try {
      await expect(
        app.query("SELECT count(*) FROM employees"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });

  it("stops before any connection without MIGRATION_DATABASE_URL, even with the app DATABASE_URL", async () => {
    await clearHistory();
    const result = run({ DATABASE_URL: appUrl });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.out).toContain("MIGRATION_DATABASE_URL");
    expect(result.out).not.toContain("PTKP history");
    for (const seed of seeded) expect(await history(seed)).toEqual([]);
  });

  it("refuses the app login given as the migration URL and writes nothing", async () => {
    await clearHistory();
    const result = run({ MIGRATION_DATABASE_URL: appUrl });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.out).toMatch(/migration owner/i);
    for (const seed of seeded) expect(await history(seed)).toEqual([]);
  });

  it("writes the history of both tenants as the migration owner, and is idempotent", async () => {
    await clearHistory();
    for (let pass = 0; pass < 2; pass += 1) {
      const result = run({ MIGRATION_DATABASE_URL: ownerUrl });
      expect(result.status, result.out).toBe(0);
      expect(result.out).toMatch(/PTKP history 2026: \d+ tenant, \d+ karyawan/);
      const [changed, same] = seeded;
      expect(await history(changed!)).toEqual([
        { effective_from: "2026-01-01", ptkp_status: "TK/0" },
        { effective_from: expect.any(String), ptkp_status: "K/0" },
      ]);
      expect(await history(same!)).toEqual([
        { effective_from: "2026-01-01", ptkp_status: "TK/0" },
      ]);
    }
  });

  it("reads the migration URL from MIGRATION_DATABASE_URL_FILE", async () => {
    await clearHistory();
    const dir = mkdtempSync(join(tmpdir(), "ptkp-url-"));
    try {
      const file = join(dir, "url");
      writeFileSync(file, `${ownerUrl}\n`, { mode: 0o600 });
      const result = run({ MIGRATION_DATABASE_URL_FILE: file });
      expect(result.status, result.out).toBe(0);
      expect((await history(seeded[0]!)).length).toBeGreaterThan(0);
      const both = run({
        MIGRATION_DATABASE_URL_FILE: file,
        MIGRATION_DATABASE_URL: ownerUrl,
      });
      expect(both.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repair-supplier-invoice-npwp also stops without the migration URL, before any connection", () => {
    const npwp = resolve(apiDir, "dist/repair-supplier-invoice-npwp.js");
    const merged: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: appUrl };
    delete merged.MIGRATION_DATABASE_URL;
    delete merged.MIGRATION_DATABASE_URL_FILE;
    const id = () => randomUUID();
    const result = spawnSync(
      process.execPath,
      [
        npwp,
        "--tenant",
        id(),
        "--entity",
        id(),
        "--invoice",
        id(),
        "--actor",
        id(),
        "--reason",
        "valid audited reason",
      ],
      { encoding: "utf8", env: merged, timeout: 60_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(`${result.stdout}${result.stderr}`).toContain(
      "MIGRATION_DATABASE_URL",
    );
  });
});
