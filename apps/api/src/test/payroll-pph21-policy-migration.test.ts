import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Migration test for payroll_pph21_policies (0068 table + 0069 RLS). The two
// migrations were renumbered from 0063/0064 after main took those numbers, so
// this suite proves both ways a database can reach them: a fresh database that
// applies the whole folder, and a database that already sits at 0067 (the last
// migration before them) and then applies the full folder. Both must end with
// the table, row level security enabled and forced, and an app role that can
// read and insert but never UPDATE, DELETE or TRUNCATE (a policy version is
// immutable). The scratch databases live on the disposable test server and are
// dropped in afterAll; the shared test database and the real journal are never
// touched.
import { randomBytes } from "node:crypto";
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
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const table = "payroll_pph21_policies";
const lastBeforePolicy = 67;

function urlFor(database: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

// Refuse to create databases on anything but the disposable test server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

// Temp copy of the migrations with the journal cut after idx 67. The real
// folder and journal stay untouched.
function copyMigrationsUpTo0067() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0067-"));
  const upTo0067 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0067, { recursive: true });
  const journalPath = join(upTo0067, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter(
    (entry) => entry.idx <= lastBeforePolicy,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0067 };
}

async function expectPolicyTableLocked(scratch: Pool) {
  const exists = await scratch.query(
    `SELECT to_regclass('public.${table}') AS name`,
  );
  expect(exists.rows[0].name).toBe(table);

  const flags = await scratch.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'public.${table}'::regclass`,
  );
  expect(flags.rows[0]).toEqual({
    relrowsecurity: true,
    relforcerowsecurity: true,
  });

  const policies = await scratch.query(
    `SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  expect(policies.rows[0].n).toBeGreaterThan(0);

  const privileges = await scratch.query(
    `SELECT p AS privilege, has_table_privilege('legend_app', 'public.${table}', p) AS granted
       FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p`,
  );
  const granted = Object.fromEntries(
    privileges.rows.map((r) => [r.privilege, r.granted]),
  );
  expect(granted).toEqual({
    SELECT: true,
    INSERT: true,
    UPDATE: false,
    DELETE: false,
    TRUNCATE: false,
  });
}

describe("payroll_pph21_policies migrations 0068 and 0069 on a fresh database", () => {
  const scratchName = `pph21_pol_fresh_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let scratch: Pool;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    // 70 migrations into a fresh database outlast the default hook timeout on
    // a slow disposable Postgres.
  }, 120_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  it("applies the full migration folder without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("creates the table with forced RLS and no UPDATE, DELETE or TRUNCATE for legend_app", async () => {
    await expectPolicyTableLocked(scratch);
  });
});

describe("payroll_pph21_policies migrations 0068 and 0069 on a database migrated only to 0067", () => {
  const scratchName = `pph21_pol_up_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsUpTo0067();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.upTo0067 });
  }, 120_000);

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

  it("starts without the table (the fixture really stops before 0068)", async () => {
    const exists = await scratch.query(
      `SELECT to_regclass('public.${table}') AS name`,
    );
    expect(exists.rows[0].name).toBeNull();
  });

  it("applies the full migration folder on top without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  });

  it("ends with the table, forced RLS and no UPDATE, DELETE or TRUNCATE for legend_app", async () => {
    await expectPolicyTableLocked(scratch);
  });
});
