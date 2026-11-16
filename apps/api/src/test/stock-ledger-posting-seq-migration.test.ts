import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Bead legend-bsw9: migration 0186 numbers the existing stock ledger rows by
// (occurred_at, id) while the table is append-only and force-RLS, restores both
// protections, and restarts the identity after the highest number.
//
// The scratch database lives on the disposable test server (superuser login):
// every migration before 0186 is applied, fixture rows are written, then the
// real 0186 SQL runs in one transaction. The database is dropped in afterAll.
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleDir = join(apiRoot, "drizzle");
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const database = `postingseq_${randomBytes(6).toString("hex")}`;
const TAG = "0186_stock_ledger_posting_seq";

function urlFor(db: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${db}`;
  if (user) url.username = user;
  if (password) url.password = password;
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

type Journal = {
  entries: { idx: number; when: number; tag: string }[];
};

function readJournal(): Journal {
  return JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

// A copy of drizzle/ holding every migration except 0186 (the journal is cut
// at the entry before it; the later SQL files are not copied).
function copyFolderWithout0186(workDir: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => entry.tag !== TAG);
  const keptTags = new Set(kept.map((entry) => entry.tag));
  const folder = join(workDir, "drizzle-before-0186");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const file of readdirSync(drizzleDir))
    if (file.endsWith(".sql") && keptTags.has(file.replace(/\.sql$/, "")))
      cpSync(join(drizzleDir, file), join(folder, file));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

// The statements of the real 0186 file, split the way drizzle splits them.
function migrationStatements(transform: (sql: string) => string = (s) => s) {
  const statements = transform(
    readFileSync(join(drizzleDir, `${TAG}.sql`), "utf8"),
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  expect(statements.length).toBeGreaterThan(0);
  return statements;
}

// One transaction, like drizzle's migrator: a failure rolls everything back.
async function applyStatements(pool: Pool, statements: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Fixture ids sort as written: hex text order is uuid order.
const t1 = "11111111-1111-4111-8111-111111111111";
const t2 = "22222222-2222-4222-8222-222222222222";
const T = Date.parse("2026-11-01T10:00:00.000Z");
const at = (offsetSeconds: number) =>
  new Date(T + offsetSeconds * 1_000).toISOString();

// Physical insertion order differs from (occurred_at, id) on purpose, with two
// occurred_at ties that only the id can break and rows of two tenants mixed.
const fixtures = [
  { id: "aaaaaaaa-0000-4000-8000-00000000000a", tenant: t1, occurred: at(2) },
  { id: "22222222-0000-4000-8000-000000000002", tenant: t2, occurred: at(0) },
  { id: "11111111-0000-4000-8000-000000000001", tenant: t1, occurred: at(0) },
  { id: "ffffffff-0000-4000-8000-00000000000f", tenant: t2, occurred: at(-1) },
  { id: "33333333-0000-4000-8000-000000000003", tenant: t1, occurred: at(2) },
];
const expectedOrder = [
  "ffffffff-0000-4000-8000-00000000000f", // earliest occurred_at
  "11111111-0000-4000-8000-000000000001", // tie at T, smaller id
  "22222222-0000-4000-8000-000000000002", // tie at T, larger id
  "33333333-0000-4000-8000-000000000003", // tie at T+2, smaller id
  "aaaaaaaa-0000-4000-8000-00000000000a", // tie at T+2, larger id
];

async function insertLedgerRow(
  client: PoolClient,
  row: { id: string; tenant: string; occurred: string },
) {
  return client.query<{ posting_seq?: string }>(
    `INSERT INTO stock_ledger
       (id, tenant_id, outlet_id, location_id, inventory_item_id, movement_type,
        quantity, unit_cost_idr, source_type, source_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'receipt', 1, 1, 'goods_receipt', $1, $6)
     RETURNING *`,
    [row.id, row.tenant, row.tenant, row.tenant, row.tenant, row.occurred],
  );
}

describe("legend-bsw9 migration 0186 against a populated ledger", () => {
  let admin: Pool; // superuser on the server's default database
  let scratch: Pool;
  let workDir: string;

  /** Runs `run` with foreign keys skipped (fixtures own no outlets or items). */
  async function withoutForeignKeys<T>(run: (c: PoolClient) => Promise<T>) {
    const client = await scratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
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

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    scratch = new Pool({ connectionString: urlFor(database), max: 2 });
    workDir = mkdtempSync(join(tmpdir(), "legend-posting-seq-"));

    await runMigrations(scratch, copyFolderWithout0186(workDir), {
      lockTimeout: "10s",
      statementTimeout: "0",
    });
    const before = await scratch.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'stock_ledger' AND column_name = 'posting_seq'`,
    );
    expect(before.rowCount).toBe(0);

    await withoutForeignKeys(async (client) => {
      for (const row of fixtures) await insertLedgerRow(client, row);
    });

    // The real migration file, statement by statement, in one transaction.
    await applyStatements(scratch, migrationStatements());
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

  it("numbers every row 1..N by (occurred_at, id) across tenants", async () => {
    const { rows } = await scratch.query<{ id: string; posting_seq: string }>(
      "SELECT id, posting_seq::text AS posting_seq FROM stock_ledger ORDER BY posting_seq",
    );
    expect(rows).toHaveLength(fixtures.length);
    expect(rows.map((row) => row.posting_seq)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(rows.map((row) => row.id)).toEqual(expectedOrder);
    const nulls = await scratch.query(
      "SELECT 1 FROM stock_ledger WHERE posting_seq IS NULL",
    );
    expect(nulls.rowCount).toBe(0);
  });

  it("the column is NOT NULL, GENERATED ALWAYS and indexed with the location key", async () => {
    const column = await scratch.query<{
      is_nullable: string;
      is_identity: string;
      identity_generation: string;
      data_type: string;
    }>(
      `SELECT is_nullable, is_identity, identity_generation, data_type
       FROM information_schema.columns
       WHERE table_name = 'stock_ledger' AND column_name = 'posting_seq'`,
    );
    expect(column.rows[0]).toEqual({
      is_nullable: "NO",
      is_identity: "YES",
      identity_generation: "ALWAYS",
      data_type: "bigint",
    });
    const index = await scratch.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'stock_ledger_tenant_outlet_seq_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain(
      "(tenant_id, outlet_id, posting_seq)",
    );
  });

  it("the identity sequence has cache 1, so numbers follow insertion order", async () => {
    // A larger cache hands each session a block of numbers up front and breaks
    // the order guarantee the rebuild depends on.
    const sequence = await scratch.query<{ cache_size: string }>(
      `SELECT cache_size::text AS cache_size FROM pg_sequences
       WHERE schemaname = 'public' AND sequencename = 'stock_ledger_posting_seq_seq'`,
    );
    expect(sequence.rows).toEqual([{ cache_size: "1" }]);
  });

  it("the append-only trigger is enabled again and FORCE RLS is back on", async () => {
    const trigger = await scratch.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'public.stock_ledger'::regclass
         AND tgname = 'stock_ledger_append_only'`,
    );
    expect(trigger.rows).toEqual([{ tgenabled: "O" }]);
    const relation = await scratch.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'public.stock_ledger'::regclass`,
    );
    expect(relation.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("the identity restarted after the highest number", async () => {
    const inserted = await withoutForeignKeys((client) =>
      insertLedgerRow(client, {
        id: "44444444-0000-4000-8000-000000000004",
        tenant: t2,
        // Dated before every backfilled row: the sequence follows insertion.
        occurred: at(-3600),
      }),
    );
    expect(String(inserted.rows[0]?.posting_seq)).toBe("6");
  });

  it("UPDATE and DELETE are still rejected, even for the owner", async () => {
    await expect(
      scratch.query("UPDATE stock_ledger SET quantity = 99"),
    ).rejects.toThrow(/append-only/);
    await expect(
      scratch.query("UPDATE stock_ledger SET posting_seq = DEFAULT"),
    ).rejects.toThrow(/append-only/);
    await expect(
      scratch.query("UPDATE stock_ledger SET posting_seq = 0"),
    ).rejects.toThrow(/posting_seq/);
    await expect(scratch.query("DELETE FROM stock_ledger")).rejects.toThrow(
      /append-only/,
    );
  });
});

