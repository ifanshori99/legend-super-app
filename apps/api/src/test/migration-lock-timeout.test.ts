// Bead legend-jluo: the migrator gives up on a blocked table lock after
// MIGRATION_LOCK_TIMEOUT, rolls back every pending migration, prints a clear
// message and exits non-zero, while long statements are not cut by default.
// The scratch database lives on the disposable test server and is dropped in
// afterAll.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT,
  MigrationSettingError,
  migrationError,
  migrationTimeouts,
  runMigrations,
} from "../db/migration-session";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const database = `migrlock_${randomBytes(6).toString("hex")}`;

function urlFor(db: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${db}`;
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

// Pool.end() resolves before the server has closed the sessions; a forced
// DROP DATABASE racing them terminates a client that is still closing (57P01).
async function waitForNoSessions(admin: Pool, db: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [db],
    );
    if (rows[0]?.n === 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
}

// A drizzle folder holding the given migrations, in order.
function writeFolder(dir: string, migrations: string[]) {
  const folder = join(dir, `drizzle-${migrations.length}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const entries = migrations.map((sql, idx) => {
    const tag = `${String(idx).padStart(4, "0")}_step`;
    writeFileSync(join(folder, `${tag}.sql`), sql);
    return {
      idx,
      version: "7",
      when: 1_700_000_000_000 + idx,
      tag,
      breakpoints: true,
    };
  });
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  return folder;
}

const createTable = `CREATE TABLE lock_target (id int PRIMARY KEY);`;
// Creates a table first, then needs ACCESS EXCLUSIVE on lock_target.
const blockedStep = `CREATE TABLE created_before_lock (id int);
--> statement-breakpoint
ALTER TABLE lock_target ADD COLUMN note text;`;
const slowStep = `SELECT pg_sleep(0.3);`;

describe("legend-jluo migration session settings", () => {
  it("defaults to a 10s lock wait and no statement limit", () => {
    expect(migrationTimeouts({})).toEqual({
      lockTimeout: DEFAULT_MIGRATION_LOCK_TIMEOUT,
      statementTimeout: DEFAULT_MIGRATION_STATEMENT_TIMEOUT,
    });
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT).toBe("10s");
    expect(DEFAULT_MIGRATION_STATEMENT_TIMEOUT).toBe("0");
  });

  it("takes overrides and refuses values PostgreSQL would misread", () => {
    expect(
      migrationTimeouts({
        MIGRATION_LOCK_TIMEOUT: " 30s ",
        MIGRATION_STATEMENT_TIMEOUT: "45min",
      }),
    ).toEqual({ lockTimeout: "30s", statementTimeout: "45min" });
    expect(
      migrationTimeouts({
        MIGRATION_LOCK_TIMEOUT: "0",
        MIGRATION_STATEMENT_TIMEOUT: "35791min",
      }),
    ).toEqual({ lockTimeout: "0", statementTimeout: "35791min" });
    for (const bad of [
      "abc",
      "-1s",
      "10 s",
      "1.5s",
      "10h",
      "010s",
      "1s; RESET ALL",
      "10",
      "35792min",
      "99999999999ms",
    ])
      expect(() => migrationTimeouts({ MIGRATION_LOCK_TIMEOUT: bad })).toThrow(
        MigrationSettingError,
      );
  });

  it("explains lock and statement timeouts, wrapped or not, and leaves other errors to databaseError", () => {
    const timeouts = { lockTimeout: "10s", statementTimeout: "0" };
    expect(migrationError({ code: "55P03" }, timeouts)).toMatch(
      /^Migration stopped: a lock was not granted within MIGRATION_LOCK_TIMEOUT \(10s\).*Nothing was applied/,
    );
    expect(migrationError({ cause: { code: "55P03" } }, timeouts)).toMatch(
      /MIGRATION_LOCK_TIMEOUT/,
    );
    expect(migrationError({ code: "57014" }, timeouts)).toMatch(
      /MIGRATION_STATEMENT_TIMEOUT \(0\).*Nothing was applied/,
    );
    expect(migrationError({ code: "40P01" }, timeouts)).toMatch(
      /deadlock.*Nothing was applied/,
    );
    expect(migrationError({ code: "28P01" }, timeouts)).toMatch(
      /rejected the credentials/,
    );
    expect(
      migrationError(new MigrationSettingError("bad value"), undefined),
    ).toBe("bad value");
  });

  it("the migrate script exits non-zero with the message on a bad setting, before connecting", () => {
    const run = spawnSync(
      join(apiRoot, "node_modules", ".bin", "tsx"),
      ["src/migrate.ts"],
      {
        cwd: apiRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          MIGRATION_LOCK_TIMEOUT: "ten seconds",
          MIGRATION_DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none",
        },
        timeout: 60_000,
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'MIGRATION_LOCK_TIMEOUT must be 0 or a whole number with ms, s or min, at most 35791min (for example 10s); got "ten seconds".',
    );
  });
});

