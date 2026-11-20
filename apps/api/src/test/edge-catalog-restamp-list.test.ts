// Restamp list guard (second opinion 1199, finding P2-A). After a cloud
// dump/restore an operator restamps `sync_txid` on every catalog table
// (docs/deployment.md, "Cloud database restore and catalog sync"). A table
// that carries `sync_txid` but is missing from that list keeps its old, high
// stamp: the cloud sends it, the edge only accepts newer stamps, and a change
// after the restore never arrives (promo_settings was missed this way).
// This test compares the documented list with every table that has a
// `sync_txid` column in the migrated database.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../db/index.ts";

const DEPLOYMENT_DOC = resolve(__dirname, "../../../../docs/deployment.md");

// Edge-only copies: the cloud never exports them, so there is nothing to
// restamp on the cloud (the edge replaces them from the vouchers stream).
const EDGE_ONLY_TABLES = ["edge_voucher_catalog"];

function documentedRestampTables(): string[] {
  const line = readFileSync(DEPLOYMENT_DOC, "utf8")
    .split("\n")
    .find((l) => l.includes("Cloud, restamp."));
  if (line === undefined) throw new Error("restamp step not found in the doc");
  const list = /The tables are (.+?)\. /.exec(line)?.[1];
  if (list === undefined) throw new Error("restamp table list not found");
  return [...list.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
}

describe("restamp list covers every catalog table with sync_txid", () => {
  it("lists exactly the tables that have a sync_txid column", async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'sync_txid'
      ORDER BY table_name`);
    const actual = result.rows
      .map((r) => r.table_name)
      .filter((t) => !EDGE_ONLY_TABLES.includes(t));
    expect(actual.length).toBeGreaterThan(0);
    const documented = documentedRestampTables();
    expect(documented.filter((t) => !actual.includes(t))).toEqual([]);
    expect(actual.filter((t) => !documented.includes(t))).toEqual([]);
  });
});
