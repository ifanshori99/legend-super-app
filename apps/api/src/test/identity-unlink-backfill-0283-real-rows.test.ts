// legend-c79uy section C (tier K access). Migration 0283 appends
// `crm.customer.identity.unlink` to the STORED owner and tenant_admin template
// roles of tenants that existed before the code did. This test runs the whole
// real SQL file (every statement, in one transaction like the migrator) against
// rows of fresh, isolated tenants in the pre-0283 shape, and checks every
// other row stays byte-for-byte the same. Fresh tenants (not the shared cafe
// fixture) so parallel test files never see a half-migrated role.
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

const CODE = "crm.customer.identity.unlink";
const BASE = ["menu.item.view", "crm.customer.view"];
const STALE = new Date("2020-01-01T00:00:00.000Z");

function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(drizzleFolder, "0283_identity_unlink_permission_backfill.sql"),
    "utf8",
  );
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Every statement of the file, in one transaction (drizzle's migrator shape). */
async function applyMigration(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    for (const statement of migrationStatements())
      await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createTenant(): Promise<string> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Unlink backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `unlink-backfill-${tenantId}`, randomUUID()],
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
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, false, '["tenant"]'::jsonb, $6)
     RETURNING id`,
    [
      tenantId,
      name,
      templateKey !== null,
      templateKey,
      JSON.stringify(permissions),
      STALE,
    ],
  );
  return rows[0]!.id;
}

async function rowOf(
  roleId: string,
): Promise<{ permissions: string[]; updatedAt: number }> {
  const { rows } = await owner.query<{
    permissions: string[];
    updated_at: Date;
  }>("SELECT permissions, updated_at FROM roles WHERE id = $1", [roleId]);
  return {
    permissions: rows[0]!.permissions,
    updatedAt: rows[0]!.updated_at.getTime(),
  };
}

async function forceRlsOnRoles(): Promise<boolean> {
  const { rows } = await owner.query<{ forced: boolean }>(
    `SELECT c.relforcerowsecurity AS forced FROM pg_class c
     WHERE c.oid = 'public.roles'::regclass`,
  );
  return rows[0]!.forced;
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

describe("legend-c79uy migration 0283 unlink permission backfill on real rows", () => {
  it("is registered in the journal with a timestamp after every older migration", () => {
    const journal = JSON.parse(
      readFileSync(resolve(drizzleFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find((row) => row.idx === 283);
    expect(entry?.tag).toBe("0283_identity_unlink_permission_backfill");
    for (const row of journal.entries.filter((e) => e.idx < 283)) {
      expect(row.when).toBeLessThan(entry!.when);
    }
  });

  it("restores FORCE ROW LEVEL SECURITY on roles after running", async () => {
    expect(await forceRlsOnRoles()).toBe(true);
    await applyMigration();
    expect(await forceRlsOnRoles()).toBe(true);
  });

  it("appends the code (last, order kept) to owner and tenant_admin of every tenant, once, even after two runs", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const ownerA = await insertRole(tenantA, "Owner", "owner", BASE);
    const adminA = await insertRole(tenantA, "Admin", "tenant_admin", BASE);
    const ownerB = await insertRole(tenantB, "Owner", "owner", []);
    const adminB = await insertRole(tenantB, "Admin", "tenant_admin", [
      "crm.customer.pii.read",
    ]);

    await applyMigration();
    await applyMigration();

    expect((await rowOf(ownerA)).permissions).toEqual([...BASE, CODE]);
    expect((await rowOf(adminA)).permissions).toEqual([...BASE, CODE]);
    expect((await rowOf(ownerB)).permissions).toEqual([CODE]);
    expect((await rowOf(adminB)).permissions).toEqual([
      "crm.customer.pii.read",
      CODE,
    ]);
    expect((await rowOf(ownerA)).updatedAt).toBeGreaterThan(STALE.getTime());
    expect((await rowOf(adminB)).updatedAt).toBeGreaterThan(STALE.getTime());
  });

  it("never touches other templates or custom roles (permissions and updated_at unchanged)", async () => {
    const tenantId = await createTenant();
    const untouched: string[] = [];
    for (const key of [
      "general_manager",
      "hr",
      "employee",
      "kitchen_lead",
      "cashier",
    ]) {
      untouched.push(await insertRole(tenantId, key, key, BASE));
    }
    // Custom roles, including ones named like the granted templates or already
    // holding the sensitive PII read code: a tenant grants the code deliberately.
    untouched.push(await insertRole(tenantId, "Owner", null, BASE));
    untouched.push(await insertRole(tenantId, "Tenant Admin", null, BASE));
    untouched.push(
      await insertRole(tenantId, "PII reader", null, [
        ...BASE,
        "crm.customer.pii.read",
      ]),
    );
    const grantedOwner = await insertRole(tenantId, "Owner T", "owner", BASE);
    const before = await Promise.all(untouched.map((id) => rowOf(id)));

    await applyMigration();

    const after = await Promise.all(untouched.map((id) => rowOf(id)));
    expect(after).toEqual(before);
    for (const row of after) expect(row.permissions).not.toContain(CODE);
    expect((await rowOf(grantedOwner)).permissions).toEqual([...BASE, CODE]);
  });

  it("skips a template that already holds the code: no duplicate, updated_at not bumped", async () => {
    const tenantId = await createTenant();
    const stored = [CODE, ...BASE];
    const ownerId = await insertRole(tenantId, "Owner", "owner", stored);
    const adminId = await insertRole(tenantId, "Admin", "tenant_admin", [
      ...BASE,
      CODE,
    ]);

    await applyMigration();

    expect(await rowOf(ownerId)).toEqual({
      permissions: stored,
      updatedAt: STALE.getTime(),
    });
    expect(await rowOf(adminId)).toEqual({
      permissions: [...BASE, CODE],
      updatedAt: STALE.getTime(),
    });
  });

  it("matches the code as an exact element, not a prefix or substring of a longer code", async () => {
    // jsonb @> on arrays compares whole elements. A near-miss code must not
    // make the migration think the real code is already granted.
    const tenantId = await createTenant();
    const near = [
      "crm.customer.identity.unlink.extra",
      "crm.customer.identity",
    ];
    const ownerId = await insertRole(tenantId, "Owner", "owner", near);

    await applyMigration();

    expect((await rowOf(ownerId)).permissions).toEqual([...near, CODE]);
  });
});
