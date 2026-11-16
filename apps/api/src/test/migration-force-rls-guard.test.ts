// Guard for beads legend-m007: every migration keeps the FORCE ROW LEVEL
// SECURITY invariant that docs/plan/contracts.md ("Migrations: foreign keys
// into FORCE RLS tables") relies on.
//
// Pattern 2 of that convention lifts FORCE on a parent table for the
// migration transaction (NO FORCE ... FORCE). Forgetting the closing FORCE
// does not fail any migration, yet it silently exempts the table owner from
// the tenant policy for good. migration-fk-force-rls.test.ts pins the
// patterns on a toy table and edge-received-events-migration.test.ts proves
// the real folder applies as a plain owner; neither checks the end state of
// every table. This suite does:
//
// 1. Statically, on the SQL files: each NO FORCE has a later FORCE for the
//    same table in the same file, and no migration from 0065 on adds a
//    foreign key NOT VALID or disables row level security (the end-state
//    check below cannot see a table whose RLS was switched off entirely
//    unless it has a tenant_id column, which src/db/rls.test.ts covers).
// 2. On the test database after every migration: each public table with
//    row level security enabled also forces it, except the two documented
//    ENABLE-only tables. src/db/rls.test.ts already requires FORCE plus the
//    tenant_isolation policy on every tenant_id table; this also covers RLS
//    tables without a tenant_id column. That the folder applies as a plain
//    owner from 0065 on is proven by edge-received-events-migration.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;

// First migration that must run without BYPASSRLS (contracts.md).
const FIRST_PLAIN_OWNER_IDX = 65;

type JournalEntry = { idx: number; tag: string };

function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

// SQL without comments, statements split on ";" (drizzle files also carry
// "--> statement-breakpoint", which is a comment and goes with the rest).
function statementsOf(sql: string): string[] {
  const noComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  return noComments
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// "public.outlets", "\"outlets\"", "outlets" -> "outlets"
function tableName(raw: string): string {
  const last = raw.split(".").pop() ?? raw;
  return last.replace(/"/g, "").toLowerCase();
}

const forceRe =
  /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) (NO )?FORCE ROW LEVEL SECURITY$/i;

// Tables left without FORCE at the end of the file (lifted, never restored).
function unrestoredForce(sql: string): string[] {
  const lifted = new Set<string>();
  for (const statement of statementsOf(sql)) {
    const match = forceRe.exec(statement);
    if (!match) continue;
    const table = tableName(match[1] as string);
    if (match[2]) lifted.add(table);
    else lifted.delete(table);
  }
  return [...lifted].sort();
}

function notValidForeignKeys(sql: string): string[] {
  return statementsOf(sql).filter(
    (statement) =>
      /\bFOREIGN KEY\b/i.test(statement) && /\bNOT VALID\b/i.test(statement),
  );
}

function rlsDisables(sql: string): string[] {
  return statementsOf(sql).filter((statement) =>
    /\bDISABLE ROW LEVEL SECURITY\b/i.test(statement),
  );
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

describe("legend-m007 static scan of the migration SQL", () => {
  const entries = readJournal(drizzleFolder);
  const sqlOf = (entry: JournalEntry) =>
    readFileSync(join(drizzleFolder, `${entry.tag}.sql`), "utf8");

  it("the scanner sees lifts, restores, NOT VALID foreign keys and RLS disables", () => {
    const sample = `
      ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
      ALTER TABLE "stations" NO FORCE ROW LEVEL SECURITY;
      -- ALTER TABLE public.stations FORCE ROW LEVEL SECURITY; (comment, ignored)
      ALTER TABLE child ADD CONSTRAINT c_fk FOREIGN KEY (x) REFERENCES outlets (id) NOT VALID;
      ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
      ALTER TABLE public.outlets DISABLE ROW LEVEL SECURITY;
    `;
    expect(unrestoredForce(sample)).toEqual(["stations"]);
    expect(notValidForeignKeys(sample)).toHaveLength(1);
    expect(rlsDisables(sample)).toHaveLength(1);
    expect(
      notValidForeignKeys(
        "ALTER TABLE t ADD CONSTRAINT t_check CHECK (x > 0) NOT VALID;",
      ),
    ).toEqual([]);
  });

  it("every NO FORCE ROW LEVEL SECURITY is restored with FORCE in the same file", () => {
    const offenders = entries
      .map((entry) => ({
        tag: entry.tag,
        tables: unrestoredForce(sqlOf(entry)),
      }))
      .filter((offender) => offender.tables.length > 0);
    expect(offenders).toEqual([]);
  });

  it(`no migration from ${FIRST_PLAIN_OWNER_IDX} on adds a foreign key NOT VALID`, () => {
    const offenders = entries
      .filter((entry) => entry.idx >= FIRST_PLAIN_OWNER_IDX)
      .map((entry) => ({
        tag: entry.tag,
        statements: notValidForeignKeys(sqlOf(entry)),
      }))
      .filter((offender) => offender.statements.length > 0);
    expect(offenders).toEqual([]);
  });

  it(`no migration from ${FIRST_PLAIN_OWNER_IDX} on disables row level security`, () => {
    const offenders = entries
      .filter((entry) => entry.idx >= FIRST_PLAIN_OWNER_IDX)
      .map((entry) => ({
        tag: entry.tag,
        statements: rlsDisables(sqlOf(entry)),
      }))
      .filter((offender) => offender.statements.length > 0);
    expect(offenders).toEqual([]);
  });
});

describe("legend-m007 FORCE ROW LEVEL SECURITY after all migrations", () => {
  let admin: Pool; // superuser on the test database that pnpm test migrated

  // ENABLE without FORCE on purpose: read before a tenant context exists, and
  // the owner keeps repair access (0007_platform_org_rls.sql,
  // 0021_payment_rls.sql; also allowlisted in src/db/rls.test.ts and
  // docs/deployment.md). delivery_store_index (0126_ws08_delivery_store_index_rls.sql)
  // is the same TEN-02 exception: the webhook resolves it before a tenant
  // context exists. Anything else lifted and never restored lands here.
  const enableOnly = [
    "delivery_store_index",
    // legend-111j: member_profile_user_index (0203), same TEN-02 exception.
    "member_profile_user_index",
    "payment_link_tokens",
    // legend-so897 review P2-1: payroll_payout_proof_hash_contests (0398),
    // same exception: global, no policy, no app-role privilege, written only by
    // the SECURITY DEFINER claim trigger.
    "payroll_payout_proof_hash_contests",
    // legend-so897: payroll_payout_proof_hashes (0395), global owner of each
    // payout proof hash across tenants; no policy, no app-role privilege,
    // written only by a SECURITY DEFINER trigger (pattern of delivery_store_index).
    "payroll_payout_proof_hashes",
    "tenant_domains",
  ];

  beforeAll(() => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("the test database holds every journal entry", async () => {
    const applied = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.n).toBe(readJournal(drizzleFolder).length);
  });

  it("every public table with row level security enabled also forces it", async () => {
    const { rows } = await admin.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
       ORDER BY 1`);
    expect(rows.map((row) => row.table)).toEqual(enableOnly);
  });
});
