// TEN-03: role and approval data must remain inside the resolved tenant.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const roleB = randomUUID();
const assignmentB = randomUUID();
const policyB = randomUUID();
const person = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});
const app = new Pool({ connectionString: process.env.APP_DATABASE_URL });

describe("TEN-03 access storage tenant isolation", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Access test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [tenantB, `access-${tenantB}`, person],
    );
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Access tester', $2)`,
      [person, `${person}@example.test`],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Test role', '["org.view"]', '["tenant"]')`,
      [roleB, tenantB],
    );
    await owner.query(
      `INSERT INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, assigned_by)
       VALUES ($1, $2, $3, $4, 'tenant', $3)`,
      [assignmentB, tenantB, person, roleB],
    );
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, approver_role_id, levels)
       VALUES ($1, $2, 'void', $3, 1)`,
      [policyB, tenantB, roleB],
    );
  });
  afterAll(async () => {
    await owner.query("DELETE FROM approval_policies WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await owner.query('DELETE FROM "user" WHERE id = $1', [person]);
    await owner.end();
    await app.end();
  });

  for (const [table, id] of [
    ["roles", roleB],
    ["role_assignments", assignmentB],
    ["approval_policies", policyB],
  ] as const) {
    it(`TEN-03 denies tenant A reading or deleting tenant B ${table}`, async () => {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_app");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantA],
        );
        expect(
          (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [id]))
            .rowCount,
        ).toBe(0);
        expect(
          (await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]))
            .rowCount,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  }

  it("TEN-03 rejects cross-tenant role references even for a privileged writer", async () => {
    await expect(
      owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, assigned_by)
       VALUES ($1, $2, $3, 'tenant', $2)`,
        [tenantA, person, roleB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, approver_role_id, levels)
       VALUES ($1, 'void', $2, 1)`,
        [tenantA, roleB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("TEN-03 refuses malformed time windows, scopes, and non-distinct approval", async () => {
    await expect(
      owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, assigned_by)
       VALUES ($1, $2, $3, 'tenant', $4, $2)`,
        [tenantB, person, roleB, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, assigned_by, valid_from, valid_until)
       VALUES ($1, $2, $3, 'tenant', $2, now(), now() - interval '1 second')`,
        [tenantB, person, roleB],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'refund', $2, 1, false)`,
        [tenantB, roleB],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
