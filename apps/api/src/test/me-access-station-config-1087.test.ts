// legend-huz8 (1087): GET /api/me/access gains `canManageStationConfig`
// (boolean, default false). It is true only when the caller may rename, retype
// or delete a station, which is exactly when the caller holds menu.item.manage
// at outlet or tenant scope. A grant of menu.item.manage at station scope only
// (legend-cot3) gives false, so the web UI can hide the name/type fields and
// the Delete button. Expected behaviour comes from the brief and bead; the
// consistency checks tie the flag to what PATCH/DELETE /api/menu/stations/:id
// actually allow (PERMISSION_DENIED 403 for station-only grants, legend-cot3).
// Everything runs through HTTP against the real Express app, Better Auth, RBAC
// and PostgreSQL.
//
// Assumptions:
//  - The flag is a property of the caller's grants, not of one outlet: an outlet
//    A manager has true even when asked about outlet B stations; the PATCH/DELETE
//    of a station outside the grant is refused separately (403 or 404).
//  - Brand-scope grants are not covered (the brief names outlet and tenant).
//  - Cross-tenant: the flag reflects the caller's own tenant grants; a manager
//    of another tenant cannot change this tenant's station and vice versa
//    (403 or 404, row unchanged).
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures, tenantIdSchema } from "@starter/shared/core";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

async function asOwnerTenant<T>(
  tenantOfRows: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantOfRows],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];
let tenantB: SecondTenant | null = null;
let tenantBStation: string;
let tenantBHost: string;

async function createStation(
  outletId: string,
  tenantOfRow = tenantId,
): Promise<string> {
  const result = await asOwnerTenant(tenantOfRow, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
      [tenantOfRow, outletId, `Uji ${randomUUID().slice(0, 8)}`],
    ),
  );
  const id = result.rows[0].id;
  createdStationIds.push(id);
  return id;
}

async function customRole(
  permissions: readonly string[],
  tenantOfRole = tenantId,
): Promise<string> {
  const roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantOfRole,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "brand", "outlet", "station"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

type Holder = { client: ReturnType<typeof agent>; userId: string };

/** Signed-in client holding the given roles, each at one scope. */
async function holder(
  grants: Array<{
    roleId: string;
    scope: { type: "tenant" | "outlet" | "station"; id: string | null };
    tenantOfGrant?: string;
  }>,
  host?: string,
): Promise<Holder> {
  const client = agent(app);
  await signUp(client, "Station Config User");
  // Without a Host the dev fallback resolves tenant A; tenant B callers need
  // their tenant's own domain to reach tenant B's grants.
  if (host) client.set("Host", host);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const grant of grants)
    await ownerPool.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        grant.tenantOfGrant ?? tenantId,
        userId,
        grant.roleId,
        grant.scope.type,
        grant.scope.id,
      ],
    );
  return { client, userId };
}

async function stationRow(id: string, tenantOfRow = tenantId) {
  const { rows } = await asOwnerTenant(tenantOfRow, (client) =>
    client.query<{ name: string; deleted_at: Date | null }>(
      "SELECT name, deleted_at FROM stations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

const canManage = async (who: Holder) => {
  const response = await who.client.get("/api/me/access");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.canManageStationConfig as unknown;
};

const rename = (who: Holder, stationId: string, name: string) =>
  who.client
    .patch(`/api/menu/stations/${stationId}`)
    .set(originHeader)
    .send({ name });

const remove = (who: Holder, stationId: string) =>
  who.client.delete(`/api/menu/stations/${stationId}`).set(originHeader).send();

let stationA1: string;
let stationA2: string;
let stationOfOutletB: string;
let manageRole: string;
let viewRole: string;
let stationOnly: Holder;
let stationOnlyPlusView: Holder;
let outletManager: Holder;
let tenantManager: Holder;
let viewOnly: Holder;
let noGrant: Holder;
let tenantBManager: Holder;
let tenantBStationOnly: Holder;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  stationA1 = await createStation(outletA);
  stationA2 = await createStation(outletA);
  stationOfOutletB = await createStation(outletB);
  manageRole = await customRole(["menu.item.view", "menu.item.manage"]);
  viewRole = await customRole(["menu.item.view"]);
  stationOnly = await holder([
    { roleId: manageRole, scope: { type: "station", id: stationA1 } },
  ]);
  stationOnlyPlusView = await holder([
    { roleId: manageRole, scope: { type: "station", id: stationA1 } },
    { roleId: viewRole, scope: { type: "outlet", id: outletA } },
  ]);
  outletManager = await holder([
    { roleId: manageRole, scope: { type: "outlet", id: outletA } },
  ]);
  tenantManager = await holder([
    { roleId: manageRole, scope: { type: "tenant", id: null } },
  ]);
  viewOnly = await holder([
    { roleId: viewRole, scope: { type: "outlet", id: outletA } },
  ]);
  noGrant = await holder([]);

  tenantB = await createSecondTenant(ownerPool, "stationcfg");
  tenantBHost = `stationcfg-${tenantB.tenantId.slice(0, 8)}.example.test`;
  await ownerPool.query(
    `INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, 'custom', 'active', now())`,
    [tenantB.tenantId, tenantB.brandId, tenantBHost],
  );
  tenantBStation = await createStation(
    tenantB.outletId,
    tenantIdSchema.parse(tenantB.tenantId),
  );
  const roleB = await customRole(
    ["menu.item.view", "menu.item.manage"],
    tenantIdSchema.parse(tenantB.tenantId),
  );
  tenantBManager = await holder(
    [
      {
        roleId: roleB,
        scope: { type: "outlet", id: tenantB.outletId },
        tenantOfGrant: tenantB.tenantId,
      },
    ],
    tenantBHost,
  );
  tenantBStationOnly = await holder(
    [
      {
        roleId: roleB,
        scope: { type: "station", id: tenantBStation },
        tenantOfGrant: tenantB.tenantId,
      },
    ],
    tenantBHost,
  );
}, 120_000);

afterAll(async () => {
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await ownerPool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  if (createdStationIds.length > 0)
    await ownerPool.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
      createdStationIds,
    ]);
  if (tenantB) {
    await ownerPool.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
  }
  if (tenantB) await removeSecondTenant(ownerPool, tenantB);
  await ownerPool.end();
});

