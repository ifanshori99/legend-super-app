import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Migration test for 0118 (legend-rhq5): employment_contracts.tax_scheme.
// A contract that existed before 0118 must read 'gross' after it (CTO decision
// 2026-11-09), new rows must state a scheme (no default left), and the CHECK
// allows only gross, gross_up and net. Follows the pattern of
// payroll-pph21-policy-migration.test.ts: a scratch database on the disposable
// test server, migrated to 0117 with a temp copy of the journal, then migrated
// with the full folder. The shared test database and real journal stay untouched.
//
// Assumption: the disposable server's user is a superuser (POSTGRES_USER in
// compose.test.yaml), so it bypasses FORCE RLS, and
// `session_replication_role = replica` lets us seed rows without building the
// whole tenant/employee chain.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const lastBeforeTaxScheme = 117;

function urlFor(database: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

function copyMigrationsUpTo0117() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0117-"));
  const upTo0117 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0117, { recursive: true });
  const journalPath = join(upTo0117, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter(
    (entry) => entry.idx <= lastBeforeTaxScheme,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0117 };
}

async function withoutFkChecks<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return await run(client);
  } finally {
    await client.query("RESET session_replication_role").catch(() => {});
    client.release();
  }
}

describe("employment_contracts.tax_scheme migration 0118 on a database migrated only to 0117", () => {
  const scratchName = `tax_scheme_up_${randomBytes(6).toString("hex")}`;
  const legacyContractId = randomUUID();
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsUpTo0117();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.upTo0117 });

    // One contract from before 0118, seeded without a tax_scheme column.
    await withoutFkChecks(scratch, (client) =>
      client.query(
        `INSERT INTO employment_contracts
           (id, tenant_id, employee_id, type, start_date, end_date,
            reminder_days_before, status)
         VALUES ($1, $2, $3, 'pkwt', '2025-01-01', '2025-12-31', 30, 'active')`,
        [legacyContractId, randomUUID(), randomUUID()],
      ),
    );
  }, 180_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("starts without the column (the fixture really stops before 0118)", async () => {
    const { rows } = await scratch.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employment_contracts' AND column_name = 'tax_scheme'`,
    );
    expect(rows).toHaveLength(0);
    const legacy = await scratch.query(
      "SELECT count(*)::int AS n FROM employment_contracts WHERE id = $1",
      [legacyContractId],
    );
    expect(legacy.rows[0].n).toBe(1);
  });

  it("applies the full migration folder on top without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("[legend-rhq5] a contract that existed before 0118 reads 'gross' after it", async () => {
    const { rows } = await scratch.query(
      "SELECT tax_scheme FROM employment_contracts WHERE id = $1",
      [legacyContractId],
    );
    expect(rows).toEqual([{ tax_scheme: "gross" }]);
  });

  it("[legend-rhq5] leaves the column NOT NULL with no default and a CHECK on the three schemes", async () => {
    const column = await scratch.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'employment_contracts' AND column_name = 'tax_scheme'`,
    );
    expect(column.rows[0]).toEqual({ is_nullable: "NO", column_default: null });

    await withoutFkChecks(scratch, async (client) => {
      const attempt = (scheme: string | null) =>
        client.query(
          `INSERT INTO employment_contracts
             (id, tenant_id, employee_id, type, tax_scheme, start_date, end_date,
              reminder_days_before, status)
           VALUES ($1, $2, $3, 'pkwt', $4, '2026-01-01', '2026-12-31', 30, 'draft')`,
          [randomUUID(), randomUUID(), randomUUID(), scheme],
        );
      for (const ok of ["gross", "gross_up", "net"])
        await expect(attempt(ok)).resolves.toBeDefined();
      await expect(attempt("bogus")).rejects.toMatchObject({ code: "23514" });
      await expect(attempt(null)).rejects.toMatchObject({ code: "23502" });
    });
  });
});
