// Inventory setup write tests (PRD v1.7 §16 "Lokasi Stok", "Item Bahan &
// Satuan", "Par Level & Saran Pembelian", "Pemotongan Otomatis"; bead
// legend-gjmk). Needs the disposable PostgreSQL database; the migration owner
// seeds fixtures, the restricted legend_app login checks RLS, and the services
// run as an owner-role user. The HTTP block needs `createInventorySetupRouter`
// mounted at /api/inventory in routes/index.ts (lead wiring).
//
// Acceptance ids used in test names:
// - SETUP-01 locations (outlet scope, type, unique name, idempotency)
// - SETUP-02 UOM conversions and alternates (cycles, duplicates, replay)
// - SETUP-03 par levels (range, one per location+item, outlet scope)
// - SETUP-04 tenant inventory settings (bounds, concurrency, audit)
// - TEN-01/TEN-03 isolation across tenants and outlets
import type { UomId } from "@starter/shared/inventory";
import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CoreError,
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
  conversionLinksConnectedUnits,
  createInventoryItemAlternate,
  createParLevel,
  createStockLocation,
  createUomConversion,
  deleteInventoryItemAlternate,
  deleteParLevel,
  deleteUomConversion,
  listParLevels,
  registerConversionReferenceCheck,
  updateParLevel,
  updateStockLocation,
} from "../services/inventory-setup.service.ts";
import {
  getInventorySettings,
  updateInventorySettings,
} from "../services/inventory-settings.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();

const createdUserIds: string[] = [];
const createdLocationIds: string[] = [];
const createdItemIds: string[] = [];
const createdUomIds: string[] = [];

function tenantContext(
  tenantId = tenantA,
  outletIds: readonly string[] | null = null,
): ScopedTenantContext {
  const reach = outletIds?.map((id) => outletIdSchema.parse(id) as OutletId);
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    reach === null || reach === undefined
      ? { kind: "tenant" }
      : { kind: "outlets", outletIds: reach },
  );
}

async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function rejectsWithCode(
  run: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
}

async function rejectsWithStatus(
  run: Promise<unknown>,
  status: number,
): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect((error as { status?: number } | null)?.status).toBe(status);
}

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  createdUomIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertItem(baseUomId: string, name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `${name} ${randomUUID().slice(0, 6)}`, baseUomId],
  );
  createdItemIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertLocation(outletId: string, name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletId, `${name} ${randomUUID().slice(0, 6)}`],
  );
  createdLocationIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function assignRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

/** A tenant custom role holding exactly these codes, assigned tenant-wide. */
async function assignCustomRole(
  userId: string,
  permissions: string[],
): Promise<void> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, $3::jsonb, false, '["tenant"]'::jsonb) RETURNING id`,
    [tenantA, `Custom ${randomUUID()}`, JSON.stringify(permissions)],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, userId, rows[0]!.id],
  );
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

let ownerUserId: string;
let uomKg: UomId;
let uomG: UomId;
let uomPack: UomId;
let uomPcs: UomId;
let itemA: string;
let itemB: string;
let locationA1: string;
let locationOutletB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Inventory Setup Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `inv-setup-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  uomKg = (await insertUom("kg")) as UomId;
  uomG = (await insertUom("g")) as UomId;
  uomPack = (await insertUom("pk")) as UomId;
  uomPcs = (await insertUom("pc")) as UomId;
  itemA = await insertItem(uomKg, "Gula Setup");
  itemB = await insertItem(uomKg, "Gula Aren Setup");
  locationA1 = await insertLocation(outletA, "Gudang Setup");
  locationOutletB = await insertLocation(outletB, "Gudang Setup B");

  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Inventory Setup Owner", `${ownerUserId}@example.com`],
  );
  await assignRole(ownerUserId, "owner", { type: "tenant" });
});

