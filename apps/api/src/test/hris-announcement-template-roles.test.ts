// HRIS announcements over HTTP with the REAL role templates (not synthetic
// custom roles): bead legend-qi21, PRD v1.7 §3 F32, TEN-01/03.
//
// Permission lists come from `roleTemplate(...)` in the shared package, so a
// template that loses (or wrongly gains) `hr.announcement.manage` fails here.
// Assumptions: a cross-tenant receipts read answers 403 or 404 (the spec says
// only "not visible"); the stored template rows of the fixture tenant carry
// the permission as the 0171 backfill intends.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import { roleTemplate, type RoleTemplateKey } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const otherTenant = randomUUID();
const run = randomUUID().slice(0, 8);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

async function asOwner<T>(
  tenant: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantRole(
  userId: string,
  permissions: readonly string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Ann tpl ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

/** A signed-in user holding exactly the permissions of a real role template. */
async function signedInAs(
  template: RoleTemplateKey,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
) {
  const client = agent(app);
  await signUp(client, `Tpl ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await grantRole(userId, roleTemplate(template).permissions, scope, tenant);
  return client;
}

const body = (overrides: Record<string, unknown> = {}) => ({
  title: `Template ${run}`,
  body: "Rapat staf Senin pukul 09.00.",
  audience: { kind: "all" },
  requiresReceipt: true,
  expiresAt: null,
  ...overrides,
});

type Client = ReturnType<typeof agent>;
async function publish(client: Client) {
  const response = await client
    .post("/api/hris/announcements")
    .set(originHeader)
    .send(body());
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.id as string;
}

let ownerHttp: Client;
let managerOtherTenant: Client;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Announcement template-role tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `ann-tpl-${otherTenant.slice(0, 8)}`, tenantId],
  );
  ownerHttp = await signedInAs("owner", { type: "tenant" });
  managerOtherTenant = await signedInAs("hr", { type: "tenant" }, otherTenant);
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM announcement_receipts WHERE announcement_id IN
       (SELECT id FROM announcements WHERE published_by = ANY($1))`,
    [createdUsers],
  );
  await owner.query(
    `DELETE FROM hris_announcement_outlets WHERE announcement_id IN
       (SELECT id FROM announcements WHERE published_by = ANY($1))`,
    [createdUsers],
  );
  await owner.query("DELETE FROM announcements WHERE published_by = ANY($1)", [
    createdUsers,
  ]);
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

describe("[qi21] announcements with real role templates", () => {
  it("the catalog gives hr.announcement.manage to owner, general_manager and hr only (not kitchen_lead, outlet_manager, tenant_admin)", () => {
    const holds = (key: RoleTemplateKey) =>
      (roleTemplate(key).permissions as readonly string[]).includes(
        "hr.announcement.manage",
      );
    expect(holds("owner")).toBe(true);
    expect(holds("general_manager")).toBe(true);
    expect(holds("hr")).toBe(true);
    expect(holds("kitchen_lead")).toBe(false);
    expect(holds("outlet_manager")).toBe(false);
    expect(holds("tenant_admin")).toBe(false);
  });

  it("stored template rows (0171 backfill) carry the permission for owner, general_manager and hr, not kitchen_lead", async () => {
    const rows = await asOwner(tenantId, async (client) => {
      const result = await client.query(
        `SELECT template_key, permissions FROM roles
          WHERE tenant_id = $1 AND is_template
            AND template_key IN ('owner','general_manager','hr','kitchen_lead','outlet_manager','tenant_admin')`,
        [tenantId],
      );
      return result.rows as {
        template_key: string;
        permissions: string[];
      }[];
    });
    for (const row of rows) {
      const has = row.permissions.includes("hr.announcement.manage");
      expect(has, row.template_key).toBe(
        ["owner", "general_manager", "hr"].includes(row.template_key),
      );
    }
  });

  it.each([
    ["owner", { type: "tenant" }],
    ["general_manager", { type: "tenant" }],
    ["hr", { type: "tenant" }],
  ] as const)(
    "%s can publish an announcement and read its receipts",
    async (template, scope) => {
      const client = await signedInAs(template, scope);
      const id = await publish(client);
      const receipts = await client.get(
        `/api/hris/announcements/${id}/receipts`,
      );
      expect(receipts.status, JSON.stringify(receipts.body)).toBe(200);
      expect(receipts.body.meta.summary).toBeDefined();
    },
  );

  it("outlet_manager is refused on publish and on receipts (403)", async () => {
    const id = await publish(ownerHttp);
    const client = await signedInAs("outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    const create = await client
      .post("/api/hris/announcements")
      .set(originHeader)
      .send(body({ audience: { kind: "outlets", outletIds: [outletA] } }));
    expect(create.status).toBe(403);
    const receipts = await client.get(`/api/hris/announcements/${id}/receipts`);
    expect(receipts.status).toBe(403);
  });

  it("tenant_admin is refused on publish and on receipts (403)", async () => {
    const id = await publish(ownerHttp);
    const client = await signedInAs("tenant_admin", { type: "tenant" });
    const create = await client
      .post("/api/hris/announcements")
      .set(originHeader)
      .send(body());
    expect(create.status).toBe(403);
    const receipts = await client.get(`/api/hris/announcements/${id}/receipts`);
    expect(receipts.status).toBe(403);
  });

  it("kitchen_lead is refused on publish and on receipts (403)", async () => {
    const id = await publish(ownerHttp);
    const client = await signedInAs("kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const create = await client
      .post("/api/hris/announcements")
      .set(originHeader)
      .send(body({ audience: { kind: "outlets", outletIds: [outletA] } }));
    expect(create.status).toBe(403);
    const receipts = await client.get(`/api/hris/announcements/${id}/receipts`);
    expect(receipts.status).toBe(403);
  });

  it("a manager of another tenant cannot read this tenant's receipts", async () => {
    const id = await publish(ownerHttp);
    const response = await managerOtherTenant.get(
      `/api/hris/announcements/${id}/receipts`,
    );
    // Not visible: 404 (no existence leak) or 403; never 200 and no data.
    expect([403, 404]).toContain(response.status);
    expect(response.body.data ?? []).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(`Template ${run}`);
  });
});
