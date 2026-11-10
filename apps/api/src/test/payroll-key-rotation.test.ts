// Payroll sealed values ride the HRIS key ring (bead legend-snhxw): the re-seal
// job moves `employee_pay_components.amount_encrypted` and
// `payslips.calculation_encrypted` from key version 1 to the active version 2,
// and the database guards allow that move ONLY for the job (transaction flag
// `app.payroll_reseal`), never for ordinary app writes.
//
// The suite runs with a key ring of versions 1 and 2 and version 2 active.
// Fixture rows are written as the table owner with triggers off
// (session_replication_role = replica) so the tests do not depend on the guard
// they are checking; the job and the guard assertions run as legend_app.
//
// Assumptions (the contract in the brief, not the spec text):
// - A write that changes a sealed column or pii_key_version without the flag is
//   rejected either by a missing column grant (42501) or by the guard
//   (23514, message starting `PAYR-KEY:`). Cases the grant cannot cover (only
//   the version changes, only the ciphertext changes, version 0, extra column
//   on payslips) must be the guard itself: 23514 with `PAYR-KEY:`.
// - Employees are created at the active version so only payroll rows are stale.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Config reads the environment when it loads, before the imports below run.
const KEY2 = vi.hoisted(() => {
  const key = Buffer.alloc(32, 9).toString("base64");
  process.env.HRIS_PII_KEYS = `2:${key}`;
  process.env.HRIS_PII_ACTIVE_KEY_VERSION = "2";
  return key;
});

import { idr } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  openPayrollAmount,
  openPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
  sealPayrollValue,
  type PayrollSealBinding,
} from "../lib/payroll-sealed.ts";
import {
  listAllTenantIds,
  runHrisPiiReseal,
} from "../worker/hris-pii-reseal.job.ts";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenants: string[] = [tenantA, tenantB];
/** Rows per tenant: A has three of each, B has two. */
const ROWS = { [tenantA]: 3, [tenantB]: 2 } as const;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

type Fixture = {
  tenantId: string;
  brandId: string;
  entityId: string;
  outletId: string;
  runId: string;
  employeeIds: string[];
  componentIds: string[];
  pay: { id: string; amount: number }[];
  slips: { id: string; calc: string }[];
};
const fixtures: Record<string, Fixture> = {};

const payBinding = (tenantId: string, rowId: string): PayrollSealBinding => ({
  tenantId,
  table: "employee_pay_components",
  rowId,
  field: "amount",
});
const slipBinding = (tenantId: string, rowId: string): PayrollSealBinding => ({
  tenantId,
  table: "payslips",
  rowId,
  field: "calculation",
});

/** Owner transaction scoped to one tenant; `raw` also turns triggers off. */
async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
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

/** A legend_app transaction that is always rolled back. */
async function asApp<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

type Attempt =
  | { ok: true; rowCount: number }
  | { ok: false; code: string | undefined; message: string };

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
    return { ok: true, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code, message: e.message ?? "" };
  }
}

const enableFlag = (client: PoolClient) =>
  client.query("SELECT set_config('app.payroll_reseal', 'on', true)");

/** The guard itself said no: check violation with the PAYR-KEY prefix. */
function expectGuard(result: Attempt) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("23514");
  expect(result.message).toMatch(/^PAYR-KEY:/);
}

/** Rejected by the guard or by a missing column grant. */
function expectRejected(result: Attempt) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  if (result.code === "42501") return;
  expectGuard(result);
}

const RUN_STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
];

let counter = 0;

