import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/0373_edge_catalog_publisher.sql", import.meta.url),
  "utf8",
);
if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
  throw new Error("Requires the disposable test database");
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});

afterAll(async () => pool.end());

describe("edge inbound outcome migration", () => {
  it("retains legacy rows without validation while enforcing the new check on writes", async () => {
    const statement = migration
      .split("--> statement-breakpoint")
      .find((part) =>
        /ADD CONSTRAINT edge_inbound_events_outcome_check/i.test(part),
      );
    expect(statement).toBeDefined();
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "CREATE TEMP TABLE inbound_migration_test (outcome text NOT NULL)",
      );
      await connection.query(
        "INSERT INTO inbound_migration_test VALUES ('legacy')",
      );
      await connection.query(
        statement!.replace(
          /ALTER TABLE edge_inbound_events/i,
          "ALTER TABLE inbound_migration_test",
        ),
      );
      await connection.query(
        "INSERT INTO inbound_migration_test VALUES ('deferred')",
      );
      const rows = await connection.query(
        "SELECT outcome FROM inbound_migration_test ORDER BY outcome",
      );
      expect(rows.rows.map((row) => row.outcome)).toEqual([
        "deferred",
        "legacy",
      ]);
      await expect(
        connection.query(
          "INSERT INTO inbound_migration_test VALUES ('invalid')",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const actual = await pool.query(
      "SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.edge_inbound_events'::regclass AND conname = 'edge_inbound_events_outcome_check'",
    );
    expect(actual.rows).toEqual([{ convalidated: false }]);
  });
});
