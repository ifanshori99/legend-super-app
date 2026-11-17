// legend-44g8n: the cash columns of `order_issue_charges` (legend-800h1) reach
// a database that already ran the shipped 0229 through the forward migration
// 0230. 0229 itself stays as it shipped (drizzle never re-runs an applied
// file), so a change in place left such a database without the columns.
//
// Checks: 0229 does not mention the cash columns, 0230 has a unique `when` above
// 0229's, above every entry before it, its snapshot chains onto 0229's, and
// applying the 0230 statements to the table as 0229 left it (simulated in a
// transaction that is rolled back) adds the columns, the constraints and the
// unique index, and the paid-in-cash rules then hold.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/order-issue-charge-cash-migration.test.ts" pnpm test
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
afterAll(async () => {
  await owner.end();
});

const drizzleFile = (path: string) =>
  new URL(`../../drizzle/${path}`, import.meta.url);
const read = (path: string) => readFileSync(drizzleFile(path), "utf8");
const TAG = "0230_order_issue_charge_cash";
const sql0229 = read("0229_order_issue_refund_rejected.sql");
const sql0230 = read(`${TAG}.sql`);
const statements0230 = sql0230
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

/** The table as the shipped 0229 left it: the 0230 changes taken back. */
const BACK_TO_0229 = [
  `DROP INDEX order_issue_charges_cash_movement_once_idx`,
  `ALTER TABLE order_issue_charges DROP CONSTRAINT order_issue_charges_cash_movement_fk`,
  `ALTER TABLE order_issue_charges DROP CONSTRAINT order_issue_charges_paid_by_user_id_fk`,
  `ALTER TABLE order_issue_charges DROP CONSTRAINT order_issue_charges_cash_paid_check`,
  `ALTER TABLE order_issue_charges DROP CONSTRAINT order_issue_charges_route_status_check`,
  `ALTER TABLE order_issue_charges ADD CONSTRAINT order_issue_charges_route_status_check CHECK ((route = 'pos') = (status = 'routed_pos') OR status IN ('waived', 'expired'))`,
  `ALTER TABLE order_issue_charges DROP COLUMN cash_movement_id`,
  `ALTER TABLE order_issue_charges DROP COLUMN paid_by`,
];

async function inRolledBackTx(work: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    // The table is shared with other test files and what they leave behind
    // (paid-at-POS and voided charges, legend-gt98h / legend-s61sg) breaks the
    // 0229 route/status CHECK this test puts back. The simulated 0229 table
    // starts empty; the ROLLBACK below restores every row.
    await client.query("DELETE FROM order_issue_charges");
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const columns = async (client: PoolClient) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'order_issue_charges'
         AND column_name IN ('cash_movement_id', 'paid_by')
       ORDER BY column_name`,
    )
  ).rows.map((r) => r.column_name);

describe("legend-44g8n migration 0230: swap charge cash columns", () => {
  it("0229 is back to its shipped text; 0230 holds the cash columns", () => {
    expect(sql0229).not.toContain("cash_movement_id");
    expect(sql0229).not.toContain('"paid_by"');
    expect(sql0229).not.toContain("order_issue_charges_cash_");
    expect(sql0229).toContain(
      `OR "order_issue_charges"."status" IN ('waived', 'expired')),`,
    );
    expect(sql0230).toContain('ADD COLUMN "cash_movement_id" uuid');
    expect(sql0230).toContain('ADD COLUMN "paid_by" text');
  });

  it("journal: 0230 has a unique `when` above 0229's, above every entry before it; snapshot chains onto 0229", () => {
    const journal = JSON.parse(read("meta/_journal.json")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = (tag: string) => journal.entries.find((e) => e.tag === tag)!;
    expect(entry(TAG).idx).toBe(230);
    expect(entry(TAG).when).toBeGreaterThan(
      entry("0229_order_issue_refund_rejected").when,
    );
    const whens = journal.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    const before = journal.entries
      .slice(
        0,
        journal.entries.findIndex((e) => e.tag === TAG),
      )
      .map((e) => e.when);
    expect(entry(TAG).when).toBeGreaterThan(Math.max(...before));
    const snap0229 = JSON.parse(read("meta/0229_snapshot.json"));
    const snap0230 = JSON.parse(read("meta/0230_snapshot.json"));
    expect(snap0230.prevId).toBe(snap0229.id);
    expect(snap0230.id).not.toBe(snap0229.id);
    const table = (snap: {
      tables: Record<string, { columns: Record<string, unknown> }>;
    }) =>
      snap.tables["public.order_issue_charges"].columns;
    expect(Object.keys(table(snap0229))).not.toContain("cash_movement_id");
    expect(Object.keys(table(snap0230))).toContain("cash_movement_id");
    expect(Object.keys(table(snap0230))).toContain("paid_by");
  });

  it("a table as 0229 left it has no cash columns; 0230 adds them, the constraints and the unique index", async () => {
    await inRolledBackTx(async (client) => {
      expect(await columns(client)).toEqual(["cash_movement_id", "paid_by"]);
      for (const statement of BACK_TO_0229) await client.query(statement);
      expect(await columns(client)).toEqual([]);

      for (const statement of statements0230) await client.query(statement);
      expect(await columns(client)).toEqual(["cash_movement_id", "paid_by"]);

      const { rows } = await client.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'public.order_issue_charges'::regclass
           AND conname IN ('order_issue_charges_cash_paid_check',
                           'order_issue_charges_paid_by_user_id_fk',
                           'order_issue_charges_cash_movement_fk',
                           'order_issue_charges_route_status_check')`,
      );
      const byName = new Map(rows.map((r) => [r.conname, r.def]));
      expect([...byName.keys()].sort()).toEqual([
        "order_issue_charges_cash_movement_fk",
        "order_issue_charges_cash_paid_check",
        "order_issue_charges_paid_by_user_id_fk",
        "order_issue_charges_route_status_check",
      ]);
      expect(byName.get("order_issue_charges_route_status_check")).toContain(
        "'paid'",
      );
      const index = await client.query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes
         WHERE tablename = 'order_issue_charges'
           AND indexname = 'order_issue_charges_cash_movement_once_idx'`,
      );
      expect(index.rows[0]?.def).toContain("UNIQUE");
      expect(index.rows[0]?.def).toContain("cash_movement_id IS NOT NULL");
    });
  });

  it("the live table (every migration applied) matches the forward state", async () => {
    const client = await owner.connect();
    try {
      expect(await columns(client)).toEqual(["cash_movement_id", "paid_by"]);
    } finally {
      client.release();
    }
  });
});
