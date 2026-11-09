// Supplier reads are tenant-level data. The access snapshot is a flat union
// over every scope, so a supplier-read permission held only at a station must
// not pass just because the same user holds some other permission at an outlet
// (bead legend-dak5). Real app, Better Auth, PostgreSQL and RLS. Every denial
// has a positive control first.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  createSupplier,
  getSupplierDetail,
  listSuppliers,
} from "../services/purchasing-supplier.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];
const createdSupplierIds: string[] = [];

const tenantContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
const outletContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletA) as OutletId] },
  );

async function customRole(permissions: readonly string[]): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
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

async function createStation(): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
      [tenantId, outletA, `Uji ${randomUUID().slice(0, 8)}`],
    );
    await client.query("COMMIT");
    createdStationIds.push(result.rows[0]!.id);
    return result.rows[0]!.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Scope = { type: "tenant" | "outlet" | "station"; id: string | null };

/** Signed-in user holding each given role at its scope. */
async function userWith(
  grants: readonly { roleId: string; scope: Scope }[],
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Supplier Scope User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const { roleId, scope } of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId, scope.type, scope.id],
    );
  return { client, userId };
}

let supplierId: string;
let stationOnly: Awaited<ReturnType<typeof userWith>>;
let stationPlusOutlet: Awaited<ReturnType<typeof userWith>>;
let outletHolder: Awaited<ReturnType<typeof userWith>>;
let tenantHolder: Awaited<ReturnType<typeof userWith>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const station = await createStation();
  const readRole = await customRole(["purchasing.request.create"]);
  const otherRole = await customRole(["order.view"]);
  const manageRole = await customRole(["purchasing.supplier.manage"]);

  tenantHolder = await userWith([
    { roleId: manageRole, scope: { type: "tenant", id: null } },
  ]);
  outletHolder = await userWith([
    { roleId: readRole, scope: { type: "outlet", id: outletA } },
  ]);
  stationOnly = await userWith([
    { roleId: readRole, scope: { type: "station", id: station } },
  ]);
  // The leak: supplier read only at a station, plus any other permission at an
  // outlet, so the request context reaches the outlet.
  stationPlusOutlet = await userWith([
    { roleId: readRole, scope: { type: "station", id: station } },
    { roleId: otherRole, scope: { type: "outlet", id: outletA } },
  ]);

  const created = await createSupplier(tenantContext(), tenantHolder.userId, {
    name: `Scope ${randomUUID().slice(0, 8)}`,
    paymentTermsDays: 14,
    idempotencyKey: `sup-${randomUUID()}`,
  } as Parameters<typeof createSupplier>[2]);
  supplierId = created.id;
  createdSupplierIds.push(supplierId);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE 'supplier.%'",
    [tenantId],
  );
  if (createdSupplierIds.length > 0)
    await owner.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
      createdSupplierIds,
    ]);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  if (createdStationIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
  await owner.end();
});

describe("legend-dak5 supplier reads, service level", () => {
  it("legend-dak5 the outlet-scoped holder lists and reads a supplier (positive control)", async () => {
    const list = await listSuppliers(outletContext(), outletHolder.userId, {
      limit: 100,
    });
    expect(list.data.map((row) => row.id)).toContain(supplierId);
    const detail = await getSupplierDetail(
      outletContext(),
      outletHolder.userId,
      supplierId,
    );
    expect(detail.supplier.id).toBe(supplierId);
  });

  it("legend-dak5 the tenant holder lists and reads a supplier (positive control)", async () => {
    const list = await listSuppliers(tenantContext(), tenantHolder.userId, {
      limit: 100,
    });
    expect(list.data.map((row) => row.id)).toContain(supplierId);
    const detail = await getSupplierDetail(
      tenantContext(),
      tenantHolder.userId,
      supplierId,
    );
    expect(detail.supplier.id).toBe(supplierId);
  });

  it("legend-dak5 a station-only supplier-read holder is denied the list and the detail", async () => {
    await expect(
      listSuppliers(outletContext(), stationOnly.userId, { limit: 100 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      getSupplierDetail(outletContext(), stationOnly.userId, supplierId),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("legend-dak5 a station supplier-read holder with another outlet permission is denied", async () => {
    await expect(
      listSuppliers(outletContext(), stationPlusOutlet.userId, { limit: 100 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      getSupplierDetail(outletContext(), stationPlusOutlet.userId, supplierId),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("legend-dak5 supplier reads, routes", () => {
  it("legend-dak5 the outlet holder gets 200 on the list (positive control)", async () => {
    const response = await outletHolder.client
      .get("/api/inventory/suppliers?limit=100")
      .set(originHeader);
    expect(response.status).toBe(200);
  });

  it("legend-dak5 the station-only holder gets 403 on the list", async () => {
    const response = await stationOnly.client
      .get("/api/inventory/suppliers?limit=100")
      .set(originHeader);
    expect(response.status).toBe(403);
  });
});