// Production runs migrations as a plain table owner: NOSUPERUSER, NOBYPASSRLS,
// so FORCE ROW LEVEL SECURITY applies to it. The superuser suite above cannot
// see that: a superuser ignores RLS, so 0186 would pass without its
// NO FORCE ROW LEVEL SECURITY line. This suite runs the SQL as that owner.
describe("legend-bsw9 migration 0186 run by a non-superuser table owner", () => {
  const ownerRole = `postingseq_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `postingseq_own_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, default database
  let adminInScratch: Pool; // superuser, the owner's database
  let owner: Pool; // the migrator: NOSUPERUSER NOBYPASSRLS
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role name and hex password are generated here, so interpolation into DDL
    // (no bind parameters) is safe. Older migrations need BYPASSRLS for a
    // non-superuser owner (foreign keys onto force-RLS tables validate rows
    // under the tenant policy), so the role loses it only before 0186 runs.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    // legend_payout (drizzle/0410) is cluster-wide and already exists, created by
    // the bootstrap superuser; the migrator manages it through ADMIN OPTION only,
    // as provisionMigrator gives it in production (db/migrator-role.ts).
    await admin.query(
      `GRANT legend_payout TO ${ownerRole} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    await admin.query(`CREATE DATABASE ${ownerDatabase} OWNER ${ownerRole}`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
    adminInScratch = new Pool({
      connectionString: urlFor(ownerDatabase),
      max: 1,
    });
    workDir = mkdtempSync(join(tmpdir(), "legend-posting-seq-owner-"));
    await runMigrations(owner, copyFolderWithout0186(workDir), {
      lockTimeout: "10s",
      statementTimeout: "0",
    });

    // Fixtures go in as superuser (RLS bypassed, foreign keys skipped).
    const client = await adminInScratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const row of fixtures) await insertLedgerRow(client, row);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // ALTER ROLE applies to new sessions only: reopen the migrator's pool.
    await endTestPool(owner);
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
  }, 240_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (adminInScratch) await endTestPool(adminInScratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, ownerDatabase);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the migrator really is a plain table owner that RLS applies to", async () => {
    const role = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const table = await adminInScratch.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE oid = 'public.stock_ledger'::regclass`,
    );
    expect(table.rows[0]?.owner).toBe(ownerRole);
    // Without a tenant context the owner sees no rows: FORCE RLS is in effect.
    const seen = await owner.query("SELECT 1 FROM stock_ledger").then(
      (result) => result.rowCount,
      (error: Error) => error.message,
    );
    expect(seen === 0 || /tenant context/i.test(String(seen))).toBe(true);
  });

  it("0186 without its NO FORCE ROW LEVEL SECURITY line fails for that owner", async () => {
    const withoutNoForce = migrationStatements((sql) => {
      const stripped = sql.replace(
        /^\s*ALTER TABLE "stock_ledger" NO FORCE ROW LEVEL SECURITY;\n/m,
        "",
      );
      expect(stripped).not.toBe(sql);
      expect(stripped).not.toContain("NO FORCE ROW LEVEL SECURITY;");
      return stripped;
    });
    // The numbering UPDATE touches no row (or the tenant policy raises), so
    // SET NOT NULL fails; the transaction rolls back, leaving the table as is.
    await expect(applyStatements(owner, withoutNoForce)).rejects.toThrow();
    const after = await adminInScratch.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'stock_ledger' AND column_name = 'posting_seq'`,
    );
    expect(after.rowCount).toBe(0);
  });

  it("the real 0186 numbers every row and restores trigger and FORCE RLS", async () => {
    await applyStatements(owner, migrationStatements());

    const { rows } = await adminInScratch.query<{
      id: string;
      posting_seq: string;
    }>(
      "SELECT id, posting_seq::text AS posting_seq FROM stock_ledger ORDER BY posting_seq",
    );
    expect(rows.map((row) => row.posting_seq)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(rows.map((row) => row.id)).toEqual(expectedOrder);

    const trigger = await adminInScratch.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'public.stock_ledger'::regclass
         AND tgname = 'stock_ledger_append_only'`,
    );
    expect(trigger.rows).toEqual([{ tgenabled: "O" }]);
    const relation = await adminInScratch.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'public.stock_ledger'::regclass`,
    );
    expect(relation.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });
});

describe("legend-bsw9 migration metadata", () => {
  it("journal entry 186 is 0186_stock_ledger_posting_seq at 1794265000000", () => {
    const entry = readJournal().entries.find((item) => item.idx === 186);
    expect(entry).toMatchObject({
      idx: 186,
      tag: TAG,
      when: 1_794_265_000_000,
    });
  });

  it("snapshot 0186 chains from the previous snapshot", () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(join(drizzleDir, "meta", name), "utf8")) as {
        id: string;
        prevId: string;
      };
    // Lower idx numbers may be added or skipped by other branches, so look up
    // the snapshot that comes right before 0186 instead of assuming 0170.
    const previous = readdirSync(join(drizzleDir, "meta"))
      .filter(
        (n) => /^\d{4}_snapshot\.json$/.test(n) && n < "0186_snapshot.json",
      )
      .sort()
      .at(-1);
    expect(previous).toBeDefined();
    expect(read("0186_snapshot.json").prevId).toBe(read(previous!).id);
  });
});
