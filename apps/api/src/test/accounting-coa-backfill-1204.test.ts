// legend-s8a3: data migration 0134 backfills account 1204 / 6110 and the
// employee_receivable / reimbursement_expense mappings for entities that were
// provisioned before the payroll journal. Written as the migration owner, so
// the SQL is proven directly, twice (idempotent), like the 0115 data test.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0134_accounting_coa_backfill_1204.sql",
  ),
  "utf8",
);

afterAll(async () => {
  await owner.end();
});

const migrate = async () => {
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.replace(/--.*$/gm, "").trim()) await owner.query(statement);
};

async function entity(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `Backfill 1204 ${unique()}`],
  );
  return id;
}

async function account(
  entityId: string,
  code: string,
  type: string,
  reportGroup: string,
  parentId: string | null = null,
  isActive = true,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      tenantId,
      entityId,
      code,
      `Akun ${code}`,
      type,
      reportGroup,
      parentId,
      isActive,
    ],
  );
  return id;
}

async function map(entityId: string, role: string, accountId: string) {
  await owner.query(
    "INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id) VALUES ($1, $2, $3, $4)",
    [tenantId, entityId, role, accountId],
  );
}

/** A provisioned entity: 1200 and 6100 headers plus one mapping row. */
async function provisioned(): Promise<string> {
  const id = await entity();
  await account(id, "1101", "asset", "cash_and_equivalents").then((cash) =>
    map(id, "cash_on_hand", cash),
  );
  await account(id, "1200", "asset", "current_asset");
  await account(id, "6100", "expense", "operating_expense");
  return id;
}

const accountsOf = async (entityId: string, code: string) =>
  (
    await owner.query<{ id: string; parent_code: string | null }>(
      `SELECT a.id, p.code AS parent_code FROM chart_of_accounts a
       LEFT JOIN chart_of_accounts p ON p.id = a.parent_id
       WHERE a.tenant_id = $1 AND a.legal_entity_id = $2 AND a.code = $3`,
      [tenantId, entityId, code],
    )
  ).rows;

const mappingsOf = async (entityId: string, role: string) =>
  (
    await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [tenantId, entityId, role],
    )
  ).rows;

describe("legend-s8a3 1204 / 6110 backfill migration", () => {
  it("adds one account and one mapping each, twice over, under 1200 / 6100", async () => {
    const id = await provisioned();

    await migrate();
    await migrate();

    const receivable = await accountsOf(id, "1204");
    const reimbursement = await accountsOf(id, "6110");
    expect(receivable).toHaveLength(1);
    expect(receivable[0]?.parent_code).toBe("1200");
    expect(reimbursement).toHaveLength(1);
    expect(reimbursement[0]?.parent_code).toBe("6100");
    expect(await mappingsOf(id, "employee_receivable")).toEqual([
      { account_id: receivable[0]?.id },
    ]);
    expect(await mappingsOf(id, "reimbursement_expense")).toEqual([
      { account_id: reimbursement[0]?.id },
    ]);
  });

  it("maps an existing 1204 / 6110 and keeps an existing mapping", async () => {
    const id = await provisioned();
    const existing1204 = await account(id, "1204", "asset", "current_asset");
    const other = await account(id, "6199", "expense", "operating_expense");
    await map(id, "reimbursement_expense", other);

    await migrate();

    expect(await accountsOf(id, "1204")).toHaveLength(1);
    expect(await mappingsOf(id, "employee_receivable")).toEqual([
      { account_id: existing1204 },
    ]);
    expect(await mappingsOf(id, "reimbursement_expense")).toEqual([
      { account_id: other },
    ]);
  });

  it("does not map a custom 1204 of the wrong type, an inactive one or a header", async () => {
    const wrongType = await provisioned();
    await account(wrongType, "1204", "expense", "operating_expense");
    const inactive = await provisioned();
    await account(inactive, "1204", "asset", "current_asset", null, false);
    const header = await provisioned();
    const headerId = await account(header, "1204", "asset", "current_asset");
    await account(header, "1205", "asset", "current_asset", headerId);

    await migrate();

    for (const id of [wrongType, inactive, header]) {
      expect(await accountsOf(id, "1204")).toHaveLength(1);
      expect(await mappingsOf(id, "employee_receivable")).toEqual([]);
      // 6110 is still backfilled and mapped on its own.
      expect(await mappingsOf(id, "reimbursement_expense")).toHaveLength(1);
    }
  });

  it("leaves an unprovisioned entity untouched", async () => {
    const id = await entity();
    await account(id, "1200", "asset", "current_asset");

    await migrate();

    expect(await accountsOf(id, "1204")).toEqual([]);
    expect(await accountsOf(id, "6110")).toEqual([]);
    expect(await mappingsOf(id, "employee_receivable")).toEqual([]);
    expect(await mappingsOf(id, "reimbursement_expense")).toEqual([]);
  });

  it("uses a NULL parent when 1200 / 6100 is missing", async () => {
    const id = await entity();
    await account(id, "1101", "asset", "cash_and_equivalents").then((cash) =>
      map(id, "cash_on_hand", cash),
    );

    await migrate();

    expect((await accountsOf(id, "1204"))[0]?.parent_code).toBeNull();
    expect((await accountsOf(id, "6110"))[0]?.parent_code).toBeNull();
    expect(await mappingsOf(id, "employee_receivable")).toHaveLength(1);
  });
});
