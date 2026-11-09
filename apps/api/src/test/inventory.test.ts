// Inventory & warehouse integration tests (PRD v1.7 §6 E, §16 "Inventori &
// Gudang", §17; bead legend-98t, INV-01).
//
// Runs against the disposable PostgreSQL test database as the migration owner
// (fixtures), the restricted legend_app login (RLS checks) and the real Express
// app (routes, RBAC, origin checks). Covers:
// - INV-01 append-only stock ledger (trigger + privileges) and balances derived
//   from the ledger with a per-location moving average;
// - TEN-01/TEN-02 cross-tenant isolation for every new table;
// - TEN-03 cross-outlet denial in the service layer;
// - the API slice: items/UOMs/locations/ledger/balances/batches, idempotency,
//   optimistic concurrency and permission checks.
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  CoreError,
  decimal4,
  extendCostIdr,
  outletIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { PERMISSION_CODES, roleTemplate } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  createStockBatch,
  inventoryLocationLockKey,
  listStockBalances,
  listStockBatches,
  listStockLedger,
  recordStockMovement,
  recordStockTransfer,
  rebuildStockBalances,
} from "../services/inventory.service";
import { agent, originHeader, signUp } from "./helpers";

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
const createdItemIds: string[] = [];
const createdUomIds: string[] = [];
const createdLocationIds: string[] = [];

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

/** Runs `run` inside a rolled-back legend_app transaction with tenant context. */
async function asTenant<T>(
  tenantId: string | null,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (tenantId !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
    return await run(client);
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Opens a legend_app transaction the test controls (holds locks deliberately). */
async function openLockHolder(tenantId: string): Promise<PoolClient> {
  const client = await appPool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE legend_app");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
  return client;
}

async function insertUom(
  tenantId: string,
  code: string,
  name: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id",
    [tenantId, code, name],
  );
  createdUomIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertLocation(
  tenantId: string,
  outletId: string,
  name: string,
  type = "warehouse",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantId, outletId, name, type],
  );
  createdLocationIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertItem(
  tenantId: string,
  baseUomId: string,
  name: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantId, name, baseUomId],
  );
  createdItemIds.push(rows[0]!.id);
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

// Fixture ids for this file (random per run, safe on the disposable database).
let uomId: string;
let itemId: string;
let location1: string;
let location2: string;
let locationB: string;
let serviceUserId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Inventory Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `inventori-${randomUUID().slice(0, 8)}`,
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

  uomId = await insertUom(
    tenantA,
    `kg-${randomUUID().slice(0, 4)}`,
    "Kilogram",
  );
  location1 = await insertLocation(tenantA, outletA, "Gudang Utama");
  location2 = await insertLocation(
    tenantA,
    outletA,
    "Chiller Bandung",
    "chiller",
  );
  locationB = await insertLocation(tenantA, outletB, "Gudang Bandung 2");
  itemId = await insertItem(
    tenantA,
    uomId,
    `Kopi Robusta ${randomUUID().slice(0, 6)}`,
  );

  // A real user row for the transfer document's moved_by and for permission
  // checks in service-level calls; an owner assignment covers every code.
  serviceUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [serviceUserId, "Inventory Service", `${serviceUserId}@example.com`],
  );
  await assignRole(serviceUserId, "owner", { type: "tenant" });
});

