// legend-wg0g. Migration 0356 appends `ops.checklist.manage` to the stored
// template roles owner, outlet_manager and kitchen_lead of tenants seeded before
// the permission existed (the resolver reads stored role rows, not the catalog).
// facility_attendant and custom roles must not get it. Idempotent. The test runs
// the real SQL file against rows in the pre-0356 shape, twice, as the table owner.
//
// ASSUMPTION: a template row that already holds the code is left unchanged (no
// duplicate entry), per the migration comment "skips rows that already hold it".
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const MANAGE = "ops.checklist.manage";
const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(drizzleFolder, "0356_ops_checklist_manage_backfill.sql"),
    "utf8",
  );
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationStatements()) await owner.query(statement);
}

async function createTenant(): Promise<string> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Checklist manage backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `cl-manage-bf-${tenantId.slice(0, 8)}`, randomUUID()],
  );
  return tenantId;
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

describe("legend-wg0g migration 0356 ops.checklist.manage backfill", () => {
  it("restores FORCE ROW LEVEL SECURITY around the backfill", () => {
    const statements = migrationStatements();
    expect(statements[0]).toMatch(/NO FORCE ROW LEVEL SECURITY/i);
    const last = statements[statements.length - 1]!;
    expect(last).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(last).not.toMatch(/NO FORCE/i);
  });

  it("appends the code to owner, outlet_manager and kitchen_lead only, once, never to custom roles", async () => {
    const tenantId = await createTenant();
    const base = ["ops.checklist.complete"];
    const ownerRole = await insertRole(tenantId, "Owner", "owner", base);
    const manager = await insertRole(
      tenantId,
      "Manajer Outlet",
      "outlet_manager",
      base,
    );
    const kitchen = await insertRole(tenantId, "Dapur", "kitchen_lead", base);
    const attendant = await insertRole(
      tenantId,
      "Petugas Fasilitas",
      "facility_attendant",
      base,
    );
    const custom = await insertRole(tenantId, "Custom", null, base);
    // A second tenant whose owner template already holds the code.
    const otherTenant = await createTenant();
    const already = await insertRole(otherTenant, "Owner", "owner", [
      ...base,
      MANAGE,
    ]);

    await applyMigration();

    for (const roleId of [ownerRole, manager, kitchen]) {
      expect(await permissionsOf(roleId)).toEqual([...base, MANAGE]);
    }
    expect(await permissionsOf(attendant)).toEqual(base);
    expect(await permissionsOf(custom)).toEqual(base);
    expect(await permissionsOf(already)).toEqual([...base, MANAGE]);

    // Second run changes nothing: no duplicate entries.
    await applyMigration();

    for (const roleId of [ownerRole, manager, kitchen, already]) {
      const permissions = await permissionsOf(roleId);
      expect(permissions).toEqual([...base, MANAGE]);
      expect(permissions.filter((code) => code === MANAGE)).toHaveLength(1);
    }
    expect(await permissionsOf(attendant)).toEqual(base);
    expect(await permissionsOf(custom)).toEqual(base);
  });
});
