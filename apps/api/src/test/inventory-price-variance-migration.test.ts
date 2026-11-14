// legend-uloj6: data migration 0384 adds the account 5106 "Selisih Harga
// Persediaan" and the `inventory_price_variance` mapping to entities that were
// provisioned before the code knew the role. Written fail-first from the design
// and the pattern of 0335 / 0205, not from the SQL.
//
// Rules under test (same family as 0147 / 0205):
// - Only entities that already have an `account_mappings` row get anything;
//   an unprovisioned entity gets nothing (the provisioning service seeds it).
// - 5106 is inserted as type expense, report group cogs, under the entity's 5100
//   when that exists with the same type (else no parent); a custom 5106 is
//   kept as is (never renamed, retyped, duplicated or deleted).
// - The role is mapped only when it has no mapping yet and the 5106 account is
//   active, an expense account and has no child account.
// - Idempotent: running it twice changes nothing more.
//
// Assumptions:
// - The migration file is `apps/api/drizzle/0384_inventory_price_variance.sql`
//   and is run statement by statement as the migration owner, like
//   the other data-migration tests. It spans every tenant, so entities of other
//   tests may gain 5106 too; this file only looks at its own entities.
// - Fixture entities belong to the fixture tenant; they are left in place
//   (ledgers and charts are append-only elsewhere, entities are random).

import { randomUUID } from "node:crypto";
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

afterAll(async () => {
  await owner.end();
});

const migrationSql = () =>
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../drizzle/0384_inventory_price_variance.sql",
    ),
    "utf8",
  );

/** Replays the migration for the fixture tenant only (legend-edxtt). */
const migrate = (): Promise<void> =>
  replayMigrationForTenant(owner, migrationSql(), tenantId);

async function entity(provisioned: boolean): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `Entity 0384 ${id.slice(0, 8)}`],
  );
  if (provisioned) {
    // One mapping row is what makes an entity "provisioned".
    const account = await addAccount(id, "1301", "Persediaan", "asset", {
      reportGroup: "current_asset",
    });
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'inventory', $3)`,
      [tenantId, id, account],
    );
  }
  return id;
}

async function addAccount(
  entityId: string,
  code: string,
  name: string,
  type: string,
  options: { reportGroup?: string; parentId?: string } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      tenantId,
      entityId,
      code,
      name,
      type,
      options.reportGroup ?? (type === "expense" ? "cogs" : "current_asset"),
      options.parentId ?? null,
    ],
  );
  return rows[0]!.id;
}

type AccountRow = {
  id: string;
  name: string;
  type: string;
  report_group: string;
  parent_id: string | null;
  is_active: boolean;
};

async function accounts5106(entityId: string): Promise<AccountRow[]> {
  const { rows } = await owner.query<AccountRow>(
    `SELECT id, name, type, report_group, parent_id, is_active FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '5106'`,
    [tenantId, entityId],
  );
  return rows;
}

async function varianceMappings(entityId: string): Promise<string[]> {
  const { rows } = await owner.query<{ account_id: string }>(
    `SELECT account_id FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'inventory_price_variance'`,
    [tenantId, entityId],
  );
  return rows.map((row) => row.account_id);
}

describe("legend-uloj6 migration 0384 inventory price variance account", () => {
  it("MIG-01 a provisioned entity gets 5106 (expense, cogs, under its 5100) and the role mapping, once even when run twice", async () => {
    const entityId = await entity(true);
    const parent = await addAccount(entityId, "5100", "Beban Pokok", "expense");

    await migrate();
    await migrate();

    const rows = await accounts5106(entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Selisih Harga Persediaan",
      type: "expense",
      report_group: "cogs",
      parent_id: parent,
      is_active: true,
    });
    expect(await varianceMappings(entityId)).toEqual([rows[0]!.id]);
  });

  it("MIG-02 without a usable 5100 the account has no parent (a parent of another type is never used)", async () => {
    const noParent = await entity(true);
    const wrongType = await entity(true);
    await addAccount(wrongType, "5100", "Aset Lain", "asset", {
      reportGroup: "current_asset",
    });

    await migrate();

    for (const entityId of [noParent, wrongType]) {
      const rows = await accounts5106(entityId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parent_id).toBeNull();
      expect(await varianceMappings(entityId)).toEqual([rows[0]!.id]);
    }
  });

  it("MIG-03 an entity with no account mapping at all (not provisioned) gets nothing", async () => {
    const entityId = await entity(false);

    await migrate();

    expect(await accounts5106(entityId)).toHaveLength(0);
    expect(await varianceMappings(entityId)).toHaveLength(0);
  });

  it("MIG-04 a custom 5106 is kept as it is: same name, no second account; mapped only when it is an active expense account without children", async () => {
    const custom = await entity(true);
    const customId = await addAccount(
      custom,
      "5106",
      "Biaya Lain-lain Custom",
      "expense",
    );
    const wrong = await entity(true);
    const wrongId = await addAccount(
      wrong,
      "5106",
      "Piutang Karyawan",
      "asset",
    );
    const header = await entity(true);
    const headerId = await addAccount(
      header,
      "5106",
      "Header Custom",
      "expense",
    );
    await addAccount(header, "51061", "Anak Header", "expense", {
      parentId: headerId,
    });

    await migrate();
    await migrate();

    const customRows = await accounts5106(custom);
    expect(customRows).toHaveLength(1);
    expect(customRows[0]).toMatchObject({
      id: customId,
      name: "Biaya Lain-lain Custom",
      type: "expense",
    });
    expect(await varianceMappings(custom)).toEqual([customId]);

    // An asset account must never receive the variance role.
    const wrongRows = await accounts5106(wrong);
    expect(wrongRows).toHaveLength(1);
    expect(wrongRows[0]).toMatchObject({
      id: wrongId,
      name: "Piutang Karyawan",
      type: "asset",
    });
    expect(await varianceMappings(wrong)).toHaveLength(0);

    // A header account (it has a child) is not postable: no mapping.
    expect((await accounts5106(header))[0]!.id).toBe(headerId);
    expect(await varianceMappings(header)).toHaveLength(0);
  });
});
