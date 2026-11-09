// legend-9yb5u (tier K access). Migration 0171 backfills two permission codes
// into the template roles of tenants seeded before the codes existed (the
// resolver reads stored role rows, not the catalog):
// - hr.announcement.manage -> owner, general_manager, hr
// - self.loan.request      -> employee
// Not tenant_admin, kitchen_lead or any other template, and never a custom
// role. Idempotent. The test runs the real SQL file against rows in the
// pre-0171 shape, twice.
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

const ANNOUNCE = "hr.announcement.manage";
const LOAN = "self.loan.request";

function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(drizzleFolder, "0171_access_perm_backfill.sql"),
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
     VALUES ($1, $2, 'Perm backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `perm-backfill-${tenantId}`, randomUUID()],
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

describe("legend-9yb5u migration 0171 permission backfill", () => {
  it("is registered in the journal after 0163 with the agreed timestamp", () => {
    const journal = JSON.parse(
      readFileSync(resolve(drizzleFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find((row) => row.idx === 171);
    expect(entry?.tag).toBe("0171_access_perm_backfill");
    expect(entry?.when).toBe(1794250000000);
    const previous = journal.entries.filter((row) => row.idx < 171);
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

  it("appends each code only to its template holders, once, and never to custom roles", async () => {
    const tenantId = await createTenant();
    const base = ["menu.item.view"];
    const ownerRole = await insertRole(tenantId, "Owner", "owner", base);
    const gm = await insertRole(tenantId, "GM", "general_manager", base);
    const hr = await insertRole(tenantId, "HR", "hr", base);
    const employee = await insertRole(tenantId, "Karyawan", "employee", base);
    const admin = await insertRole(tenantId, "Admin", "tenant_admin", base);
    const kitchen = await insertRole(tenantId, "Dapur", "kitchen_lead", base);
    const custom = await insertRole(tenantId, "Custom", null, base);
    // A second tenant whose HR template already holds the code.
    const otherTenant = await createTenant();
    const already = await insertRole(otherTenant, "HR", "hr", [
      ...base,
      ANNOUNCE,
    ]);

    await applyMigration();
    await applyMigration();

    expect(await permissionsOf(ownerRole)).toEqual([...base, ANNOUNCE]);
    expect(await permissionsOf(gm)).toEqual([...base, ANNOUNCE]);
    expect(await permissionsOf(hr)).toEqual([...base, ANNOUNCE]);
    expect(await permissionsOf(employee)).toEqual([...base, LOAN]);
    expect(await permissionsOf(admin)).toEqual(base);
    expect(await permissionsOf(kitchen)).toEqual(base);
    expect(await permissionsOf(custom)).toEqual(base);
    expect(await permissionsOf(already)).toEqual([...base, ANNOUNCE]);
  });
});