async function seedTenant(tenantId: string, rows: number): Promise<Fixture> {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Payroll key tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `payroll-key-${tenantId.slice(0, 8)}`, fixtureTenant],
  );
  const f: Fixture = {
    tenantId,
    brandId: randomUUID(),
    entityId: randomUUID(),
    outletId: randomUUID(),
    runId: randomUUID(),
    employeeIds: [],
    componentIds: [],
    pay: [],
    slips: [],
  };
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [f.brandId, tenantId],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payroll Key', false)`,
      [f.entityId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'K-01', 'Outlet K', 'Jl. K', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [f.outletId, tenantId, f.brandId, f.entityId],
    );
    const policyId = randomUUID();
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Kunci', 'GK', '{"code":"GK"}', '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenantId, f.entityId],
    );
    const day = (n: number) =>
      new Date(Date.UTC(2031, 0, 1 + n)).toISOString().slice(0, 10);
    const start = ++counter * 3;
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'payroll-key-test')`,
      [f.runId, tenantId, f.entityId, policyId, day(start), day(start + 1)],
    );
    for (const step of RUN_STEPS)
      await client.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        f.runId,
      ]);
    for (let i = 0; i < rows; i++) {
      const employeeId = randomUUID();
      const componentId = randomUUID();
      f.employeeIds.push(employeeId);
      f.componentIds.push(componentId);
      // Created at the active version: only the payroll rows are stale below.
      await client.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status, pii_key_version)
         VALUES ($1, $2, $3, 'Karyawan Kunci', $4, 'pkwtt', '2025-03-01', 'active', $5)`,
        [
          employeeId,
          tenantId,
          `PK-${i}-${employeeId.slice(0, 8).toUpperCase()}`,
          f.outletId,
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
      await client.query(
        `INSERT INTO pay_components (id, tenant_id, code, name, category, kind, recurrence,
                                     taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
         VALUES ($1, $2, $3, 'Komponen Kunci', 'base_salary', 'earning', 'fixed',
                 true, 'gross', true, true, true)`,
        [componentId, tenantId, `KC${++counter}`],
      );
      f.pay.push({ id: randomUUID(), amount: 5_000_000 + 12_345 * (i + 1) });
      f.slips.push({
        id: randomUUID(),
        calc: JSON.stringify({ net: 4_242_000 + 777 * (i + 1) }),
      });
    }
    for (const [i, p] of f.pay.entries())
      await client.query(
        `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
                                              amount_encrypted, pii_key_version, effective_from, created_by)
         VALUES ($1, $2, $3, $4, $5, 1, '2026-01-01', 'payroll-key-test')`,
        [
          p.id,
          tenantId,
          f.employeeIds[i],
          f.componentIds[i],
          sealPayrollAmount(idr(p.amount), payBinding(tenantId, p.id), 1),
        ],
      );
    for (const [i, s] of f.slips.entries())
      await client.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'bank_transfer', $5, 1)`,
        [
          s.id,
          tenantId,
          f.runId,
          f.employeeIds[i],
          sealPayrollValue(s.calc, slipBinding(tenantId, s.id), 1),
        ],
      );
  });
  return f;
}

/** Writes every sealed row of a tenant at `version` from the known plaintext. */
async function writeAt(tenantId: string, version: number): Promise<void> {
  const f = fixtures[tenantId]!;
  await asOwner(
    tenantId,
    async (client) => {
      for (const p of f.pay)
        await client.query(
          `UPDATE employee_pay_components SET amount_encrypted = $3, pii_key_version = $4
            WHERE tenant_id = $1 AND id = $2`,
          [
            tenantId,
            p.id,
            sealPayrollAmount(
              idr(p.amount),
              payBinding(tenantId, p.id),
              version,
            ),
            version,
          ],
        );
      for (const s of f.slips)
        await client.query(
          `UPDATE payslips SET calculation_encrypted = $3, pii_key_version = $4
            WHERE tenant_id = $1 AND id = $2`,
          [
            tenantId,
            s.id,
            sealPayrollValue(s.calc, slipBinding(tenantId, s.id), version),
            version,
          ],
        );
    },
    true,
  );
}

type Stored = { id: string; bytes: string; version: number };
async function stored(tenantId: string) {
  return asOwner(tenantId, async (client) => {
    const read = async (table: string, column: string) =>
      (
        await client.query(
          `SELECT id, encode(${column}, 'hex') AS bytes, pii_key_version::int AS version
             FROM ${table} WHERE tenant_id = $1 ORDER BY id`,
          [tenantId],
        )
      ).rows as Stored[];
    return {
      pay: await read("employee_pay_components", "amount_encrypted"),
      slips: await read("payslips", "calculation_encrypted"),
    };
  });
}

const versionsOf = (rows: Stored[]) => [...new Set(rows.map((r) => r.version))];

const quiet = { error: () => {} };
const reseal = (
  extra: Partial<Parameters<typeof runHrisPiiReseal>[0]> = {},
  only: string[] = tenants,
) =>
  runHrisPiiReseal({
    batchSize: 2,
    log: quiet,
    listTenantIds: async () => only,
    ...extra,
  });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(PAYROLL_SEAL_KEY_VERSION).toBe(2);
  for (const tenant of tenants)
    fixtures[tenant] = await seedTenant(tenant, ROWS[tenant]!);
});

afterAll(async () => {
  // Payslips of a locked run and sealed rows are immutable by design: the owner
  // skips triggers for the cleanup only.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const tenant of tenants) {
      if (!fixtures[tenant]) continue;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant,
      ]);
      for (const table of [
        "payslips",
        "employee_pay_components",
        "payroll_runs",
        "payroll_policies",
        "pay_components",
        "employees",
        "outlets",
        "legal_entities",
        "brands",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenant]);
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-snhxw payroll seal key ring (unit)", () => {
  const binding = payBinding(randomUUID(), randomUUID());

  it("[HR-03] values sealed under version 1 and version 2 both open under their own version", () => {
    const v1 = sealPayrollValue("v-one", binding, 1);
    const v2 = sealPayrollValue("v-two", binding, 2);
    expect(openPayrollValue(v1, binding, 1)).toBe("v-one");
    expect(openPayrollValue(v2, binding, 2)).toBe("v-two");
    expect(
      openPayrollAmount(sealPayrollAmount(idr(1500), binding, 1), binding, 1),
    ).toBe(1500);
  });

  it("[HR-03] a value sealed under version 2 cannot be opened as version 1, and the reverse", () => {
    const v1 = sealPayrollValue("secret", binding, 1);
    const v2 = sealPayrollValue("secret", binding, 2);
    expect(() => openPayrollValue(v2, binding, 1)).toThrow();
    expect(() => openPayrollValue(v1, binding, 2)).toThrow();
  });

  it("[HR-03] an unsupported key version is refused on seal and open", () => {
    expect(() => sealPayrollValue("x", binding, 9)).toThrow(
      "Unsupported payroll seal key version",
    );
    expect(() =>
      openPayrollValue(sealPayrollValue("x", binding, 2), binding, 9),
    ).toThrow("Unsupported payroll seal key version");
  });

  it("[HR-03] new seals default to the active version (2)", () => {
    expect(PAYROLL_SEAL_KEY_VERSION).toBe(2);
    const sealed = sealPayrollValue("default", binding);
    expect(openPayrollValue(sealed, binding, 2)).toBe("default");
    expect(() => openPayrollValue(sealed, binding, 1)).toThrow();
  });
});

describe("legend-snhxw payroll re-seal job", () => {
  it("[HR-03] rows written before the rotation are version 1 and still readable under version 1", async () => {
    for (const tenant of tenants) {
      const f = fixtures[tenant]!;
      const rows = await stored(tenant);
      expect(rows.pay).toHaveLength(f.pay.length);
      expect(rows.slips).toHaveLength(f.slips.length);
      expect(versionsOf(rows.pay)).toEqual([1]);
      expect(versionsOf(rows.slips)).toEqual([1]);
      for (const p of f.pay) {
        const row = rows.pay.find((r) => r.id === p.id)!;
        expect(
          openPayrollAmount(
            Buffer.from(row.bytes, "hex"),
            payBinding(tenant, p.id),
            1,
          ),
        ).toBe(p.amount);
      }
      for (const s of f.slips) {
        const row = rows.slips.find((r) => r.id === s.id)!;
        expect(
          openPayrollValue(
            Buffer.from(row.bytes, "hex"),
            slipBinding(tenant, s.id),
            1,
          ),
        ).toBe(s.calc);
      }
    }
  });

  it("[HR-03] a run for tenant A moves its pay components and payslips to version 2 and leaves tenant B alone", async () => {
    const beforeA = await stored(tenantA);
    const beforeB = await stored(tenantB);
    const result = await reseal({}, [tenantA]);
    expect(result).toMatchObject({
      tenants: 1,
      payComponents: 3,
      payslips: 3,
      failedTenants: 0,
      incompleteTenants: 0,
      aborted: false,
    });
    const afterA = await stored(tenantA);
    expect(versionsOf(afterA.pay)).toEqual([2]);
    expect(versionsOf(afterA.slips)).toEqual([2]);
    const f = fixtures[tenantA]!;
    for (const p of f.pay) {
      const before = beforeA.pay.find((r) => r.id === p.id)!;
      const after = afterA.pay.find((r) => r.id === p.id)!;
      expect(after.bytes).not.toBe(before.bytes);
      const sealed = Buffer.from(after.bytes, "hex");
      expect(openPayrollAmount(sealed, payBinding(tenantA, p.id), 2)).toBe(
        p.amount,
      );
      expect(() =>
        openPayrollAmount(sealed, payBinding(tenantA, p.id), 1),
      ).toThrow();
      // The tenant binding survives the move.
      expect(() =>
        openPayrollAmount(sealed, payBinding(tenantB, p.id), 2),
      ).toThrow();
    }
    for (const s of f.slips) {
      const before = beforeA.slips.find((r) => r.id === s.id)!;
      const after = afterA.slips.find((r) => r.id === s.id)!;
      expect(after.bytes).not.toBe(before.bytes);
      const sealed = Buffer.from(after.bytes, "hex");
      expect(openPayrollValue(sealed, slipBinding(tenantA, s.id), 2)).toBe(
        s.calc,
      );
      expect(() =>
        openPayrollValue(sealed, slipBinding(tenantA, s.id), 1),
      ).toThrow();
    }
    // Tenant B was not listed: byte for byte unchanged, still version 1.
    expect(await stored(tenantB)).toEqual(beforeB);
    expect(versionsOf(beforeB.pay)).toEqual([1]);
  });

  it("[HR-03] a second run changes nothing and counts 0", async () => {
    const before = await stored(tenantA);
    const result = await reseal({}, [tenantA]);
    expect(result).toMatchObject({
      payComponents: 0,
      payslips: 0,
      failedTenants: 0,
      incompleteTenants: 0,
    });
    expect(await stored(tenantA)).toEqual(before);
  });

  it("[HR-03] the default tenant listing includes a suspended tenant, and it is re-sealed", async () => {
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantB,
    ]);
    try {
      expect(await listAllTenantIds()).toContain(tenantB);
      // Default listing, narrowed to this suite's tenants so other suites'
      // data stays out of the counts.
      const result = await reseal({
        listTenantIds: async () =>
          (await listAllTenantIds()).filter((id) => tenants.includes(id)),
      });
      expect(result).toMatchObject({
        tenants: 2,
        payComponents: 2,
        payslips: 2,
        failedTenants: 0,
        incompleteTenants: 0,
      });
      const b = await stored(tenantB);
      expect(versionsOf(b.pay)).toEqual([2]);
      expect(versionsOf(b.slips)).toEqual([2]);
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        tenantB,
      ]);
    }
  });

  it("[HR-03] an interrupted run resumes: abort after the first batch, rerun finishes, no row moves twice", async () => {
    for (const tenant of tenants) await writeAt(tenant, 1);
    const controller = new AbortController();
    const first = await reseal({
      batchSize: 1,
      signal: controller.signal,
      afterBatch: () => controller.abort(),
    });
    expect(first.aborted).toBe(true);
    expect(first.payComponents + first.payslips).toBe(1);
    const midA = await stored(tenantA);
    const movedBytes = new Map(
      [...midA.pay, ...midA.slips]
        .filter((r) => r.version === 2)
        .map((r) => [r.id, r.bytes]),
    );
    expect(movedBytes.size).toBe(1);

    const resumed = await reseal({ batchSize: 1 });
    expect(resumed).toMatchObject({ aborted: false, failedTenants: 0 });
    // 3 + 2 pay components and 3 + 2 payslips in total, one already done.
    expect(resumed.payComponents + resumed.payslips).toBe(10 - 1);
    const endA = await stored(tenantA);
    for (const row of [...endA.pay, ...endA.slips]) {
      expect(row.version).toBe(2);
      const earlier = movedBytes.get(row.id);
      if (earlier !== undefined) expect(row.bytes).toBe(earlier);
    }
    expect(versionsOf((await stored(tenantB)).pay)).toEqual([2]);
    expect(await reseal()).toMatchObject({ payComponents: 0, payslips: 0 });
  });

  it("[HR-03] a crash after committed batches keeps them; the next run completes the rest", async () => {
    for (const tenant of tenants) await writeAt(tenant, 1);
    let batches = 0;
    const crashed = await reseal({
      batchSize: 1,
      afterBatch: () => {
        batches += 1;
        if (batches === 2) throw new Error("simulated crash");
      },
    });
    expect(crashed.failedTenants).toBe(1);
    const done = crashed.payComponents + crashed.payslips;
    expect(done).toBeGreaterThanOrEqual(2);
    const resumed = await reseal({ batchSize: 1 });
    expect(resumed.failedTenants).toBe(0);
    expect(done + resumed.payComponents + resumed.payslips).toBe(10);
    for (const tenant of tenants) {
      const rows = await stored(tenant);
      expect(versionsOf(rows.pay)).toEqual([2]);
      expect(versionsOf(rows.slips)).toEqual([2]);
    }
  });

  it("[HR-03] stale payroll rows locked by another transaction make the tenant incomplete (payroll tables are counted)", async () => {
    await writeAt(tenantA, 1);
    const target = fixtures[tenantA]!.pay[0]!;
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantA],
      );
      await holder.query(
        "SELECT id FROM employee_pay_components WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, target.id],
      );
      const result = await reseal({}, [tenantA]);
      expect(result).toMatchObject({
        failedTenants: 0,
        incompleteTenants: 1,
        payComponents: 2,
        payslips: 3,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await reseal({}, [tenantA])).toMatchObject({
      payComponents: 1,
      payslips: 0,
      incompleteTenants: 0,
    });
  });

  it("[HR-03] a corrupt ciphertext fails only its tenant: B is logged without values and unchanged, A still finishes", async () => {
    for (const tenant of tenants) await writeAt(tenant, 1);
    const bad = fixtures[tenantB]!.pay[0]!;
    await asOwner(
      tenantB,
      async (client) => {
        await client.query(
          `UPDATE employee_pay_components
              SET amount_encrypted = set_byte(amount_encrypted, length(amount_encrypted) - 1,
                                              get_byte(amount_encrypted, length(amount_encrypted) - 1) # 255)
            WHERE tenant_id = $1 AND id = $2`,
          [tenantB, bad.id],
        );
      },
      true,
    );
    const beforeB = await stored(tenantB);
    const errors: string[] = [];
    const result = await reseal(
      { log: { error: (m: string) => errors.push(m) } },
      [tenantB, tenantA],
    );
    expect(result.failedTenants).toBe(1);
    const afterB = await stored(tenantB);
    expect(afterB.pay.find((r) => r.id === bad.id)).toEqual(
      beforeB.pay.find((r) => r.id === bad.id),
    );
    const a = await stored(tenantA);
    expect(versionsOf(a.pay)).toEqual([2]);
    expect(versionsOf(a.slips)).toEqual([2]);
    const log = errors.join("\n");
    expect(log).toContain(tenantB);
    expect(log).not.toContain(KEY2);
    for (const p of fixtures[tenantB]!.pay)
      expect(log).not.toContain(String(p.amount));
    // Fail closed: the next run retries the tenant and fails again.
    expect((await reseal({}, [tenantB])).failedTenants).toBe(1);
  });

  it("[HR-03] an unknown pii_key_version (9) fails its tenant; the row is unchanged and the other tenant is done", async () => {
    for (const tenant of tenants) await writeAt(tenant, 1);
    const bad = fixtures[tenantB]!.slips[0]!;
    await asOwner(
      tenantB,
      async (client) => {
        await client.query(
          `UPDATE payslips SET pii_key_version = 9 WHERE tenant_id = $1 AND id = $2`,
          [tenantB, bad.id],
        );
      },
      true,
    );
    const beforeB = await stored(tenantB);
    const errors: string[] = [];
    const result = await reseal(
      { log: { error: (m: string) => errors.push(m) } },
      [tenantB, tenantA],
    );
    expect(result.failedTenants).toBe(1);
    const afterB = await stored(tenantB);
    expect(afterB.slips.find((r) => r.id === bad.id)).toEqual(
      beforeB.slips.find((r) => r.id === bad.id),
    );
    expect(afterB.slips.find((r) => r.id === bad.id)!.version).toBe(9);
    expect(versionsOf((await stored(tenantA)).slips)).toEqual([2]);
    expect(errors.join("\n")).not.toContain(KEY2);
    // Leave tenant B sound for later suites.
    await writeAt(tenantB, 2);
  });
});

describe("legend-snhxw payroll seal guard triggers (legend_app)", () => {
  beforeAll(async () => {
    for (const tenant of tenants) await writeAt(tenant, 1);
  });

  const pay = () => fixtures[tenantA]!.pay[0]!;
  const slip = () => fixtures[tenantA]!.slips[0]!;
  const newAmount = () =>
    sealPayrollAmount(idr(pay().amount), payBinding(tenantA, pay().id), 2);
  const newCalc = () =>
    sealPayrollValue(slip().calc, slipBinding(tenantA, slip().id), 2);

  it("[HR-03] pay component: sealed column and version cannot change without the reseal flag", async () => {
    const result = await asApp(tenantA, (client) =>
      attempt(
        client,
        `UPDATE employee_pay_components SET amount_encrypted = $2, pii_key_version = 2 WHERE id = $1`,
        [pay().id, newAmount()],
      ),
    );
    expectRejected(result);
  });

  it("[HR-03] pay component: with the flag, sealed column plus version is accepted and opens under the new version", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      const update = await attempt(
        client,
        `UPDATE employee_pay_components SET amount_encrypted = $2, pii_key_version = 2 WHERE id = $1`,
        [pay().id, newAmount()],
      );
      const read = await client.query(
        `SELECT amount_encrypted, pii_key_version::int AS version FROM employee_pay_components WHERE id = $1`,
        [pay().id],
      );
      return { update, row: read.rows[0] };
    });
    expect(result.update).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.row.version).toBe(2);
    expect(
      openPayrollAmount(
        result.row.amount_encrypted,
        payBinding(tenantA, pay().id),
        2,
      ),
    ).toBe(pay().amount);
  });

  it("[HR-03] pay component: with the flag, any other column in the same update is rejected", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      return attempt(
        client,
        `UPDATE employee_pay_components
            SET amount_encrypted = $2, pii_key_version = 2, effective_from = '2025-12-01'
          WHERE id = $1`,
        [pay().id, newAmount()],
      );
    });
    expectRejected(result);
  });

  it("[HR-03] pay component: with the flag, changing only the version, only the ciphertext or a version of 0 is rejected by the guard", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      return {
        versionOnly: await attempt(
          client,
          `UPDATE employee_pay_components SET pii_key_version = 2 WHERE id = $1`,
          [pay().id],
        ),
        sealedOnly: await attempt(
          client,
          `UPDATE employee_pay_components SET amount_encrypted = $2 WHERE id = $1`,
          [pay().id, newAmount()],
        ),
        versionZero: await attempt(
          client,
          `UPDATE employee_pay_components SET amount_encrypted = $2, pii_key_version = 0 WHERE id = $1`,
          [pay().id, newAmount()],
        ),
      };
    });
    expectGuard(result.versionOnly);
    expectGuard(result.sealedOnly);
    expectGuard(result.versionZero);
  });

  it("[HR-03] pay component: closing a pay window still works once and is not reopened", async () => {
    const result = await asApp(tenantA, async (client) => ({
      close: await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-06-30' WHERE id = $1`,
        [pay().id],
      ),
      again: await attempt(
        client,
        `UPDATE employee_pay_components SET effective_to = '2026-12-31' WHERE id = $1`,
        [pay().id],
      ),
    }));
    expect(result.close).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.again.ok).toBe(false);
  });

  it("[HR-03] payslip: calculation and version cannot change without the reseal flag", async () => {
    const result = await asApp(tenantA, (client) =>
      attempt(
        client,
        `UPDATE payslips SET calculation_encrypted = $2, pii_key_version = 2 WHERE id = $1`,
        [slip().id, newCalc()],
      ),
    );
    expectRejected(result);
  });

  it("[HR-03] payslip: with the flag, calculation plus version is accepted and opens under the new version", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      const update = await attempt(
        client,
        `UPDATE payslips SET calculation_encrypted = $2, pii_key_version = 2 WHERE id = $1`,
        [slip().id, newCalc()],
      );
      const read = await client.query(
        `SELECT calculation_encrypted, pii_key_version::int AS version FROM payslips WHERE id = $1`,
        [slip().id],
      );
      return { update, row: read.rows[0] };
    });
    expect(result.update).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.row.version).toBe(2);
    expect(
      openPayrollValue(
        result.row.calculation_encrypted,
        slipBinding(tenantA, slip().id),
        2,
      ),
    ).toBe(slip().calc);
  });

  it("[HR-03] payslip: with the flag, touching pdf_object_key or viewed_at in the same update is rejected by the guard", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      return {
        pdf: await attempt(
          client,
          `UPDATE payslips SET calculation_encrypted = $2, pii_key_version = 2, pdf_object_key = 'payslips/x.pdf' WHERE id = $1`,
          [slip().id, newCalc()],
        ),
        viewed: await attempt(
          client,
          `UPDATE payslips SET calculation_encrypted = $2, pii_key_version = 2, viewed_at = now() WHERE id = $1`,
          [slip().id, newCalc()],
        ),
      };
    });
    expectGuard(result.pdf);
    expectGuard(result.viewed);
  });

  it("[HR-03] payslip: with the flag, changing only the version, only the calculation or a version of 0 is rejected by the guard", async () => {
    const result = await asApp(tenantA, async (client) => {
      await enableFlag(client);
      return {
        versionOnly: await attempt(
          client,
          `UPDATE payslips SET pii_key_version = 2 WHERE id = $1`,
          [slip().id],
        ),
        sealedOnly: await attempt(
          client,
          `UPDATE payslips SET calculation_encrypted = $2 WHERE id = $1`,
          [slip().id, newCalc()],
        ),
        versionZero: await attempt(
          client,
          `UPDATE payslips SET calculation_encrypted = $2, pii_key_version = 0 WHERE id = $1`,
          [slip().id, newCalc()],
        ),
      };
    });
    expectGuard(result.versionOnly);
    expectGuard(result.sealedOnly);
    expectGuard(result.versionZero);
  });

  it("[HR-03] payslip: the PDF key is still set once and never repointed", async () => {
    const result = await asApp(tenantA, async (client) => ({
      set: await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = 'payslips/a.pdf' WHERE id = $1`,
        [slip().id],
      ),
      repoint: await attempt(
        client,
        `UPDATE payslips SET pdf_object_key = 'payslips/b.pdf' WHERE id = $1`,
        [slip().id],
      ),
    }));
    expect(result.set).toMatchObject({ ok: true, rowCount: 1 });
    expect(result.repoint.ok).toBe(false);
  });
});
