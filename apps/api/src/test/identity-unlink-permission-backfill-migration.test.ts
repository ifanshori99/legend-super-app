// legend-xhlbz: data migration 0283 appends `crm.customer.identity.unlink` to
// the stored owner and tenant_admin templates of tenants that existed before
// the code did. The resolver reads the stored rows, so a catalog-only change
// left old tenants without it. Custom roles are never touched, even when they
// hold `crm.customer.pii.read`. The role statements run as the migration owner,
// twice (idempotent), like the 0172 data test. Every template row is restored
// in afterAll so other tests see the seeded permissions.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const NEW_CODE = "crm.customer.identity.unlink";
const PII_READ = "crm.customer.pii.read";
const GRANTED_TEMPLATES = ["owner", "tenant_admin"];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0283_identity_unlink_permission_backfill.sql",
  ),
  "utf8",
);

type TemplateRow = { id: string; permissions: string[]; updated_at: Date };
let originals: TemplateRow[] = [];
const createdRoles: string[] = [];

beforeAll(async () => {
  originals = (
    await owner.query<TemplateRow>(
      "SELECT id, permissions, updated_at FROM roles WHERE tenant_id = $1 AND is_template",
      [tenantId],
    )
  ).rows;
});

afterAll(async () => {
  for (const row of originals) {
    await owner.query(
      "UPDATE roles SET permissions = $3::jsonb, updated_at = $4 WHERE tenant_id = $1 AND id = $2",
      [tenantId, row.id, JSON.stringify(row.permissions), row.updated_at],
    );
  }
  if (createdRoles.length > 0) {
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoles],
    );
  }
  await owner.end();
});

/** Runs only the role statements of the migration. */
const migrate = async () => {
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.replace(/--.*$/gm, "").trim();
    if (sql && /\broles\b/.test(sql)) await owner.query(statement);
  }
};

async function customRole(permissions: string[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["outlet"]'::jsonb)`,
    [id, tenantId, `Backfill ${unique()}`, JSON.stringify(permissions)],
  );
  createdRoles.push(id);
  return id;
}

const permissionsOf = async (id: string): Promise<string[]> =>
  (
    await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!.permissions;

/** Strips the new code from a stored template, as a pre-0283 tenant has it. */
async function legacyTemplate(key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `UPDATE roles SET permissions = permissions - '${NEW_CODE}'
     WHERE tenant_id = $1 AND is_template AND template_key = $2 RETURNING id`,
    [tenantId, key],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

describe("legend-xhlbz identity.unlink backfill migration", () => {
  it("adds the code to the owner and tenant_admin templates, twice over, once", async () => {
    const ids = [];
    for (const key of GRANTED_TEMPLATES) ids.push(await legacyTemplate(key));
    for (const id of ids)
      expect(await permissionsOf(id)).not.toContain(NEW_CODE);

    await migrate();
    await migrate();

    for (const id of ids) {
      const permissions = await permissionsOf(id);
      expect(permissions.filter((code) => code === NEW_CODE)).toHaveLength(1);
    }
  });

  it("leaves a custom role untouched, even one holding crm.customer.pii.read", async () => {
    const holder = await customRole(["crm.customer.view", PII_READ]);
    const viewer = await customRole(["crm.customer.view"]);

    await migrate();

    expect(await permissionsOf(holder)).toEqual([
      "crm.customer.view",
      PII_READ,
    ]);
    expect(await permissionsOf(viewer)).toEqual(["crm.customer.view"]);
  });

  it("does not grant the code to any other template", async () => {
    const { rows: others } = await owner.query<{ id: string }>(
      `SELECT id FROM roles
       WHERE tenant_id = $1 AND is_template AND template_key <> ALL($2::text[])`,
      [tenantId, GRANTED_TEMPLATES],
    );
    expect(others.length).toBeGreaterThan(0);
    const before = new Map<string, string[]>();
    for (const { id } of others) {
      await owner.query(
        `UPDATE roles SET permissions = permissions - '${NEW_CODE}' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      before.set(id, await permissionsOf(id));
    }

    await migrate();

    for (const [id, permissions] of before) {
      expect(await permissionsOf(id)).toEqual(permissions);
    }
  });

  it("does not duplicate the code on a template that already holds it", async () => {
    const adminId = await legacyTemplate("tenant_admin");
    const stored = [NEW_CODE, "crm.customer.view", PII_READ];
    await owner.query(
      "UPDATE roles SET permissions = $3::jsonb WHERE tenant_id = $1 AND id = $2",
      [tenantId, adminId, JSON.stringify(stored)],
    );

    await migrate();
    await migrate();

    expect(await permissionsOf(adminId)).toEqual(stored);
  });
});