describe("legend-jluo migrations against a held lock", () => {
  let admin: Pool; // superuser on the server's default database
  let migrator: Pool; // runs runMigrations, max 1 like src/migrate.ts
  let blockerPool: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    // A database default that would cut a backfill if the migrator kept it.
    await admin.query(
      `ALTER DATABASE ${database} SET statement_timeout = '100ms'`,
    );
    migrator = new Pool({ connectionString: urlFor(database), max: 1 });
    blockerPool = new Pool({ connectionString: urlFor(database), max: 1 });
    workDir = mkdtempSync(join(tmpdir(), "legend-mig-lock-"));
  }, 60_000);

  afterAll(async () => {
    await migrator?.end();
    await blockerPool?.end();
    if (admin) {
      await waitForNoSessions(admin, database);
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const applied = async () =>
    (
      await migrator.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      )
    ).rows[0]?.n;

  it("a long statement is not cut by default, even under a database statement_timeout", async () => {
    await runMigrations(
      migrator,
      writeFolder(workDir, [createTable, slowStep]),
      {
        lockTimeout: "10s",
        statementTimeout: "0",
      },
    );
    expect(await applied()).toBe(2);
  });

  it("gives up on a held lock within lock_timeout, rolls back every pending file, and recovers", async () => {
    const folder = writeFolder(workDir, [createTable, slowStep, blockedStep]);
    // A running service mid-transaction holding ACCESS SHARE on the table.
    const blocker: PoolClient = await blockerPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT count(*) FROM lock_target");

      const started = Date.now();
      const error = await runMigrations(migrator, folder, {
        lockTimeout: "300ms",
        statementTimeout: "0",
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(error).toBeDefined();
      expect(
        migrationError(error, { lockTimeout: "300ms", statementTimeout: "0" }),
      ).toMatch(
        /^Migration stopped: a lock was not granted within MIGRATION_LOCK_TIMEOUT \(300ms\)/,
      );

      // Nothing from the blocked batch stuck.
      expect(await applied()).toBe(2);
      const created = await migrator.query(
        `SELECT to_regclass('public.created_before_lock') AS t`,
      );
      expect(created.rows[0]).toEqual({ t: null });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    // Lock released: the same batch applies.
    await runMigrations(migrator, folder, {
      lockTimeout: "300ms",
      statementTimeout: "0",
    });
    expect(await applied()).toBe(3);
  });

  it("an explicit MIGRATION_STATEMENT_TIMEOUT still applies when set", async () => {
    const folder = writeFolder(workDir, [
      createTable,
      slowStep,
      blockedStep,
      slowStep,
    ]);
    const error = await runMigrations(migrator, folder, {
      lockTimeout: "10s",
      statementTimeout: "50ms",
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(
      migrationError(error, { lockTimeout: "10s", statementTimeout: "50ms" }),
    ).toMatch(
      /^Migration stopped: a statement ran longer than MIGRATION_STATEMENT_TIMEOUT \(50ms\)/,
    );
    expect(await applied()).toBe(3);
  });
});
