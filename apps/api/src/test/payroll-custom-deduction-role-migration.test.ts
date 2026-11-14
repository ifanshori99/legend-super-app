// legend-75kr: data migration 0155 backfills the new `payroll_custom_deduction`
// role mapping for entities provisioned before the role existed: every
// (tenant, legal entity) with a `salary_expense` mapping and no
// `payroll_custom_deduction` mapping gets the role mapped to the SAME account as
// salary_expense (not to code 6101), so the payroll journal keeps posting
// custom deductions exactly where it did. Written as the migration owner, so
// the SQL is proven directly, twice (idempotent), like the 0147 data test.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { replayMigrationForTenant } from "./helpers/migration-replay.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0155_payroll_custom_deduction_role.sql",
  ),
  "utf8",
);

afterAll(async () => {
  await owner.end();
});

const migrate = () => replayMigrationForTenant(owner, migration, tenantId);

async function entity(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `Backfill custom deduction ${unique()}`],
  );
  return id;
}

async function account(
  entityId: string,
  code: string,
  type = "expense",
  reportGroup = "operating_expense",
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, true)`,
    [id, tenantId, entityId, code, `Akun ${code}`, type, reportGroup],
  );
  return id;
}

async function map(entityId: string, role: string, accountId: string) {
  await owner.query(
    "INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id) VALUES ($1, $2, $3, $4)",
    [tenantId, entityId, role, accountId],
  );
}

const mappingsOf = async (entityId: string, role: string) =>
  (
    await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [tenantId, entityId, role],
    )
  ).rows;

const allMappings = async (entityId: string) =>
  (
    await owner.query<{ role: string; account_id: string }>(
      "SELECT role, account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY role",
      [tenantId, entityId],
    )
  ).rows;

/** An entity provisioned before the role: salary_expense -> 6101 plus one more mapping. */
async function legacyEntity(): Promise<{ id: string; salary: string }> {
  const id = await entity();
  const salary = await account(id, "6101");
  await map(id, "salary_expense", salary);
  await map(
    id,
    "cash_on_hand",
    await account(id, "1101", "asset", "current_asset"),
  );
  return { id, salary };
}

describe("legend-75kr payroll_custom_deduction backfill migration", () => {
  it("maps the role to the salary_expense account, twice over, adding exactly one row", async () => {
    const { id, salary } = await legacyEntity();
    const before = await allMappings(id);

    await migrate();
    await migrate();

    expect(await mappingsOf(id, "payroll_custom_deduction")).toEqual([
      { account_id: salary },
    ]);
    const after = await allMappings(id);
    expect(after).toHaveLength(before.length + 1);
    // Nothing existing was changed or removed.
    for (const row of before) expect(after).toContainEqual(row);
  });

  it("copies the account of a remapped salary_expense, not code 6101", async () => {
    const id = await entity();
    await account(id, "6101");
    const remapped = await account(id, "6155");
    await map(id, "salary_expense", remapped);

    await migrate();

    expect(await mappingsOf(id, "payroll_custom_deduction")).toEqual([
      { account_id: remapped },
    ]);
    expect(await mappingsOf(id, "salary_expense")).toEqual([
      { account_id: remapped },
    ]);
  });

  it("keeps an existing payroll_custom_deduction mapping untouched", async () => {
    const { id } = await legacyEntity();
    const koperasi = await account(
      id,
      "2190",
      "liability",
      "current_liability",
    );
    await map(id, "payroll_custom_deduction", koperasi);

    await migrate();

    expect(await mappingsOf(id, "payroll_custom_deduction")).toEqual([
      { account_id: koperasi },
    ]);
  });

  it("leaves an entity without a salary_expense mapping untouched", async () => {
    const id = await entity();
    await map(
      id,
      "cash_on_hand",
      await account(id, "1101", "asset", "current_asset"),
    );

    await migrate();

    expect(await mappingsOf(id, "payroll_custom_deduction")).toEqual([]);
    expect(await allMappings(id)).toHaveLength(1);
  });

  it("backfills each entity with its own salary_expense account", async () => {
    const first = await legacyEntity();
    const second = await legacyEntity();

    await migrate();

    expect(await mappingsOf(first.id, "payroll_custom_deduction")).toEqual([
      { account_id: first.salary },
    ]);
    expect(await mappingsOf(second.id, "payroll_custom_deduction")).toEqual([
      { account_id: second.salary },
    ]);
    expect(first.salary).not.toBe(second.salary);
  });
});
