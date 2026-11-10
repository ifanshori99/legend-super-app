import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

const CHANGE = "profit_share.share_allocation.change";

function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(drizzleFolder, "0221_profit_share_unabsorbed.sql"),
    "utf8",
  );
  // Only the permission backfill (the roles statements); the schema half of
  // 0221 is covered by the distribution tests.
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => /public\.roles|"roles"/.test(part));
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationStatements()) await owner.query(statement);
}

async function insertRole(
  tenantId: string,
  name: string,
  templateKey: string | null,
  permissions: readonly string[],
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5::jsonb, false, '["tenant"]'::jsonb)
     RETURNING id`,
    [
      tenantId,
      name,
      templateKey !== null,
      templateKey,
      JSON.stringify(permissions),
    ],
  );
  return rows[0]!.id;
}

async function permissionsOf(roleId: string): Promise<string[]> {
  const { rows } = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE id = $1",
    [roleId],
  );
  return rows[0]!.permissions;
}

async function createTenant(): Promise<string> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Profit share perm', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `profit-perm-${tenantId}`, randomUUID()],
  );
  return tenantId;
}

afterAll(async () => {
  if (tenantIds.length > 0) {
    await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      tenantIds,
    ]);
  }
  await owner.end();
});

describe("legend-8s992 migration 0221 share allocation permission backfill", () => {
  it("is registered in the journal after 0219 with the agreed timestamp", () => {
    const journal = JSON.parse(
      readFileSync(resolve(drizzleFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find((row) => row.idx === 221);
    expect(entry?.tag).toBe("0221_profit_share_unabsorbed");
    expect(entry?.when).toBe(1794300000000);
    const previous = journal.entries.filter((row) => row.idx < 221);
    expect(Math.max(...previous.map((row) => row.when))).toBeLessThan(
      entry!.when,
    );
  });

  it("restores FORCE ROW LEVEL SECURITY around the backfill", () => {
    const statements = migrationStatements();
    expect(statements[0]).toMatch(/NO FORCE ROW LEVEL SECURITY/i);
    expect(statements[statements.length - 1]).toMatch(
      /FORCE ROW LEVEL SECURITY/i,
    );
    expect(statements[statements.length - 1]).not.toMatch(/NO FORCE/i);
  });

  it("appends the code to the owner and finance templates once, never to cashier, shareholder or custom roles", async () => {
    const tenantId = await createTenant();
    const base = ["profit_share.registry.manage"];
    const ownerRole = await insertRole(tenantId, "Owner", "owner", base);
    const finance = await insertRole(tenantId, "Finance", "finance", base);
    const cashier = await insertRole(tenantId, "Kasir", "cashier", [
      "pos.sale.create",
    ]);
    const shareholder = await insertRole(tenantId, "Pemegang", "shareholder", [
      "profit_share.own.view",
    ]);
    const custom = await insertRole(tenantId, "Custom", null, base);
    const otherTenant = await createTenant();
    const already = await insertRole(otherTenant, "Finance", "finance", [
      ...base,
      CHANGE,
    ]);

    await applyMigration();
    await applyMigration();

    expect(await permissionsOf(ownerRole)).toEqual([...base, CHANGE]);
    expect(await permissionsOf(finance)).toEqual([...base, CHANGE]);
    expect(await permissionsOf(cashier)).toEqual(["pos.sale.create"]);
    expect(await permissionsOf(shareholder)).toEqual(["profit_share.own.view"]);
    expect(await permissionsOf(custom)).toEqual(base);
    expect(await permissionsOf(already)).toEqual([...base, CHANGE]);
  });
});
