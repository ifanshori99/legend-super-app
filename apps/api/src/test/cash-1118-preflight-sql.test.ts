// legend 1118 D4: the release gate script must stay executable. Runs both
// read-only statements of scripts/preflight/1118-shared-cash-mapping.sql as the
// database owner (RLS bypass). Rows are not asserted (other tests leave data
// in the shared test DB); the check is that both statements parse, the column
// names exist, and each returns a row list.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
afterAll(async () => {
  await owner.end();
});

const script = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../scripts/preflight/1118-shared-cash-mapping.sql",
  ),
  "utf8",
);
const statements = script
  .split(/;\s*\n/)
  .map((part) => part.trim())
  .filter((part) => /^(--[^\n]*\n)*\s*(SELECT|WITH)\b/m.test(part));

describe("1118 release gate SQL", () => {
  it("has the two statements", () => {
    expect(statements).toHaveLength(2);
  });

  it.each([0, 1])("statement %i executes read-only", async (index) => {
    const result = await owner.query(statements[index] as string);
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
