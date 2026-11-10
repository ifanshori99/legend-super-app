// Migration 0234 adds `uoms.is_system` (default false) and backfills the twelve
// standard unit codes to true. The backfill matches on `code` ONLY, never on
// name, and is case-sensitive. These tests re-run the migration's UPDATE against
// seeded legacy rows (the ADD COLUMN already ran with the schema), scoped to a
// throwaway tenant so parallel test files are not touched. Pattern follows the
// 0172 backfill test.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = randomUUID();
const migration = readFileSync(
  resolve(import.meta.dirname, "../../drizzle/0234_uom_is_system.sql"),
  "utf8",
);

/** The migration's backfill statement, narrowed to the throwaway tenant. */
const backfillSql = (() => {
  const statement = migration
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--.*$/gm, "").trim())
    .find((sql) => /^UPDATE\s+"uoms"/i.test(sql));
  if (!statement) throw new Error("0234 backfill UPDATE statement not found");
  return `${statement.replace(/;\s*$/, "")} AND "tenant_id" = $1`;
})();

const migrate = async () => {
  await owner.query(backfillSql, [tenantId]);
};

/** Inserts a pre-migration row: the column exists but holds the default. */
async function legacyUom(code: string, name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO uoms (id, tenant_id, code, name, is_system)
     VALUES ($1, $2, $3, $4, false)`,
    [id, tenantId, code, name],
  );
  return id;
}

const isSystem = async (id: string): Promise<boolean> =>
  (
    await owner.query<{ is_system: boolean }>(
      "SELECT is_system FROM uoms WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!.is_system;

beforeAll(async () => {
  const slug = `uom-backfill-${randomBytes(6).toString("hex")}`;
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'UoM backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, slug, "uom-backfill-test"],
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM uoms WHERE tenant_id = $1", [tenantId]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await owner.end();
});

describe("0234 uoms.is_system backfill migration", () => {
  it("(a) marks a legacy row with a standard code and standard name as system", async () => {
    const id = await legacyUom("kg", "Kilogram");
    expect(await isSystem(id)).toBe(false);

    await migrate();

    expect(await isSystem(id)).toBe(true);
  });

  it("(b) KNOWN RISK: a standard code with a renamed name is still marked system (code-only match)", async () => {
    // The backfill never looks at `name`. A tenant that had renamed the
    // standard `box` unit to "Dus Besar" before this migration is therefore
    // locked as a system unit. This pins today's behaviour, not a desired one.
    const id = await legacyUom("box", "Dus Besar");

    await migrate();

    expect(await isSystem(id)).toBe(true);
  });

  it("(c) leaves a non-standard code such as 'tray' as a custom unit", async () => {
    const id = await legacyUom("tray", "Tray");

    await migrate();

    expect(await isSystem(id)).toBe(false);
  });

  it("(d) is case-sensitive: uppercase 'KG' stays a custom unit", async () => {
    // Documents the behaviour: the IN list is lowercase and compared exactly.
    const id = await legacyUom("KG", "Kilogram Upper");

    await migrate();

    expect(await isSystem(id)).toBe(false);
  });

  it("(e) is idempotent: a rerun changes nothing", async () => {
    const standard = await legacyUom("porsi", "Porsi");
    const custom = await legacyUom("crate", "Crate");

    await migrate();
    const snapshot = (
      await owner.query(
        "SELECT id, code, name, is_system FROM uoms WHERE tenant_id = $1 ORDER BY id",
        [tenantId],
      )
    ).rows;
    await migrate();
    const again = (
      await owner.query(
        "SELECT id, code, name, is_system FROM uoms WHERE tenant_id = $1 ORDER BY id",
        [tenantId],
      )
    ).rows;

    expect(again).toEqual(snapshot);
    expect(await isSystem(standard)).toBe(true);
    expect(await isSystem(custom)).toBe(false);
  });

  it("(f) a new row defaults to is_system = false", async () => {
    const id = randomUUID();
    await owner.query(
      "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'bundle', 'Bundle')",
      [id, tenantId],
    );

    expect(await isSystem(id)).toBe(false);
  });
});
