// Modifier read scope (bead legend-dak5). Modifier groups and modifiers are
// tenant-shared, so a tenant, brand or outlet reader keeps reading them, but a
// station-only (or no) grant must be refused at the service boundary: the flat
// permission union alone must not decide. Real app, Better Auth, PostgreSQL.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { agent, signUp } from "./helpers";
import { listModifierGroups, listModifiers } from "../services/menu.service";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];
const createdGroupIds: string[] = [];

type ScopeType = "tenant" | "brand" | "outlet" | "station";

async function customRole(permissions: readonly string[]): Promise<string> {
  const roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "brand", "outlet", "station"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

async function roleClient(
  roleId: string,
  scope: { type: ScopeType; id: string | null },
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Modifier Scope User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

const tenantContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

let groupId: string;
let stationA: string;
let t: Awaited<ReturnType<typeof roleClient>>;
let b: Awaited<ReturnType<typeof roleClient>>;
let o: Awaited<ReturnType<typeof roleClient>>;
let s: Awaited<ReturnType<typeof roleClient>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const owner = await ownerPool.connect();
  try {
    await owner.query("BEGIN");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    stationA = (
      await owner.query<{ id: string }>(
        `INSERT INTO stations (tenant_id, outlet_id, name, type)
         VALUES ($1, $2, $3, 'coffee_bar') RETURNING id`,
        [tenantId, outletA, `Uji ${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id;
    createdStationIds.push(stationA);
    groupId = (
      await owner.query<{ id: string }>(
        `INSERT INTO modifier_groups (tenant_id, name)
         VALUES ($1, $2) RETURNING id`,
        [tenantId, `Uji ${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id;
    createdGroupIds.push(groupId);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  } finally {
    owner.release();
  }
  const roleId = await customRole(["menu.item.view"]);
  t = await roleClient(roleId, { type: "tenant", id: null });
  b = await roleClient(roleId, { type: "brand", id: brand.id });
  o = await roleClient(roleId, { type: "outlet", id: outletA });
  s = await roleClient(roleId, { type: "station", id: stationA });
});

afterAll(async () => {
  const owner = await ownerPool.connect();
  try {
    await owner.query("BEGIN");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    if (createdGroupIds.length > 0)
      await owner.query(
        "DELETE FROM modifier_groups WHERE id = ANY($1::uuid[])",
        [createdGroupIds],
      );
    if (createdStationIds.length > 0)
      await owner.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]);
    await owner.query("COMMIT");
  } finally {
    owner.release();
  }
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await ownerPool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  await ownerPool.end();
});

describe("legend-dak5 modifier reads are tenant-shared, not station-readable", () => {
  it("legend-dak5 tenant, brand and outlet readers list groups and modifiers (positive control)", async () => {
    for (const user of [t, b, o]) {
      const groups = await listModifierGroups(tenantContext(), user.userId, {
        limit: 100,
      });
      expect(groups.data.map((row) => row.id)).toContain(groupId);
      const mods = await listModifiers(tenantContext(), user.userId, groupId, {
        limit: 100,
      });
      expect(mods.data).toEqual([]);
    }
  });

  it("legend-dak5 a station-only grant is denied at the service boundary", async () => {
    await expect(
      listModifierGroups(tenantContext(), s.userId, { limit: 100 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      listModifiers(tenantContext(), s.userId, groupId, { limit: 100 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("legend-dak5 routes: outlet user gets 200, station-only gets 403", async () => {
    const groupsPath = "/api/menu/modifier-groups?limit=10";
    const modsPath = `/api/menu/modifier-groups/${groupId}/modifiers?limit=10`;
    for (const path of [groupsPath, modsPath]) {
      expect((await o.client.get(path)).status).toBe(200);
      const denied = await s.client.get(path);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
});
