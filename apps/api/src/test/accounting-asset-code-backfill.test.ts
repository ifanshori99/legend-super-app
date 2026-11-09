// legend-dux2: migration 0174 backfills fixed_assets.code for pre-existing rows as
// FA-00001.. per (tenant, legal entity) in (created_at, id) order. The UPDATE is
// extracted from the migration file and run unchanged against a session-local
// TEMP table named fixed_assets (pg_temp shadows public in the search path), so
// no real data is touched and the shipped SQL is what gets proven.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0174_finance_policy_asset_register.sql",
  ),
  "utf8",
);
const stripComments = (sql: string) => sql.replace(/--.*$/gm, "").trim();
const backfill = migration
  .split("--> statement-breakpoint")
  .map(stripComments)
  .find((statement) => /^UPDATE\s+"fixed_assets"/i.test(statement));

type Row = { id: string; tenant: string; entity: string; createdAt: string };

const tenantA = randomUUID();
const tenantB = randomUUID();
const entityA1 = randomUUID();
const entityA2 = randomUUID();
const entityB1 = randomUUID();

// Fixed ids so the id tie-break is visible: same created_at, ids in reverse insert order.
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t1 = "2026-01-01T00:00:00Z";
const t2 = "2026-01-02T00:00:00Z";
const t3 = "2026-01-03T00:00:00Z";
const rows: Row[] = [
  // (A, A1): three rows share t2 and are inserted out of id order; t1 first, t3 last.
  { id: id(9), tenant: tenantA, entity: entityA1, createdAt: t3 },
  { id: id(5), tenant: tenantA, entity: entityA1, createdAt: t2 },
  { id: id(3), tenant: tenantA, entity: entityA1, createdAt: t2 },
  { id: id(7), tenant: tenantA, entity: entityA1, createdAt: t2 },
  { id: id(8), tenant: tenantA, entity: entityA1, createdAt: t1 },
  // (A, A2): numbering restarts for a second entity of the same tenant.
  { id: id(2), tenant: tenantA, entity: entityA2, createdAt: t2 },
  { id: id(1), tenant: tenantA, entity: entityA2, createdAt: t2 },
  // (B, B1): numbering restarts for another tenant.
  { id: id(4), tenant: tenantB, entity: entityB1, createdAt: t1 },
  { id: id(6), tenant: tenantB, entity: entityB1, createdAt: t1 },
];

let client: PoolClient;

const codes = async () => {
  const result = await client.query<{ id: string; code: string }>(
    "SELECT id::text, code FROM pg_temp.fixed_assets",
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.code]));
};

const reset = async () => {
  await client.query("UPDATE pg_temp.fixed_assets SET code = NULL");
};

beforeAll(async () => {
  client = await owner.connect();
  await client.query(`CREATE TEMP TABLE fixed_assets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    legal_entity_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    code varchar(40)
  )`);
  for (const row of rows)
    await client.query(
      "INSERT INTO pg_temp.fixed_assets (id, tenant_id, legal_entity_id, created_at) VALUES ($1, $2, $3, $4)",
      [row.id, row.tenant, row.entity, row.createdAt],
    );
});

afterAll(async () => {
  client?.release();
  await owner.end();
});

describe("0174 fixed_assets.code backfill", () => {
  it("finds the backfill UPDATE in the migration file", () => {
    expect(backfill).toBeTruthy();
  });

  it("lifts FORCE RLS on fixed_assets around the backfill (migrator may lack BYPASSRLS) and restores it", () => {
    const statements = migration
      .split("--> statement-breakpoint")
      .map(stripComments);
    const at = (pattern: RegExp) =>
      statements.findIndex((statement) => pattern.test(statement));
    const lift = at(/NO FORCE ROW LEVEL SECURITY/i);
    const update = at(/^UPDATE\s+"fixed_assets"/i);
    const restore = at(
      /^ALTER TABLE public\.fixed_assets FORCE ROW LEVEL SECURITY/i,
    );
    const notNull = at(/"code" SET NOT NULL/i);
    expect(lift).toBeGreaterThanOrEqual(0);
    expect(lift).toBeLessThan(update);
    expect(update).toBeLessThan(restore);
    expect(restore).toBeLessThan(notNull);
  });

  it("numbers each (tenant, entity) FA-00001.. by created_at then id, without gaps or duplicates", async () => {
    await reset();
    await client.query(backfill!);
    expect(await codes()).toEqual({
      [id(8)]: "FA-00001",
      [id(3)]: "FA-00002",
      [id(5)]: "FA-00003",
      [id(7)]: "FA-00004",
      [id(9)]: "FA-00005",
      [id(1)]: "FA-00001",
      [id(2)]: "FA-00002",
      [id(4)]: "FA-00001",
      [id(6)]: "FA-00002",
    });
  });

  it("leaves no row without a code and no duplicate inside one (tenant, entity)", async () => {
    await reset();
    await client.query(backfill!);
    const nulls = await client.query(
      "SELECT 1 FROM pg_temp.fixed_assets WHERE code IS NULL",
    );
    expect(nulls.rowCount).toBe(0);
    const duplicates = await client.query(
      `SELECT 1 FROM pg_temp.fixed_assets
       GROUP BY tenant_id, legal_entity_id, code HAVING count(*) > 1`,
    );
    expect(duplicates.rowCount).toBe(0);
  });

  it("is deterministic: a second run from scratch gives identical codes", async () => {
    await reset();
    await client.query(backfill!);
    const first = await codes();
    await reset();
    await client.query(backfill!);
    expect(await codes()).toEqual(first);
  });

  it("is stable when re-run over already-numbered rows", async () => {
    await reset();
    await client.query(backfill!);
    const first = await codes();
    await client.query(backfill!);
    expect(await codes()).toEqual(first);
  });
});
