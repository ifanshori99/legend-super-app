import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Payroll549 / G688h P2: legacy maker=approver rows keep their lifecycle and money.
// Actual migrations run against a scratch database on the disposable server.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session.ts";
import { sealPayrollValue } from "../lib/payroll-sealed.ts";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const target = "0300_payroll_run_approvers_not_creator";
const database = `payroll549_${randomBytes(6).toString("hex")}`;
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const tenantId = randomUUID();
const entityId = randomUUID();
const policyId = randomUUID();
const brandId = randomUUID();
const outletId = randomUUID();
const employeeId = randomUUID();
const legacyHr = randomUUID();
const legacyFinance = randomUUID();
type Snapshot = Record<string, unknown>;
type Attempt = { ok: true } | { ok: false; code?: string; constraint?: string };
let admin: Pool;
let scratch: Pool;
let workDir: string;
let oldRows: { snapshot: Snapshot }[];
let oldPayslips: { snapshot: Snapshot }[];

function before0300() {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) => entry.tag === target);
  if (at < 0) throw new Error("0300 migration missing from journal");
  const entries = journal.entries.slice(0, at);
  const folder = join(workDir, "before-0300");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const entry of entries)
    cpSync(
      join(drizzleDir, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  writeFileSync(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  return folder;
}

async function legacyRows() {
  const { rows } = await scratch.query<{ snapshot: Snapshot }>(
    "SELECT to_jsonb(r) AS snapshot FROM payroll_runs r WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[legacyHr, legacyFinance]],
  );
  return rows;
}

async function payslips(client: Pool | PoolClient = scratch) {
  const { rows } = await client.query<{ snapshot: Snapshot }>(
    `SELECT to_jsonb(p) AS snapshot FROM payslips p
     WHERE payroll_run_id = ANY($1::uuid[]) ORDER BY id`,
    [[legacyHr, legacyFinance]],
  );
  return rows;
}

async function beginAttempt(client: PoolClient) {
  await client.query("BEGIN");
  // Ordinary triggers must execute: replica mode would hide a missing guard.
  await client.query("SET LOCAL session_replication_role = origin");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
}

function failure(error: unknown) {
  const pgError = error as { code?: string; constraint?: string };
  return {
    ok: false as const,
    code: pgError.code,
    constraint: pgError.constraint,
  };
}

async function attempt(sql: string, values: unknown[]): Promise<Attempt> {
  const client = await scratch.connect();
  try {
    await beginAttempt(client);
    await client.query(sql, values);
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function transition(id: string, updates: string) {
  const client = await scratch.connect();
  try {
    await beginAttempt(client);
    const result = await client.query<{ snapshot: Snapshot }>(
      `UPDATE payroll_runs SET ${updates} WHERE id = $1
       RETURNING to_jsonb(payroll_runs) AS snapshot`,
      [id],
    );
    return {
      ok: true as const,
      rowCount: result.rowCount,
      run: result.rows[0]?.snapshot,
      payslips: await payslips(client),
    };
  } catch (error) {
    return failure(error);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(async () => {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error("Run pnpm test for the disposable PostgreSQL server");
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  scratch = new Pool({ connectionString: url.toString(), max: 2 });
  workDir = mkdtempSync(join(tmpdir(), "legend-payroll549-upgrade-"));
  await runMigrations(scratch, before0300(), {
    lockTimeout: "10s",
    statementTimeout: "0",
  });
  const client = await scratch.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, limits, created_by)
       VALUES ($1, $2, 'G688h Upgrade', 'starter', 'active', 'shared', '{}', 'maker549')`,
      [tenantId, `g688h-upgrade-${tenantId}`],
    );
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT G688h Upgrade', false)",
      [entityId, tenantId],
    );
    await client.query(
      `INSERT INTO payroll_policies
       (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group,
        cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'G688h Upgrade', 'G688H', '{"code":"G688H"}',
               '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenantId, entityId],
    );
    await client.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'g688h', 'G688h')",
      [brandId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets
       (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'G688H', 'G688h', 'Jl. G688h', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [outletId, tenantId, brandId, entityId],
    );
    await client.query(
      `INSERT INTO employees
       (id, tenant_id, employee_no, full_name, home_outlet_id, employment_type, join_date, status)
       VALUES ($1, $2, 'G688H-UPGRADE', 'G688h Employee', $3, 'pkwtt', '2025-01-01', 'active')`,
      [employeeId, tenantId, outletId],
    );
    // Only seed the historical state under replica; every post-upgrade write
    // below uses origin with real FK parents and both lifecycle guards active.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
        period_start, period_end, pay_date, created_by,
        approved_by_hr, approved_by_hr_at, approved_by_finance, approved_by_finance_at,
        status, config_snapshot, totals, locked_by, locked_at)
       VALUES
       ($1, $3, $4, $5, 'regular', '2040-01-01', '2040-01-31', '2040-01-31',
        'maker549', 'maker549', now(), 'finance549', now(),
        'locked', '{"v":1}', '{"grossIdr":6000000,"deductionsIdr":0,"netIdr":6000000}', 'locker549', now()),
       ($2, $3, $4, $5, 'regular', '2040-02-01', '2040-02-29', '2040-02-29',
        'maker549', 'hr549', now(), 'maker549', now(),
        'locked', '{"v":1}', '{"grossIdr":6000000,"deductionsIdr":0,"netIdr":6000000}', 'locker549', now())`,
      [legacyHr, legacyFinance, tenantId, entityId, policyId],
    );
    for (const runId of [legacyHr, legacyFinance]) {
      const id = randomUUID();
      const encrypted = sealPayrollValue(
        JSON.stringify({
          grossIdr: 6_000_000,
          deductionsIdr: 0,
          netIdr: 6_000_000,
          overtimeIdr: 0,
          lines: [],
        }),
        { tenantId, table: "payslips", rowId: id, field: "calculation" },
        1,
      );
      await client.query(
        `INSERT INTO payslips
         (id, tenant_id, payroll_run_id, employee_id, payment_method, calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'cash', $5, 1)`,
        [id, tenantId, runId, employeeId, encrypted],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  oldRows = await legacyRows();
  oldPayslips = await payslips();
  expect(oldRows).toHaveLength(2);
  expect(oldPayslips).toHaveLength(2);
  await runMigrations(scratch, drizzleDir, {
    lockTimeout: "10s",
    statementTimeout: "0",
  });
}, 240_000);

afterAll(async () => {
  if (scratch) await endTestPool(scratch);
  if (admin) {
    try {
      await dropTestDatabase(admin, database);
    } finally {
      await endTestPool(admin);
    }
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("[549-P2-UPGRADE] historical payroll approvers", () => {
  it("[G688h-P2-UPGRADE] applies0300 and corrective migrations without rewriting historical runs or sealed payslips", async () => {
    expect(await legacyRows()).toEqual(oldRows);
    expect(await payslips()).toEqual(oldPayslips);
  });

  it("[G688h-P2-PAID] allows a legacy locked maker=HR run to be paid without changing salary or paying twice", async () => {
    const result = await transition(
      legacyHr,
      "status = 'paid', paid_by = 'payer549', paid_at = now()",
    );
    expect(result).toMatchObject({ ok: true, rowCount: 1 });
    if (!result.ok) return;
    const before = oldRows.find(
      (row) => row.snapshot.id === legacyHr,
    )!.snapshot;
    expect(result.run).toMatchObject({ status: "paid", paid_by: "payer549" });
    expect(result.run?.paid_at).not.toBeNull();
    expect({
      ...result.run,
      status: before.status,
      paid_by: before.paid_by,
      paid_at: before.paid_at,
    }).toEqual(before);
    expect(result.payslips).toEqual(oldPayslips);
  });

  it("[G688h-P2-REVERSED] allows a legacy locked maker=finance run to be reversed when identity assignments are unchanged, preserving money and slips", async () => {
    const result = await transition(
      legacyFinance,
      `status = 'reversed', reversal = '{"status":"approved"}',
       created_by = created_by, approved_by_hr = approved_by_hr,
       approved_by_finance = approved_by_finance`,
    );
    expect(result).toMatchObject({ ok: true, rowCount: 1 });
    if (!result.ok) return;
    const before = oldRows.find(
      (row) => row.snapshot.id === legacyFinance,
    )!.snapshot;
    expect(result.run).toMatchObject({
      status: "reversed",
      reversal: { status: "approved" },
    });
    expect({
      ...result.run,
      status: before.status,
      reversal: before.reversal,
    }).toEqual(before);
    expect(result.payslips).toEqual(oldPayslips);
  });

  it("[G688h-P2-INSERT] refuses all three maker/approver conflicts for new runs with ordinary triggers enabled", async () => {
    const insert = `INSERT INTO payroll_runs
      (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
       period_start, period_end, pay_date, created_by,
       approved_by_hr, approved_by_hr_at, approved_by_finance, approved_by_finance_at)
      VALUES ($1, $2, $3, $4, 'regular', '2040-03-01', '2040-03-31', '2040-03-31',
              'maker549', $5, now(), $6, now())`;
    for (const [hr, finance] of [
      ["maker549", "finance549"],
      ["hr549", "maker549"],
      ["same549", "same549"],
    ])
      expect(
        await attempt(insert, [
          randomUUID(),
          tenantId,
          entityId,
          policyId,
          hr,
          finance,
        ]),
      ).toMatchObject({
        ok: false,
        code: "23514",
        constraint: "payroll_runs_distinct_approvers_check",
      });
    expect(
      await attempt(insert, [
        randomUUID(),
        tenantId,
        entityId,
        policyId,
        "hr549",
        "finance549",
      ]),
    ).toEqual({ ok: true });
    expect(await legacyRows()).toEqual(oldRows);
    expect(await payslips()).toEqual(oldPayslips);
  });
});
