// Payroll549 P2: upgrade historical maker=approver rows without rewriting them.
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
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session.ts";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const target = "0350_payroll_run_approvers_not_creator";
const database = `payroll549_${randomBytes(6).toString("hex")}`;
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const tenantId = randomUUID();
const entityId = randomUUID();
const policyId = randomUUID();
const legacyHr = randomUUID();
const legacyFinance = randomUUID();
let admin: Pool;
let scratch: Pool;
let workDir: string;
let oldRows: unknown[];

function before0350() {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) => entry.tag === target);
  if (at < 0) throw new Error("0350 migration missing from journal");
  const entries = journal.entries.slice(0, at);
  const folder = join(workDir, "before-0350");
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
  const { rows } = await scratch.query(
    "SELECT to_jsonb(r) AS snapshot FROM payroll_runs r WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[legacyHr, legacyFinance]],
  );
  return rows;
}

async function attempt(sql: string, values: unknown[]) {
  const client = await scratch.connect();
  try {
    await client.query("BEGIN");
    // Fixture foreign keys are unrelated to the CHECK being proved. CHECKs
    // still apply under replica; only absent fixture parents are bypassed.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(sql, values);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: (error as { code?: string }).code,
      constraint: (error as { constraint?: string }).constraint,
    };
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
  await runMigrations(scratch, before0350(), {
    lockTimeout: "10s",
    statementTimeout: "0",
  });
  const client = await scratch.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
        period_start, period_end, pay_date, created_by,
        approved_by_hr, approved_by_hr_at, approved_by_finance, approved_by_finance_at)
       VALUES
       ($1, $3, $4, $5, 'regular', '2040-01-01', '2040-01-31', '2040-01-31',
        'maker549', 'maker549', now(), 'finance549', now()),
       ($2, $3, $4, $5, 'regular', '2040-02-01', '2040-02-29', '2040-02-29',
        'maker549', 'hr549', now(), 'maker549', now())`,
      [legacyHr, legacyFinance, tenantId, entityId, policyId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  oldRows = await legacyRows();
  expect(oldRows).toHaveLength(2);
}, 240_000);

afterAll(async () => {
  await scratch?.end();
  if (admin) {
    // pg can still be closing the last socket after pool.end resolves.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
        [database],
      );
      if (result.rows[0]?.n === 0) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("[549-P2-UPGRADE] historical payroll approvers", () => {
  it("[549-P2-UPGRADE] applies0350 and corrective migrations over legacy rows, leaves them byte-for-byte unchanged, and constrains new writes", async () => {
    // RED must be this real upgrade failing23514, not fixture setup.
    await expect(
      runMigrations(scratch, drizzleDir, {
        lockTimeout: "10s",
        statementTimeout: "0",
      }),
    ).resolves.not.toThrow();
    expect(await legacyRows()).toEqual(oldRows);
    const constraint = await scratch.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
       WHERE conrelid = 'public.payroll_runs'::regclass
         AND conname = 'payroll_runs_distinct_approvers_check'`,
    );
    expect(constraint.rows).toEqual([{ convalidated: false }]);

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
    expect(
      await attempt(
        "UPDATE payroll_runs SET approved_by_hr = created_by WHERE id = $1",
        [legacyFinance],
      ),
    ).toMatchObject({
      ok: false,
      code: "23514",
      constraint: "payroll_runs_distinct_approvers_check",
    });
    expect(await legacyRows()).toEqual(oldRows);
  }, 240_000);
});