describe("[legend-huz8] GET /api/me/access canManageStationConfig", () => {
  it("is false for a grant of menu.item.manage at station scope only", async () => {
    expect(await canManage(stationOnly)).toBe(false);
  });

  it("is true for menu.item.manage at outlet scope", async () => {
    expect(await canManage(outletManager)).toBe(true);
  });

  it("is true for menu.item.manage at tenant scope", async () => {
    expect(await canManage(tenantManager)).toBe(true);
  });

  it("is false for a view-only outlet grant", async () => {
    expect(await canManage(viewOnly)).toBe(false);
  });

  it("is false for an account without any grant", async () => {
    expect(await canManage(noGrant)).toBe(false);
  });

  it("stays false when station-scope manage is combined with an outlet-scope view-only grant", async () => {
    expect(await canManage(stationOnlyPlusView)).toBe(false);
  });
});

describe("[legend-huz8] the flag matches what the server allows on a station", () => {
  it("station-only grant: flag false, and rename and delete answer 403 PERMISSION_DENIED", async () => {
    expect(await canManage(stationOnly)).toBe(false);
    const before = await stationRow(stationA1);
    const patch = await rename(stationOnly, stationA1, "Nama Baru Stasiun");
    expect(patch.status).toBe(403);
    expect(patch.body.error?.code).toBe("PERMISSION_DENIED");
    const del = await remove(stationOnly, stationA1);
    expect(del.status).toBe(403);
    expect(del.body.error?.code).toBe("PERMISSION_DENIED");
    const after = await stationRow(stationA1);
    expect(after.name).toBe(before.name);
    expect(after.deleted_at).toBeNull();
  });

  it("outlet grant: flag true, and rename of a station of that outlet works", async () => {
    expect(await canManage(outletManager)).toBe(true);
    const name = `Diganti ${randomUUID().slice(0, 6)}`;
    const patch = await rename(outletManager, stationA2, name);
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await stationRow(stationA2)).name).toBe(name);
  });
});

describe("[legend-huz8] cross-outlet", () => {
  it("an outlet A manager has the flag true but cannot rename or delete a station of outlet B", async () => {
    expect(await canManage(outletManager)).toBe(true);
    const before = await stationRow(stationOfOutletB);
    const patch = await rename(
      outletManager,
      stationOfOutletB,
      "Lintas Outlet",
    );
    expect([403, 404], JSON.stringify(patch.body)).toContain(patch.status);
    const del = await remove(outletManager, stationOfOutletB);
    expect([403, 404], JSON.stringify(del.body)).toContain(del.status);
    const after = await stationRow(stationOfOutletB);
    expect(after.name).toBe(before.name);
    expect(after.deleted_at).toBeNull();
  });
});

describe("[legend-huz8] cross-tenant", () => {
  it("each tenant's flag follows its own grants (outlet manager true, station-only false)", async () => {
    expect(await canManage(tenantBManager)).toBe(true);
    expect(await canManage(tenantBStationOnly)).toBe(false);
  });

  it("a manager of another tenant cannot rename or delete this tenant's station", async () => {
    const before = await stationRow(stationA1);
    const patch = await rename(tenantBManager, stationA1, "Lintas Tenant");
    expect([403, 404], JSON.stringify(patch.body)).toContain(patch.status);
    const del = await remove(tenantBManager, stationA1);
    expect([403, 404], JSON.stringify(del.body)).toContain(del.status);
    const after = await stationRow(stationA1);
    expect(after.name).toBe(before.name);
    expect(after.deleted_at).toBeNull();
  });

  it("a manager of this tenant cannot rename or delete another tenant's station", async () => {
    const before = await stationRow(
      tenantBStation,
      tenantIdSchema.parse(tenantB!.tenantId),
    );
    const patch = await rename(outletManager, tenantBStation, "Lintas Tenant");
    expect([403, 404], JSON.stringify(patch.body)).toContain(patch.status);
    const del = await remove(outletManager, tenantBStation);
    expect([403, 404], JSON.stringify(del.body)).toContain(del.status);
    const after = await stationRow(
      tenantBStation,
      tenantIdSchema.parse(tenantB!.tenantId),
    );
    expect(after.name).toBe(before.name);
    expect(after.deleted_at).toBeNull();
  });
});
