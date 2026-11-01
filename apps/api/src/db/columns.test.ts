import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import {
  createUlid,
  decimal4,
  idr,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
  uuidId,
} from "./columns.ts";

const tenants = pgTable("column_helper_tenants", {
  id: uuid("id").primaryKey(),
});
const outlets = pgTable("column_helper_outlets", {
  id: uuid("id").primaryKey(),
});
const fixture = pgTable("column_helper_fixture", {
  id: ulidInUuid("id").primaryKey(),
  reference: uuidId("reference").notNull(),
  tenantId: tenantIdColumn(() => tenants.id).notNull(),
  outletId: outletIdColumn(() => outlets.id).notNull(),
  amount: idrColumn("amount").notNull(),
  quantity: decimal4Column("quantity").notNull(),
  day: businessDate("day").notNull(),
});
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});
const db = drizzle(pool);
describe("D-CORE-1/2/4 column conventions", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires disposable test database");
    await pool.query(
      "CREATE TABLE column_helper_tenants (id uuid PRIMARY KEY)",
    );
    await pool.query(
      "CREATE TABLE column_helper_outlets (id uuid PRIMARY KEY)",
    );
    await pool.query(
      "CREATE TABLE column_helper_fixture (id uuid PRIMARY KEY, reference uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES column_helper_tenants(id), outlet_id uuid NOT NULL REFERENCES column_helper_outlets(id), amount bigint NOT NULL, quantity numeric(14,4) NOT NULL, day date NOT NULL)",
    );
    await pool.query(
      "INSERT INTO column_helper_tenants VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
    );
    await pool.query(
      "INSERT INTO column_helper_outlets VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')",
    );
    await pool.query(
      "SELECT app.enforce_tenant_rls('public.column_helper_fixture'::regclass)",
    );
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS column_helper_fixture");
    await pool.query(
      "DROP TABLE IF EXISTS column_helper_outlets, column_helper_tenants",
    );
    await pool.end();
  });
  it("D-CORE-1 D-CORE-2 round trips branded values through PostgreSQL", async () => {
    const value = {
      id: createUlid(),
      reference: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId: tenantIdSchema.parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      outletId: outletIdSchema.parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      amount: idr(Number.MAX_SAFE_INTEGER),
      quantity: decimal4("123.4500"),
      day: "2026-11-02",
    };
    await db.insert(fixture).values(value);
    expect(await db.select().from(fixture)).toEqual([value]);
    const raw = await pool.query(
      "SELECT id::text, quantity::text FROM column_helper_fixture",
    );
    expect(raw.rows[0].id).not.toBe(value.id);
    expect(raw.rows[0].quantity).toBe("123.4500");
  });
  it("D-CORE-2 rejects unsafe amounts and invalid precision at the database boundary", async () => {
    const base = {
      id: createUlid(),
      reference: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId: tenantIdSchema.parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      outletId: outletIdSchema.parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      amount: idr(1),
      quantity: decimal4("1"),
      day: "2026-11-02",
    };
    await expect(
      db
        .insert(fixture)
        .values({ ...base, amount: (Number.MAX_SAFE_INTEGER + 1) as never }),
    ).rejects.toThrow();
    await expect(
      db.insert(fixture).values({ ...base, quantity: "1.00001" as never }),
    ).rejects.toThrow();
  });
});
