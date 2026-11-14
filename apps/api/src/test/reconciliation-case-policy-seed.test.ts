// PAY recon / PRD §3.7: the approval policy for the `reconciliation_case`
// action exists by default (Owner or Finance, one level with two rows, either
// role is enough, distinct actor) for new tenants (seedTenantRoleTemplates) and
// for old tenants without one (migration 0357).
// A tenant that already has a policy for the action is never touched, and
// re-running either path adds nothing.
//
// Assumption: the schema half of 0357 (DROP/ADD CONSTRAINT, ADD COLUMN) is not
// repeatable by nature (the test database already carries those columns), so
// "safe to repeat" is proved on the policy backfill part of the file: every
// statement that touches roles / approval_policies, including the NO FORCE /
// FORCE RLS brackets.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db";
import { seedTenantRoleTemplates } from "../services/access.service";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];
const ACTION = "reconciliation_case";
const MIGRATION = "0357_reconciliation_case_approval";

type PolicyRow = {
  action_type: string;
  threshold_idr: string | null;
  levels: number;
  requires_distinct_actor: boolean;
  template_key: string | null;
};

function migrationStatements(): string[] {
  return readFileSync(resolve(drizzleFolder, `${MIGRATION}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Statements of 0357 that deal with the policy backfill (repeatable). */
function backfillStatements(): string[] {
  return migrationStatements().filter((statement) =>
    /\b(public\.)?(roles|approval_policies)\b/.test(
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n"),
    ),
  );
}

// One transaction, as drizzle applies a pending migration: a failing INSERT
// rolls back the NO FORCE statements too, so FORCE RLS is never left lifted.
async function applyBackfill(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of backfillStatements()) await client.query(statement);
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
     VALUES ($1, $2, 'Recon policy seed', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `recon-policy-${tenantId}`, randomUUID()],
  );
  return tenantId;
}

async function seedTemplates(tenantId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await seedTenantRoleTemplates(tx, tenantId);
  });
}

async function policiesOf(
  tenantId: string,
  action = ACTION,
): Promise<PolicyRow[]> {
  const { rows } = await owner.query<PolicyRow>(
    `SELECT p.action_type, p.threshold_idr::text, p.levels, p.requires_distinct_actor, r.template_key
       FROM approval_policies p
       JOIN roles r ON r.tenant_id = p.tenant_id AND r.id = p.approver_role_id
      WHERE p.tenant_id = $1 AND p.action_type = $2
      ORDER BY r.template_key`,
    [tenantId, action],
  );
  return rows;
}

/** An old tenant: template roles exist, no reconciliation_case policy. */
async function oldTenant(): Promise<string> {
  const tenantId = await createTenant();
  await seedTemplates(tenantId);
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
    [tenantId, ACTION],
  );
  return tenantId;
}

const OWNER_DEFAULT: PolicyRow = {
  action_type: ACTION,
  threshold_idr: "0",
  levels: 1,
  requires_distinct_actor: true,
  template_key: "owner",
};
const FINANCE_DEFAULT: PolicyRow = {
  ...OWNER_DEFAULT,
  template_key: "finance",
};
// policiesOf orders by template_key: finance, owner.
const BOTH_DEFAULT: PolicyRow[] = [FINANCE_DEFAULT, OWNER_DEFAULT];

afterAll(async () => {
  if (tenantIds.length > 0) {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = ANY($1::uuid[])",
      [tenantIds],
    );
    await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      tenantIds,
    ]);
  }
  await owner.end();
});

describe("reconciliation_case default approval policy", () => {
  it("gives a newly provisioned tenant Owner and Finance level-1 policies that need a distinct actor", async () => {
    const tenantId = await createTenant();
    await seedTemplates(tenantId);
    expect(await policiesOf(tenantId)).toEqual(BOTH_DEFAULT);
  });

  it("does not duplicate or overwrite on a retried provisioning run", async () => {
    const tenantId = await createTenant();
    await seedTemplates(tenantId);
    await seedTemplates(tenantId);
    expect(await policiesOf(tenantId)).toEqual(BOTH_DEFAULT);
  });

  it("provisioning leaves a policy the tenant already has for the action alone", async () => {
    const tenantId = await createTenant();
    await seedTemplates(tenantId);
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
      [tenantId, ACTION],
    );
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       SELECT tenant_id, $2, 5000000, id, 2, true FROM roles
        WHERE tenant_id = $1 AND is_template AND template_key = 'finance'`,
      [tenantId, ACTION],
    );
    await seedTemplates(tenantId);
    const rows = await policiesOf(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template_key: "finance",
      threshold_idr: "5000000",
      levels: 2,
    });
  });

  it("is registered as 0357 in the journal", () => {
    const journal = JSON.parse(
      readFileSync(resolve(drizzleFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find((row) => row.tag === MIGRATION);
    expect(entry?.idx).toBe(357);
  });

  it("lifts and restores FORCE ROW LEVEL SECURITY around the backfill", () => {
    const statements = migrationStatements();
    const text = statements.join("\n");
    expect(text).toMatch(/ALTER TABLE public\.roles NO FORCE/i);
    expect(text).toMatch(/ALTER TABLE public\.approval_policies NO FORCE/i);
    expect(statements.slice(-2).join("\n")).toMatch(
      /approval_policies FORCE ROW LEVEL SECURITY[\s\S]*roles FORCE ROW LEVEL SECURITY/i,
    );
  });

  it("backfills an old tenant without a policy, once", async () => {
    const tenantId = await oldTenant();
    expect(await policiesOf(tenantId)).toHaveLength(0);
    await applyBackfill();
    expect(await policiesOf(tenantId)).toEqual(BOTH_DEFAULT);
    await applyBackfill();
    expect(await policiesOf(tenantId)).toEqual(BOTH_DEFAULT);
  });

  it("never touches a tenant that already has a policy for the action", async () => {
    const tenantId = await oldTenant();
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       SELECT tenant_id, $2, NULL, id, 1, true FROM roles
        WHERE tenant_id = $1 AND is_template AND template_key = 'finance'`,
      [tenantId, ACTION],
    );
    await applyBackfill();
    const rows = await policiesOf(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template_key: "finance",
      threshold_idr: null,
    });
  });

  it("gives a tenant without an Owner template role the Finance row only", async () => {
    const tenantId = await oldTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND approver_role_id IN (SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner')",
      [tenantId],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
      [tenantId],
    );
    await applyBackfill();
    expect(await policiesOf(tenantId)).toEqual([FINANCE_DEFAULT]);
  });

  it("gives a tenant without a Finance template role the Owner row only", async () => {
    const tenantId = await oldTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND approver_role_id IN (SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance')",
      [tenantId],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
      [tenantId],
    );
    await applyBackfill();
    expect(await policiesOf(tenantId)).toEqual([OWNER_DEFAULT]);
  });

  it("adds nothing for a tenant with neither template role", async () => {
    const tenantId = await oldTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND approver_role_id IN (SELECT id FROM roles WHERE tenant_id = $1 AND template_key IN ('owner', 'finance'))",
      [tenantId],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND template_key IN ('owner', 'finance')",
      [tenantId],
    );
    await applyBackfill();
    expect(await policiesOf(tenantId)).toHaveLength(0);
  });
});