afterAll(async () => {
  await owner.query("DELETE FROM par_levels WHERE tenant_id = $1", [tenantA]);
  await owner.query(
    "DELETE FROM inventory_item_alternates WHERE tenant_id = $1",
    [tenantA],
  );
  await owner.query(
    "DELETE FROM uom_conversions WHERE inventory_item_id = ANY($1::uuid[])",
    [createdItemIds],
  );
  await owner.query("DELETE FROM inventory_settings WHERE tenant_id = $1", [
    tenantA,
  ]);
  await owner.query(
    "DELETE FROM inventory_setup_idempotency WHERE tenant_id = $1",
    [tenantA],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantA, [...createdUserIds, ownerUserId]],
  );
  await owner.query(
    "DELETE FROM stock_locations WHERE tenant_id = $1 AND (id = ANY($2::uuid[]) OR name LIKE 'Lokasi Setup %')",
    [tenantA, createdLocationIds],
  );
  await owner.query("DELETE FROM inventory_items WHERE id = ANY($1::uuid[])", [
    createdItemIds,
  ]);
  await owner.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
    createdUomIds,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("SETUP-01 stock locations", () => {
  it("SETUP-01 creates a location, replays the same key and rejects a reused key", async () => {
    const input = {
      outletId: outletA,
      name: `Lokasi Setup ${randomUUID().slice(0, 6)}`,
      type: "chiller" as const,
      idempotencyKey: `loc-${randomUUID()}`,
    };
    const first = await createStockLocation(
      tenantContext(),
      ownerUserId,
      input,
    );
    expect(first).toMatchObject({
      outletId: outletA,
      type: "chiller",
      isActive: true,
    });
    const replay = await createStockLocation(
      tenantContext(),
      ownerUserId,
      input,
    );
    expect(replay.id).toBe(first.id);
    await rejectsWithCode(
      createStockLocation(tenantContext(), ownerUserId, {
        ...input,
        type: "freezer",
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("SETUP-01 refuses a duplicate name in one outlet and allows it in another", async () => {
    const name = `Lokasi Setup ${randomUUID().slice(0, 6)}`;
    await createStockLocation(tenantContext(), ownerUserId, {
      outletId: outletA,
      name,
      type: "bar",
      idempotencyKey: `loc-${randomUUID()}`,
    });
    await rejectsWithStatus(
      createStockLocation(tenantContext(), ownerUserId, {
        outletId: outletA,
        name: name.toUpperCase(),
        type: "bar",
        idempotencyKey: `loc-${randomUUID()}`,
      }),
      409,
    );
    const other = await createStockLocation(tenantContext(), ownerUserId, {
      outletId: outletB,
      name,
      type: "bar",
      idempotencyKey: `loc-${randomUUID()}`,
    });
    expect(other.outletId).toBe(outletB);
  });

  it("TEN-03 SETUP-01 an outlet-scoped caller cannot create or edit in another outlet", async () => {
    const scoped = tenantContext(tenantA, [outletA]);
    await rejectsWithCode(
      createStockLocation(scoped, ownerUserId, {
        outletId: outletB,
        name: `Lokasi Setup ${randomUUID().slice(0, 6)}`,
        type: "kitchen",
        idempotencyKey: `loc-${randomUUID()}`,
      }),
      "OUTLET_OUT_OF_SCOPE",
    );
    // RLS hides the other outlet's row: a 404, not a leak.
    await rejectsWithStatus(
      updateStockLocation(scoped, ownerUserId, locationOutletB, {
        name: "Diubah",
      }),
      404,
    );
  });

  it("SETUP-01 updates name and type, blocks an empty patch and a deactivation with stock", async () => {
    const created = await createStockLocation(tenantContext(), ownerUserId, {
      outletId: outletA,
      name: `Lokasi Setup ${randomUUID().slice(0, 6)}`,
      type: "pastry",
      idempotencyKey: `loc-${randomUUID()}`,
    });
    const renamed = await updateStockLocation(
      tenantContext(),
      ownerUserId,
      created.id,
      { name: `Lokasi Setup ${randomUUID().slice(0, 6)}`, type: "kitchen" },
    );
    expect(renamed.type).toBe("kitchen");
    await rejectsWithStatus(
      updateStockLocation(tenantContext(), ownerUserId, created.id, {}),
      422,
    );

    await owner.query(
      `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
       VALUES ($1, $2, $3, $4, 5, 1000)`,
      [tenantA, outletA, created.id, itemA],
    );
    await rejectsWithStatus(
      updateStockLocation(tenantContext(), ownerUserId, created.id, {
        isActive: false,
      }),
      409,
    );
    await owner.query("DELETE FROM stock_balances WHERE location_id = $1", [
      created.id,
    ]);
    const off = await updateStockLocation(
      tenantContext(),
      ownerUserId,
      created.id,
      { isActive: false },
    );
    expect(off.isActive).toBe(false);
  });

  it("SETUP-01 audits location changes", async () => {
    const created = await createStockLocation(tenantContext(), ownerUserId, {
      outletId: outletA,
      name: `Lokasi Setup ${randomUUID().slice(0, 6)}`,
      type: "bar",
      idempotencyKey: `loc-${randomUUID()}`,
    });
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'stock_location.created'",
      [tenantA, created.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("legend-1ozj setup writes need inventory.item.manage", () => {
  const location = (name: string) => ({
    outletId: outletA,
    name,
    type: "chiller",
    idempotencyKey: `loc-${randomUUID()}`,
  });

  it("denies stock.receive alone and allows inventory.item.manage on locations", async () => {
    const receiveOnly = await signedIn("Setup Terima Saja");
    await assignCustomRole(receiveOnly.userId, [
      "inventory.stock.view",
      "inventory.stock.receive",
    ]);
    const denied = await receiveOnly.client
      .post("/api/inventory/locations")
      .set(originHeader)
      .send(location(`Gudang ${randomUUID().slice(0, 6)}`));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);

    const manager = await signedIn("Setup Pengelola");
    await assignCustomRole(manager.userId, [
      "inventory.stock.view",
      "inventory.item.manage",
    ]);
    const created = await manager.client
      .post("/api/inventory/locations")
      .set(originHeader)
      .send(location(`Gudang ${randomUUID().slice(0, 6)}`));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  it("denies stock.receive alone on a UOM conversion", async () => {
    const receiveOnly = await signedIn("Konversi Terima Saja");
    await assignCustomRole(receiveOnly.userId, [
      "inventory.stock.view",
      "inventory.stock.receive",
    ]);
    const denied = await receiveOnly.client
      .post(`/api/inventory/items/${itemA}/uom-conversions`)
      .set(originHeader)
      .send({
        fromUomId: uomPcs,
        toUomId: uomG,
        factor: "7.0000",
        idempotencyKey: `uom-${randomUUID()}`,
      });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  });
});

describe("SETUP-02 UOM conversions and alternates", () => {
  it("SETUP-02 detects duplicate pairs and cycles in the unit graph", () => {
    const edges = [
      { fromUomId: "kg", toUomId: "g" },
      { fromUomId: "pack", toUomId: "kg" },
    ];
    expect(conversionLinksConnectedUnits(edges, "kg", "g")).toBe(true);
    expect(conversionLinksConnectedUnits(edges, "g", "kg")).toBe(true);
    expect(conversionLinksConnectedUnits(edges, "pack", "g")).toBe(true);
    expect(conversionLinksConnectedUnits(edges, "pack", "pcs")).toBe(false);
    expect(conversionLinksConnectedUnits([], "kg", "g")).toBe(false);
  });

  it("SETUP-02 creates a conversion, replays it, then refuses duplicate, reverse and cyclic links", async () => {
    const input = {
      fromUomId: uomKg,
      toUomId: uomG,
      factor: "1000.0000" as never,
      idempotencyKey: `uom-${randomUUID()}`,
    };
    const first = await createUomConversion(
      tenantContext(),
      ownerUserId,
      itemA,
      input,
    );
    expect(first.factor).toBe("1000.0000");
    const replay = await createUomConversion(
      tenantContext(),
      ownerUserId,
      itemA,
      input,
    );
    expect(replay.id).toBe(first.id);
    await rejectsWithCode(
      createUomConversion(tenantContext(), ownerUserId, itemA, {
        ...input,
        factor: "999.0000" as never,
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    // Reverse pair of an existing conversion.
    await rejectsWithStatus(
      createUomConversion(tenantContext(), ownerUserId, itemA, {
        fromUomId: uomG,
        toUomId: uomKg,
        factor: "0.0010" as never,
        idempotencyKey: `uom-${randomUUID()}`,
      }),
      409,
    );
    // pack -> kg is fine; pack -> g would close a cycle (kg-g, pack-kg).
    await createUomConversion(tenantContext(), ownerUserId, itemA, {
      fromUomId: uomPack,
      toUomId: uomKg,
      factor: "2.0000" as never,
      idempotencyKey: `uom-${randomUUID()}`,
    });
    await rejectsWithStatus(
      createUomConversion(tenantContext(), ownerUserId, itemA, {
        fromUomId: uomPack,
        toUomId: uomG,
        factor: "2000.0000" as never,
        idempotencyKey: `uom-${randomUUID()}`,
      }),
      409,
    );
    // The same pair on another item is independent.
    const other = await createUomConversion(
      tenantContext(),
      ownerUserId,
      itemB,
      { ...input, idempotencyKey: `uom-${randomUUID()}` },
    );
    expect(other.inventoryItemId).toBe(itemB);
  });

  it("SETUP-02 deletes a conversion and a missing one is a 404", async () => {
    const created = await createUomConversion(
      tenantContext(),
      ownerUserId,
      itemB,
      {
        fromUomId: uomPcs,
        toUomId: uomPack,
        factor: "0.0400" as never,
        idempotencyKey: `uom-${randomUUID()}`,
      },
    );
    await deleteUomConversion(tenantContext(), ownerUserId, itemB, created.id);
    await rejectsWithStatus(
      deleteUomConversion(tenantContext(), ownerUserId, itemB, created.id),
      404,
    );
  });

  it("SETUP-02 a conversion still referenced (recipe/purchase line) cannot be deleted", async () => {
    const itemRef = await insertItem(uomKg, "Tepung Setup");
    const created = await createUomConversion(
      tenantContext(),
      ownerUserId,
      itemRef,
      {
        fromUomId: uomG,
        toUomId: uomPcs,
        factor: "5.0000" as never,
        idempotencyKey: `uom-${randomUUID()}`,
      },
    );
    const unregister = registerConversionReferenceCheck(
      async (_tx, _context, subject) => subject.id === created.id,
    );
    try {
      const error = await deleteUomConversion(
        tenantContext(),
        ownerUserId,
        itemRef,
        created.id,
      ).then(
        () => null,
        (caught: unknown) => caught as { status?: number; code?: string },
      );
      expect(error).toMatchObject({ status: 409, code: "CONFLICT" });
      const { rows } = await owner.query(
        "SELECT 1 FROM uom_conversions WHERE id = $1",
        [created.id],
      );
      expect(rows).toHaveLength(1);
    } finally {
      unregister();
    }
    await deleteUomConversion(
      tenantContext(),
      ownerUserId,
      itemRef,
      created.id,
    );
  });

  it("SETUP-02 alternates: no self link, no duplicate, replayable, deletable", async () => {
    await rejectsWithStatus(
      createInventoryItemAlternate(tenantContext(), ownerUserId, itemA, {
        alternateItemId: itemA as never,
        priority: 0,
        idempotencyKey: `alt-${randomUUID()}`,
      }),
      422,
    );
    const input = {
      alternateItemId: itemB as never,
      priority: 1,
      idempotencyKey: `alt-${randomUUID()}`,
    };
    const created = await createInventoryItemAlternate(
      tenantContext(),
      ownerUserId,
      itemA,
      input,
    );
    const replay = await createInventoryItemAlternate(
      tenantContext(),
      ownerUserId,
      itemA,
      input,
    );
    expect(replay.id).toBe(created.id);
    await rejectsWithStatus(
      createInventoryItemAlternate(tenantContext(), ownerUserId, itemA, {
        ...input,
        idempotencyKey: `alt-${randomUUID()}`,
      }),
      409,
    );
    await deleteInventoryItemAlternate(
      tenantContext(),
      ownerUserId,
      itemA,
      created.id,
    );
    await rejectsWithStatus(
      deleteInventoryItemAlternate(
        tenantContext(),
        ownerUserId,
        itemA,
        created.id,
      ),
      404,
    );
  });

  it("TEN-01 SETUP-02 tenant-wide setup is denied to an outlet-scoped caller", async () => {
    const { userId } = await signedIn("Outlet Only Setup");
    await assignRole(userId, "warehouse", { type: "outlet", id: outletA });
    const scoped = tenantContext(tenantA, [outletA]);
    await expect(
      createUomConversion(scoped, userId, itemA, {
        fromUomId: uomPcs,
        toUomId: uomG,
        factor: "5.0000" as never,
        idempotencyKey: `uom-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("SETUP-03 par levels", () => {
  it("SETUP-03 creates, lists, updates and deletes a par level", async () => {
    const input = {
      outletId: outletA,
      locationId: locationA1 as never,
      inventoryItemId: itemA as never,
      parMin: "2.0000" as never,
      parMax: "10.0000" as never,
      idempotencyKey: `par-${randomUUID()}`,
    };
    const created = await createParLevel(tenantContext(), ownerUserId, input);
    expect(created).toMatchObject({ parMin: "2.0000", parMax: "10.0000" });
    expect((await createParLevel(tenantContext(), ownerUserId, input)).id).toBe(
      created.id,
    );
    // One level per location + item.
    await rejectsWithStatus(
      createParLevel(tenantContext(), ownerUserId, {
        ...input,
        idempotencyKey: `par-${randomUUID()}`,
      }),
      409,
    );
    const page = await listParLevels(tenantContext(), ownerUserId, {
      outletId: outletA,
      limit: 50,
    });
    expect(page.data.some((par) => par.id === created.id)).toBe(true);

    const updated = await updateParLevel(
      tenantContext(),
      ownerUserId,
      created.id,
      { parMax: "12.0000" as never },
    );
    expect(updated.parMax).toBe("12.0000");
    await rejectsWithStatus(
      updateParLevel(tenantContext(), ownerUserId, created.id, {
        parMin: "13.0000" as never,
      }),
      422,
    );
    await deleteParLevel(tenantContext(), ownerUserId, created.id);
    await rejectsWithStatus(
      deleteParLevel(tenantContext(), ownerUserId, created.id),
      404,
    );
  });

  it("TEN-03 SETUP-03 a location of another outlet cannot carry the level", async () => {
    await rejectsWithStatus(
      createParLevel(tenantContext(), ownerUserId, {
        outletId: outletA,
        locationId: locationOutletB as never,
        inventoryItemId: itemA as never,
        parMin: "1.0000" as never,
        parMax: "2.0000" as never,
        idempotencyKey: `par-${randomUUID()}`,
      }),
      404,
    );
    await rejectsWithCode(
      createParLevel(tenantContext(tenantA, [outletA]), ownerUserId, {
        outletId: outletB,
        locationId: locationOutletB as never,
        inventoryItemId: itemA as never,
        parMin: "1.0000" as never,
        parMax: "2.0000" as never,
        idempotencyKey: `par-${randomUUID()}`,
      }),
      "OUTLET_OUT_OF_SCOPE",
    );
  });

  it("TEN-03 SETUP-03 an outlet-scoped caller cannot list, edit or delete another outlet's level", async () => {
    const itemC = await insertItem(uomKg, "Kopi Setup");
    const foreign = await createParLevel(tenantContext(), ownerUserId, {
      outletId: outletB,
      locationId: locationOutletB as never,
      inventoryItemId: itemC as never,
      parMin: "1.0000" as never,
      parMax: "4.0000" as never,
      idempotencyKey: `par-${randomUUID()}`,
    });
    const scoped = tenantContext(tenantA, [outletA]);
    await rejectsWithCode(
      listParLevels(scoped, ownerUserId, { outletId: outletB, limit: 50 }),
      "OUTLET_OUT_OF_SCOPE",
    );
    // RLS hides the other outlet's row: a 404, not a leak or a write.
    await rejectsWithStatus(
      updateParLevel(scoped, ownerUserId, foreign.id, {
        parMax: "99.0000" as never,
      }),
      404,
    );
    await rejectsWithStatus(
      deleteParLevel(scoped, ownerUserId, foreign.id),
      404,
    );
    const { rows } = await owner.query<{ par_max: string }>(
      "SELECT par_max FROM par_levels WHERE id = $1",
      [foreign.id],
    );
    expect(rows[0]?.par_max).toBe("4.0000");
  });

  it("SETUP-03 concurrent creates of one location+item under different keys: one wins, one 409", async () => {
    const itemD = await insertItem(uomKg, "Susu Setup");
    const attempt = () =>
      createParLevel(tenantContext(), ownerUserId, {
        outletId: outletA,
        locationId: locationA1 as never,
        inventoryItemId: itemD as never,
        parMin: "1.0000" as never,
        parMax: "2.0000" as never,
        idempotencyKey: `par-${randomUUID()}`,
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect((failure?.reason as { status?: number } | undefined)?.status).toBe(
      409,
    );
  });

  it("TEN-01 SETUP-03 another tenant sees no par levels, settings or alternates", async () => {
    await createParLevel(tenantContext(), ownerUserId, {
      outletId: outletA,
      locationId: locationA1 as never,
      inventoryItemId: itemB as never,
      parMin: "1.0000" as never,
      parMax: "3.0000" as never,
      idempotencyKey: `par-${randomUUID()}`,
    });
    for (const table of [
      "par_levels",
      "inventory_settings",
      "inventory_item_alternates",
      "inventory_setup_idempotency",
    ]) {
      const seen = await asTenant(tenantB, (client) =>
        client.query(`SELECT 1 FROM ${table}`),
      );
      expect(seen.rows, table).toHaveLength(0);
    }
  });
});

describe("SETUP-04 tenant inventory settings", () => {
  it("SETUP-04 reads defaults, saves, replays, and guards stale writes", async () => {
    const before = await getInventorySettings(tenantContext(), ownerUserId);
    expect(before).toMatchObject({
      recipeDeductionMode: "real_time",
      expiryWarningDays: 7,
      updatedAt: null,
    });
    const input = {
      recipeDeductionMode: "close_of_day" as const,
      expiryWarningDays: 14,
      expectedUpdatedAt: null,
      idempotencyKey: `set-${randomUUID()}`,
    };
    const saved = await updateInventorySettings(
      tenantContext(),
      ownerUserId,
      input,
    );
    expect(saved).toMatchObject({
      recipeDeductionMode: "close_of_day",
      expiryWarningDays: 14,
    });
    expect(saved.updatedAt).not.toBeNull();
    // Replay of the same request returns the saved settings.
    expect(
      (await updateInventorySettings(tenantContext(), ownerUserId, input))
        .updatedAt,
    ).toBe(saved.updatedAt);
    // Same key, different request.
    await rejectsWithCode(
      updateInventorySettings(tenantContext(), ownerUserId, {
        ...input,
        expiryWarningDays: 30,
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    // Stale: a first-save value after the row exists.
    await rejectsWithCode(
      updateInventorySettings(tenantContext(), ownerUserId, {
        ...input,
        expiryWarningDays: 21,
        idempotencyKey: `set-${randomUUID()}`,
      }),
      "PRECONDITION_FAILED",
    );
    const next = await updateInventorySettings(tenantContext(), ownerUserId, {
      recipeDeductionMode: "real_time",
      expiryWarningDays: 3,
      expectedUpdatedAt: saved.updatedAt,
      idempotencyKey: `set-${randomUUID()}`,
    });
    expect(next).toMatchObject({
      recipeDeductionMode: "real_time",
      expiryWarningDays: 3,
    });
    const audited = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'inventory_settings.updated'",
      [tenantA],
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("SETUP-04 a warehouse role may read but not change settings", async () => {
    const { userId } = await signedIn("Warehouse Settings");
    await assignRole(userId, "warehouse", { type: "tenant" });
    expect(await getInventorySettings(tenantContext(), userId)).toHaveProperty(
      "expiryWarningDays",
    );
    await expect(
      updateInventorySettings(tenantContext(), userId, {
        recipeDeductionMode: "real_time",
        expiryWarningDays: 5,
        expectedUpdatedAt: null,
        idempotencyKey: `set-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("inventory setup API", () => {
  it("requires a session, rejects tenant fields and a foreign origin", async () => {
    expect((await agent(app).get("/api/inventory/settings")).status).toBe(401);
    const { client, userId } = await signedIn("Owner Setup API");
    await assignRole(userId, "owner", { type: "tenant" });

    const settings = await client.get("/api/inventory/settings");
    expect(settings.status).toBe(200);
    expect(settings.body.data).toHaveProperty("recipeDeductionMode");

    const location = {
      outletId: outletA,
      name: `Lokasi Setup ${randomUUID().slice(0, 6)}`,
      type: "freezer",
      idempotencyKey: `api-loc-${randomUUID()}`,
    };
    const created = await client
      .post("/api/inventory/locations")
      .set(originHeader)
      .send(location);
    expect(created.status).toBe(201);
    createdLocationIds.push(created.body.data.id);
    expect(
      (
        await client
          .post("/api/inventory/locations")
          .set(originHeader)
          .send({ ...location, tenantId: tenantB })
      ).status,
    ).toBe(422);
    expect(
      (await client.post("/api/inventory/locations").send(location)).status,
    ).toBe(403);
  });

  it("TEN-03 an outlet role cannot write setup in another outlet or tenant-wide", async () => {
    const { client, userId } = await signedIn("Warehouse API Setup");
    await assignRole(userId, "warehouse", { type: "outlet", id: outletA });
    expect(
      (
        await client
          .post("/api/inventory/locations")
          .set(originHeader)
          .send({
            outletId: outletB,
            name: "Tidak boleh",
            type: "bar",
            idempotencyKey: `api-loc-${randomUUID()}`,
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .put("/api/inventory/settings")
          .set(originHeader)
          .send({
            recipeDeductionMode: "real_time",
            expiryWarningDays: 7,
            expectedUpdatedAt: null,
            idempotencyKey: `api-set-${randomUUID()}`,
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .delete(`/api/inventory/par-levels/${randomUUID()}`)
          .set(originHeader)
      ).status,
    ).toBe(404);
  });
});