afterAll(async () => {
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
  // Items created over HTTP have no ledger rows; the service-level fixtures do
  // and the ledger is append-only, so leave those rows in the disposable DB.
  const httpItems = createdItemIds.filter((id) => id !== itemId);
  if (httpItems.length > 0)
    await owner.query(
      "DELETE FROM inventory_items WHERE id = ANY($1::uuid[])",
      [httpItems],
    );
  // Tenant B exists only for the isolation checks; its items were written in a
  // rolled-back transaction, so removing its unit and tenant restores the
  // database other test files expect (the platform tenant list parses rows).
  await owner.query("DELETE FROM uoms WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("INV-01 append-only stock card", () => {
  it("INV-01 records a receipt and rejects every rewrite attempt", async () => {
    const entry = await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId: location1,
      inventoryItemId: itemId,
      movementType: "receipt",
      quantity: decimal4("10.0000"),
      unitCostIdr: decimal4("1000.0000"),
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      actor: { type: "system" },
    });
    expect(entry.quantity).toBe("10.0000");
    expect(entry.unitCostIdr).toBe("1000.0000");

    // The table owner (not just the app login) is blocked by the trigger.
    await expect(
      owner.query("UPDATE stock_ledger SET quantity = 99 WHERE id = $1", [
        ulidToUuid(entry.id),
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query("DELETE FROM stock_ledger WHERE id = $1", [
        ulidToUuid(entry.id),
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE stock_ledger")).rejects.toThrow(
      /append-only/,
    );

    // The application login has no UPDATE/DELETE privilege at all, so history
    // survives even a bug that tried to rewrite it.
    await expect(
      asTenant(tenantA, (client) =>
        client.query("UPDATE stock_ledger SET quantity = 99 WHERE id = $1", [
          ulidToUuid(entry.id),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(tenantA, (client) =>
        client.query("DELETE FROM stock_ledger WHERE id = $1", [
          ulidToUuid(entry.id),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("INV-01 derives per-location balances with a moving average", async () => {
    // 10 @ 1000 already on hand from the test above; add 10 @ 2000.
    await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId: location1,
      inventoryItemId: itemId,
      movementType: "receipt",
      quantity: decimal4("10.0000"),
      unitCostIdr: decimal4("2000.0000"),
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      actor: { type: "system" },
    });
    // An outflow without an explicit cost is valued at the moving average.
    const sale = await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId: location1,
      inventoryItemId: itemId,
      movementType: "sale",
      quantity: decimal4("-5.0000"),
      sourceType: "order",
      sourceId: "01JBQ7Z8K0A1B2C3D4E5F6G7H8",
      actor: { type: "system" },
    });
    expect(sale.unitCostIdr).toBe("1500.0000");

    const { data } = await listStockBalances(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 100,
      inventoryItemId: itemId,
    });
    const balance = data.find(
      (row) => row.locationId === location1 && row.inventoryItemId === itemId,
    );
    expect(balance?.quantity).toBe("15.0000");
    expect(balance?.avgCostIdr).toBe("1500.0000");
    expect(
      extendCostIdr(balance!.quantity, balance!.avgCostIdr, "half_up"),
    ).toBe(22_500);

    // The rebuild folds the ledger with the shared INV-01 helper and matches
    // the materialized rows exactly.
    await rebuildStockBalances(tenantContext(), serviceUserId, outletA);
    const rebuilt = await listStockBalances(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 100,
      inventoryItemId: itemId,
    });
    expect(
      rebuilt.data.find((row) => row.locationId === location1),
    ).toMatchObject({ quantity: "15.0000", avgCostIdr: "1500.0000" });
  });

  it("INV-01 posts a transfer as paired rows at the moving-average cost", async () => {
    const transfer = await recordStockTransfer(tenantContext(), serviceUserId, {
      outletId: outletA,
      fromLocationId: location1,
      toLocationId: location2,
      lines: [{ inventoryItemId: itemId, quantity: decimal4("5.0000") }],
      note: "Pindah ke chiller",
    });
    expect(transfer.lines).toHaveLength(1);

    const { rows } = await owner.query(
      `SELECT movement_type, quantity, unit_cost_idr, source_type
       FROM stock_ledger WHERE tenant_id = $1 AND inventory_item_id = $2
       ORDER BY occurred_at, id`,
      [tenantA, itemId],
    );
    const transferRows = rows.filter(
      (row) => row.source_type === "stock_transfer",
    );
    expect(transferRows).toHaveLength(2);
    expect(transferRows.map((row) => row.movement_type).sort()).toEqual([
      "transfer_in",
      "transfer_out",
    ]);
    expect(transferRows.every((row) => row.unit_cost_idr === "1500.0000")).toBe(
      true,
    );

    const balances = await listStockBalances(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 100,
      inventoryItemId: itemId,
    });
    expect(
      balances.data.find((row) => row.locationId === location1),
    ).toMatchObject({ quantity: "10.0000", avgCostIdr: "1500.0000" });
    expect(
      balances.data.find((row) => row.locationId === location2),
    ).toMatchObject({ quantity: "5.0000", avgCostIdr: "1500.0000" });

    // A transfer cannot invent stock at the destination.
    await rejectsWithCode(
      recordStockTransfer(tenantContext(), serviceUserId, {
        outletId: outletA,
        fromLocationId: location1,
        toLocationId: location2,
        lines: [{ inventoryItemId: itemId, quantity: decimal4("999.0000") }],
      }),
      "CONFLICT",
    );
  });

  it("INV-01 rejects a ledger row that breaks the contract direction rules", async () => {
    await expect(
      recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location1,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("-1.0000"),
        unitCostIdr: decimal4("1000.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        actor: { type: "system" },
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe("INV-01 batches and expiry", () => {
  it("INV-01 stores a batch and lists it by expiry window", async () => {
    const batch = await createStockBatch(tenantContext(), {
      outletId: outletA,
      locationId: location2,
      inventoryItemId: itemId,
      batchCode: `B-${randomUUID().slice(0, 6)}`,
      expiresOn: businessDateSchema.parse("2026-11-10"),
    });
    expect(batch.expiresOn).toBe("2026-11-10");

    const page = await listStockBatches(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 100,
      inventoryItemId: itemId,
      expiresOnOrBefore: businessDateSchema.parse("2026-11-30"),
    });
    expect(page.data.some((row) => row.id === batch.id)).toBe(true);
    const none = await listStockBatches(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 100,
      inventoryItemId: itemId,
      expiresOnOrBefore: businessDateSchema.parse("2026-11-01"),
    });
    expect(none.data.some((row) => row.id === batch.id)).toBe(false);
  });
});

describe("TEN-01/TEN-02 inventory isolation", () => {
  it("TEN-01 another tenant sees no inventory rows", async () => {
    const counts = await asTenant(tenantB, async (client) => {
      const result = await client.query<{
        items: string;
        uoms: string;
        ledger: string;
        balances: string;
        locations: string;
        batches: string;
      }>(
        `SELECT
           (SELECT count(*) FROM inventory_items) AS items,
           (SELECT count(*) FROM uoms) AS uoms,
           (SELECT count(*) FROM stock_ledger) AS ledger,
           (SELECT count(*) FROM stock_balances) AS balances,
           (SELECT count(*) FROM stock_locations) AS locations,
           (SELECT count(*) FROM stock_batches) AS batches`,
      );
      return result.rows[0]!;
    });
    expect(counts).toEqual({
      items: "0",
      uoms: "0",
      ledger: "0",
      balances: "0",
      locations: "0",
      batches: "0",
    });
  });

  it("TEN-02 a query without tenant context is refused", async () => {
    await expect(
      asTenant(null, (client) => client.query("SELECT * FROM inventory_items")),
    ).rejects.toThrow();
  });

  it("TEN-01 the composite keys stop a cross-tenant reference", async () => {
    const uomB = await insertUom(tenantB, "kg", "Kilogram B");
    await expect(
      asTenant(tenantB, (client) =>
        client.query(
          `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id)
           VALUES ($1, 'Cross', 'Bahan Baku', 'raw_material', $2)`,
          [tenantB, uomId],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
    // Its own unit still works inside tenant B.
    await asTenant(tenantB, (client) =>
      client.query(
        `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id)
         VALUES ($1, 'Own', 'Bahan Baku', 'raw_material', $2)`,
        [tenantB, uomB],
      ),
    );
  });

  it("TEN-03 an outlet-scoped caller cannot reach another outlet", async () => {
    const scoped = tenantContext(tenantA, [outletA]);
    await rejectsWithCode(
      recordStockMovement(scoped, {
        outletId: outletB,
        locationId: locationB,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("1.0000"),
        unitCostIdr: decimal4("1000.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        actor: { type: "system" },
      }),
      "OUTLET_OUT_OF_SCOPE",
    );
    await rejectsWithCode(
      listStockBalances(scoped, serviceUserId, {
        outletId: outletB,
        limit: 10,
      }),
      "OUTLET_OUT_OF_SCOPE",
    );
  });
});

describe("Q39 stock card business-day filter", () => {
  it("Q39 fromDate/toDate select [04:00, next 04:00) in the outlet zone, not the calendar day", async () => {
    const location = await insertLocation(
      tenantA,
      outletA,
      `Q39 ${randomUUID().slice(0, 6)}`,
    );
    const item = await insertItem(
      tenantA,
      uomId,
      `Q39 Susu ${randomUUID().slice(0, 6)}`,
    );
    // Ledger rows are append-only: like `itemId`, this item stays in the
    // disposable DB instead of the HTTP-item cleanup.
    createdItemIds.splice(createdItemIds.indexOf(item), 1);
    // Seeded outlet A: Asia/Jakarta (UTC+7), default cutoff 04:00.
    const wib = {
      "2026-10-12 03:59": "2026-10-11T20:59:00.000Z", // business date 11 Oct
      "2026-10-12 04:00": "2026-10-11T21:00:00.000Z", // 12 Oct
      "2026-10-12 23:59": "2026-10-12T16:59:00.000Z", // 12 Oct
      "2026-10-13 00:30": "2026-10-12T17:30:00.000Z", // 12 Oct (after close)
      "2026-10-13 04:00": "2026-10-12T21:00:00.000Z", // 13 Oct
    };
    for (const occurredAt of Object.values(wib))
      await recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: item,
        movementType: "receipt",
        quantity: decimal4("1.0000"),
        unitCostIdr: decimal4("1000.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        occurredAt,
        actor: { type: "system" },
      });
    const page = await listStockLedger(tenantContext(), serviceUserId, {
      limit: 100,
      outletId: outletA,
      inventoryItemId: item,
      fromDate: "2026-10-12",
      toDate: "2026-10-12",
    });
    expect(page.data.map((row) => row.occurredAt).sort()).toEqual([
      wib["2026-10-12 04:00"],
      wib["2026-10-12 23:59"],
      wib["2026-10-13 00:30"],
    ]);
    const tail = await listStockLedger(tenantContext(), serviceUserId, {
      limit: 100,
      outletId: outletA,
      inventoryItemId: item,
      fromDate: "2026-10-13",
    });
    expect(tail.data.map((row) => row.occurredAt)).toEqual([
      wib["2026-10-13 04:00"],
    ]);
  });
});

describe("pre-review regressions", () => {
  it("HIGH :816 values an outflow from the locked balance, not a stale cost read", async () => {
    const location = await insertLocation(
      tenantA,
      outletA,
      `Cost lock ${randomUUID().slice(0, 6)}`,
    );
    await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId: location,
      inventoryItemId: itemId,
      movementType: "receipt",
      quantity: decimal4("10.0000"),
      unitCostIdr: decimal4("1000.0000"),
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      actor: { type: "system" },
    });

    // A concurrent receipt holds the balance row and re-weights the average;
    // it commits only after the outflow has started. The outflow must read the
    // average from the row it locked (2000), never the stale committed 1000.
    const holder = await openLockHolder(tenantA);
    let outflow: Promise<unknown> | undefined;
    try {
      await holder.query(
        "UPDATE stock_balances SET avg_cost_idr = '2000.0000' WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
        [tenantA, location, itemId],
      );
      outflow = recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "sale",
        quantity: decimal4("-1.0000"),
        sourceType: "order",
        sourceId: "01JBQ7Z8K0A1B2C3D4E5F6G7H8",
        actor: { type: "system" },
      });
      await sleep(300);
      await holder.query("COMMIT");
      const entry = (await outflow) as { unitCostIdr: string };
      expect(entry.unitCostIdr).toBe("2000.0000");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await outflow?.catch(() => undefined);
    }
  });

  it("HIGH :962 masks costs for a role without inventory.cost.view", async () => {
    const warehouseUser = await signedIn("Warehouse Cost Mask");
    await assignRole(warehouseUser.userId, "warehouse", {
      type: "outlet",
      id: outletA,
    });

    const ledger = await warehouseUser.client.get(
      `/api/inventory/stock-ledger?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.length).toBeGreaterThan(0);
    expect(
      ledger.body.data.every(
        (row: { unitCostIdr: string }) => row.unitCostIdr === "0.0000",
      ),
    ).toBe(true);

    const balances = await warehouseUser.client.get(
      `/api/inventory/balances?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(balances.status).toBe(200);
    expect(
      balances.body.data.every(
        (row: { avgCostIdr: string }) => row.avgCostIdr === "0.0000",
      ),
    ).toBe(true);

    // The separate cost permission still reveals the real numbers.
    const ownerUser = await signedIn("Owner Cost Unmasked");
    await assignRole(ownerUser.userId, "owner", { type: "tenant" });
    const ownerLedger = await ownerUser.client.get(
      `/api/inventory/stock-ledger?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(ownerLedger.status).toBe(200);
    expect(
      ownerLedger.body.data.some(
        (row: { unitCostIdr: string }) => row.unitCostIdr !== "0.0000",
      ),
    ).toBe(true);
    const ownerBalances = await ownerUser.client.get(
      `/api/inventory/balances?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(
      ownerBalances.body.data.some(
        (row: { avgCostIdr: string }) => row.avgCostIdr !== "0.0000",
      ),
    ).toBe(true);
  });

  it("HIGH :1102 serialises the rebuild and movements on the tenant+location lock", async () => {
    const location = await insertLocation(
      tenantA,
      outletA,
      `Rebuild lock ${randomUUID().slice(0, 6)}`,
    );
    const holder = await openLockHolder(tenantA);
    let rebuilt = false;
    let posted = false;
    let rebuild: Promise<unknown> | undefined;
    let movement: Promise<unknown> | undefined;
    try {
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [inventoryLocationLockKey(tenantA, location)],
      );
      rebuild = rebuildStockBalances(
        tenantContext(),
        serviceUserId,
        outletA,
      ).then((result) => {
        rebuilt = true;
        return result;
      });
      movement = recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("1.0000"),
        unitCostIdr: decimal4("500.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        actor: { type: "system" },
      }).then((entry) => {
        posted = true;
        return entry;
      });
      await sleep(400);
      expect(rebuilt).toBe(false);
      expect(posted).toBe(false);
      await holder.query("COMMIT");
      await rebuild;
      await movement;
      expect(posted).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled([rebuild, movement]);
    }
  });

  it("HIGH :779 posts a retried movement once and rejects a reused key", async () => {
    const location = await insertLocation(
      tenantA,
      outletA,
      `Retry ${randomUUID().slice(0, 6)}`,
    );
    const idempotencyKey = `movement-${randomUUID()}`;
    const posting = () =>
      recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "receipt" as const,
        quantity: decimal4("2.0000"),
        unitCostIdr: decimal4("500.0000"),
        sourceType: "goods_receipt" as const,
        sourceId: "5b0f3c2e-6f4a-4c1e-9a3b-2f5d8e1a4c70",
        idempotencyKey,
        actor: { type: "system" as const },
      });

    const [first, second] = await Promise.all([posting(), posting()]);
    expect(second.id).toBe(first.id);
    const count = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM stock_ledger WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
      [tenantA, location, itemId],
    );
    expect(count.rows[0]!.count).toBe(1);
    const balances = await listStockBalances(tenantContext(), serviceUserId, {
      outletId: outletA,
      limit: 10,
      locationId: location,
      inventoryItemId: itemId,
    });
    expect(balances.data).toHaveLength(1);
    expect(balances.data[0]!.quantity).toBe("2.0000");

    await rejectsWithCode(
      recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("3.0000"),
        unitCostIdr: decimal4("500.0000"),
        sourceType: "goods_receipt",
        sourceId: "5b0f3c2e-6f4a-4c1e-9a3b-2f5d8e1a4c70",
        idempotencyKey,
        actor: { type: "system" },
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("HIGH :779 replays a retried transfer instead of posting the stock twice", async () => {
    const from = await insertLocation(
      tenantA,
      outletA,
      `Retry from ${randomUUID().slice(0, 6)}`,
    );
    const to = await insertLocation(
      tenantA,
      outletA,
      `Retry to ${randomUUID().slice(0, 6)}`,
    );
    for (const location of [from, to]) {
      await recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("10.0000"),
        unitCostIdr: decimal4("1000.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        actor: { type: "system" },
      });
    }
    const idempotencyKey = `transfer-${randomUUID()}`;
    const transfer = () =>
      recordStockTransfer(tenantContext(), serviceUserId, {
        outletId: outletA,
        fromLocationId: from,
        toLocationId: to,
        lines: [{ inventoryItemId: itemId, quantity: decimal4("4.0000") }],
        idempotencyKey,
      });

    const first = await transfer();
    const second = await transfer();
    expect(second.id).toBe(first.id);
    const count = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM stock_ledger WHERE tenant_id = $1 AND source_type = 'stock_transfer' AND source_id = $2",
      [tenantA, ulidToUuid(first.id)],
    );
    expect(count.rows[0]!.count).toBe(2);

    await rejectsWithCode(
      recordStockTransfer(tenantContext(), serviceUserId, {
        outletId: outletA,
        fromLocationId: from,
        toLocationId: to,
        lines: [{ inventoryItemId: itemId, quantity: decimal4("5.0000") }],
        idempotencyKey,
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("MED :714 walks an equal-timestamp batch cursor without repeating a row", async () => {
    const location = await insertLocation(
      tenantA,
      outletA,
      `Batches ${randomUUID().slice(0, 6)}`,
    );
    const receivedAt = "2026-10-30T03:00:00.000Z";
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const batch = await createStockBatch(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        batchCode: `B-${index}-${randomUUID().slice(0, 4)}`,
        receivedAt,
      });
      created.push(batch.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await listStockBatches(tenantContext(), serviceUserId, {
        outletId: outletA,
        limit: 1,
        locationId: location,
        inventoryItemId: itemId,
        cursor,
      });
      seen.push(...result.data.map((row) => row.id));
      if (!result.meta.nextCursor) break;
      cursor = result.meta.nextCursor;
    }
    expect(seen).toHaveLength(created.length);
    expect([...seen].sort()).toEqual([...created].sort());
  });

  it("MED :1190 makes opposing transfers wait on the same location lock order", async () => {
    const left = await insertLocation(
      tenantA,
      outletA,
      `Opposing left ${randomUUID().slice(0, 6)}`,
    );
    const right = await insertLocation(
      tenantA,
      outletA,
      `Opposing right ${randomUUID().slice(0, 6)}`,
    );
    for (const location of [left, right]) {
      await recordStockMovement(tenantContext(), {
        outletId: outletA,
        locationId: location,
        inventoryItemId: itemId,
        movementType: "receipt",
        quantity: decimal4("5.0000"),
        unitCostIdr: decimal4("1000.0000"),
        sourceType: "goods_receipt",
        sourceId: randomUUID(),
        actor: { type: "system" },
      });
    }

    // Both transfers start with the lowest-sorted location, so holding that
    // one lock parks both of them before either can take a row lock.
    const firstLock = [left, right].sort()[0]!;
    const holder = await openLockHolder(tenantA);
    let forwardDone = false;
    let backwardDone = false;
    let forward: Promise<unknown> | undefined;
    let backward: Promise<unknown> | undefined;
    try {
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [inventoryLocationLockKey(tenantA, firstLock)],
      );
      forward = recordStockTransfer(tenantContext(), serviceUserId, {
        outletId: outletA,
        fromLocationId: left,
        toLocationId: right,
        lines: [{ inventoryItemId: itemId, quantity: decimal4("1.0000") }],
      }).then((result) => {
        forwardDone = true;
        return result;
      });
      backward = recordStockTransfer(tenantContext(), serviceUserId, {
        outletId: outletA,
        fromLocationId: right,
        toLocationId: left,
        lines: [{ inventoryItemId: itemId, quantity: decimal4("1.0000") }],
      }).then((result) => {
        backwardDone = true;
        return result;
      });
      await sleep(400);
      expect(forwardDone).toBe(false);
      expect(backwardDone).toBe(false);
      await holder.query("COMMIT");
      await Promise.all([forward, backward]);
      expect(forwardDone).toBe(true);
      expect(backwardDone).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled([forward, backward]);
    }
  });
});

describe("inventory API", () => {
  it("requires a session and a stored role", async () => {
    expect((await agent(app).get("/api/inventory/items")).status).toBe(401);
    const plain = await signedIn("No inventory role");
    expect((await plain.client.get("/api/inventory/items")).status).toBe(403);
  });

  it("lets an owner read and create items idempotently", async () => {
    const { client, userId } = await signedIn("Owner Inventory");
    await assignRole(userId, "owner", { type: "tenant" });

    const list = await client.get("/api/inventory/items?limit=100");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);

    const uoms = await client.get("/api/inventory/uoms?limit=100");
    expect(uoms.status).toBe(200);
    expect(uoms.body.data.some((row: { id: string }) => row.id === uomId)).toBe(
      true,
    );

    const idempotencyKey = `item-${randomUUID()}`;
    const create = await client
      .post("/api/inventory/items")
      .set(originHeader)
      .send({
        name: `Item API ${randomUUID().slice(0, 6)}`,
        category: "Bahan Baku",
        type: "raw_material",
        baseUomId: uomId,
        isPerishable: true,
        parMin: "2.0000",
        parMax: "10.0000",
        idempotencyKey,
      });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.headers.location).toBe(
      `/api/inventory/items/${create.body.data.id}`,
    );
    const createdId = create.body.data.id as string;
    createdItemIds.push(createdId);

    const replay = await client
      .post("/api/inventory/items")
      .set(originHeader)
      .send({
        name: create.body.data.name,
        category: "Bahan Baku",
        type: "raw_material",
        baseUomId: uomId,
        isPerishable: true,
        parMin: "2.0000",
        parMax: "10.0000",
        idempotencyKey,
      });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(createdId);

    const reuse = await client
      .post("/api/inventory/items")
      .set(originHeader)
      .send({
        name: "Different item",
        category: "Bahan Baku",
        type: "raw_material",
        baseUomId: uomId,
        isPerishable: false,
        idempotencyKey,
      });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const stale = await client
      .patch(`/api/inventory/items/${createdId}`)
      .set(originHeader)
      .send({
        name: "Stale write",
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe("PRECONDITION_FAILED");

    const update = await client
      .patch(`/api/inventory/items/${createdId}`)
      .set(originHeader)
      .send({
        name: "Item API diperbarui",
        isActive: false,
        expectedUpdatedAt: create.body.data.updatedAt,
      });
    expect(update.status).toBe(200);
    expect(update.body.data).toMatchObject({
      name: "Item API diperbarui",
      isActive: false,
    });

    const unknownUom = await client
      .post("/api/inventory/items")
      .set(originHeader)
      .send({
        name: "Unknown unit",
        category: "Bahan Baku",
        type: "raw_material",
        baseUomId: randomUUID(),
        isPerishable: false,
        idempotencyKey: `item-${randomUUID()}`,
      });
    expect(unknownUom.status).toBe(422);

    // Outlet-scoped lists: the owner's tenant assignment reaches both outlets.
    const locations = await client.get(
      `/api/inventory/locations?outletId=${outletA}&limit=100`,
    );
    expect(locations.status).toBe(200);
    expect(
      locations.body.data.some((row: { id: string }) => row.id === location1),
    ).toBe(true);

    const ledger = await client.get(
      `/api/inventory/stock-ledger?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.length).toBeGreaterThan(0);

    const balances = await client.get(
      `/api/inventory/balances?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(balances.status).toBe(200);

    const batches = await client.get(
      `/api/inventory/batches?outletId=${outletA}&limit=100&inventoryItemId=${itemId}`,
    );
    expect(batches.status).toBe(200);
  });

  it("denies an outlet role another outlet and tenant-level master data", async () => {
    const { client, userId } = await signedIn("Warehouse Bandung");
    await assignRole(userId, "warehouse", { type: "outlet", id: outletA });

    expect(
      (await client.get(`/api/inventory/locations?outletId=${outletA}`)).status,
    ).toBe(200);
    expect(
      (await client.get(`/api/inventory/locations?outletId=${outletB}`)).status,
    ).toBe(403);
  });

  it("legend-1ozj lets an outlet role read the item and UOM catalogs but not write them without inventory.item.manage", async () => {
    const reader = await signedIn("Supervisor Katalog");
    await assignRole(reader.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    expect(
      (await reader.client.get("/api/inventory/items?limit=10")).status,
    ).toBe(200);
    expect(
      (await reader.client.get("/api/inventory/uoms?limit=10")).status,
    ).toBe(200);
    // Reading the catalog never widens writes: outlet_manager has no
    // inventory.item.manage, and the code must exist in the catalog.
    expect(PERMISSION_CODES).toContain("inventory.item.manage");
    const denied = await reader.client
      .post("/api/inventory/items")
      .set(originHeader)
      .send({
        name: "Tidak Boleh",
        category: "Bahan Baku",
        type: "raw_material",
        baseUomId: randomUUID(),
        isPerishable: false,
        idempotencyKey: `catalog-${randomUUID()}`,
      });
    expect(denied.status).toBe(403);

    // The warehouse role holds the master-data code and may write.
    expect(roleTemplate("warehouse").permissions).toContain(
      "inventory.item.manage",
    );
    expect(roleTemplate("outlet_manager").permissions).not.toContain(
      "inventory.item.manage",
    );
  });
  it("legend-1ozj item writes need inventory.item.manage; stock.receive alone no longer writes the item master", async () => {
    const owned = await signedIn("Pemilik Katalog");
    await assignRole(owned.userId, "owner", { type: "tenant" });
    const uoms = await owned.client.get("/api/inventory/uoms?limit=1");
    const baseUomId = uoms.body.data[0].id as string;
    const body = () => ({
      name: `Bahan ${randomUUID().slice(0, 8)}`,
      category: "Bahan Baku",
      type: "raw_material",
      baseUomId,
      isPerishable: false,
      parMin: null,
      parMax: null,
      idempotencyKey: `perm-${randomUUID()}`,
    });

    const receiveOnly = await signedIn("Penerima Saja");
    await assignCustomRole(receiveOnly.userId, [
      "inventory.stock.view",
      "inventory.stock.receive",
    ]);
    expect(
      (
        await receiveOnly.client
          .post("/api/inventory/items")
          .set(originHeader)
          .send(body())
      ).status,
    ).toBe(403);

    const manager = await signedIn("Pengelola Katalog");
    await assignCustomRole(manager.userId, [
      "inventory.stock.view",
      "inventory.item.manage",
    ]);
    const created = await manager.client
      .post("/api/inventory/items")
      .set(originHeader)
      .send(body());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createdItemIds.push(created.body.data.id as string);
  });
});
